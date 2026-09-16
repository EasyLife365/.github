targetScope = 'subscription'

param name string
param location string

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-07-01' = {
  name: name
  location: location
}
