# Platform documentation

Cross-cutting architecture and platform decisions that span more than one EasyLife 365 repository.
Anything that belongs to a single product lives in that product's own `docs/`.

| Area | What is here |
|---|---|
| [`architecture/`](architecture/) | How services talk to each other, and the platform improvements backlog |
| [`identity/`](identity/) | Every managed identity in the platform, what it can reach, and the tooling to reconcile that against live Azure |

## Start here

- **"How should these two services talk?"** → [`architecture/inter-service-contracts.md`](architecture/inter-service-contracts.md)
- **"What should we fix next, and what has to be decided first?"** → [`architecture/improvements.md`](architecture/improvements.md)
- **"What can this app reach today?"** → [`identity/identity-inventory.md`](identity/identity-inventory.md)
