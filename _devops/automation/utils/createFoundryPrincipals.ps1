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
# ============================================================================

param(
    [string]$CiApplicationName = 'elagents-p-foundry-ci',
    [string]$DeveloperGroupName = 'EasyLife 365 Foundry Developers',
    [string]$DeveloperGroupMailNickname = 'easylife365-foundry-developers',
    [string]$Organization = 'EasyLife365',

    # Repositories whose pr_code_review.yml runs should be able to authenticate.
    # Each one costs a federated identity credential (see the cap below).
    #
    # NOTE: these names are CASE-SENSITIVE. Entra matches the federated
    # credential's subject against GitHub's `sub` claim verbatim, and that claim
    # carries the repository's canonical name. A casing mismatch fails at sign-in
    # with AADSTS700213 ("No matching federated identity record found"), not here.
    # The Agents and Notification repositories are deliberately absent — add them
    # once their canonical names are confirmed.
    [string[]]$Repos = @(
        'EasyLife365-Core'
        'EasyLife365-Identity'
        'EasyLife365-Collaboration'
        'EasyLife365-Exchange'
        'EasyLife365-EasyHub'
        'EasyLife365-Notifications'
        'EasyLife365-AgentHub'
        'EasyLife-Approvals'
        'EasyMeet365'
        'EasyLife-React-Auth'
        'EasyLife-React-Components'
        'EasyLife-React-Core'
        '.github'
    )
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

$output = az account show 2>&1
if (!$?) {
    az login
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
$existingCredentialsJson = az ad app federated-credential list --id $applicationObjectId --query "[].subject" -o json --only-show-errors 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Could not list federated identity credentials.`n$existingCredentialsJson" -ForegroundColor Red
    exit 1
}
$existingSubjects = @($existingCredentialsJson | ConvertFrom-Json)

foreach ($repo in $Repos) {
    # pr_code_review.yml runs on pull_request, so that is the subject GitHub
    # mints. A run on a branch push carries `ref:refs/heads/<branch>` instead
    # and would need its own credential.
    $subject = "repo:$Organization/${repo}:pull_request"

    if ($existingSubjects -contains $subject) {
        Write-Host "  ✓ $repo already has a credential" -ForegroundColor Green
        continue
    }

    # Federated credential names allow alphanumerics and hyphens only.
    $credentialName = "github-$($repo -replace '[^a-zA-Z0-9-]', '-')-pull-request".ToLower()

    # az mangles embedded double quotes in inline JSON on Windows, so the
    # payload goes through a file instead of --parameters '<json>'.
    $credentialFile = Join-Path ([System.IO.Path]::GetTempPath()) "fic-$([guid]::NewGuid()).json"
    @{
        name        = $credentialName
        issuer      = $githubIssuer
        subject     = $subject
        description = "GitHub Actions OIDC for $Organization/$repo pull requests"
        audiences   = @($entraAudience)
    } | ConvertTo-Json -Depth 5 | Set-Content -Path $credentialFile -Encoding utf8

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
