# GitHub Templates Repository

Welcome to our GitHub Templates repository! 🚀 This repository serves as a centralized location for various templates used across our GitHub repositories. Whether you're looking for issue templates, pull request templates, or any other standardized documents, you'll find them all here.

## Templates Available

Currently, we provide the following templates:
- **Issue Templates**: Standardized templates to help you report issues effectively.

## Reusable workflows

Every repository calls these rather than copying the steps, so a fix lands once.

| Workflow | Purpose |
|---|---|
| `ci_dotnet.yml` | Restore, build, and test a .NET solution |
| `ci_react_build.yml`, `ci_react_unit_tests.yml`, `ci_react_publish.yml`, `ci_react_storybook_tests.yml` | The React library pipeline |
| `ci_wcag_check.yml` | Accessibility check that blocks merge in React Components |
| `spa_build.yml`, `spa_deploy.yml` | Build and deploy a single-page app |
| `release_nuget_packages.yml` | Publish NuGet packages |
| `create_maintenance_branch.yml` | Cut a maintenance branch |
| `azure-storage-sync.yml` | Sync blob storage between rings |
| `sync-pr-title.yml` | Rewrite a pull request title to carry its linked issues |
| **`pr_compliance.yml`** | **Deterministic pull request checks — the facts** |
| **`pr_code_review.yml`** | **The EasyLife 365 review standard, run on the pull request — the judgement** |

### Pull request review

Review is two layers, and the split is deliberate.

**`pr_compliance.yml`** settles what a script can settle: the issue keyword, newly added
credential files, `react-table >= 9`, mixed `EL.*` package versions, a project missing from the
solution, test-folder placement, branch naming, and a notice on restricted paths. No model, no
token spend, no false positives — so this one is safe to make a **required check**.

**`pr_code_review.yml`** runs the `Code Reviewer` standard from `.github-private` and posts
inline comments. It is **advisory**: it never approves, never counts toward the two required
human approvals, and must not be a required check — an LLM finding is an opinion worth reading,
and a flaky merge gate teaches people to ignore the checks that are not flaky.

Both are wired per repository, and every compliance check is individually switchable, because
the estate genuinely differs — Collaboration does not use the feature-folder hierarchy, four
repositories have no `.sln`, and EasyMeet 365 is on different package versions on purpose.

```yaml
name: PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  compliance:
    permissions:
      contents: read
    uses: EasyLife365/.github/.github/workflows/pr_compliance.yml@main
    with:
      solution-file: EL.Core.sln
    secrets: inherit

  review:
    # A called workflow cannot hold more than the calling job grants, so the review job
    # needs these even though the reusable workflow declares them. `pull-requests: write`
    # is permission to comment, not to approve.
    permissions:
      contents: read
      pull-requests: write
      issues: read
      id-token: write
    uses: EasyLife365/.github/.github/workflows/pr_code_review.yml@main
    secrets: inherit
```

Prerequisites, the rules the review applies, and the rollout order are documented in
[`docs/agents/pr-review.md`](https://github.com/EasyLife365/.github-private/blob/main/docs/agents/pr-review.md).

## Scripts

| Path | Purpose |
|---|---|
| `scripts/check-wcag.mjs` | Accessibility rules for the WCAG check |
| `scripts/pr-compliance.mjs` | The deterministic pull request checks run by `pr_compliance.yml` |