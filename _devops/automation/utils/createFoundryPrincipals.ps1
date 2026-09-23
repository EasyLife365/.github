# ============================================================================
# Entra principals for the Claude-on-Foundry deployment — EasyLife 365
# ----------------------------------------------------------------------------
# Creates the two Microsoft Graph objects that
# _devops/automation/deployment/infrastructure/bicep/main.bicep expects but
# cannot provision itself:
#
#   1. A single-tenant app registration + service principal that
#      pr_code_review.yml authenticates as from GitHub Actions  ->  feeds the
#      Bicep's `ciServicePrincipalId`.
#   2. A security group of developers who may fall back to the Foundry
#      deployment locally via `az login`  ->  feeds the Bicep's
#      `developerGroupPrincipalId`.
#
# The CI identity gets one federated identity credential per repository, so it
# authenticates with a short-lived token minted by GitHub's OIDC issuer and
# NEVER a client secret. This is the whole point of the script, and the reason
# it does not follow EasyLife365-EasyHub's / EasyMeet365's own
# _devops/automation/utils/createCredentials.ps1, which use
# `az ad sp create-for-rbac` and hand back a secret somebody then has to store.
#
# ----------------------------------------------------------------------------
# What this deliberately does NOT do
# ----------------------------------------------------------------------------
#   - It does not assign any Azure role. The Bicep already grants
#     `Cognitive Services User` to both principals; granting here as well would
#     put the same decision in two places that then drift apart.
#   - It does not write the ids into config/main.parameters-p.json. It prints
#     them; a human pastes them. A provisioning script silently rewriting a
#     checked-in parameter file is how surprising diffs happen.
#
# ----------------------------------------------------------------------------
# Who can run it
# ----------------------------------------------------------------------------
# The signed-in identity needs, in Entra ID:
#   - Application Administrator (or Cloud Application Administrator) — to
#     create the app registration, its service principal, and the federated
#     credentials.
#   - Groups Administrator — to create the security group.
# No Azure subscription role is needed: nothing here touches ARM.
#
# Re-running is safe. Every step looks the object up first and only creates
# what is missing, so this doubles as the way to add a repository later.
#
# It also only ever ADDS by default: a credential whose subject matches no name currently in
# -Repos (a typo from a prior run, or a repository since removed from the list) is left in
# place unless -RemoveOrphaned is passed. That is not a theoretical case -- two credentials
# for the exact typos named above (EasyLife365-Notifications, EasyLife365-AgentHub) sat live,
# unused and unnoticed, until something went looking for why those two repositories' sign-ins
# were failing. -RemoveOrphaned exists to clear exactly that state, deliberately opt-in rather
# than automatic: an orphan is silent and inert, so there is no urgency that justifies deleting
# on a caller's behalf without them asking for it by name.
#
# -WhatIf previews every mutating call (app/SP/group creation, credential create AND delete).
# It did not always: this script ran with no CmdletBinding at all until a live -RemoveOrphaned
# -WhatIf run deleted the two orphans above for real -- PowerShell accepted the unbound -WhatIf
# switch without complaint and every line downstream ran unguarded. If a mutating call is ever
# added here without wrapping it in $PSCmdlet.ShouldProcess, -WhatIf will silently stop meaning
# anything again, exactly as it did before.
# ============================================================================

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$CiApplicationName = 'elagents-p-foundry-ci',
    [string]$DeveloperGroupName = 'EasyLife 365 Foundry Developers',
    [string]$DeveloperGroupMailNickname = 'easylife365-foundry-developers',
    [string]$Organization = 'EasyLife365',

    # Repositories whose pr_code_review.yml runs should be able to authenticate.
    # Each one costs a federated identity credential (see the cap below).
    #
    # NOTE: these names are CASE-SENSITIVE and must be the repository's exact
    # canonical name. Entra matches the federated credential's subject against
    # GitHub's `sub` claim verbatim, so a wrong name fails at SIGN-IN with
    # AADSTS700213 ("No matching federated identity record found") -- possibly
    # weeks later, in CI, not here. That is why Test-RepositoryNames below
    # verifies every name against GitHub before a single credential is created.
    #
    # The canonical list of EasyLife repositories lives in
    # .github-private/scripts/products-workspace.repositories.json. Check new
    # entries against it, and against `gh repo list EasyLife365`.
    [string[]]$Repos = @(
        'EasyLife365-Core'
        'EasyLife365-Identity'
        'EasyLife365-Collaboration'
        'EasyLife365-Exchange'
        'EasyLife365-EasyHub'
        'EasyLife365-Notification'
        'EasyLife365-Agents'
        'EasyLife-Approvals'
        'EasyMeet365'
        'EasyLife-React-Auth'
        'EasyLife-React-Components'
        'EasyLife-React-Core'
        '.github'
    ),

    # Skip the GitHub name check. Only for a tenant-only rehearsal where `gh` is
    # unavailable -- it trades the one safeguard that catches a typo before it
    # becomes a sign-in failure.
    [switch]$SkipRepositoryCheck,

    # Delete every existing federated identity credential whose subject matches no repository
    # currently in -Repos, before creating whatever the current list is still missing. Off by
    # default: reconciling is always reported, deleting is opt-in. This is how a wrong subject
    # from an earlier run (a typo, or a repository later renamed/removed) actually gets cleared,
    # since the create step below only ever adds -- it has no way to tell "wrong" from "not
    # ours to touch" on its own, so removal has to be a deliberate, named choice.
    [switch]$RemoveOrphaned
)

$ErrorActionPreference = 'Stop'

# Entra allows 20 federated identity credentials per application. Fail before
# creating a partial set rather than halfway through the loop.
$federatedCredentialLimit = 20

$githubIssuer = 'https://token.actions.githubusercontent.com'
$entraAudience = 'api://AzureADTokenExchange'

if ($Repos.Count -gt $federatedCredentialLimit) {
    Write-Host "ERROR: $($Repos.Count) repositories requested, but Entra allows at most $federatedCredentialLimit federated identity credentials per application." -ForegroundColor Red
    Write-Host "       Either split the repositories across two applications, or switch to a wildcard subject (flexible federated identity credentials)." -ForegroundColor Red
    exit 1
}

# Verify every repository name against GitHub before touching Entra.
#
# This exists because a wrong name is otherwise invisible: `az` accepts any
# string as a subject, the credential is created happily, and the only symptom
# is AADSTS700213 the next time that repository's workflow tries to sign in.
# Two names in this list were wrong on the first pass (EasyLife365-Notifications
# for -Notification, EasyLife365-AgentHub for -Agents) and nothing caught them.
function Test-RepositoryNames {
    param([string[]]$Names)

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Host "WARNING: the GitHub CLI (gh) is not on PATH, so repository names cannot be verified." -ForegroundColor Yellow
        Write-Host "         A typo here surfaces only as AADSTS700213 at sign-in. Install gh, or re-run with -SkipRepositoryCheck to accept that." -ForegroundColor Yellow
        exit 1
    }

    Write-Host "Verifying repository names against GitHub..." -ForegroundColor Cyan
    $unknown = @()

    foreach ($name in $Names) {
        # --jq .full_name so a rename shows up as a mismatch rather than a pass:
        # GitHub resolves an old name to its successor, and the credential must
        # carry the CURRENT one.
        $fullName = gh api "repos/$Organization/$name" --jq .full_name 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  ! $name does not resolve" -ForegroundColor Red
            $unknown += $name
            continue
        }

        $fullName = "$fullName".Trim()
        if ($fullName -cne "$Organization/$name") {
            Write-Host "  ! $name resolves to '$fullName' - use that name instead" -ForegroundColor Red
            $unknown += $name
            continue
        }

        Write-Host "  ✓ $fullName" -ForegroundColor Green
    }

    if ($unknown.Count -gt 0) {
        Write-Host ''
        Write-Host "ERROR: $($unknown.Count) repository name(s) could not be confirmed: $($unknown -join ', ')" -ForegroundColor Red
        Write-Host "       Nothing has been created. Fix the -Repos list and re-run." -ForegroundColor Red
        exit 1
    }
}

$output = az account show 2>&1
if (!$?) {
    az login
}

if (-not $SkipRepositoryCheck) {
    Test-RepositoryNames -Names $Repos
}

$tenantId = az account show --query tenantId -o tsv --only-show-errors 2>&1
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($tenantId)) {
    Write-Host "ERROR: Could not resolve the signed-in tenant id." -ForegroundColor Red
    Write-Host $tenantId
    exit 1
}
$tenantId = $tenantId.Trim()

Write-Host "Provisioning Foundry Entra principals in tenant '$tenantId'..." -ForegroundColor Cyan

# === CI application registration =============================================
Write-Host "Looking up app registration '$CiApplicationName'..." -ForegroundColor Cyan
$applicationJson = az ad app list --display-name $CiApplicationName --query "[0].{appId:appId, id:id}" -o json --only-show-errors 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Could not query app registrations.`n$applicationJson" -ForegroundColor Red
    exit 1
}

$application = $applicationJson | ConvertFrom-Json
if ($null -eq $application -or [string]::IsNullOrWhiteSpace($application.appId)) {
    Write-Host "Creating app registration '$CiApplicationName'..." -ForegroundColor Cyan

    if ($PSCmdlet.ShouldProcess($CiApplicationName, 'Create app registration')) {
        # Single-tenant on purpose. A multi-tenant registration can be consented to
        # in any customer tenant, and this identity is the one that reaches the
        # Foundry account - it must never be holdable by a principal outside ours.
        $applicationJson = az ad app create `
            --display-name $CiApplicationName `
            --sign-in-audience AzureADMyOrg `
            --query "{appId:appId, id:id}" -o json --only-show-errors 2>&1

        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Could not create the app registration.`n$applicationJson" -ForegroundColor Red
            exit 1
        }

        $application = $applicationJson | ConvertFrom-Json
        Write-Host "  ✓ Created app registration (appId $($application.appId))" -ForegroundColor Green
    }
    else {
        Write-Host "  Would create app registration '$CiApplicationName'." -ForegroundColor Yellow
        Write-Host '  Nothing downstream can be previewed without its real appId -- stopping here.' -ForegroundColor Yellow
        exit 0
    }
}
else {
    Write-Host "  ✓ App registration already exists (appId $($application.appId))" -ForegroundColor Green
}

$applicationObjectId = $application.id
$applicationClientId = $application.appId

# === CI service principal ====================================================
# The app registration is the definition; the service principal is the object
# that actually holds role assignments in this tenant. The Bicep needs the
# latter's id, not the former's.
Write-Host "Looking up service principal for appId '$applicationClientId'..." -ForegroundColor Cyan
$servicePrincipalId = az ad sp list --filter "appId eq '$applicationClientId'" --query "[0].id" -o tsv --only-show-errors 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Could not query service principals.`n$servicePrincipalId" -ForegroundColor Red
    exit 1
}

if ([string]::IsNullOrWhiteSpace($servicePrincipalId)) {
    if (-not $PSCmdlet.ShouldProcess($applicationClientId, 'Create service principal')) {
        Write-Host "  Would create a service principal for appId '$applicationClientId'." -ForegroundColor Yellow
        Write-Host '  Nothing downstream can be previewed without its real id -- stopping here.' -ForegroundColor Yellow
        exit 0
    }
    Write-Host "Creating service principal..." -ForegroundColor Cyan
    $servicePrincipalId = az ad sp create --id $applicationClientId --query id -o tsv --only-show-errors 2>&1
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($servicePrincipalId)) {
        Write-Host "ERROR: Could not create the service principal.`n$servicePrincipalId" -ForegroundColor Red
        exit 1
    }
    Write-Host "  ✓ Created service principal" -ForegroundColor Green
}
else {
    Write-Host "  ✓ Service principal already exists" -ForegroundColor Green
}
$servicePrincipalId = $servicePrincipalId.Trim()

# === Federated identity credentials ==========================================
Write-Host "Reconciling federated identity credentials..." -ForegroundColor Cyan
$existingCredentialsJson = az ad app federated-credential list --id $applicationObjectId --query "[].{id:id, name:name, subject:subject}" -o json --only-show-errors 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Could not list federated identity credentials.`n$existingCredentialsJson" -ForegroundColor Red
    exit 1
}
$existingCredentials = @($existingCredentialsJson | ConvertFrom-Json)
$existingSubjects = @($existingCredentials | ForEach-Object { $_.subject })

# Every subject a credential COULD legitimately hold for the current -Repos list. Anything
# live that isn't in this set belongs to no repository we're being asked to trust right now --
# a prior run's typo, or a repository since removed from the list -- not a fact this script can
# repair by creating something; only removal (or leaving it alone) applies.
#
# -cnotin, not -notin: PowerShell's default comparison operators are case-INsensitive, which
# would silently miss a stale credential that differs from an expected subject only in case --
# exactly the mistake Test-RepositoryNames above already exists to catch on the -Repos side,
# so the comparison here needs the same case-sensitive discipline, not a looser one.
#
# Only a subject matching this script's OWN shape (repo:<org>/<anything>:pull_request) is even
# considered for orphan status. A credential of a different shape -- a future push-trigger
# credential (repo:<org>/<repo>:ref:refs/heads/<branch>), or one added by hand for some other
# purpose entirely -- is left alone and separately reported, never silently swept into
# "orphan" just because this run doesn't recognise it. "Not one of ours" and "wrong" are not
# the same claim, and only the second is safe to offer for deletion.
$expectedSubjects = @($Repos | ForEach-Object { "repo:$Organization/${_}:pull_request" })
$ourShapePattern = "^repo:$([regex]::Escape($Organization))/.+:pull_request$"
$orphans = @($existingCredentials | Where-Object { $_.subject -cmatch $ourShapePattern -and $_.subject -cnotin $expectedSubjects })
$otherShape = @($existingCredentials | Where-Object { $_.subject -cnotmatch $ourShapePattern })

if ($otherShape.Count -gt 0) {
    Write-Host ''
    Write-Host "$($otherShape.Count) federated credential(s) have a different subject shape than repo:$Organization/<repo>:pull_request -- not evaluated as orphans, left untouched:" -ForegroundColor Yellow
    foreach ($other in $otherShape) {
        Write-Host "  - $($other.name)  ($($other.subject))" -ForegroundColor Yellow
    }
}

if ($orphans.Count -gt 0) {
    Write-Host ''
    Write-Host "$($orphans.Count) federated credential(s) match no repository in -Repos:" -ForegroundColor Yellow
    foreach ($orphan in $orphans) {
        Write-Host "  - $($orphan.name)  ($($orphan.subject))" -ForegroundColor Yellow
    }

    if ($RemoveOrphaned) {
        foreach ($orphan in $orphans) {
            if ($PSCmdlet.ShouldProcess($orphan.name, 'Delete orphaned federated identity credential')) {
                $result = az ad app federated-credential delete --id $applicationObjectId --federated-credential-id $orphan.id --only-show-errors 2>&1
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "ERROR: Could not delete '$($orphan.name)'.`n$result" -ForegroundColor Red
                    exit 1
                }
                Write-Host "  ✓ Removed $($orphan.name)" -ForegroundColor Green
                $existingSubjects = @($existingSubjects | Where-Object { $_ -cne $orphan.subject })
            }
            else {
                Write-Host "  Would remove $($orphan.name)" -ForegroundColor Yellow
            }
        }
    }
    else {
        Write-Host "  Not removed -- re-run with -RemoveOrphaned to delete them." -ForegroundColor Yellow
    }
    Write-Host ''
}

foreach ($repo in $Repos) {
    # pr_code_review.yml runs on pull_request, so that is the subject GitHub
    # mints. A run on a branch push carries `ref:refs/heads/<branch>` instead
    # and would need its own credential.
    $subject = "repo:$Organization/${repo}:pull_request"

    # -ccontains: same case-sensitive discipline as the orphan check above and
    # Test-RepositoryNames' -cne -- Entra matches a federated credential's subject against
    # GitHub's `sub` claim verbatim, so a case-insensitive "already exists" here could skip
    # creating the credential a repository actually needs, on the strength of an existing one
    # that only looks the same.
    if ($existingSubjects -ccontains $subject) {
        Write-Host "  ✓ $repo already has a credential" -ForegroundColor Green
        continue
    }

    if (-not $PSCmdlet.ShouldProcess($subject, 'Create federated identity credential')) {
        Write-Host "  Would create a credential for $repo -> $subject" -ForegroundColor Yellow
        continue
    }

    # Federated credential names allow alphanumerics and hyphens only.
    $credentialName = "github-$($repo -replace '[^a-zA-Z0-9-]', '-')-pull-request".ToLower()

    # az mangles embedded double quotes in inline JSON on Windows, so the
    # payload goes through a file instead of --parameters '<json>'.
    $credentialFile = Join-Path ([System.IO.Path]::GetTempPath()) "fic-$([guid]::NewGuid()).json"
    $credentialBody = @{
        name        = $credentialName
        issuer      = $githubIssuer
        subject     = $subject
        description = "GitHub Actions OIDC for $Organization/$repo pull requests"
        audiences   = @($entraAudience)
    } | ConvertTo-Json -Depth 5

    # WriteAllText with an explicit BOM-less encoding, not Set-Content -Encoding
    # utf8: that writes a BOM on Windows PowerShell 5.1 and az rejects the
    # parameter file. Same reason as in .github-private's
    # scripts/Set-CiFederatedCredentials.ps1.
    [IO.File]::WriteAllText($credentialFile, $credentialBody, [Text.UTF8Encoding]::new($false))

    try {
        $result = az ad app federated-credential create --id $applicationObjectId --parameters "@$credentialFile" --only-show-errors 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Could not create the federated credential for '$repo'.`n$result" -ForegroundColor Red
            exit 1
        }
        Write-Host "  ✓ $repo -> $subject" -ForegroundColor Green
    }
    finally {
        if (Test-Path $credentialFile) {
            Remove-Item -Path $credentialFile -Force -ErrorAction SilentlyContinue
        }
    }
}

# === Developer security group ================================================
Write-Host "Looking up security group '$DeveloperGroupName'..." -ForegroundColor Cyan
$groupId = az ad group list --display-name $DeveloperGroupName --query "[0].id" -o tsv --only-show-errors 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Could not query groups.`n$groupId" -ForegroundColor Red
    exit 1
}

if ([string]::IsNullOrWhiteSpace($groupId)) {
    if ($PSCmdlet.ShouldProcess($DeveloperGroupName, 'Create security group')) {
        Write-Host "Creating security group '$DeveloperGroupName'..." -ForegroundColor Cyan
        $groupId = az ad group create `
            --display-name $DeveloperGroupName `
            --mail-nickname $DeveloperGroupMailNickname `
            --query id -o tsv --only-show-errors 2>&1

        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($groupId)) {
            Write-Host "ERROR: Could not create the security group.`n$groupId" -ForegroundColor Red
            exit 1
        }
        Write-Host "  ✓ Created security group (it is empty - add developers to it)" -ForegroundColor Green
    }
    else {
        Write-Host "  Would create security group '$DeveloperGroupName'." -ForegroundColor Yellow
        $groupId = '<what-if: not yet created>'
    }
}
else {
    Write-Host "  ✓ Security group already exists" -ForegroundColor Green
}
$groupId = $groupId.Trim()

# === Summary =================================================================
Write-Host ''
Write-Host 'Paste into _devops/automation/deployment/infrastructure/config/main.parameters-p.json:' -ForegroundColor Cyan
Write-Host ''
Write-Host "        `"ciServicePrincipalId`": {"
Write-Host "            `"value`": `"$servicePrincipalId`""
Write-Host '        },'
Write-Host "        `"developerGroupPrincipalId`": {"
Write-Host "            `"value`": `"$groupId`""
Write-Host '        },'
Write-Host ''
Write-Host 'Then re-run provision-environment-production-locally.ps1 so the grants are applied.' -ForegroundColor Cyan
Write-Host ''
Write-Host 'For pr_code_review.yml''s azure/login@v2 step:' -ForegroundColor Cyan
Write-Host "  client-id  $applicationClientId"
Write-Host "  tenant-id  $tenantId"
Write-Host ''
Write-Host 'Remaining manual step: add the developers who should have fallback access to' -ForegroundColor Yellow
Write-Host "'$DeveloperGroupName'. The group is created empty, and membership is the only" -ForegroundColor Yellow
Write-Host 'thing standing between a developer and the shared Foundry deployment.' -ForegroundColor Yellow
