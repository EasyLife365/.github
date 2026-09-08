# Platform identity inventory

Phase 0 of the managed-identity redesign: a single enumeration of every application, engine and
microservice across the EasyLife 365 platform, what its identity may reach, and which shared
identity is proposed to replace it.

Platform architecture that shapes this inventory — how services are allowed to reach each other,
and the improvements backlog — is in [`../architecture/`](../architecture/).

| File | What it is |
|---|---|
| [`identity-inventory.json`](identity-inventory.json) | The dataset. Authoritative — edit this. |
| [`identity-inventory.md`](identity-inventory.md) | Human-readable rendering of the dataset. Generated. |
| [`../../scripts/identity/`](../../scripts/identity/) | Tooling to reconcile the dataset against live Azure. |

## Why this exists

Every workload in the platform runs on a **system-assigned** managed identity, so its principal ID is
created with the app and dies with it. Role assignments are named `guid(principalId, role, scope)`,
which welds each grant to one app in one region: recreating an app invalidates every grant it held,
and adding a region re-grants everything from scratch.

Before that can change, one question has to be answerable from a single place: *what can each
workload reach today?* It currently cannot be answered from the templates alone — the grants are
spread across five repositories, several of them cross a product boundary, and one product's
microservice is deployed by another product's pipeline.

## What the dataset covers

- **22 managed identities per ring**, across five products, all `SystemAssigned`.
- **235 role assignments per ring**, counted from the templates rather than estimated.
- **8 Entra app-role grants per ring**, issued by `provision-environment.ps1` after deployment.
- Cross-product grants, Entra app registrations, and the principals that are not workloads
  (deploy service principals, operations principals, an integration-test principal).
- A `proposedIdentity` per app: the shared user-assigned identity that should hold its permissions.

## What it does not cover

It is a static read of infrastructure-as-code, not of Azure. It therefore cannot see orphaned
assignments left behind by recreated apps, or grants made by hand. Run the scripts for that:

```powershell
# 1. what Azure actually holds, with orphans flagged
./scripts/identity/Export-AzureRoleAssignments.ps1 -OutputDirectory ./out -ManagementGroupId <mg>

# 2. how that differs from this dataset
./scripts/identity/Compare-IdentityInventory.ps1 -ExportPath ./out/role-assignments.json -Ring p
```

Two further gaps are named in the dataset's `gaps` array and worth repeating here:

- **The Notification service is not in any repository in scope.** Three products hold its
  `Notification.Send.All` app role, but its own identity and permissions are unenumerated.
- **The privilege that lets deploy pipelines create role assignments is not in code.** The templates
  grant those principals `Contributor`, which cannot write role assignments — so the rights that make
  the current model work were granted out-of-band and can only be confirmed in the portal.

## Regenerating the markdown

`identity-inventory.md` is derived from the JSON. After editing the dataset, re-render it:

```bash
python3 scripts/identity/render_inventory.py            # rewrite the markdown
python3 scripts/identity/render_inventory.py --check    # fail if it is out of date (for CI)
```
