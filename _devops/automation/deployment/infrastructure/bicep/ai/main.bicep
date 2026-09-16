param prefix string
param location string = resourceGroup().location
param enablePublicAccess bool = true
param allowedSubnetIds array = []

@description('REQUIRED. See the legal-attestation header comment in ../main.bicep before setting these.')
param claudeOrganizationName string
param claudeCountryCode string
param claudeIndustry string

@description('Sonnet family model id to deploy. Empty = skip.')
param sonnetModel string

@description('Haiku family model id. Empty (default) = not deployed — add only if a concrete need shows up.')
param haikuModel string = ''

@description('Opus family model id. Empty (default) = not deployed — add only if a concrete need shows up.')
param opusModel string = ''

param modelVersion string = '1'
param sonnetCapacityK int = 50
param haikuCapacityK int = 25
param opusCapacityK int = 25

@description('Object id of the Entra service principal pr_code_review.yml authenticates as (the one with a federated credential trusting the GitHub Actions OIDC issuer). Empty = skip this grant.')
param ciServicePrincipalId string = ''

@description('Object id of the Entra security group of developers who may fall back to this deployment locally via az login. Empty = skip this grant. Prefer a group over individual users so onboarding/offboarding a developer never requires redeploying this template.')
param developerGroupPrincipalId string = ''

// Built-in role: Cognitive Services User. Least-privilege role documented for keyless Foundry
// inference — grants exactly the data action Claude inference needs and nothing broader. See:
// https://learn.microsoft.com/azure/foundry/foundry-models/how-to/configure-entra-id
var cognitiveServicesUserRoleDefinitionName = 'a97b65f3-24c7-4388-baec-2e87135dc908'

var aiServicesName = '${prefix}-ai'
var sonnetDeploymentName = empty(sonnetModel) ? '' : sonnetModel
var haikuDeploymentName = empty(haikuModel) ? '' : haikuModel
var opusDeploymentName = empty(opusModel) ? '' : opusModel

module aiServicesModule './aiServices.bicep' = {
  name: 'elagents-aiServices'
  params: {
    name: aiServicesName
    location: location
    enablePublicAccess: enablePublicAccess
    allowedSubnetIds: allowedSubnetIds
  }
}

// Role assignments declared before the model deployments so each deployment can dependsOn them:
// the role-assignment PUT returns in ~5s but Foundry's data-plane RBAC takes a few minutes to
// propagate, and the deployment LRO (30s-20min) absorbs that wait for free, so the first real call
// after this template finishes doesn't hit a 401 propagation-lag race.
//
// Both principals are pre-existing objects provisioned out-of-band (a service principal with a
// federated credential, a security group) rather than created by this template, so — unlike a
// principal minted moments earlier in the same deployment — there is no Azure AD replication lag
// to account for and no need to pin principalType.
module assignCiRole '../common/assignRoledefinition.bicep' = if (!empty(ciServicePrincipalId)) {
  name: 'elagents-ci-cogsvc-user-role'
  dependsOn: [aiServicesModule]
  params: {
    principalId: ciServicePrincipalId
    roleDefinitionName: cognitiveServicesUserRoleDefinitionName
  }
}

module assignDeveloperRole '../common/assignRoledefinition.bicep' = if (!empty(developerGroupPrincipalId)) {
  name: 'elagents-developer-cogsvc-user-role'
  dependsOn: [aiServicesModule]
  params: {
    principalId: developerGroupPrincipalId
    roleDefinitionName: cognitiveServicesUserRoleDefinitionName
  }
}

module sonnetDeployment './aiModelDeployment.bicep' = if (!empty(sonnetModel)) {
  name: 'elagents-aiModelDeployment-sonnet'
  dependsOn: [assignCiRole, assignDeveloperRole]
  params: {
    aiServicesName: aiServicesModule.outputs.aiServicesName
    deploymentName: sonnetDeploymentName
    modelName: sonnetModel
    modelVersion: modelVersion
    capacityK: sonnetCapacityK
    claudeOrganizationName: claudeOrganizationName
    claudeCountryCode: claudeCountryCode
    claudeIndustry: claudeIndustry
  }
}

// Foundry serializes deployments under one account; chain to avoid 409s on concurrent create.
module haikuDeployment './aiModelDeployment.bicep' = if (!empty(haikuModel)) {
  name: 'elagents-aiModelDeployment-haiku'
  dependsOn: [sonnetDeployment]
  params: {
    aiServicesName: aiServicesModule.outputs.aiServicesName
    deploymentName: haikuDeploymentName
    modelName: haikuModel
    modelVersion: modelVersion
    capacityK: haikuCapacityK
    claudeOrganizationName: claudeOrganizationName
    claudeCountryCode: claudeCountryCode
    claudeIndustry: claudeIndustry
  }
}

module opusDeployment './aiModelDeployment.bicep' = if (!empty(opusModel)) {
  name: 'elagents-aiModelDeployment-opus'
  dependsOn: [haikuDeployment]
  params: {
    aiServicesName: aiServicesModule.outputs.aiServicesName
    deploymentName: opusDeploymentName
    modelName: opusModel
    modelVersion: modelVersion
    capacityK: opusCapacityK
    claudeOrganizationName: claudeOrganizationName
    claudeCountryCode: claudeCountryCode
    claudeIndustry: claudeIndustry
  }
}

output aiServicesId string = aiServicesModule.outputs.aiServicesId
output aiServicesName string = aiServicesModule.outputs.aiServicesName
output claudeBaseUrl string = aiServicesModule.outputs.claudeBaseUrl
output sonnetDeploymentName string = sonnetDeploymentName
output haikuDeploymentName string = haikuDeploymentName
output opusDeploymentName string = opusDeploymentName
