// Foundry account + project + per-family Claude deployments + RBAC for two
// distinct principal kinds. Called by foundry.bicep at resource-group scope.
// See the header comment in foundry.bicep for the legal-attestation and
// EU-residency notes before deploying — they aren't repeated here.

param location string
param tags object
param accountName string
param projectName string
param suffix string

param sonnetModel string
param haikuModel string
param opusModel string
param sonnetDeploymentName string
param haikuDeploymentName string
param opusDeploymentName string
param sonnetCapacity int
param haikuCapacity int
param opusCapacity int
param modelVersion string

param claudeOrganizationName string
param claudeCountryCode string
param claudeIndustry string

param ciServicePrincipalId string
param developerGroupPrincipalId string
param cognitiveServicesUserRoleId string

var ciRbacEnabled = !empty(ciServicePrincipalId)
var developerRbacEnabled = !empty(developerGroupPrincipalId)

resource account 'Microsoft.CognitiveServices/accounts@2025-10-01-preview' = {
  name: accountName
  location: location
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: accountName
    allowProjectManagement: true
    publicNetworkAccess: 'Enabled'
    // Deliberate deviation from the upstream sample (which leaves this
    // false, i.e. API keys enabled). EasyLife 365 uses Entra ID / federated
    // tokens exclusively for automation identities — this makes that the
    // only way to authenticate to this account, not just the recommended
    // one. If a genuine break-glass need for an API key ever comes up,
    // flip this deliberately and narrowly, not as a blanket default.
    disableLocalAuth: true
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-10-01-preview' = {
  parent: account
  name: projectName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {}
}

// Role assignments declared before the model deployments so each deployment
// can dependsOn them: the role-assignment PUT returns in ~5s but Foundry's
// data-plane RBAC takes a few minutes to propagate, and the deployment LRO
// (30s-20min) absorbs that wait for free, so the first real call after this
// template finishes doesn't hit a 401 propagation-lag race.
//
// principalType is set explicitly per principal kind — the upstream sample
// hardcodes 'User', which is wrong here: ciServicePrincipalId names a
// service principal, developerGroupPrincipalId names a security group.
resource ciRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (ciRbacEnabled) {
  name: guid(account.id, ciServicePrincipalId, cognitiveServicesUserRoleId, 'ci')
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRoleId)
    principalId: ciServicePrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource developerRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (developerRbacEnabled) {
  name: guid(account.id, developerGroupPrincipalId, cognitiveServicesUserRoleId, 'developers')
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRoleId)
    principalId: developerGroupPrincipalId
    principalType: 'Group'
  }
}

resource sonnetDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-10-01-preview' = if (!empty(sonnetModel)) {
  parent: account
  name: sonnetDeploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: sonnetCapacity
  }
  properties: {
    model: {
      format: 'Anthropic'
      name: sonnetModel
      version: modelVersion
    }
    // Required — Claude deployments fail with AnthropicOrganizationCreationException
    // without this block. `industry` must be lowercase to match the Foundry
    // portal dropdown. See the legal-attestation note in foundry.bicep.
    modelProviderData: {
      organizationName: claudeOrganizationName
      countryCode: claudeCountryCode
      industry: claudeIndustry
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
    raiPolicyName: 'Microsoft.DefaultV2'
  }
  dependsOn: [
    project
    ciRoleAssignment
    developerRoleAssignment
  ]
}

resource haikuDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-10-01-preview' = if (!empty(haikuModel)) {
  parent: account
  name: haikuDeploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: haikuCapacity
  }
  properties: {
    model: {
      format: 'Anthropic'
      name: haikuModel
      version: modelVersion
    }
    modelProviderData: {
      organizationName: claudeOrganizationName
      countryCode: claudeCountryCode
      industry: claudeIndustry
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
    raiPolicyName: 'Microsoft.DefaultV2'
  }
  // Foundry serializes deployments under one account; chain to avoid 409s
  // on concurrent create.
  dependsOn: [
    project
    sonnetDeployment
    ciRoleAssignment
    developerRoleAssignment
  ]
}

resource opusDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-10-01-preview' = if (!empty(opusModel)) {
  parent: account
  name: opusDeploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: opusCapacity
  }
  properties: {
    model: {
      format: 'Anthropic'
      name: opusModel
      version: modelVersion
    }
    modelProviderData: {
      organizationName: claudeOrganizationName
      countryCode: claudeCountryCode
      industry: claudeIndustry
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
    raiPolicyName: 'Microsoft.DefaultV2'
  }
  dependsOn: [
    project
    haikuDeployment
    ciRoleAssignment
    developerRoleAssignment
  ]
}

output claudeBaseUrl string = 'https://${account.name}.services.ai.azure.com/anthropic'
output foundryAccountName string = account.name
output sonnetDeploymentName string = sonnetDeploymentName
output haikuDeploymentName string = haikuDeploymentName
output opusDeploymentName string = opusDeploymentName
