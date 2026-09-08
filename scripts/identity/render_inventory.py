#!/usr/bin/env python3
"""Render docs/identity/identity-inventory.md from identity-inventory.json.

The JSON is authoritative. This script only formats it, so the markdown in the repository
can never disagree with the dataset. Run it after every edit to the JSON:

    python3 scripts/identity/render_inventory.py

Optional arguments let it run from anywhere:

    python3 scripts/identity/render_inventory.py --json <path> --out <path> --check
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

MANAGEMENT_PLANE_ROLES = {"StorageAccountContributor", "Contributor", "MonitoringReader"}


def role_plane(role: str) -> str:
    return "management" if role in MANAGEMENT_PLANE_ROLES else "data"


def app_list(app_ids: list[str]) -> str:
    rendered = ", ".join(f"`{a}`" for a in app_ids)
    return rendered if len(app_ids) <= 4 else f"{len(app_ids)} apps: {rendered}"


def render(inv: dict) -> str:
    out: list[str] = []
    w = out.append
    d = inv["derived"]

    w("# Identity inventory\n")
    w("> **Generated from [`identity-inventory.json`](identity-inventory.json).** Edit the JSON, not this file.\n")
    w("Phase 0 of the managed-identity redesign: every application, engine and microservice across the platform, ")
    w("the Azure roles its identity is granted, and the identity proposed to replace it.\n")
    w(f"- **Derived from:** {inv['derivedFrom']}")
    w(f"- **Method:** {inv['method']}")
    w(f"- **Managed identities per ring:** {d['managedIdentitiesPerRing']}  ")
    w(f"- **Role assignments per ring:** {d['roleAssignmentRowsPerRing']} (counted, not estimated)")
    w(f"- **Entra app-role grants per ring:** {d['appRoleGrants']}")
    w("- **Rings:** " + ", ".join(f"`{r['code']}` {r['name']}" for r in inv["rings"]) + "\n")

    w("## At a glance\n")
    w("| Product | Repository | Prefix | Apps | Role assignments | Prod region | Deploy scope |")
    w("|---|---|---|---:|---:|---|---|")
    for p in inv["products"]:
        regions = ", ".join(f"{n['location']} (`{n['postfix']}`)" for n in p["productionNodes"])
        w(
            f"| {p['name']} | `{p['repo']}` | `{p['namePrefix']}` | {len(p['apps'])} | "
            f"{d['roleAssignmentRowsPerProduct'][p['key']]} | {regions} | {p['deploymentScope']} |"
        )
    w(f"| **Total** | | | **{d['managedIdentitiesPerRing']}** | **{d['roleAssignmentRowsPerRing']}** | | |\n")
    w("Every one of those identities is `SystemAssigned` today. There are no user-assigned managed identities anywhere in the platform.\n")

    for p in inv["products"]:
        w(f"## {p['name']}\n")
        w(f"`{p['repo']}` · `{p['infrastructure']}` · deployed at **{p['deploymentScope']}** scope · {p['nodeModel']}\n")

        w("### Applications\n")
        w("| App | Resource name | Kind | Source | Proposed identity |")
        w("|---|---|---|---|---|")
        for a in p["apps"]:
            w(f"| `{a['id']}` | `{a['resourceName']}` | {a['kind']} | {a['source']} | `{a['proposedIdentity']}` |")
        w("")

        w("### Grants\n")
        w("| Apps | Roles | Scope | Emitted by |")
        w("|---|---|---|---|")
        for g in p["grants"]:
            scope = p["scopes"].get(g["scope"], g["scope"])
            w(f"| {app_list(g['apps'])} | {', '.join(g['roles'])} | `{scope}` | `{g['source']}` |")
        w("")

        w("### Effective roles per identity\n")
        w("| App | Distinct roles | Assignments |")
        w("|---|---|---:|")
        for a in p["apps"]:
            roles: list[str] = []
            for g in p["grants"]:
                if a["id"] in g["apps"]:
                    roles += g["roles"]
            w(f"| `{a['id']}` | {', '.join(sorted(set(roles)))} | {len(roles)} |")
        w("")

        if p["appRoles"]:
            w("### Entra app roles (granted post-deployment by `provision-environment.ps1`)\n")
            w("| Apps | Application | Role | Condition |")
            w("|---|---|---|---|")
            for ar in p["appRoles"]:
                apps = ", ".join(f"`{x}`" for x in ar["apps"])
                w(f"| {apps} | {ar['application']} | `{ar['role']}` | {ar['condition']} |")
            w("")

        if p["notes"]:
            w("### Notes\n")
            for note in p["notes"]:
                w(f"- {note}")
            w("")

    w("## Cross-product grants\n")
    w("Grants that cross a product boundary. Each one is a reason the identity catalogue cannot be designed per repository in isolation.\n")
    w("| From | To | Roles | Emitted by |")
    w("|---|---|---|---|")
    for c in inv["crossProductGrants"]:
        w(f"| {c['source']} | {c['target']} | {', '.join(c['roles'])} | `{c['via']}` |")
    w("")

    w("## Entra app registrations\n")
    w("The second identity plane. Multi-tenant registrations cannot be replaced by managed identities — managed identities are single-tenant — so customer-tenant Graph access stays here by design.\n")
    w("| Registration | Tenancy | Credential | Purpose | Used by | Could be a managed identity |")
    w("|---|---|---|---|---|---|")
    movable = {True: "yes", False: "no", None: "n/a (resource app)"}
    for a in inv["appRegistrations"]:
        w(
            f"| {a['name']} | {a['tenancy']} | {a['credential']} | {a['purpose']} | "
            f"{', '.join(a['usedBy'])} | {movable[a['canMoveToManagedIdentity']]} |"
        )
    w("")

    w("## Principals that are not workloads\n")
    w("| Principal | Grant | Source | Note |")
    w("|---|---|---|---|")
    for n in inv["nonWorkloadPrincipals"]:
        w(f"| {n['name']} | {n['grant']} | `{n['source']}` | {n['note']} |")
    w("")

    w("## Roles in use\n")
    w("| Role | GUID | Plane |")
    w("|---|---|---|")
    for role in d["distinctRolesInUse"] + ["Contributor"]:
        w(f"| {role} | `{inv['roleDefinitions'][role]}` | {role_plane(role)} |")
    w("")
    w(
        "`StorageAccountContributor` is a management-plane role and is granted to almost every identity, "
        "usually at resource-group scope. It carries `Microsoft.Storage/storageAccounts/write`, so a holder can "
        "re-enable shared-key access, rewrite network ACLs, or delete the account.\n"
    )

    w("## Known gaps in this inventory\n")
    for gap in inv["gaps"]:
        w(f"- {gap}")
    w("")

    w("## Reconciling against live Azure\n")
    w("```powershell")
    w("./scripts/identity/Export-AzureRoleAssignments.ps1 -OutputDirectory ./out -ManagementGroupId <mg>")
    w("./scripts/identity/Compare-IdentityInventory.ps1 -ExportPath ./out/role-assignments.json -Ring p")
    w("```")

    return "\n".join(out) + "\n"


def main() -> int:
    here = pathlib.Path(__file__).resolve().parent
    docs = here.parent.parent / "docs" / "identity"

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=pathlib.Path, default=docs / "identity-inventory.json")
    parser.add_argument("--out", type=pathlib.Path, default=docs / "identity-inventory.md")
    parser.add_argument("--check", action="store_true", help="fail if the rendered output differs from --out")
    args = parser.parse_args()

    inv = json.loads(args.json.read_text(encoding="utf-8"))
    rendered = render(inv)

    if args.check:
        current = args.out.read_text(encoding="utf-8") if args.out.exists() else ""
        if current != rendered:
            print(f"{args.out} is out of date; run: python3 {pathlib.Path(__file__).name}", file=sys.stderr)
            return 1
        print(f"{args.out} is up to date.")
        return 0

    args.out.write_text(rendered, encoding="utf-8")
    print(f"Wrote {args.out} ({len(rendered.splitlines())} lines).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
