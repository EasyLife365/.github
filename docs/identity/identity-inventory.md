# Identity inventory

> **Generated from [`identity-inventory.json`](identity-inventory.json).** Edit the JSON, not this file.

Phase 0 of the managed-identity redesign: every application, engine and microservice across the platform, 
the Azure roles its identity is granted, and the identity proposed to replace it.

- **Derived from:** Bicep templates and provision-environment.ps1 at branch claude/permission-management-queues-storage-fdhayf
- **Method:** static read of infrastructure-as-code; NOT a read of live Azure state (see scripts/identity/)
- **Managed identities per ring:** 22  
- **Role assignments per ring:** 235 (counted, not estimated)
- **Entra app-role grants per ring:** 8
- **Rings:** `d` development, `i` insiders, `p` production, `int` integration

## At a glance

| Product | Repository | Prefix | Apps | Role assignments | Prod region | Deploy scope |
|---|---|---|---:|---:|---|---|
| EasyLife 365 Collaboration | `EasyLife365-Collaboration` | `el-<ring>` | 16 | 163 | westeurope (`we`) | managementGroup |
| EasyLife 365 Identity | `EasyLife365-Identity` | `eid-<ring>` | 1 | 13 | northeurope (`ne`) | subscription |
| EasyLife 365 EasyHub | `EasyLife365-EasyHub` | `ehub-<ring>` | 1 | 12 | northeurope (`ne`) | subscription |
| EasyLife 365 Mail (Exchange) | `EasyLife365-Exchange` | `ele-<ring>` | 3 | 35 | westeurope (`we`) | subscription |
| EasyMeet 365 | `EasyMeet365` | `elt-<ring>` | 1 | 12 | northeurope (`ne`) | subscription |
| **Total** | | | **22** | **235** | | |

Every one of those identities is `SystemAssigned` today. There are no user-assigned managed identities anywhere in the platform.

## EasyLife 365 Collaboration

`EasyLife365-Collaboration` · `_devops/automation/deployment/infrastructure/bicep` · deployed at **managementGroup** scope · nodes[] (per-region)

### Applications

| App | Resource name | Kind | Source | Proposed identity |
|---|---|---|---|---|
| `collab-api-app` | `el-<ring>-api-app-<node>` | api | App/EL.App.API | `id-collab-api-<ring>` |
| `collab-api-app-shared` | `el-<ring>-api-shared-app-<node>` | api | App/EL.App.API (shared slot) | `id-collab-api-<ring>` |
| `collab-api-user` | `el-<ring>-api-user-<node>` | api | Users/EL.Users.API | `id-collab-api-<ring>` |
| `collab-api-group` | `el-<ring>-api-group-<node>` | api | Groups/EL.Groups.API | `id-collab-api-<ring>` |
| `collab-api-spo` | `el-<ring>-api-spo-<node>` | api | SharePoint/EL.SharePoint.API | `id-collab-api-<ring>` |
| `collab-api-cockpit` | `el-<ring>-api-cockpit-<node>` | api | Cockpit/EL.Cockpit.API | `id-collab-cockpit-<ring>` |
| `collab-api-cockpit-sh` | `el-<ring>-api-shared-cockpit-<node>` | api | Cockpit/EL.Cockpit.API (shared slot) | `id-collab-cockpit-<ring>` |
| `collab-eng-provisioning` | `el-<ring>-eng-provisioning-<node>` | engine | Provisioning/EL.Provisioning.Engine | `id-collab-engine-<ring>` |
| `collab-eng-spo` | `el-<ring>-eng-spo-<node>` | engine | SharePoint/EL.SharePoint.Engine | `id-collab-engine-<ring>` |
| `collab-eng-group` | `el-<ring>-eng-group-<node>` | engine | Groups/EL.Groups.Engine | `id-collab-engine-<ring>` |
| `collab-eng-user` | `el-<ring>-eng-user-<node>` | engine | Users/EL.Users.Engine | `id-collab-engine-<ring>` |
| `collab-eng-onboarding` | `el-<ring>-eng-onboarding-<node>` | engine | Core/EL.Core.Engine (onboarding) | `id-collab-engine-<ring>` |
| `approvals-api` | `el-<ring>-api-approval-<node>` | api | EasyLife-Approvals/EL.Approvals.API | `id-approvals-api-<ring>` |
| `approvals-eng` | `el-<ring>-eng-approvals-<node>` | engine | EasyLife-Approvals/EL.Approvals.Engine | `id-approvals-engine-<ring>` |
| `collab-api-admin` | `el-<ring>-api-admin-<node>` | api | Admin/EL.Admin.API | `id-collab-admin-<ring>` |
| `collab-eng-admin` | `el-<ring>-eng-admin-<node>` | engine | Admin/EL.Admin.Engine | `id-collab-admin-<ring>` |

### Grants

| Apps | Roles | Scope | Emitted by |
|---|---|---|---|
| 5 apps: `collab-api-app`, `collab-api-app-shared`, `collab-api-user`, `collab-api-group`, `collab-api-spo` | StorageAccountContributor, StorageTableDataContributor | `rg-el-<ring>-storage` | `backendservices/main.bicep#apiStoragePermissions` |
| `collab-api-cockpit`, `collab-api-cockpit-sh` | StorageAccountContributor, StorageTableDataContributor, StorageBlobDataContributor, StorageBlobDataOwner | `rg-el-<ring>-storage` | `backendservices/main.bicep#apiCockpitStoragePermissions` |
| 5 apps: `collab-eng-provisioning`, `collab-eng-spo`, `collab-eng-group`, `collab-eng-user`, `collab-eng-onboarding` | StorageAccountContributor, StorageTableDataContributor | `rg-el-<ring>-storage` | `backendservices/main.bicep#engineStoragePermissions` |
| 12 apps: `collab-eng-provisioning`, `collab-eng-spo`, `collab-eng-group`, `collab-eng-user`, `collab-eng-onboarding`, `collab-api-app`, `collab-api-app-shared`, `collab-api-user`, `collab-api-group`, `collab-api-spo`, `collab-api-cockpit`, `collab-api-cockpit-sh` | StorageAccountContributor, StorageTableDataContributor | `rg-el-<ring>-core-storage` | `backendservices/main.bicep#engineApiCoreStoragePermissions` |
| 7 apps: `collab-api-app`, `collab-api-app-shared`, `collab-api-user`, `collab-api-group`, `collab-api-spo`, `collab-api-cockpit`, `collab-api-cockpit-sh` | StorageQueueDataContributor, StorageAccountContributor | `rg-el-<ring>-<rgname>-eng-<node>` | `backendservices/main.bicep#engineApiPermissions` |
| 5 apps: `collab-eng-provisioning`, `collab-eng-spo`, `collab-eng-group`, `collab-eng-user`, `collab-eng-onboarding` | StorageQueueDataContributor, StorageAccountContributor, StorageTableDataContributor, StorageBlobDataContributor, StorageBlobDataOwner | `rg-el-<ring>-<rgname>-eng-<node>` | `backendservices/main.bicep#engineEnginePermissions` |
| 12 apps: `collab-eng-provisioning`, `collab-eng-spo`, `collab-eng-group`, `collab-eng-user`, `collab-eng-onboarding`, `collab-api-app`, `collab-api-app-shared`, `collab-api-user`, `collab-api-group`, `collab-api-spo`, `collab-api-cockpit`, `collab-api-cockpit-sh` | KeyVaultSecretsUser, KeyVaultCertificatesOfficer | `rg-el-<ring>-security` | `backendservices/main.bicep#assignKeyVaultPermissionsCore` |
| `collab-api-cockpit`, `collab-api-cockpit-sh` | KeyVaultSecretsOfficer | `rg-el-<ring>-security` | `backendservices/main.bicep#assignKeyVaultSecretsUserToCustom` |
| `approvals-eng` | StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner | `rg-el-<ring>-backup` | `backendservices/approvals.bicep#adminEngineBackupPermissions` |
| `approvals-api` | StorageAccountContributor, StorageTableDataContributor | `rg-el-<ring>-storage` | `backendservices/approvals.bicep#apiStoragePermissions` |
| `approvals-eng` | StorageAccountContributor, StorageTableDataContributor | `rg-el-<ring>-storage` | `backendservices/approvals.bicep#engineStoragePermissions` |
| `approvals-api`, `approvals-eng` | StorageAccountContributor, StorageTableDataContributor | `rg-el-<ring>-core-storage` | `backendservices/approvals.bicep#engineApiCoreStoragePermissions` |
| `approvals-api` | StorageQueueDataContributor, StorageAccountContributor | `rg-el-<ring>-<rgname>-eng-<node>` | `backendservices/approvals.bicep#engineApiPermissions` |
| `approvals-eng` | StorageQueueDataContributor, StorageAccountContributor, StorageTableDataContributor, StorageBlobDataContributor, StorageBlobDataOwner | `rg-el-<ring>-<rgname>-eng-<node>` | `backendservices/approvals.bicep#engineEnginePermissions` |
| `approvals-api`, `approvals-eng` | KeyVaultSecretsUser, KeyVaultCertificatesOfficer | `rg-el-<ring>-security` | `backendservices/approvals.bicep#assignKeyVaultPermissionsCore` |
| `collab-api-admin` | StorageAccountContributor, StorageTableDataContributor | `rg-el-<ring>-storage` | `backendservices/adminApiPermissions.bicep#adminApiStoragePermissions` |
| `collab-api-admin` | StorageAccountContributor, StorageTableDataContributor | `rg-el-<ring>-core-storage` | `backendservices/adminApiPermissions.bicep#adminApiCoreStoragePermissions` |
| `collab-api-admin` | StorageQueueDataContributor, StorageAccountContributor | `rg-el-<ring>-<rgname>-eng-<node>` | `backendservices/adminApiPermissions.bicep#adminApiEnginePermissions` |
| `collab-eng-admin` | StorageAccountContributor, StorageTableDataContributor | `rg-el-<ring>-storage` | `backendservices/adminApiPermissions.bicep#adminEngineStoragePermissions` |
| `collab-eng-admin` | StorageAccountContributor, StorageTableDataContributor | `rg-el-<ring>-core-storage` | `backendservices/adminApiPermissions.bicep#adminEngineCoreStoragePermissions` |
| `collab-eng-admin` | StorageQueueDataContributor, StorageTableDataContributor, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner | `rg-el-<ring>-<rgname>-eng-<node>` | `backendservices/adminApiPermissions.bicep#adminEnginePermissions` |
| `collab-eng-admin` | StorageTableDataContributor, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner | `rg-el-<ring>-backup` | `backendservices/adminApiPermissions.bicep#adminEngineBackupPermissions` |
| `collab-api-admin`, `collab-eng-admin` | KeyVaultSecretsUser, KeyVaultCertificatesOfficer | `rg-el-<ring>-security` | `backendservices/admin.bicep#assignKeyVaultPermissionsCore` |
| `collab-eng-admin` | ServiceBusDataReceiver | `discovered by tag (central messaging)` | `backendservices/admin.bicep#assignAdminEngineServiceBusReceiverRoles` |

### Effective roles per identity

| App | Distinct roles | Assignments |
|---|---|---:|
| `collab-api-app` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageQueueDataContributor, StorageTableDataContributor | 8 |
| `collab-api-app-shared` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageQueueDataContributor, StorageTableDataContributor | 8 |
| `collab-api-user` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageQueueDataContributor, StorageTableDataContributor | 8 |
| `collab-api-group` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageQueueDataContributor, StorageTableDataContributor | 8 |
| `collab-api-spo` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageQueueDataContributor, StorageTableDataContributor | 8 |
| `collab-api-cockpit` | KeyVaultCertificatesOfficer, KeyVaultSecretsOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner, StorageQueueDataContributor, StorageTableDataContributor | 11 |
| `collab-api-cockpit-sh` | KeyVaultCertificatesOfficer, KeyVaultSecretsOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner, StorageQueueDataContributor, StorageTableDataContributor | 11 |
| `collab-eng-provisioning` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner, StorageQueueDataContributor, StorageTableDataContributor | 11 |
| `collab-eng-spo` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner, StorageQueueDataContributor, StorageTableDataContributor | 11 |
| `collab-eng-group` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner, StorageQueueDataContributor, StorageTableDataContributor | 11 |
| `collab-eng-user` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner, StorageQueueDataContributor, StorageTableDataContributor | 11 |
| `collab-eng-onboarding` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner, StorageQueueDataContributor, StorageTableDataContributor | 11 |
| `approvals-api` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageQueueDataContributor, StorageTableDataContributor | 8 |
| `approvals-eng` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner, StorageQueueDataContributor, StorageTableDataContributor | 14 |
| `collab-api-admin` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageQueueDataContributor, StorageTableDataContributor | 8 |
| `collab-eng-admin` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, ServiceBusDataReceiver, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner, StorageQueueDataContributor, StorageTableDataContributor | 16 |

### Entra app roles (granted post-deployment by `provision-environment.ps1`)

| Apps | Application | Role | Condition |
|---|---|---|---|
| `collab-eng-admin` | EasyLife 365 Intercommunication[ Dev] | `Subscriptions.Read` | SUBSCRIPTION_MODE=Centralized |

### Notes

- EL.Approvals API and Engine are deployed by THIS repository's templates; the EasyLife-Approvals repo contains no infrastructure.
- Static Web Apps (app/cockpit/admin/onboarding clients) carry no managed identity.
- Redis cache is reached with a connection-string secret from Key Vault, not an identity.

## EasyLife 365 Identity

`EasyLife365-Identity` · `_devops/automation/infrastructure/bicep` · deployed at **subscription** scope · single backend (backend.postfix)

### Applications

| App | Resource name | Kind | Source | Proposed identity |
|---|---|---|---|---|
| `identity-eng` | `eid-<ring>-eng-api-<node>` | engine | EL.Identity.Engine (52 HTTP + queue + scheduler functions) | `id-identity-engine-<ring>` |

### Grants

| Apps | Roles | Scope | Emitted by |
|---|---|---|---|
| `identity-eng` | StorageQueueDataContributor, StorageAccountContributor, StorageBlobDataOwner, StorageBlobDataContributor, StorageTableDataContributor, KeyVaultSecretsUser, KeyVaultCertificatesOfficer | `rg-eid-<ring>-core` | `backendservices/main.bicep#assignPermissionsToEngineStorage` |
| `identity-eng` | StorageAccountContributor, StorageBlobDataOwner, StorageBlobDataContributor | `rg-eid-<ring>-backup` | `main.bicep#assignPermissionsToEngineStorage` |
| `identity-eng` | StorageAccountContributor, StorageTableDataContributor | `shared directory storage account (settings.directory.storageAccountId)` | `main.bicep#assignStorageAccountPermissions (storagePermissionsCore)` |
| `identity-eng` | ServiceBusDataReceiver | `discovered by tag (central messaging)` | `main.bicep#assignEngineServiceBusReceiverRole` |

### Effective roles per identity

| App | Distinct roles | Assignments |
|---|---|---:|
| `identity-eng` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, ServiceBusDataReceiver, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner, StorageQueueDataContributor, StorageTableDataContributor | 13 |

### Entra app roles (granted post-deployment by `provision-environment.ps1`)

| Apps | Application | Role | Condition |
|---|---|---|---|
| `identity-eng` | EasyLife 365 Notification <ring> | `Notification.Send.All` | always |
| `identity-eng` | EasyLife 365 Intercommunication[ Dev] | `Subscriptions.Read` | SUBSCRIPTION_MODE=Centralized |

### Notes

- The only product where the grant to the shared directory account is already made at ACCOUNT scope rather than resource-group scope — the pattern to copy.
- Dev ring also grants Notification.Send.All to SP_Integration_IDENTITY_D, which no deployment creates.

## EasyLife 365 EasyHub

`EasyLife365-EasyHub` · `_devops/automation/infrastructure/bicep` · deployed at **subscription** scope · single backend (backend.postfix)

### Applications

| App | Resource name | Kind | Source | Proposed identity |
|---|---|---|---|---|
| `easyhub-eng` | `ehub-<ring>-eng-api-<node>` | engine | EL.EasyHub.Engine (55 HTTP + service + scheduler functions) | `id-easyhub-engine-<ring>` |

### Grants

| Apps | Roles | Scope | Emitted by |
|---|---|---|---|
| `easyhub-eng` | StorageQueueDataContributor, StorageAccountContributor, StorageBlobDataOwner, StorageBlobDataContributor, StorageTableDataContributor, KeyVaultSecretsUser, KeyVaultCertificatesOfficer | `rg-ehub-<ring>-core` | `backendservices/main.bicep#assignPermissionsToEngineStorage` |
| `easyhub-eng` | StorageAccountContributor, StorageBlobDataOwner, StorageBlobDataContributor | `rg-ehub-<ring>-backup` | `main.bicep#assignPermissionsToEngineStorage` |
| `easyhub-eng` | ServiceBusDataSender | `discovered by tag (central messaging)` | `main.bicep#assignEngineServiceBusSenderRole` |
| `easyhub-eng` | CognitiveServicesOpenAIUser | `rg-ehub-<ring>-core` | `main.bicep#assignEngineOpenAiUserRole` |

### Effective roles per identity

| App | Distinct roles | Assignments |
|---|---|---:|
| `easyhub-eng` | CognitiveServicesOpenAIUser, KeyVaultCertificatesOfficer, KeyVaultSecretsUser, ServiceBusDataSender, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner, StorageQueueDataContributor, StorageTableDataContributor | 12 |

### Entra app roles (granted post-deployment by `provision-environment.ps1`)

| Apps | Application | Role | Condition |
|---|---|---|---|
| `easyhub-eng` | EasyLife 365 Notification <ring> | `Notification.Send.All` | always |

### Notes

- The only Service Bus SENDER in the platform: EasyHub publishes subscription changes, the products receive them.
- Also the only holder of Cognitive Services OpenAI User (AI Foundry news / feature-request / initiative assistants).
- backendservices/common/storagePermissionsCore.bicep exists here but is never invoked — dead template.

## EasyLife 365 Mail (Exchange)

`EasyLife365-Exchange` · `_devops/automation/infrastructure/bicep` · deployed at **subscription** scope · nodes[] (per-region)

### Applications

| App | Resource name | Kind | Source | Proposed identity |
|---|---|---|---|---|
| `mail-api-app` | `ele-<ring>-api-app-<node>` | api | ELE.App.API | `id-mail-api-<ring>` |
| `mail-api-cockpit` | `ele-<ring>-api-cockpit-<node>` | api | ELE.Cockpit.API | `id-mail-cockpit-<ring>` |
| `mail-eng-exo` | `ele-<ring>-eng-exo-<node>` | engine | ELE.Engine | `id-mail-engine-<ring>` |

### Grants

| Apps | Roles | Scope | Emitted by |
|---|---|---|---|
| `mail-api-app`, `mail-api-cockpit` | StorageQueueDataContributor, StorageAccountContributor | `rg-ele-<ring>-<rgname>-api-<node>` | `backendservices/main.bicep#apiPermissions` |
| `mail-api-app`, `mail-api-cockpit` | StorageAccountContributor, StorageTableDataContributor | `rg-ele-<ring>-storage` | `backendservices/main.bicep#apiStoragePermissions` |
| `mail-eng-exo` | StorageAccountContributor, StorageTableDataContributor | `rg-ele-<ring>-storage` | `backendservices/main.bicep#engineStoragePermissions` |
| `mail-eng-exo` | StorageQueueDataContributor, StorageAccountContributor, StorageTableDataContributor, StorageBlobDataContributor, StorageBlobDataOwner | `rg-ele-<ring>-<rgname>-api-<node>` | `backendservices/main.bicep#engineEnginePermissions` |
| `mail-api-app`, `mail-api-cockpit`, `mail-eng-exo` | StorageTableDataContributor, StorageAccountContributor | `shared directory storage resource group (storage.directory)` | `backendservices/main.bicep#apiEngineCorePermissions` |
| `mail-eng-exo` | StorageTableDataContributor, StorageQueueDataContributor, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner | `rg-ele-<ring>-backup` | `backendservices/main.bicep#apiEngineBackupPermissions` |
| `mail-api-app`, `mail-api-cockpit`, `mail-eng-exo` | KeyVaultSecretsUser, KeyVaultCertificatesOfficer | `rg-ele-<ring>-security` | `backendservices/main.bicep#assignKeyVaultPermissionsCore` |
| `mail-eng-exo` | ServiceBusDataReceiver | `discovered by tag (central messaging)` | `backendservices/main.bicep#assignEngineSbReceiverRole` |
| `mail-api-app`, `mail-api-cockpit` | StorageQueueDataContributor | `Approvals engine storage RG (in Collaboration's subscription)` | `backendservices/approvalsPermissions.bicep#approvalStoragePermissions` |

### Effective roles per identity

| App | Distinct roles | Assignments |
|---|---|---:|
| `mail-api-app` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageQueueDataContributor, StorageTableDataContributor | 9 |
| `mail-api-cockpit` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, StorageAccountContributor, StorageQueueDataContributor, StorageTableDataContributor | 9 |
| `mail-eng-exo` | KeyVaultCertificatesOfficer, KeyVaultSecretsUser, ServiceBusDataReceiver, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner, StorageQueueDataContributor, StorageTableDataContributor | 17 |

### Entra app roles (granted post-deployment by `provision-environment.ps1`)

| Apps | Application | Role | Condition |
|---|---|---|---|
| `mail-eng-exo`, `mail-api-cockpit` | EasyLife 365 Notification <ring> | `Notification.Send.All` | always |
| `mail-eng-exo`, `mail-api-cockpit` | EasyLife 365 Intercommunication[ Dev] | `Subscriptions.Read` | SUBSCRIPTION_MODE=Centralized |

### Notes

- Everything is prefixed ELE./ele- (EasyLife Exchange); the product is called Mail.
- Engine and APIs share one resource group per node (rg:api-node), so the engine's blob-owner grant also covers the API storage.

## EasyMeet 365

`EasyMeet365` · `_devops/automation/deployment/infrastructure/bicep` · deployed at **subscription** scope · single backend, no region postfix

### Applications

| App | Resource name | Kind | Source | Proposed identity |
|---|---|---|---|---|
| `meet-eng-api` | `elt-<ring>-eng-api` | engine+api | ELT.Api.Functions (HttpTriggers + Queues + Scheduler) | `id-meet-api-<ring>` |

### Grants

| Apps | Roles | Scope | Emitted by |
|---|---|---|---|
| `meet-eng-api` | StorageQueueDataContributor, StorageAccountContributor, StorageBlobDataOwner, StorageBlobDataContributor, StorageTableDataContributor, KeyVaultSecretsUser, KeyVaultCertificatesOfficer | `backend resource group` | `backend/main.bicep#assignPermissionsToEngineStorage` |
| `meet-eng-api` | KeyVaultSecretsUser, KeyVaultCertificatesOfficer, KeyVaultCryptoUser | `security resource group` | `core/main.bicep#assignKeyVault*` |
| `meet-eng-api` | StorageTableDataContributor | `content storage resource group` | `core/main.bicep#assignApiStorageTableDataContributeRightsToStorageAccounts` |
| `meet-eng-api` | StorageBlobDataContributor | `backup resource group` | `core/main.bicep#assignApiStorageDataBlobContributorRightsToBackupStorageAccounts` |

### Effective roles per identity

| App | Distinct roles | Assignments |
|---|---|---:|
| `meet-eng-api` | KeyVaultCertificatesOfficer, KeyVaultCryptoUser, KeyVaultSecretsUser, StorageAccountContributor, StorageBlobDataContributor, StorageBlobDataOwner, StorageQueueDataContributor, StorageTableDataContributor | 12 |

### Notes

- Only product holding Key Vault Crypto User — AesOperation encrypts shareable scheduling links.
- No Entra app-role grants and no Service Bus role: not wired into centralized subscriptions.
- Does not use @easylife365/react-auth and uses react-components v1.

## Cross-product grants

Grants that cross a product boundary. Each one is a reason the identity catalogue cannot be designed per repository in isolation.

| From | To | Roles | Emitted by |
|---|---|---|---|
| approvals-eng (Collaboration templates) | Mail content storage RG | StorageTableDataReader | `Collaboration backendservices/approvalMailPermissions.bicep#engineMailContentStoragePermissions` |
| approvals-eng (Collaboration templates) | Mail engine storage RG | StorageQueueDataContributor | `Collaboration backendservices/approvalMailPermissions.bicep#engineMailStoragePermissions` |
| mail-api-app, mail-api-cockpit | Approvals engine storage RG (Collaboration subscription) | StorageQueueDataContributor | `Exchange backendservices/approvalsPermissions.bicep#approvalStoragePermissions` |
| identity-eng | shared directory storage account | StorageAccountContributor, StorageTableDataContributor | `Identity main.bicep#assignStorageAccountPermissions` |
| mail-api-app, mail-api-cockpit, mail-eng-exo | shared directory storage RG | StorageTableDataContributor, StorageAccountContributor | `Exchange backendservices/main.bicep#apiEngineCorePermissions` |
| easyhub-eng | central Service Bus namespace | ServiceBusDataSender | `EasyHub main.bicep (publisher)` |
| identity-eng, collab-eng-admin, mail-eng-exo | central Service Bus namespace | ServiceBusDataReceiver | `per-product main.bicep (subscribers)` |

## Entra app registrations

The second identity plane. Multi-tenant registrations cannot be replaced by managed identities — managed identities are single-tenant — so customer-tenant Graph access stays here by design.

| Registration | Tenancy | Credential | Purpose | Used by | Could be a managed identity |
|---|---|---|---|---|---|
| EasyLife 365 App (EasyLifeAppAzureAD) | multi-tenant | certificate in Key Vault | customer-tenant Graph access | collaboration | no |
| EasyLife 365 Admin (EasyLifeAdminAzureAD) | multi-tenant | certificate in Key Vault | admin Graph access | collaboration | no |
| EasyLife 365 Edu (EasyLifeEduAzureAD) | multi-tenant | certificate in Key Vault | education tenant Graph access | collaboration | no |
| EasyLife 365 Cockpit / Onboarding (EasyLifeCockpitAzureAD, OnboardingAADSettings) | multi-tenant | certificate in Key Vault | cockpit + onboarding token validation | collaboration | no |
| EntraIdAppSettings / EntraIdAdminSettings | multi-tenant | certificate in Key Vault | customer-tenant Entra management | identity | no |
| EasyHubAADSettings / InterServiceAADSettings | single-tenant | certificate in Key Vault | service-to-service | easyhub, exchange | yes |
| EasyLife 365 Notification Dev/Insiders/Prod | single-tenant (internal) | n/a (resource app) | defines app role Notification.Send.All | identity, easyhub, exchange | n/a (resource app) |
| EasyLife 365 Intercommunication[ Dev] | single-tenant (internal) | n/a (resource app) | defines app role Subscriptions.Read | identity, collaboration, exchange | n/a (resource app) |
| EasyHub 365 | multi-tenant | n/a (resource app) | customer-facing EasyHub API; deliberately NOT used for internal app roles | easyhub | n/a (resource app) |
| EasyLife 365 Group/User Schema Extensions | single-tenant | certificate | directory schema extension owner | collaboration | no |
| EasyLife 365 Mail Dev | single-tenant (internal) | n/a | referenced by scripts | exchange | n/a (resource app) |

## Principals that are not workloads

| Principal | Grant | Source | Note |
|---|---|---|---|
| contributePrincipalIds (deploy service principals, OIDC-federated to GitHub) | Contributor at subscription scope | `*/contributepermissions/*.bicep and Identity main.bicep` | RBAC-write and Graph AppRoleAssignment rights are NOT granted in code — they exist out-of-band and must be read from the portal. |
| backup.backupPrincipalIds (operations) | StorageAccountContributor + BlobDataOwner + BlobDataContributor on rg:backup | `Identity and EasyHub main.bicep#assignOperationsBackupPrincipalPermissions` | human/automation principals, not workloads |
| SP_Integration_IDENTITY_D | Notification.Send.All app role | `Identity provision-environment.ps1` | federated to the repo's Integration-Dev environment; created by hand, not by any deployment |

## Roles in use

| Role | GUID | Plane |
|---|---|---|
| CognitiveServicesOpenAIUser | `5e0bd9bd-7b93-4f28-af87-19fc36ad61bd` | data |
| KeyVaultCertificatesOfficer | `a4417e6f-fecd-4de8-b567-7b0420556985` | data |
| KeyVaultCryptoUser | `12338af0-0e69-4776-bea7-57ae8d297424` | data |
| KeyVaultSecretsOfficer | `b86a8fe4-44ce-4948-aee5-eccb2c155cd7` | data |
| KeyVaultSecretsUser | `4633458b-17de-408a-b874-0445c86b69e6` | data |
| ServiceBusDataReceiver | `4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0` | data |
| ServiceBusDataSender | `69a216fc-b8fb-44d8-bc22-1f3c2cd27a39` | data |
| StorageAccountContributor | `17d1049b-9a84-46fb-8f53-869881c3d3ab` | management |
| StorageBlobDataContributor | `ba92f5b4-2d11-453d-a403-e96b0029c9fe` | data |
| StorageBlobDataOwner | `b7e6dc6d-f1e8-4753-8033-0f276bb0955b` | data |
| StorageQueueDataContributor | `974c5e8b-45b9-4653-ba55-5f855dd0fb88` | data |
| StorageTableDataContributor | `0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3` | data |
| Contributor | `b24988ac-6180-42a0-ab88-20f7382dd24c` | management |

`StorageAccountContributor` is a management-plane role and is granted to almost every identity, usually at resource-group scope. It carries `Microsoft.Storage/storageAccounts/write`, so a holder can re-enable shared-key access, rewrite network ACLs, or delete the account.

## Known gaps in this inventory

- The Notification service itself is not in any repository in scope. Its app registrations are referenced by three products, but its own identity and permissions are unenumerated.
- Whatever owns 'EasyLife 365 Group/User Schema Extensions' and 'EasyLife 365 Mail Dev' is likewise outside these repositories.
- The privilege that lets deploy pipelines CREATE role assignments is not in code — only Contributor is. Confirm in the portal which principals hold User Access Administrator / RBAC Administrator.
- Live Azure state is not covered here: orphaned assignments from recreated apps, and any hand-made grants, can only be found by running scripts/identity/Export-AzureRoleAssignments.ps1.
- The CDN storage account keeps allowSharedKeyAccess=true and allowBlobPublicAccess=true (by design); integration-environment storage does too.

## Reconciling against live Azure

```powershell
./scripts/identity/Export-AzureRoleAssignments.ps1 -OutputDirectory ./out -ManagementGroupId <mg>
./scripts/identity/Compare-IdentityInventory.ps1 -ExportPath ./out/role-assignments.json -Ring p
```
