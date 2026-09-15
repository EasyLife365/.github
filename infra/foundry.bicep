// ============================================================================
// Claude on Microsoft Foundry — EasyLife 365
// ----------------------------------------------------------------------------
// Provisions one Foundry account + project + Claude model deployment(s),
// serving two consumers with a single deployment:
//   1. `pr_code_review.yml` (cloud, GitHub Actions) — authenticates via a
//      federated Entra ID service principal (OIDC), never an API key.
//   2. Developers locally, as a fallback when their personal Claude
//      subscription hits its usage limit — authenticate via `az login`
//      (their own Entra identity), also never an API key.
//
// Adapted from Microsoft's own reference template:
//   https://github.com/Azure-Samples/claude (infra-bicep/infra/foundry.bicep)
// Deliberate deviations from that template, and why, are called out inline
// below. Re-check the upstream repo before reusing this after a long gap —
// Foundry's Claude catalog, region list, and API version move quickly.
//
// ----------------------------------------------------------------------------
// READ BEFORE DEPLOYING — legal attestation
// ----------------------------------------------------------------------------
// `modelProviderData` (organizationName, countryCode, industry) is sent to
// Anthropic on every deployment and used by the Cognitive Services resource
// provider to AUTO-SIGN the Azure Marketplace offer for Anthropic Claude on
// your organization's behalf — no manual click-through happens. Before you
// deploy this:
//   1. Read https://www.anthropic.com/legal/commercial-terms (the master
//      agreement — Foundry requires an Enterprise or MCA-E subscription),
//      https://www.anthropic.com/legal/aup (incorporated by reference), and
//      https://aka.ms/supported_anthropic_regions (also incorporated by
//      reference — governs which regions are actually eligible; the
//      `location` allowed-list below is this repo's best current
//      understanding, not a substitute for checking that page yourself).
//   2. Set `claudeOrganizationName`, `claudeCountryCode`, `claudeIndustry`
//      below to values that accurately describe EasyLife 365 AG — they are
//      part of your acceptance of those terms. There are deliberately no
//      defaults for these three params in this file; you must supply them
//      explicitly at deploy time.
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
//
// ----------------------------------------------------------------------------
// What this deliberately does differently from the upstream sample:
//   - `disableLocalAuth: true` on the account (upstream defaults to `false`,
//     leaving account API keys enabled). EasyLife 365's identity model is
//     Entra ID / federated tokens everywhere, never long-lived static keys
//     (see docs/agents/identities.md in .github-private) — this makes that
//     the ONLY way in, not just the recommended one.
//   - Two RBAC principals, not one: a service principal for the GitHub
//     Actions CI path and a security group for developer fallback access,
//     each with the correct `principalType` set explicitly (the upstream
//     sample hardcodes `principalType: 'User'`, which is wrong for a service
//     principal or a group and can cause the role assignment to silently
//     fail to resolve).
//   - Only `sonnet` is deployed by default. Both stated use cases (PR review,
//     developer fallback) are well served by one capable, cost-reasonable
//     model; haiku/opus stay available as params, not deployed until there's
//     a concrete reason to pay for the extra quota.
// ============================================================================

targetScope = 'subscription'

@description('Azure region. eastus2 and swedencentral currently host all three Claude families; westus2 is sonnet+opus only. Re-verify against https://aka.ms/supported_anthropic_regions before deploying — this list is this file\'s best current understanding, not a live source.')
@allowed([
  'eastus2'
  'swedencentral'
  'westus2'
])
param location string = 'swedencentral'

@description('Resource group to create for the Foundry account and project.')
param resourceGroupName string = 'rg-el-agents-foundry'

@description('Short prefix for resource names.')
param baseName string = 'el-agents-claude'

// --- Legal attestation — see the header comment above. No defaults on
// purpose: these values are sent to Anthropic and auto-sign binding terms,
// so a silent default is exactly what this file should never do. -----------
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
// Deployment name is `<model>-<suffix>`; the model id itself (e.g.
// "claude-sonnet-4-6") must match what's actually live in the Foundry
// catalog for the chosen region and API version at deploy time — check the
// Foundry portal's model catalog (or Get-ClaudeCatalog.ps1 from the
// Azure-Samples/claude repo) rather than trusting a hardcoded default here,
// since this moves faster than this file will be kept in sync.
@description('Sonnet family model id to deploy. Empty = skip.')
param sonnetModel string

@description('Haiku family model id. Empty (default) = not deployed — add only if a concrete need shows up.')
param haikuModel string = ''

@description('Opus family model id. Empty (default) = not deployed — add only if a concrete need shows up.')
param opusModel string = ''

@description('Model version string for every deployed family.')
param modelVersion string = '1'

@description('Sonnet deployment capacity (TPM / 1000). Shared by cloud PR review across 14 repos and developer fallback use — raise if you see 429s under real load; there is no way to guess the right number before that traffic exists.')
param sonnetCapacity int = 50

@description('Haiku deployment capacity (TPM / 1000). Only relevant if haikuModel is set.')
param haikuCapacity int = 25

@description('Opus deployment capacity (TPM / 1000). Only relevant if opusModel is set.')
param opusCapacity int = 25

// --- Access: two distinct principals, two distinct purposes -------------
@description('Object id of the Entra service principal that pr_code_review.yml authenticates as (the one with a federated credential trusting the GitHub Actions OIDC issuer for the relevant repo/workflow). Empty = skip this grant.')
param ciServicePrincipalId string = ''

@description('Object id of the Entra security group containing developers who should be able to fall back to this deployment locally via `az login`. Empty = skip this grant. Prefer a group over individual users so onboarding/offboarding a developer never requires redeploying this template.')
param developerGroupPrincipalId string = ''

var tags = {
  purpose: 'claude-code-review-and-dev-fallback'
  managedBy: 'bicep'
  source: 'https://github.com/EasyLife365/.github/blob/main/infra/foundry.bicep'
}
var suffix = take(uniqueString(subscription().id, resourceGroupName, baseName), 6)
var accountName = '${baseName}-${suffix}'
var projectName = '${baseName}-proj-${suffix}'

// Built-in role: `Cognitive Services User`. Least-privilege role documented
// for keyless Foundry inference — grants exactly the data action Claude
// inference needs (Claude routes through the MaaS data path) and nothing
// broader. See: https://learn.microsoft.com/azure/foundry/foundry-models/how-to/configure-entra-id
var cognitiveServicesUserRoleId = 'a97b65f3-24c7-4388-baec-2e87135dc908'

var sonnetDeploymentNameVar = empty(sonnetModel) ? '' : '${sonnetModel}-${suffix}'
var haikuDeploymentNameVar = empty(haikuModel) ? '' : '${haikuModel}-${suffix}'
var opusDeploymentNameVar = empty(opusModel) ? '' : '${opusModel}-${suffix}'

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module foundry 'foundry-account.bicep' = {
  name: 'foundry-account-deploy'
  scope: rg
  params: {
    location: location
    tags: tags
    accountName: accountName
    projectName: projectName
    suffix: suffix
    sonnetModel: sonnetModel
    haikuModel: haikuModel
    opusModel: opusModel
    sonnetDeploymentName: sonnetDeploymentNameVar
    haikuDeploymentName: haikuDeploymentNameVar
    opusDeploymentName: opusDeploymentNameVar
    sonnetCapacity: sonnetCapacity
    haikuCapacity: haikuCapacity
    opusCapacity: opusCapacity
    modelVersion: modelVersion
    claudeOrganizationName: claudeOrganizationName
    claudeCountryCode: claudeCountryCode
    claudeIndustry: claudeIndustry
    ciServicePrincipalId: ciServicePrincipalId
    developerGroupPrincipalId: developerGroupPrincipalId
    cognitiveServicesUserRoleId: cognitiveServicesUserRoleId
  }
}

// --- Outputs -----------------------------------------------------------
// Feed these into pr_code_review.yml's ANTHROPIC_FOUNDRY_BASE_URL and into
// each developer's Claude Code activator (ANTHROPIC_FOUNDRY_RESOURCE +
// ANTHROPIC_DEFAULT_SONNET_MODEL, per Microsoft's configure-claude-code
// pattern) once this deploys.
output claudeFoundryBaseUrl string = foundry.outputs.claudeBaseUrl
output foundryAccountName string = foundry.outputs.foundryAccountName
output foundryResourceGroup string = rg.name
output sonnetDeploymentName string = foundry.outputs.sonnetDeploymentName
output haikuDeploymentName string = foundry.outputs.haikuDeploymentName
output opusDeploymentName string = foundry.outputs.opusDeploymentName
