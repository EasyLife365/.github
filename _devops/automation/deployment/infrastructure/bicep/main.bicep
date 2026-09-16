targetScope = 'subscription'

// ============================================================================
// Claude on Microsoft Foundry — EasyLife 365
// ----------------------------------------------------------------------------
// Provisions one Foundry account + project + Claude model deployment(s) in its
// own resource group, serving two consumers from a single deployment:
//   1. `pr_code_review.yml` (cloud, GitHub Actions) — authenticates via a
//      federated Entra ID service principal (OIDC), never an API key.
//   2. Developers locally, as a fallback when their personal Claude
//      subscription hits its usage limit — authenticate via `az login`
//      (their own Entra identity), also never an API key.
//
// Structured to match this estate's usual infrastructure layout (compare
// EasyLife365-EasyHub's and EasyLife365-Collaboration's
// _devops/automation/deployment/infrastructure/): a subscription-scope
// main.bicep, a resourcegroups/ module, a common/ folder for shared
// role-assignment helpers, and a feature module (here ai/) called with
// `scope: resourceGroup(...)`. Deploy it with provision-environment.ps1 in
// this same folder, the same way every other product repo deploys its infra.
//
// Adapted from Microsoft's own reference template:
//   https://github.com/Azure-Samples/claude (infra-bicep/infra/foundry.bicep)
// and from EasyLife365-EasyHub's own ai/ folder (its aiServices.bicep /
// aiModelDeployment.bicep, deploying Azure OpenAI rather than Claude).
// Deliberate deviations from both, and why, are called out inline in
// bicep/ai/*.bicep. Re-check the upstream repo before reusing this after a
// long gap — Foundry's Claude catalog, region list, and API version move
// quickly.
//
// ----------------------------------------------------------------------------
// READ BEFORE DEPLOYING — legal attestation
// ----------------------------------------------------------------------------
// `modelProviderData` (organizationName, countryCode, industry — set below and
// threaded down to every model deployment) is sent to Anthropic on every
// deployment and used by the Cognitive Services resource provider to
// AUTO-SIGN the Azure Marketplace offer for Anthropic Claude on your
// organization's behalf — no manual click-through happens. Before you deploy
// this:
//   1. Read https://www.anthropic.com/legal/commercial-terms (the master
//      agreement — Foundry requires an Enterprise or MCA-E subscription),
//      https://www.anthropic.com/legal/aup (incorporated by reference), and
//      https://aka.ms/supported_anthropic_regions (also incorporated by
//      reference — governs which regions are actually eligible; the
//      `location` allowed-list below is this repo's best current
//      understanding, not a substitute for checking that page yourself).
//   2. Set `claudeOrganizationName`, `claudeCountryCode`, `claudeIndustry` in
//      config/main.parameters-<stage>.json to values that accurately describe
//      EasyLife 365 AG (or the correct entity/jurisdiction) — they are part of
//      your acceptance of those terms. They are deliberately left blank in the
//      checked-in parameter files, and provision-environment.ps1 refuses to
//      deploy until they're filled in.
//
// ----------------------------------------------------------------------------
// READ BEFORE DEPLOYING — EU data residency
// ----------------------------------------------------------------------------
// `swedencentral` is a genuinely supported Azure region for real Claude model
// deployments (verified against Microsoft's own sample template, which lists
// it alongside `eastus2` as hosting all three Claude families). That is a
// different question from whether Anthropic's *inference execution* for
// those deployments is guaranteed to stay within EU borders under GDPR —
// some public reporting as of this file's writing suggested Claude-on-Foundry
// inference may still route through Anthropic-managed, non-EU-native
// infrastructure even when the Azure resource itself is EU-located. If EU
// data residency is a hard compliance requirement (not just "an EU Azure
// region for the resource"), confirm the current guarantee directly against
// Anthropic's Supported Regions Policy and your Microsoft/Anthropic account
// team before relying on this deployment for that purpose.
// ============================================================================

@description('Deployment stage. There is only one: this is a single shared resource, not per-ring product infra with its own "d"/"i"/"p" traffic. Kept as a param (rather than a hardcoded "p") only so the resource-naming pattern (elagents-p-...) matches every other repo\'s stage-prefixed naming.')
@allowed([
  'p'
])
param stage string = 'p'

@description('Azure region. eastus2 and swedencentral currently host all three Claude families; westus2 is sonnet+opus only. Re-verify against https://aka.ms/supported_anthropic_regions before deploying — this list is this file\'s best current understanding, not a live source.')
@allowed([
  'eastus2'
  'swedencentral'
  'westus2'
])
param location string = 'swedencentral'

@description('The resource group to create for the Foundry account and project.')
param resourceGroups {
  core: {
    name: string
    location: string
  }
}

// --- Legal attestation — see the header comment above. No defaults on
// purpose: these values are sent to Anthropic and auto-sign binding terms, so
// a silent default is exactly what this file should never do. -------------
@description('REQUIRED. Legal entity name — must accurately describe EasyLife 365 AG (or the correct entity for your jurisdiction/subsidiary).')
param claudeOrganizationName string

@description('REQUIRED. Two-letter ISO country code your organization operates from.')
@minLength(2)
@maxLength(2)
param claudeCountryCode string

@description('REQUIRED. Lowercase, must match the Foundry portal dropdown.')
@allowed([
  'technology'
  'finance'
  'healthcare'
  'education'
  'retail'
  'manufacturing'
  'government'
  'media'
  'other'
])
param claudeIndustry string

// --- Model selection ---------------------------------------------------
// Deployment name is the model id itself (e.g. "claude-sonnet-4-6"), which
// must match what's actually live in the Foundry catalog for the chosen
// region and API version at deploy time — check the Foundry portal's model
// catalog rather than trusting a hardcoded default here, since this moves
// faster than this file will be kept in sync.
@description('Sonnet family model id to deploy. Empty = skip.')
param sonnetModel string

@description('Haiku family model id. Empty (default) = not deployed — add only if a concrete need shows up.')
param haikuModel string = ''

@description('Opus family model id. Empty (default) = not deployed — add only if a concrete need shows up.')
param opusModel string = ''

@description('Model version string for every deployed family.')
param modelVersion string = '1'

@description('Sonnet deployment capacity (TPM / 1000). Shared by cloud PR review across every repo and developer fallback use — raise if you see 429s under real load; there is no way to guess the right number before that traffic exists.')
param sonnetCapacityK int = 50

@description('Haiku deployment capacity (TPM / 1000). Only relevant if haikuModel is set.')
param haikuCapacityK int = 25

@description('Opus deployment capacity (TPM / 1000). Only relevant if opusModel is set.')
param opusCapacityK int = 25

@description('Whether the Foundry account answers on the public endpoint. See the parameter of the same name in bicep/ai/aiServices.bicep for why this defaults to true here.')
param enablePublicAccess bool = true

@description('Subnet resource IDs allowed to reach the account when enablePublicAccess is false.')
param allowedSubnetIds array = []

// --- Access: two distinct principals, two distinct purposes -------------
@description('Object id of the Entra service principal that pr_code_review.yml authenticates as (the one with a federated credential trusting the GitHub Actions OIDC issuer for the relevant repo/workflow). Empty = skip this grant.')
param ciServicePrincipalId string = ''

@description('Object id of the Entra security group containing developers who should be able to fall back to this deployment locally via `az login`. Empty = skip this grant. Prefer a group over individual users so onboarding/offboarding a developer never requires redeploying this template.')
param developerGroupPrincipalId string = ''

var prefixWithStage = 'elagents-${stage}'
var rgFoundryName = 'rg-${prefixWithStage}-${resourceGroups.core.name}'

module rgFoundryModule './resourcegroups/resourceGroup.bicep' = {
  name: 'elagents-rgFoundryModule'
  params: {
    name: rgFoundryName
    location: resourceGroups.core.location
  }
}

module aiModule './ai/main.bicep' = {
  name: 'elagents-ai-module'
  dependsOn: [rgFoundryModule]
  scope: resourceGroup(rgFoundryName)
  params: {
    prefix: prefixWithStage
    location: location
    enablePublicAccess: enablePublicAccess
    allowedSubnetIds: allowedSubnetIds
    claudeOrganizationName: claudeOrganizationName
    claudeCountryCode: claudeCountryCode
    claudeIndustry: claudeIndustry
    sonnetModel: sonnetModel
    haikuModel: haikuModel
    opusModel: opusModel
    modelVersion: modelVersion
    sonnetCapacityK: sonnetCapacityK
    haikuCapacityK: haikuCapacityK
    opusCapacityK: opusCapacityK
    ciServicePrincipalId: ciServicePrincipalId
    developerGroupPrincipalId: developerGroupPrincipalId
  }
}

// --- Outputs -----------------------------------------------------------
// Feed these into pr_code_review.yml's ANTHROPIC_FOUNDRY_BASE_URL and into
// each developer's Claude Code activator (ANTHROPIC_FOUNDRY_RESOURCE +
// ANTHROPIC_DEFAULT_SONNET_MODEL, per Microsoft's configure-claude-code
// pattern) once this deploys.
output claudeFoundryBaseUrl string = aiModule.outputs.claudeBaseUrl
output foundryAccountName string = aiModule.outputs.aiServicesName
output foundryResourceGroup string = rgFoundryName
output sonnetDeploymentName string = aiModule.outputs.sonnetDeploymentName
output haikuDeploymentName string = aiModule.outputs.haikuDeploymentName
output opusDeploymentName string = aiModule.outputs.opusDeploymentName
