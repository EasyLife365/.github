<#
.SYNOPSIS
    Exports every Azure role assignment in the given scopes and flags the ones whose principal no longer exists.

.DESCRIPTION
    Phase 0 of the managed-identity redesign: the inventory in docs/identity/identity-inventory.json
    describes what the templates INTEND to grant. This script reads what Azure actually holds, so the
    two can be compared (see Compare-IdentityInventory.ps1).

    An orphaned assignment is one whose principal has been deleted - the usual cause is an app being
    recreated, because a system-assigned identity gets a new principal ID every time. Orphans are
    invisible in the templates, still count against the 4,000-assignments-per-subscription limit, and
    are the clearest evidence of how often the current model breaks.

    Principal resolution uses Microsoft Graph directoryObjects/getByIds in batches of 1,000. If the
    signed-in identity cannot call Graph, the script still runs and falls back to the CLI's own
    principalName, which is empty for a deleted principal - less precise, so it is reported as such.

.PARAMETER SubscriptionId
    One or more subscription IDs to enumerate. Defaults to every enabled subscription the caller can see.

.PARAMETER ManagementGroupId
    Also enumerate assignments made directly at this management group's scope. Collaboration deploys at
    management-group scope, where the limit is a fixed 500.

.PARAMETER OutputDirectory
    Where to write role-assignments.json, role-assignments.csv and orphans.csv. Defaults to ./out.

.EXAMPLE
    ./Export-AzureRoleAssignments.ps1 -OutputDirectory ./out

.EXAMPLE
    ./Export-AzureRoleAssignments.ps1 -SubscriptionId 4126e0c2-... -ManagementGroupId easylife-prod
#>
[CmdletBinding()]
param(
    [string[]]$SubscriptionId,
    [string]$ManagementGroupId,
    [string]$OutputDirectory = (Join-Path (Get-Location) 'out')
)

$ErrorActionPreference = 'Stop'

# Assignment counts are only meaningful against the platform ceilings, so they travel with the report.
$SubscriptionAssignmentLimit = 4000
$ManagementGroupAssignmentLimit = 500

function Assert-AzCli {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw 'The Azure CLI (az) is required and was not found on PATH.'
    }
    $account = az account show -o json --only-show-errors 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Not signed in to Azure. Run 'az login' first.`n$account"
    }
    return ($account | ConvertFrom-Json)
}

function Get-TargetSubscriptions {
    if ($SubscriptionId) { return @($SubscriptionId) }

    Write-Host 'No -SubscriptionId given; enumerating every enabled subscription.' -ForegroundColor Cyan
    $ids = az account list --query "[?state=='Enabled'].id" -o tsv --only-show-errors 2>&1
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($ids)) {
        throw "Could not enumerate subscriptions.`n$ids"
    }
    return @($ids.Trim() -split "`n" | Where-Object { $_ } | ForEach-Object { $_.Trim() })
}

function Get-AssignmentsForSubscription {
    param([Parameter(Mandatory)][string]$Subscription)

    # --all walks resource-group and resource scopes too, which is where almost every EasyLife grant sits.
    $json = az role assignment list --subscription $Subscription --all -o json --only-show-errors 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not list role assignments in $Subscription. Skipping.`n$json"
        return @()
    }
    return @($json | ConvertFrom-Json)
}

function Get-AssignmentsForManagementGroup {
    param([Parameter(Mandatory)][string]$Group)

    $scope = "/providers/Microsoft.Management/managementGroups/$Group"
    $json = az role assignment list --scope $scope -o json --only-show-errors 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not list role assignments at $scope. Skipping.`n$json"
        return @()
    }
    return @($json | ConvertFrom-Json)
}

# Resolves principal IDs against Graph. Returns a hashtable id -> object, and the set of ids Graph
# confirmed do not exist. Graph omits unknown ids from the response rather than erroring on them,
# which is exactly the orphan signal we want.
function Resolve-Principals {
    param([Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Ids)

    $known = @{}
    $graphWorked = $false
    $unique = @($Ids | Where-Object { $_ } | Select-Object -Unique)
    if ($unique.Count -eq 0) { return @{ Known = $known; GraphWorked = $true } }

    for ($i = 0; $i -lt $unique.Count; $i += 1000) {
        $batch = $unique[$i..([Math]::Min($i + 999, $unique.Count - 1))]
        $body = @{ ids = @($batch) } | ConvertTo-Json -Compress -Depth 3

        # az rest on Windows mangles double quotes in --body, so the payload goes in single quotes.
        $result = az rest --method POST `
            --url 'https://graph.microsoft.com/v1.0/directoryObjects/getByIds' `
            --headers 'Content-Type=application/json' `
            --body $body.Replace('"', "'") -o json --only-show-errors 2>&1

        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Graph lookup failed; falling back to CLI principalName for orphan detection.`n$result"
            return @{ Known = @{}; GraphWorked = $false }
        }

        $graphWorked = $true
        foreach ($obj in ($result | ConvertFrom-Json).value) {
            $known[$obj.id] = [pscustomobject]@{
                DisplayName = $obj.displayName
                Type        = $obj.'@odata.type' -replace '#microsoft.graph.', ''
                # Present only on service principals; 'ManagedIdentity' is what we are migrating away from.
                SpType      = $obj.servicePrincipalType
            }
        }
    }

    return @{ Known = $known; GraphWorked = $graphWorked }
}

function Get-ScopeKind {
    param([string]$Scope)
    switch -Regex ($Scope) {
        '^/providers/Microsoft\.Management/managementGroups/' { 'managementGroup'; break }
        '/resourceGroups/[^/]+/providers/'                    { 'resource'; break }
        '/resourceGroups/[^/]+$'                              { 'resourceGroup'; break }
        '^/subscriptions/[^/]+$'                              { 'subscription'; break }
        default                                               { 'other' }
    }
}

$identity = Assert-AzCli
Write-Host "Signed in as $($identity.user.name) (tenant $($identity.tenantId))." -ForegroundColor Cyan

$subscriptions = Get-TargetSubscriptions
Write-Host "Enumerating $($subscriptions.Count) subscription(s)." -ForegroundColor Cyan

$raw = [System.Collections.Generic.List[object]]::new()

foreach ($sub in $subscriptions) {
    Write-Host "  reading $sub ..." -NoNewline
    $items = Get-AssignmentsForSubscription -Subscription $sub
    foreach ($item in $items) { $raw.Add([pscustomobject]@{ Container = $sub; ContainerKind = 'subscription'; Item = $item }) }
    Write-Host " $($items.Count) assignment(s)"
}

if ($ManagementGroupId) {
    Write-Host "  reading management group $ManagementGroupId ..." -NoNewline
    $items = Get-AssignmentsForManagementGroup -Group $ManagementGroupId
    foreach ($item in $items) { $raw.Add([pscustomobject]@{ Container = $ManagementGroupId; ContainerKind = 'managementGroup'; Item = $item }) }
    Write-Host " $($items.Count) assignment(s)"
}

if ($raw.Count -eq 0) {
    Write-Host 'No role assignments were returned. Nothing to export.' -ForegroundColor Yellow
    return
}

Write-Host 'Resolving principals against Microsoft Graph...' -ForegroundColor Cyan
$resolution = Resolve-Principals -Ids @($raw | ForEach-Object { $_.Item.principalId })
$known = $resolution.Known
$graphWorked = $resolution.GraphWorked

$rows = foreach ($entry in $raw) {
    $a = $entry.Item
    $principal = if ($graphWorked) { $known[$a.principalId] } else { $null }

    if ($graphWorked) {
        $orphaned = -not $known.ContainsKey($a.principalId)
        $confidence = 'graph'
    }
    else {
        # Without Graph the CLI's own resolution is all we have: an empty principalName usually means
        # the object is gone, but it can also mean the caller simply cannot read the directory.
        $orphaned = [string]::IsNullOrWhiteSpace($a.principalName)
        $confidence = 'cli-fallback'
    }

    [pscustomobject]@{
        Container            = $entry.Container
        ContainerKind        = $entry.ContainerKind
        RoleDefinitionName   = $a.roleDefinitionName
        RoleDefinitionId     = ($a.roleDefinitionId -split '/')[-1]
        PrincipalId          = $a.principalId
        PrincipalDisplayName = if ($principal) { $principal.DisplayName } else { $a.principalName }
        PrincipalType        = if ($principal) { $principal.Type } else { $a.principalType }
        ServicePrincipalType = if ($principal) { $principal.SpType } else { $null }
        Scope                = $a.scope
        ScopeKind            = Get-ScopeKind -Scope $a.scope
        HasCondition         = -not [string]::IsNullOrWhiteSpace($a.condition)
        AssignmentName       = ($a.id -split '/')[-1]
        Orphaned             = $orphaned
        OrphanConfidence     = $confidence
        CreatedOn            = $a.createdOn
    }
}

$rows = @($rows)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$orphans = @($rows | Where-Object { $_.Orphaned })
$byContainer = $rows | Group-Object Container, ContainerKind | ForEach-Object {
    $limit = if ($_.Group[0].ContainerKind -eq 'managementGroup') { $ManagementGroupAssignmentLimit } else { $SubscriptionAssignmentLimit }
    [pscustomobject]@{
        Container       = $_.Group[0].Container
        ContainerKind   = $_.Group[0].ContainerKind
        Assignments     = $_.Count
        Orphaned        = @($_.Group | Where-Object { $_.Orphaned }).Count
        Limit           = $limit
        PercentOfLimit  = [Math]::Round(100 * $_.Count / $limit, 1)
    }
}

$report = [pscustomobject]@{
    generated        = (Get-Date).ToString('o')
    tenantId         = $identity.tenantId
    graphResolution  = $graphWorked
    totals           = [pscustomobject]@{
        assignments        = $rows.Count
        orphaned           = $orphans.Count
        managedIdentities  = @($rows | Where-Object { $_.ServicePrincipalType -eq 'ManagedIdentity' } | Select-Object -ExpandProperty PrincipalId -Unique).Count
        withCondition      = @($rows | Where-Object { $_.HasCondition }).Count
        byScopeKind        = $(
            $kinds = [ordered]@{}
            foreach ($group in ($rows | Group-Object ScopeKind | Sort-Object Name)) { $kinds[$group.Name] = $group.Count }
            [pscustomobject]$kinds
        )
    }
    perContainer     = @($byContainer)
    assignments      = $rows
}

$jsonPath    = Join-Path $OutputDirectory 'role-assignments.json'
$csvPath     = Join-Path $OutputDirectory 'role-assignments.csv'
$orphanPath  = Join-Path $OutputDirectory 'orphans.csv'

$report | ConvertTo-Json -Depth 8 | Set-Content -Path $jsonPath -Encoding utf8
$rows | Export-Csv -Path $csvPath -NoTypeInformation -Encoding utf8
$orphans | Export-Csv -Path $orphanPath -NoTypeInformation -Encoding utf8

Write-Host ''
Write-Host "Assignments        : $($rows.Count)" -ForegroundColor Green
Write-Host "Distinct managed IDs: $($report.totals.managedIdentities)" -ForegroundColor Green
Write-Host "With ABAC condition : $($report.totals.withCondition)" -ForegroundColor Green
if ($orphans.Count -gt 0) {
    $colour = if ($graphWorked) { 'Red' } else { 'Yellow' }
    Write-Host "Orphaned            : $($orphans.Count)  (confidence: $(if ($graphWorked) { 'graph' } else { 'cli-fallback' }))" -ForegroundColor $colour
}
else {
    Write-Host 'Orphaned            : 0' -ForegroundColor Green
}
Write-Host ''
$byContainer | Sort-Object -Property PercentOfLimit -Descending | Format-Table -AutoSize
Write-Host "Written to $OutputDirectory" -ForegroundColor Cyan
