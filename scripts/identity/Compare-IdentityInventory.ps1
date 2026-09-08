<#
.SYNOPSIS
    Compares live Azure role assignments against the intended inventory and reports the differences.

.DESCRIPTION
    Takes the export produced by Export-AzureRoleAssignments.ps1 and the intended inventory in
    docs/identity/identity-inventory.json, and answers the three questions Phase 0 exists to answer:

      1. Which managed identities hold roles that the templates do not grant?  (drift, or a hand-made grant)
      2. Which grants do the templates make that Azure does not hold?         (a failed or partial deployment)
      3. Which managed identities exist in Azure that the inventory does not name at all?
         (a product or microservice we have not enumerated - the point of "comprehensive")

    What it deliberately does NOT do: assert scope equivalence. The inventory records logical scopes
    ("rg:storage"), while Azure records real resource IDs, and the mapping between them depends on
    per-ring parameter files. Role sets are compared per identity; scopes are reported for a human to
    classify. Overstating that match would hide exactly the drift this is meant to surface.

.PARAMETER ExportPath
    Path to role-assignments.json from Export-AzureRoleAssignments.ps1.

.PARAMETER InventoryPath
    Path to identity-inventory.json. Defaults to ../../docs/identity/identity-inventory.json.

.PARAMETER Ring
    Ring code the export was taken from (d, i, p, int). Used to fill <ring> in the resource-name
    patterns so identities are matched against the right ring.

.EXAMPLE
    ./Compare-IdentityInventory.ps1 -ExportPath ./out/role-assignments.json -Ring p
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ExportPath,
    [string]$InventoryPath = (Join-Path $PSScriptRoot '../../docs/identity/identity-inventory.json'),
    [Parameter(Mandatory)][ValidateSet('d', 'i', 'p', 'int')][string]$Ring
)

$ErrorActionPreference = 'Stop'

foreach ($path in @($ExportPath, $InventoryPath)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "File not found: $path" }
}

$export    = Get-Content -LiteralPath $ExportPath -Raw | ConvertFrom-Json
$inventory = Get-Content -LiteralPath $InventoryPath -Raw | ConvertFrom-Json

if (-not $export.graphResolution) {
    Write-Warning 'The export was produced without Graph resolution, so principal display names come from the CLI and identities may not match. Re-run the export with Graph access for a reliable comparison.'
}

# A resource-name pattern such as 'el-<ring>-eng-group-<node>' becomes a regex with the ring pinned
# and the node left open, because one identity per ring is expected to appear once per region.
function Convert-PatternToRegex {
    param([Parameter(Mandatory)][string]$Pattern, [Parameter(Mandatory)][string]$RingCode)

    $withRing = $Pattern.Replace('<ring>', $RingCode)
    $escaped = [regex]::Escape($withRing)
    $escaped = $escaped.Replace([regex]::Escape('<node>'), '[a-z0-9]+')
    return "^$escaped$"
}

$expected = foreach ($product in $inventory.products) {
    foreach ($app in $product.apps) {
        $roles = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($grant in $product.grants) {
            if ($grant.apps -contains $app.id) {
                foreach ($role in $grant.roles) { [void]$roles.Add($role) }
            }
        }
        [pscustomobject]@{
            Product          = $product.key
            AppId            = $app.id
            Kind             = $app.kind
            Pattern          = $app.resourceName
            Regex            = Convert-PatternToRegex -Pattern $app.resourceName -RingCode $Ring
            ProposedIdentity = $app.proposedIdentity.Replace('<ring>', $Ring)
            ExpectedRoles    = @($roles)
        }
    }
}
$expected = @($expected)

$live = @($export.assignments | Where-Object { -not $_.Orphaned })
$liveManaged = @($live | Where-Object { $_.ServicePrincipalType -eq 'ManagedIdentity' -or $_.PrincipalType -eq 'servicePrincipal' })

$matchedPrincipalIds = [System.Collections.Generic.HashSet[string]]::new()
$perApp = foreach ($row in $expected) {
    $hits = @($liveManaged | Where-Object { $_.PrincipalDisplayName -match $row.Regex })
    foreach ($hit in $hits) { [void]$matchedPrincipalIds.Add($hit.PrincipalId) }

    $instances = $hits | Group-Object PrincipalId, PrincipalDisplayName | ForEach-Object {
        $held = @($_.Group | Select-Object -ExpandProperty RoleDefinitionName -Unique | Sort-Object)
        [pscustomobject]@{
            PrincipalId   = $_.Group[0].PrincipalId
            DisplayName   = $_.Group[0].PrincipalDisplayName
            HeldRoles     = $held
            Unexpected    = @($held | Where-Object { $row.ExpectedRoles -notcontains $_ })
            Missing       = @($row.ExpectedRoles | Where-Object { $held -notcontains $_ })
            Assignments   = $_.Count
            Scopes        = @($_.Group | Select-Object -ExpandProperty Scope -Unique)
        }
    }

    [pscustomobject]@{
        Product          = $row.Product
        AppId            = $row.AppId
        Pattern          = $row.Pattern
        ProposedIdentity = $row.ProposedIdentity
        ExpectedRoles    = $row.ExpectedRoles
        Found            = @($instances).Count
        Instances        = @($instances)
    }
}
$perApp = @($perApp)

$unmatched = @($liveManaged |
    Where-Object { -not $matchedPrincipalIds.Contains($_.PrincipalId) } |
    Group-Object PrincipalId, PrincipalDisplayName |
    ForEach-Object {
        [pscustomobject]@{
            PrincipalId   = $_.Group[0].PrincipalId
            DisplayName   = $_.Group[0].PrincipalDisplayName
            Type          = $_.Group[0].ServicePrincipalType
            Assignments   = $_.Count
            Roles         = @($_.Group | Select-Object -ExpandProperty RoleDefinitionName -Unique | Sort-Object)
            Scopes        = @($_.Group | Select-Object -ExpandProperty Scope -Unique)
        }
    })

$orphans = @($export.assignments | Where-Object { $_.Orphaned })

Write-Host ''
Write-Host "=== Ring '$Ring' - inventory vs Azure ===" -ForegroundColor Cyan
Write-Host ("Apps in inventory     : {0}" -f $expected.Count)
Write-Host ("  found in Azure      : {0}" -f @($perApp | Where-Object { $_.Found -gt 0 }).Count)
Write-Host ("  not found in Azure  : {0}" -f @($perApp | Where-Object { $_.Found -eq 0 }).Count)
Write-Host ("Unmatched identities  : {0}" -f $unmatched.Count) -ForegroundColor $(if ($unmatched.Count) { 'Yellow' } else { 'Green' })
Write-Host ("Orphaned assignments  : {0}" -f $orphans.Count) -ForegroundColor $(if ($orphans.Count) { 'Red' } else { 'Green' })
Write-Host ''

$notFound = @($perApp | Where-Object { $_.Found -eq 0 })
if ($notFound.Count) {
    Write-Host '--- In the inventory, absent from Azure (expected for rings that do not run every product) ---' -ForegroundColor Yellow
    $notFound | Select-Object Product, AppId, Pattern | Format-Table -AutoSize
}

$withDrift = @($perApp | Where-Object { $_.Instances | Where-Object { $_.Unexpected.Count -or $_.Missing.Count } })
if ($withDrift.Count) {
    Write-Host '--- Role-set differences ---' -ForegroundColor Yellow
    foreach ($app in $withDrift) {
        foreach ($instance in $app.Instances) {
            if (-not ($instance.Unexpected.Count -or $instance.Missing.Count)) { continue }
            Write-Host ("{0} / {1}" -f $app.Product, $instance.DisplayName) -ForegroundColor White
            if ($instance.Unexpected.Count) {
                Write-Host ("    holds but inventory does not grant : {0}" -f ($instance.Unexpected -join ', ')) -ForegroundColor Red
            }
            if ($instance.Missing.Count) {
                Write-Host ("    inventory grants but does not hold : {0}" -f ($instance.Missing -join ', ')) -ForegroundColor Yellow
            }
        }
    }
    Write-Host ''
}
else {
    Write-Host 'No role-set differences for any matched identity.' -ForegroundColor Green
    Write-Host ''
}

if ($unmatched.Count) {
    Write-Host '--- Service principals holding roles that the inventory does not name ---' -ForegroundColor Yellow
    Write-Host '    (deploy principals and operations principals are expected here; anything else is a gap in the inventory)'
    $unmatched | Select-Object DisplayName, Type, Assignments, @{n='Roles';e={$_.Roles -join ', '}} | Format-Table -AutoSize
}

if ($orphans.Count) {
    Write-Host '--- Orphaned assignments (principal deleted) ---' -ForegroundColor Red
    $orphans | Group-Object PrincipalId | ForEach-Object {
        [pscustomobject]@{
            PrincipalId = $_.Name
            Assignments = $_.Count
            Roles       = (@($_.Group | Select-Object -ExpandProperty RoleDefinitionName -Unique) -join ', ')
        }
    } | Format-Table -AutoSize
    Write-Host 'These are safe to delete once you have confirmed the principal is gone:' -ForegroundColor DarkGray
    Write-Host '  az role assignment delete --ids <assignment id>' -ForegroundColor DarkGray
}

[pscustomobject]@{
    ring       = $Ring
    apps       = $perApp
    unmatched  = $unmatched
    orphans    = $orphans
    summary    = [pscustomobject]@{
        appsInInventory = $expected.Count
        appsFound       = @($perApp | Where-Object { $_.Found -gt 0 }).Count
        driftedApps     = $withDrift.Count
        unmatched       = $unmatched.Count
        orphans         = $orphans.Count
    }
}
