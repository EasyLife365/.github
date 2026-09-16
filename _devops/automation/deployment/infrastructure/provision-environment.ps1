param ($stage = "p", $subscriptionId)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($subscriptionId)) {
    Write-Host "ERROR: -subscriptionId is required. Pass the id of the subscription to deploy the Foundry account into." -ForegroundColor Red
    exit 1
}

$output = az account show 2>&1
if (!$?) {
    az login
}

Write-Host "Processing Foundry infrastructure deployment for stage '$stage' into subscription '$subscriptionId'..." -ForegroundColor Cyan

$automationDirectory = $PSScriptRoot
$templateFile = "$automationDirectory/bicep/main.bicep"
$stageLower = $stage.ToLower()
$paramFile = "$automationDirectory/config/main.parameters-$stageLower.json"

if ($stageLower -notin @('d', 'p')) {
    Write-Host "ERROR: Unsupported stage '$stage'. Expected one of: d, p." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $paramFile)) {
    Write-Host "ERROR: Parameter file '$paramFile' was not found." -ForegroundColor Red
    exit 1
}

$deploymentParameters = Get-Content -LiteralPath $paramFile -Raw | ConvertFrom-Json

$deploymentLocation = $deploymentParameters.parameters.location.value
if ([string]::IsNullOrWhiteSpace($deploymentLocation)) {
    Write-Host "ERROR: Could not resolve deployment location from '$paramFile'." -ForegroundColor Red
    exit 1
}

# claudeOrganizationName / claudeCountryCode are deliberately left blank in the checked-in
# parameter files (see the legal-attestation header comment in bicep/main.bicep) so a real
# deployment can never silently inherit a placeholder. Fail here with a clear message rather than
# letting it fail deep inside the ai module with a less obvious Anthropic/Marketplace error.
if ([string]::IsNullOrWhiteSpace($deploymentParameters.parameters.claudeOrganizationName.value) -or
    [string]::IsNullOrWhiteSpace($deploymentParameters.parameters.claudeCountryCode.value)) {
    Write-Host "ERROR: '$paramFile' must set claudeOrganizationName and claudeCountryCode before deploying - these are sent to Anthropic and auto-sign the Azure Marketplace offer terms on your organization's behalf. See the header comment in bicep/main.bicep." -ForegroundColor Red
    exit 1
}

az account set --subscription $subscriptionId
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Could not set active subscription to '$subscriptionId'." -ForegroundColor Red
    exit 1
}

$deploymentName = "elagents_foundry_" + [guid]::NewGuid()

# az writes its warnings - the bicep upgrade notice and every linter warning - to stderr. Merging
# them into stdout puts them in front of the JSON and breaks the parse below, so stderr is kept
# separate and only replayed when the deployment actually fails.
$deploymentErrorFile = Join-Path ([System.IO.Path]::GetTempPath()) "elagents-foundry-deploy-$stageLower-$([guid]::NewGuid()).err"

try {
    $deploymentResult = az deployment sub create `
        --name "$($deploymentName)_main" `
        --subscription $subscriptionId `
        --template-file $templateFile `
        --location $deploymentLocation `
        --parameters $paramFile `
        --query properties.outputs --only-show-errors 2> $deploymentErrorFile

    if ($LASTEXITCODE -ne 0) {
        Write-Host 'ERROR: Deployment failed.' -ForegroundColor Red
        Write-Host $deploymentResult
        Get-Content -Path $deploymentErrorFile -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
        exit 1
    }

    $deploymentResult | ConvertFrom-Json
} finally {
    if (Test-Path $deploymentErrorFile) {
        Remove-Item -Path $deploymentErrorFile -Force -ErrorAction SilentlyContinue
    }
}
