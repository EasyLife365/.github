# Platform improvements backlog

> **Last reviewed:** 2026-09-08 · Companion to [`inter-service-contracts.md`](inter-service-contracts.md) and [`../identity/`](../identity/)

Everything the identity and inter-service work has surfaced, in the order it should be decided.
Group A must be settled **before** building, because the answers change the design. Group B will
bite during migration if it is not planned for. Group C is real but can follow.

Each item names the evidence, so nothing here has to be taken on trust.

---

## A. Decide before building

### 1. Pick one east-west network convention

The platform already has two, and they behave differently:

| Caller → callee | Address | How it gets through |
|---|---|---|
| Identity, Mail, EasyHub → Notification | `https://api.easylife365.cloud/notifications/` | Front Door — the callee allows the `AzureFrontDoor.Backend` service tag with an `x-azure-fdid` header check |
| Identity → EasyHub | `https://ehub-p-eng-api-ne.azurewebsites.net` | the function app's own hostname, which only works because the caller's subnet is in the callee's `ipSecurityRestrictions` |

Every function app sets `ipSecurityRestrictionsDefaultAction: 'Deny'`, so an inter-service call
reaches its target only by one of those two routes. Front Door hairpins the traffic out and back
in; the direct hostname needs a subnet allowlist maintained across regions and subscriptions,
which is what the `discoveredSubnetIds` machinery and `updateCoreAcls.bicep` exist to do.

Adding the Approvals API is the third instance, so this is the moment to choose. **The app role is
only half of an inter-service hop; the network path is the other half**, and it is the half that
fails silently in a new region.

### 2. Decide how messages are routed between regions

Outcome delivery is wired per node today — `ApprovalServiceSettings__OutputQueue__N` points at a
specific storage account in a specific node — so same-region delivery is implicit and accidental.
A shared Service Bus topic is not region-aware: an Approvals instance in West Europe would deliver
to whichever subscriber picks the message up.

Either add a region or node property to the message and filter on it alongside `Product`, or run a
topic per region. This interacts with the existing `node.slot` / `ApiOptions__Slot` sharding and
with wherever a tenant's data is required to stay, so decide it with data residency in mind rather
than as a messaging detail.

### 3. Derive the calling product from the token, not the payload

`ApprovalsRequestInterfaceRepository.CreateApprovalAsync(productId, ...)` takes the caller's own
product as a parameter, and the queue hop authenticates nothing at the message level. Any holder of
the queue role can claim to be any product.

Moving to HTTP is the chance to fix this: the app role identifies the caller, and the server sets
`ProductId` from the token. Doing it during the transport change costs nothing; doing it later is a
breaking change to a published contract.

### 4. Choose the Service Bus tier deliberately

Standard caps messages at 256 KB and offers no VNet integration or private endpoints. Premium
raises the cap to 100 MB and supports both. Every storage account and key vault in the platform is
network-restricted with `defaultAction: Deny`, so a namespace reachable from the public internet
would be the exception to an otherwise consistent posture.

This is a cost decision with a security consequence. Make it explicitly, before the topology
depends on it.

---

## B. Plan for during the migration

### 5. Measure payload sizes before choosing a transport

Storage queue messages cap at 64 KB; Service Bus Standard at 256 KB. Notification requests already
serialise a whole notification object into `TemplateParameters`, and approval payloads carry
approver lists. Measure the p99 before committing; if anything is close, use a claim-check — write
the body to blob storage and put the reference on the message.

### 6. Give every dead-letter queue an owner and a replay path

Storage queue triggers get a `-poison` queue that Functions manages. Service Bus dead-letters
instead, and nothing consumes a DLQ unless someone builds it. The existing topics already set
`DeadLetteringOnMessageExpiration: true` and `MaxDeliveryCount: 10`, so the mechanism is there —
what is missing is an alert on DLQ depth and a documented way to replay. Every new entity needs
both, or messages will die quietly.

### 7. Version the message contracts, and stop putting CLR names on the wire

`[JsonDiscriminator("EL.Approvals.Business.ApprovalResponseWebhookPayload")]` puts a namespace and
class name into the serialised payload. Renaming or moving that class breaks every in-flight
message and every consumer, and no compiler will warn anyone.

A message schema is a contract with no compile-time check, so it needs the discipline a published
API gets: a stable logical discriminator rather than a type name, an explicit `schemaVersion`,
additive-only evolution, and consumers that ignore fields they do not know.

### 8. Verify trace context survives the new transports

`ApprovalsRequestInterfaceRepository` propagates `Activity.Current?.Id` by hand into
`request.TraceParent`. HTTP clients propagate W3C trace context automatically; Service Bus needs
the `Diagnostic-Id` / `traceparent` application property to be set and read. Confirm that
`[OperationTraceRoot]` and the Core observability middleware still stitch a request end to end
after each hop changes — otherwise the migration makes debugging worse while making security
better, and only one of those is visible in a demo.

### 9. Keep Docker off the `dotnet test` path

Identity's and EasyHub's agent instructions promise that `dotnet test` needs Azurite and nothing
else. HTTP hops must stay mockable with Moq, and Service Bus must not appear in a unit-test path.
Ship a fake alongside each new client package — `EL.Core.Clients.Testing` is the precedent, and a
`.Testing` package is the Core convention for exactly this.

### 10. Make outcome handlers idempotent, and turn on duplicate detection

At-least-once delivery is what makes the design durable, so handlers have to be idempotent on
`RequestId` — which the payload already carries. This is not new risk; it is existing risk that
becomes visible when the hop is rewritten. Setting `MessageId = RequestId` also lets Service Bus
detect duplicates, which the existing topics currently disable
(`RequiresDuplicateDetection: false`).

### 11. Budget for the recovery stampede

If the Approvals API is unavailable, several products' queues retry in parallel and all hit it at
once when it returns. Exponential backoff plus per-queue concurrency limits (`batchSize`,
`maxDequeueCount`) turn a thundering herd into a drain.

### 12. Remember that a new entity has three homes

A queue or topic added in code must also be added to `servicebus-emulator/Config.json` and to the
Bicep, plus its role assignment. Missing the first fails locally; missing the second fails in the
ring. This is already documented as a trap in EasyHub's instructions, and more entities means more
chances to hit it.

---

## C. Worth doing, not blocking

### 13. Re-scope existing Service Bus roles from resource group to entity

Sender and Receiver are assigned at resource-group scope today. Both can be assigned per queue,
per topic, or per subscription, so EasyHub can hold Sender on the two topics it publishes and each
product Receiver on its own subscription — instead of send and receive across everything in the
group.

### 14. Move Approvals out of Collaboration's deployment

`EasyLife-Approvals` contains no infrastructure; its API and engine are deployed by Collaboration's
templates into Collaboration's subscriptions. Once Approvals is reached only over HTTP and Service
Bus there is no technical reason to keep that, and a good reason against it: a service with its own
published contract should own its own infrastructure, storage and identity.

### 15. Find an owner for the Notification service

It defines the `Notification.Send.All` app role that three products hold, and it lives in no
repository in scope. Its own identity and permissions are unenumerated, and the same contract rules
apply to it as to everything else here.

### 16. Give the shared directory storage an explicit owner

Identity and Mail both hold grants on a shared directory storage account. That is legitimate
shared platform data rather than one product reaching into another's store — but it has no named
owner, and both grants currently include the management-plane `Storage Account Contributor`
alongside the table role. Drop the management-plane role and record who owns the schema.

### 17. Consider Entra authentication for the Redis cache

`Caching--CacheConnectionString` is a secret in Key Vault. Azure Cache for Redis supports Entra ID
authentication, which would remove one more long-lived credential. Low urgency, same direction of
travel as everything else here.

### 18. Confirm ownership of the two accounts that still allow shared keys

Every storage account sets `allowSharedKeyAccess: false` except the CDN account and the
integration-environment accounts, which also allow public blob access. Both look deliberate — a CDN
origin needs it — but they are the only places where account keys are live, so they should have a
named owner and a rotation answer rather than being an unremarked exception.

---

## D. Tracked elsewhere

The identity work has its own phases in [`../identity/README.md`](../identity/README.md) and the
[Managed Identity Blueprint](../identity/README.md). In dependency order, the two tracks meet here:

- Every cross-product grant removed by the inter-service work is one fewer grant to model,
  migrate and re-scope in the shared-identity work. Do the Approvals hops **before** migrating
  those identities.
- Adding the `Approvals.Request.Write` app role touches the same plane the identity work is moving
  to stable, pre-provisioned identities. Do both in one pass rather than adding a grant that then
  has to be migrated.
