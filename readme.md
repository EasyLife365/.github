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
| **`pr_compliance.yml`** | **Deterministic pull request checks — the facts** |
| **`pr_code_review.yml`** | **The EasyLife 365 review standard, run on the pull request — the judgement** |
| **`pr_agent_review.yml`** | **Verifies a Claude review exists for the pull request's current head commit — the gate** |

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
the diff and forms no opinion. It answers one question: *did a Claude review happen for this
exact head commit?* The approver of record runs `/el-review` in their own session; that skill posts
the findings and records a marker naming the commit it reviewed, and this check looks for the
marker. Binding it to the head commit is the whole point — a review of an earlier commit must
not satisfy the check for code pushed afterwards, or you review once, push anything, and merge.

Because it is a fact rather than a judgement, it is safe to require. It enforces the agent half
of the approval rule:

> One human approval plus a passing agent review on every pull request.

**`/el-review` is not `/code-review`.** Anthropic ships a built-in skill called `code-review`.
It prints findings in the terminal, posts nothing to the pull request unless given `--comment`,
and never writes the `easylife-review` marker — so it cannot clear this check. A reviewer who
runs it sees a full set of findings and reasonably believes they have reviewed the pull request,
while the pull request itself receives nothing and stays red. That is why ours carries the `el-`
prefix rather than sitting next to it as `review`.

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
| `scripts/pr-agent-review.mjs` | The head-commit agent-review check run by `pr_agent_review.yml` |