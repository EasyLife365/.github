# GitHub Templates Repository

Welcome to our GitHub Templates repository! 🚀 This repository serves as a centralized location for various templates used across our GitHub repositories. Whether you're looking for issue templates, pull request templates, or any other standardized documents, you'll find them all here.

## Templates Available

Currently, we provide the following templates:
- **Issue Templates**: Standardized templates to help you report issues effectively.

## Reusable workflows

Every repository calls these rather than copying the steps, so a fix lands once.

| Workflow | Purpose |
|---|---|
| `ci_dotnet.yml` | Restore, build, and test a .NET solution. Accepts a caller-supplied `checkout-ref` for Dependabot/Renovate PRs; carries no `id-token: write` and no Azure sign-in capability by design |
| `ci_dotnet_azure.yml` | Same, plus Azure OIDC sign-in for fixtures that resolve `@Microsoft.KeyVault(...)` references. Never accepts `checkout-ref` -- for a repository's trusted (non-Dependabot) PR lane only |
| `ci_react_build.yml`, `ci_react_unit_tests.yml`, `ci_react_publish.yml`, `ci_react_storybook_tests.yml` | The React library pipeline |
| `security_gate.yml` | Secret scan, dependency advisories and dependency licence checks for .NET and npm; see "Security gate" below |
| `ci_wcag_check.yml` | Accessibility check that blocks merge in React Components |
| `spa_build.yml`, `spa_deploy.yml` | Build and deploy a single-page app |
| `release_nuget_packages.yml` | Publish NuGet packages |
| `create_maintenance_branch.yml` | Cut a maintenance branch |
| `azure-storage-sync.yml` | Sync blob storage between rings |
| **`pr_compliance.yml`** | **Deterministic pull request checks — the facts** |
| **`pr_code_review.yml`** | **The EasyLife 365 review standard, run on the pull request — the judgement** |
| **`pr_agent_review.yml`** | **Verifies a Claude review exists for the pull request — the gate** |

### Security gate

`security_gate.yml` runs a TruffleHog secret scan, a Critical/High advisory check for the .NET solution
and the yarn workspace, and a **licence check** of the same dependencies. Callers pass `dotnet-solution`
and/or `node: true`; the licence jobs run for whichever of those is set.

**The licence check reports first.** By default it only reports: findings are warnings, a summary on the
run page, and the job never fails. A caller opts in to failing with `licence-enforce: true`, and out of
the check altogether with `licence-check: false`. Existing callers need no change.

**The policy is `licence-policy/policy.json`** in this repository, and changing it is a reviewed pull
request. Every package gets one of four outcomes:

| Outcome | Meaning | Fails when enforcing |
|---|---|---|
| Allowed | Every licence that applies is on `allowed` (MIT, MIT-0, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense, CC0-1.0, MS-PL, Zlib, BlueOak-1.0.0, Python-2.0) | no |
| Needs review | A real SPDX licence on neither list (MPL-2.0, CC-BY-4.0, EPL-2.0, ...), or an npm licence guessed from a file | no, listed only |
| Unknown | No licence, a URL or file name instead of an SPDX id, `Custom: ...`, `UNLICENSED`, an expression that does not parse | no, listed and warned about |
| Forbidden | Matches `forbidden`: GPL, AGPL, LGPL, SSPL, EUPL, OSL, BUSL, CC-BY-NC, CC-BY-ND, Commons-Clause | **yes** |

**Only a forbidden licence fails the gate**, and only when a caller sets `licence-enforce: true`. An
unknown licence is accepted: it is listed in the job summary and raised as a warning so someone can
look, but it never blocks a pull request. A scan that did not run is different from an unknown
licence: a missing, unreadable or empty listing means the check checked nothing, so it warns when
reporting and fails when enforcing.

SPDX expressions are evaluated, not text-matched: `MIT OR GPL-3.0-only` is allowed (the consumer picks
MIT), `MIT AND CC-BY-4.0` needs review (both apply), and a `WITH` exception never rescues a forbidden
licence. Our own packages (`ownPackages`, matched case-sensitively: `@easylife365/*` and the published
`EL.Core.*`, `EL.Storage.*`, `EL.Cache.*`, `EL.Serialization.*`, `EL.Approvals.*`, `EL.Notification.*`,
`EL.EasyHub.*` families) are not checked.

**Excluding a reviewed package** is optional bookkeeping, not a way to get a green run: unknown licences
do not fail the gate, so nothing has to be excluded to pass. An exclusion records that someone looked
at a package, and takes it off the warning list. It goes in `.licenceignore` at the root of the caller
repository, read from its **default branch** (never from the pull request being checked, so a pull request cannot hide its own
findings; an entry takes effect once merged). One package per line, `*` is the wildcard, `name@version`
pins a single version, `#` starts a comment. Say why in the comment. Keep entries narrow:
`Microsoft.AspNetCore.*` is a decision about a family, `*` is a decision about everything. A package
that is excluded but whose current licence is forbidden still raises a warning, because a new version
can change the licence.

**Tools**, both pinned:
- [nuget-license](https://github.com/sensslen/nuget-license) 4.0.18 for .NET (the whole graph, transitive
  included), pinned by version in the workflow and installed from nuget.org only. It has no manifest
  for Dependabot to track, so bump it by hand.
- [license-checker-rseidelsohn](https://github.com/RSeidelsohn/license-checker-rseidelsohn) 5.0.1 for npm,
  pinned by `tools/licence-checker/package-lock.json` in this repository and installed with
  `npm ci --ignore-scripts`, so its own dependencies cannot drift or run a script. Dependabot tracks that
  directory. A repository with one `package.json` is listed for production dependencies only. A yarn
  workspace is listed for everything installed, development tooling included, because the tool's
  `--production` reads only the root manifest and would miss packages only the workspace apps use.

`scripts/licence-report.mjs` classifies their output and writes the report; `scripts/lib/licence-policy.test.mjs`
and `scripts/lib/licence-report.test.mjs` test it, against output trimmed from real runs.

**Accepted risk.** The check inspects the pull request's own dependency graph, and the code of a pull
request from the same repository runs before the report step in the same job (project targets during
restore, a `yarn-path` setting). An author with write access can therefore influence the verdict, in
report-only mode and when enforcing alike. The check protects against honest mistakes, an AI assistant
pulling in an incompatible dependency, and licence changes upstream; it is not a control against a hostile
author. What a pull request cannot do: edit the exclusion list (it is read from the default branch), reach
the package token from the tool and report steps (it is given to restore and install only), or change the
policy, reporter and lister lockfile, which come from this repository at the workflow's own commit. The
lister runs under Node 24 from a copy outside the scanned workspace.

### Versioning

Every caller today references these workflows at `@main` — there is no version tag yet to pin
against, and this repository has no history of ever cutting one. That is a real gap: `@main`
means every caller adopts a change to a reusable workflow the moment it merges, with no way to
stay on a known-good version while a fix is verified elsewhere first.

**The convention**: semantic version tags on the whole repository, one version line covering every
reusable workflow together rather than per-file versions, since a caller pins a commit of this
repository, not a single file in isolation.

- **`v1.2.3`** is an exact tag. It never moves once published — pin it for a frozen, reproducible
  reference.
- **`v1`** is a floating tag, moved to the newest `v1.x.x` release the moment it publishes. Pin it
  to always get the latest fix in that major line without a manual bump — the same convention
  `actions/checkout@v4` and every other third-party Action use.
- A **major** bump means a breaking change to an existing input, output, or default for an
  existing caller (removing an input, changing what a default does, renaming a secret). A
  **minor** bump adds something new and backward compatible (a new optional input, a new
  workflow file). A **patch** bump fixes a bug in existing behaviour without changing the
  interface — EasyLife365/.github#107's Test-step fix would have been a patch, had this
  convention existed when it merged.

**Cutting a release**: run the `Release` workflow (`workflow_dispatch`) with the version number
(`1.2.3`, the `v` is added for you). Use `dry_run: true` first to validate without publishing.
The actual tag/release/major-tag-move work is delegated to
[`EasyLife365/get-version-action`](https://github.com/EasyLife365/get-version-action)'s
`create-release` action rather than hand-rolled here -- this file used to duplicate that logic in
bash, which is exactly the kind of two-copies-that-drift this readme's own reusable-workflows
philosophy exists to avoid (see the table above: "Every repository calls these rather than copying
the steps, so a fix lands once" -- the same principle, one repository up). Release notes are
auto-generated from merged PR titles since the last tag — which is why a PR title must carry its
issue keyword (see the Pull request review section below): that keyword is what "What's Changed" is
built from.

**Pinning by tag is opt-in, not required yet.** No caller has been migrated off `@main` as part of
building this convention — that is a separate, later pass, once the convention itself has a real
release behind it to prove out. `pr_agent_review.yml` in particular has a standing reason to stay
unpinned regardless (see "The caller shape" below: pinning it would change whether `secrets:
inherit` is safe on the caller side).

### Pull request review

Review is three layers, and the split is deliberate.

**`pr_compliance.yml`** settles what a script can settle: the issue keyword, newly added
credential files, `react-table >= 9`, mixed `EL.*` package versions, a project missing from the
solution, test-folder placement, branch naming, and a notice on restricted paths. No model, no
token spend, no false positives — so this one is safe to make a **required check**.

**`pr_code_review.yml`** runs the `Code Reviewer` standard from `.github-private` and posts
inline comments. It is **advisory**: it never approves, never counts toward a required human
approval, and must not be a required check — an LLM finding is an opinion worth reading, and a
flaky merge gate teaches people to ignore the checks that are not flaky.

**`pr_agent_review.yml`** is the third layer and behaves unlike the other two. It does not read
the diff and forms no opinion. It answers one question: *did a Claude review happen on
this pull request?* The approver of record runs `/el-review` in their own session; that skill posts
the findings and records a marker naming the commit it reviewed, and this check looks for the
marker. One review per pull request is enough: a push after the review does not turn the check red.
When the reviewed commit is not the head, the status says so (`Reviewed by @user at fd0066f, 2
commits since`), so an approver can see how far the code has moved past the review and re-run
`/el-review` if that matters to them. A small first commit reviewed and a large change pushed
afterwards stays green; that trade-off is accepted (see `.github`#135).

Because it is a fact rather than a judgement, it is safe to require. It enforces the agent half
of the approval rule:

> One human approval plus a passing agent review on every pull request.

**`/el-review` is not `/code-review`.** Anthropic ships a built-in skill called `code-review`.
It prints findings in the terminal, posts nothing to the pull request unless given `--comment`,
and never writes the `easylife-review` marker — so it cannot clear this check. A reviewer who
runs it sees a full set of findings and reasonably believes they have reviewed the pull request,
while the pull request itself receives nothing and stays red. That is why ours carries the `el-`
prefix rather than sitting next to it as `review`.

**Who can satisfy it.** The marker is accepted only from a **review** (not a plain comment) by
someone with `OWNER`, `MEMBER` or `COLLABORATOR` standing, or with write access to the
repository. The second route is there because the check reads with `github.token`, which sees a
*private* org member as `CONTRIBUTOR`; the reviewer's repository permission does not depend on
whether their membership is public. A pull request author *may* satisfy it
on their own pull request — running `/el-review` before asking anyone to look is a good habit and
banning it would only discourage it — but the status names who posted it, so an approver sees a
self-review and can re-run it. The human approval is a separate person regardless; GitHub
enforces that.

**This is not tamper-proof, and should not be described as such.** Anyone with push access can
post the `agent-review` status directly with their own token — commit statuses carry no
per-context write protection. The ceiling is "who can push". What the marker rules buy is that
the *lazy* path is no longer the wrong path: clearing the gate without a review takes deliberate
effort rather than a copied line.

**Read the status, not the job.** The `agent-review-check` job goes green whenever it posted a
status; the answer is in the `agent-review` **status** itself. A check run is never retracted, so
once a review lands the review-triggered run adds a second check run of the same name — you will
see two `agent-review-check / Agent review` entries on a pull request that went red then green.
That is the lifecycle showing its history, not a failure. The job only fails when it could not
post a status at all.

**A green `agent-review` is not an agent sign-off.** It means a review exists for this commit,
not that the review was favourable. The findings are in the review; the human approval is the
gate.

Both compliance and the agent check are wired per repository, and every compliance check is
individually switchable, because the estate genuinely differs — Collaboration does not use the
feature-folder hierarchy, four repositories have no `.sln`, and EasyMeet 365 is on different
package versions on purpose.

#### The caller shape

Copy this. Every line that looks fussy is load-bearing, and the notes below say why.

```yaml
name: PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited]
  pull_request_review:
    types: [submitted]

concurrency:
  group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: true

jobs:
  compliance-gate:
    if: github.event_name == 'pull_request'
    permissions:
      contents: read
    uses: EasyLife365/.github/.github/workflows/pr_compliance.yml@main
    with:
      solution-file: EL.Core.sln
    secrets: inherit

  agent-review-check:
    permissions:
      contents: read
      pull-requests: read
      statuses: write
    uses: EasyLife365/.github/.github/workflows/pr_agent_review.yml@main

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

**`edited` is in the `pull_request` types on purpose.** `pr-compliance.mjs` reads the pull
request *body*, and its issue-keyword check is the one that fails most often. Without `edited`,
that failure cannot be cleared by the obvious action: editing the body fires no event, and
re-running the job does not help either — a re-run replays the *stored* event payload, so it
still sees the old body. What is left is a new commit or close-and-reopen, both worse than one
extra run.

**`pull_request_review: [submitted]` is not optional.** The agent review is posted *after* a
`pull_request`-triggered run has already finished, and posting a review does not re-fire
`pull_request`. A caller that triggers only on `pull_request` fails `agent-review` once and
never re-runs it, however many reviews follow — the pull request is then unmergeable until
someone re-runs the workflow by hand.

**No job id may equal a required check name.** A caller job that can be skipped reports a check
run under its *bare job id*, and GitHub counts a skipped check as passing. `compliance-gate`
skips on every review-triggered run, so naming it `compliance` would let anyone with read access
submit a review and shadow a **failing** `compliance / Compliance` with a passing bare
`compliance`. Hence `compliance-gate` and `agent-review-check`, not `compliance` and
`agent-review`. The required contexts stay `compliance / Compliance` and the `agent-review`
commit status.

**The guard is written in the positive form.** `if: github.event_name == 'pull_request'` rather
than `!= 'pull_request_review'`, so a trigger added later has to opt in deliberately instead of
silently inheriting a payload `pr-compliance.mjs` cannot parse.

**Dismissing a review takes it back, but only at the next run.** `agent-review` ignores dismissed reviews. Because a later push no longer retires a review, a caller that wants a dismissal to turn the status red straight away adds `dismissed` to its `pull_request_review` types; without it the status is recomputed on the next push or review.

**The concurrency group is keyed by event.** The two event types do not run the same job set — a
review run skips compliance — so sharing a group with `cancel-in-progress` lets a review
submission cancel an in-flight push run's compliance job and never replace it, leaving the
required check *cancelled*. The `run_id` fallback degrades safe: an absent pull request number
gives a group unique per run rather than a shared ref key that would cancel other pull requests.

**`agent-review-check` takes no `secrets: inherit`.** `pr_agent_review.yml` declares no secrets
and runs entirely on `github.token`. Callers reference it unpinned, so inheriting would hand a
step added there later every one of your repository's secrets with no caller-side change ever
being reviewed.

**`merge_group` is deliberately absent.** Neither reusable workflow can serve a merge group
today: `pr-compliance.mjs` exits when `event.pull_request` is absent, and `pr_agent_review.yml`
reads the pull request number from the same place. Adding the trigger ahead of that support does
not make a queue ready — it guarantees every queued pull request fails one check and waits
forever on the other. Teach both scripts to resolve the pull request from
`github.event.merge_group.head_ref` (a full ref, `refs/heads/gh-readonly-queue/main/pr-123-<sha>`)
first.

**Fork pull requests are not supported.** On a fork `pull_request` the token is read-only
regardless of the `permissions:` block, so the status POST fails and *no* status is posted —
leaving a required `agent-review` at "Expected" indefinitely. Every repository in the estate is
branch-PR-only today; do not make `agent-review` required anywhere that takes fork
contributions without fixing this first.

Prerequisites, the rules the review applies, and the rollout order are documented in
[`docs/agents/pr-review.md`](https://github.com/EasyLife365/.github-private/blob/main/docs/agents/pr-review.md).

## Scripts

| Path | Purpose |
|---|---|
| `scripts/check-wcag.mjs` | Accessibility rules for the WCAG check |
| `scripts/pr-compliance.mjs` | The deterministic pull request checks run by `pr_compliance.yml` |
| `scripts/pr-agent-review.mjs` | The agent-review check run by `pr_agent_review.yml` |