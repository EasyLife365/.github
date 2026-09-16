param aiServicesName string

@description('Name of the model deployment (e.g. claude-sonnet-4-6).')
param deploymentName string

@description('Anthropic Claude model id to deploy. Check the Foundry portal\'s model catalog for what is actually live in the chosen region/API version at deploy time — this moves faster than this file will be kept in sync.')
param modelName string

@description('Model version string.')
param modelVersion string = '1'

@description('Deployment capacity (TPM / 1000).')
param capacityK int = 50

@description('REQUIRED. Sent to Anthropic on every deployment and used by the Cognitive Services resource provider to auto-sign the Azure Marketplace offer for Anthropic Claude on your organization\'s behalf. See the header comment in bicep/main.bicep before setting these — there are deliberately no defaults.')
param claudeOrganizationName string
param claudeCountryCode string
param claudeIndustry string

resource aiServices 'Microsoft.CognitiveServices/accounts@2025-10-01-preview' existing = {
  name: aiServicesName
}

resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-10-01-preview' = {
  parent: aiServices
  name: deploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: capacityK
  }
  properties: {
    model: {
      format: 'Anthropic'
      name: modelName
      version: modelVersion
    }
    // Required — Claude deployments fail with AnthropicOrganizationCreationException without
    // this block. `industry` must be lowercase to match the Foundry portal dropdown.
    modelProviderData: {
      organizationName: claudeOrganizationName
      countryCode: claudeCountryCode
      industry: claudeIndustry
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
    raiPolicyName: 'Microsoft.DefaultV2'
  }
}

output deploymentName string = modelDeployment.name
