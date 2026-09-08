# Inter-service contracts

> **Status:** proposed · **Scope:** all EasyLife 365 products and microservices · **Last reviewed:** 2026-09-08

How services in the platform are allowed to talk to each other, why, and what has to change to
get there. Companion to [`../identity/`](../identity/), which covers who each service *is*; this
document covers what it may *reach*.

## The rules

Four rules. If a hop does not fit one of the first three, it is the fourth.

| When | Use | Authorised by |
|---|---|---|
| A command to one named service, and the caller wants to know it was accepted | HTTP through a published `*.Client` package, behind the caller's **own** queue for retry | Entra **app role** on the callee's internal, single-tenant app registration |
| An outcome or command to one service that must arrive even if that service is down | **Service Bus** queue, or topic with a per-product subscription filter, in the shared namespace | `Azure Service Bus Data Sender` / `Data Receiver` scoped to the **entity** |
| A fact several services care about — settings changed, licence changed | Service Bus **topic**; the event carries the data and a version, and a read endpoint exists for backfill | Sender on the topic, Receiver on each subscription |
| Anything else | **Never** read or write another service's storage account | — |

Storage queues stay, but only ever *inside* one service, for its own retry.

### And one rule for the data

- **Request-scoped data travels in the request.** A product raising an approval already knows its
  own tenant's branding, language, reply-to and approver template. Put them in the request. The
  callee then needs no replica, no subscription, and no knowledge of anyone's schema.
- **Only config needed for later, unsolicited work is replicated** — reminders and escalations that
  run days after the request. That is a much smaller set than "the settings table".
- **A replica is never the source of truth.** The owning service's read endpoint is. The topic
  exists to say "your copy is stale", not to be the only way a copy can be built.

## Where each hop stands today

| Hop | Transport today | Fits the rules |
|---|---|---|
| Identity, Mail, EasyHub → Notification | HTTP via `EL.Notification.Client`, app role `Notification.Send.All`, behind each caller's own queue | ✅ this is the reference implementation |
| EasyHub → products (subscription changed / deleted) | Service Bus topic, per-product subscription, `Product` correlation filter | ✅ needs entity-scoped roles instead of resource-group scope |
| Identity, Mail, Collab admin → EasyHub (`Subscriptions.Read`) | HTTP via `EL.EasyHub.Client`, app role | ✅ |
| Products → Approvals (raise a request) | **Storage queue write into the Approvals engine's storage account**, via `EL.Approvals.Interface` | ❌ |
| Approvals → products (deliver the outcome) | **Storage queue writes into each product's storage account**, six `ApprovalServiceSettings__OutputQueue__N` entries | ❌ |
| Approvals → products (read tenant settings) | **Direct table reads** of each product's content storage, via `EL.Core.TenantSettings` | ❌ |

Three of the four rule-breaking hops belong to Approvals. It is the last service in the platform
still reaching into other services' storage.

### Why the Approvals hops look like a client package but are not

`EL.Notification.Client` and `EL.Approvals.Interface` are both consumed as NuGet packages, so a
call site cannot tell them apart. They wrap different transports:

```csharp
// EL.Notification.Client - HTTP, app role at the callee
await notificationService.Notifications.SendAsync(request, cancellationToken);

// EL.Approvals.Interface - a storage queue in the callee's account
public class ApprovalsRequestInterfaceRepository : QueueRepository, IApprovalsRequestInterfaceRepository
```

The consequence is a permission, not a preference. An app role says *"you may submit a
notification"*. A queue role says *"you may operate this storage"*:

- `el-<ring>-eng-approvals-<node>` is created in **Collaboration's engine resource group**
  (`approvals.bicep`, `scope: resourceGroup(node.engineSubscriptionId, engineResourceGroupName)`) —
  the same group as `el-<ring>-eng-core-<node>`, which carries every Collaboration engine queue.
- Exchange's `approvalsPermissions.bicep` grants Mail's `appApi` and `cockpitApi`
  `Storage Queue Data Contributor` **at that resource group's scope**.
- That role covers `queues/messages/*` — read, add, update and **delete**.

So Mail's two APIs can dequeue and delete messages from Collaboration's provisioning, group, user,
SharePoint and onboarding queues. Nothing does, and nothing is meant to, but the grant permits it
and no code review would surface it, because the call site only says "create an approval".

A second consequence: the queue hop is unauthenticated at the message level, so
`CreateApprovalAsync(productId, ...)` takes the calling product's identity **as a parameter**.
Any holder of the queue role can claim to be any product. Moving to HTTP is the opportunity to
derive the product from the token instead.

## Target state

| Hop | Becomes |
|---|---|
| Product → Approvals | `EL.Approvals.Client`, HTTP to the existing `ApprovalRequestsController`, app role `Approvals.Request.Write`. `IApprovalsRequestInterfaceRepository` keeps its signature; only the implementation changes, so callers get it on the next package bump. Product ID is derived from the token, not the payload. |
| Approvals → product | Topic `approval-decided-<ring>` with one subscription per product and a `Product` correlation filter, reusing the convention already in `servicebus-emulator/Config.json`. `ProvisioningQueue` publishes instead of resolving an output queue. |
| Approvals → tenant settings | `GET /internal/tenants/{tenantId}/settings` on the owning product, app-role protected, returning the shared contract. `EL.Core.TenantSettings` splits: Core keeps `TenantSettingsBase` and a client; the product-specific readers move into their products. |

### Why the settings endpoint comes before the topic

If a topic is the only way a consumer can learn a tenant's settings, three situations have no
answer: **cold start** (a new region or rebuilt ring has an empty replica), **a missed message**
(the existing topics use a one-hour TTL, after which the replica is silently wrong), and **a new
consumer** (it has to replay history that no longer exists).

Build the endpoint first. It is correct on its own and it is what deletes the cross-account table
reads. Add the topic afterwards, when call volume or the staleness window justifies it.

## What this removes

Three of the platform's seven cross-product grants disappear; the rest are already the right
pattern and only need narrowing from resource-group to entity scope.

| Grant | After |
|---|---|
| Approvals engine → Mail content storage · Table Data Reader | gone — settings endpoint |
| Approvals engine → Mail engine storage · Queue Data Contributor | gone — `approval-decided` topic |
| Mail APIs → Approvals engine storage RG · Queue Data Contributor | gone — Approvals API + app role |
| Identity, Mail → shared directory storage · Account Contributor + Table W | stays; shared platform data. Drop the management-plane role, keep the account-scoped table grant |
| EasyHub, Identity, Mail, Collab admin → Service Bus namespace RG | stays; re-scope from resource group to the topics and subscriptions actually used |

It also removes six `ApprovalServiceSettings__OutputQueue__N` settings — one per approvable
resource type, each of which today adds a storage account, a queue name and a grant.

## Migrating without a flag day

Each hop moves independently, and each end is switchable on its own:

1. Approvals accepts **both** queue and HTTP submissions; callers move one at a time.
2. Approvals emits **both** the output-queue write and the topic publish, behind a setting; each
   product's outcome handler subscribes when it is ready, then the output queue entry is deleted.
3. Settings reads move from table to endpoint behind a setting, per consumer.

`SUBSCRIPTION_MODE` and the `FeatureFlags` array are the existing precedent for this kind of
switch. Once a hop is fully migrated, delete the old path *and its role assignment* in the same
release — a grant that outlives its code is the drift the identity inventory exists to catch.

## Open decisions

- **Does the approval outcome need ordering across resource types?** One topic with a product
  filter gives ordering per subscription, not across them. If Collaboration relies on the four
  output queues draining independently, four subscriptions or a queue per product is closer to
  today's behaviour.
- **How much of the settings contract does Approvals actually need?** If it is branding, language,
  reply-to and the approver template, most of it can travel in the request and the replica question
  nearly disappears.
- **Which east-west convention?** See [`improvements.md`](improvements.md#1-pick-one-east-west-network-convention) — the platform currently has two.
- **Does Approvals keep living in Collaboration's deployment?** Once it is reached only over HTTP
  and Service Bus there is no technical reason for it, and a real reason against: a service with
  its own published contract should own its own infrastructure.
- **Who speaks for Notification?** It defines app roles three products depend on but lives in no
  repository in scope. The same rules apply to it, and it needs an owner in this conversation.
