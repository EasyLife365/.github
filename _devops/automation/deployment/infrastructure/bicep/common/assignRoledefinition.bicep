param principalId string
param roleDefinitionName string

resource roleDefinition 'Microsoft.Authorization/roleDefinitions@2022-05-01-preview' existing = {
  scope: subscription()
  name: roleDefinitionName
}

resource resourceGroupRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(principalId, roleDefinition.id, resourceGroup().id)
  properties: {
    roleDefinitionId: roleDefinition.id
    principalId: principalId
  }
}
