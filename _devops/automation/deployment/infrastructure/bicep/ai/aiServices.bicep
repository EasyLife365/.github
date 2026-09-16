param name string
param location string = resourceGroup().location

@description('Whether the account answers on the public endpoint (Entra ID/RBAC-gated either way). Defaults to true here, unlike EasyHub\'s ai/aiServices.bicep (which defaults to false): this account is called from GitHub-hosted Actions runners and from developer laptops, neither of which sits on an EasyLife 365 VNet, so there is no fixed set of subnets to allow instead.')
param enablePublicAccess bool = true

@description('Subnet resource IDs allowed to reach the account when enablePublicAccess is false. Each subnet must already carry the Microsoft.CognitiveServices service endpoint.')
param allowedSubnetIds array = []

var virtualNetworkRules = [
  for subnetId in allowedSubnetIds: {
    id: subnetId
    ignoreMissingVnetServiceEndpoint: true
  }
]

@description('Azure AI Foundry account (kind: AIServices) hosting the Claude model deployments, plus its Foundry project.')
resource aiServices 'Microsoft.CognitiveServices/accounts@2025-10-01-preview' = {
  name: name
  location: location
  kind: 'AIServices'
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: name
    allowProjectManagement: true
    // Kept 'Enabled' even when locked down: with 'Disabled' the account only answers on a private
    // endpoint and networkAcls are ignored. 'Enabled' + defaultAction 'Deny' is the
    // "Selected networks and private endpoints" mode, where the virtual network rules apply.
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: enablePublicAccess ? 'Allow' : 'Deny'
      bypass: 'None'
      virtualNetworkRules: enablePublicAccess ? [] : virtualNetworkRules
      ipRules: []
    }
    // Deliberate deviation from EasyHub's ai/aiServices.bicep (which leaves this false, i.e.
    // account API keys enabled). EasyLife 365's identity model is Entra ID / federated tokens
    // everywhere, never long-lived static keys — this makes that the ONLY way to authenticate to
    // this account, not just the recommended one.
    disableLocalAuth: true
  }
}

// The lightweight Foundry "project" sub-resource, not the older Microsoft.MachineLearningServices
// workspace ("Hub") that EasyHub's ai/aiHub.bicep creates. Claude deployments don't need a
// workspace/Hub; a project scoped directly under the AIServices account is the current, simpler
// Foundry shape and is what Microsoft's own Claude-on-Foundry reference template uses.
resource aiProject 'Microsoft.CognitiveServices/accounts/projects@2025-10-01-preview' = {
  parent: aiServices
  name: '${name}-proj'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {}
}

output aiServicesId string = aiServices.id
output aiServicesName string = aiServices.name
output endpoint string = aiServices.properties.endpoint
output claudeBaseUrl string = 'https://${aiServices.name}.services.ai.azure.com/anthropic'
