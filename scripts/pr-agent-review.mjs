#!/usr/bin/env node
// EasyLife 365 agent-review check.
//
// Verifies that a Claude review exists FOR THIS PULL REQUEST, posted as a REVIEW by
// someone with write standing. It does not read the
// review, judge it, or care what it found -- the judgement lives in the review itself, posted
// by the /el-review skill in the approver's own session. This only answers "did one happen".
//
// The approval rule it enforces one half of:
//
//     One human approval plus a passing agent review on every pull request.
//
// One review per pull request is enough. The marker names the commit that was reviewed, but the
// check does not require it to be the head: a push after the review does not turn the status red
// and does not force another review. What it does instead is say so -- the status names the
// reviewed commit and how many commits came after it, so an approver can see how far the code has
// moved past the review and re-run /el-review if that matters to them.
//
// The weak spot is accepted on purpose (EasyLife365/.github#135): review a small first commit, push
// a large change, and the status stays green. The transparency note makes that visible; nothing
// blocks it.
//
// WHAT THIS SCRIPT'S EXIT CODE MEANS
//
// It reports whether the CHECK RAN, not what the check FOUND. Those are different questions and
// conflating them is a bug this script used to have.
//
// The finding lives in the commit status: red when the pull request has no trusted review marker,
// green when it has one. The status is the required context, so the gate is unaffected by the exit code.
//
// Exiting non-zero on "no review yet" made the job itself red -- and a check run is never
// retracted, so the later review-triggered run added a SECOND check run of the same name while
// the first stayed red forever. Every pull request ended up displaying a permanently failing
// check beside an identically named passing one, which is misleading in the one place people
// look to decide whether a pull request is healthy.
//
// So: exit 0 whenever the status was posted, whatever it says. Exit non-zero only when the
// script could not do its job -- missing configuration, an unreachable API, a status that would
// not post.
//
// It posts an explicit commit status rather than relying on the workflow's own check run.
// A run triggered by pull_request_review does not reliably attach its check to the pull
// request's head SHA, so a required check that depended on that association would pass or
// fail against the wrong commit. An explicit status names the SHA and removes the question.
//
// Configuration arrives as environment variables from .github/workflows/pr_agent_review.yml.
//
// MERGE QUEUE
//
// A merge_group event carries no `pull_request` at all -- GitHub's own schema for the payload
// has no such field -- so github.event.pull_request.number is empty and INPUT_PR_NUMBER arrives
// blank. The pull request number is recoverable from the queue's own temporary branch name
// instead: github.event.merge_group.head_ref looks like
// "refs/heads/gh-readonly-queue/main/pr-123-<sha>". PR_NUMBER_IN_REF below extracts it.
//
// Once resolved, the review lookup itself is unchanged: it reads the markers on the PR's own
// reviews and compares the reviewed commit with the PR's real head commit (pull.head.sha, fetched
// by number) only to describe how far the head has moved. What changes is where the ANSWER gets
// posted: a merge queue evaluates required checks against the merge group's own temporary commit, not the PR's head commit --
// GitHub's own docs describe GITHUB_SHA as "SHA of the merge group" for this event -- so
// postStatus targets GITHUB_SHA instead of the PR's head commit specifically when this run was
// triggered by merge_group. For every other trigger this is a no-op: GITHUB_EVENT_NAME is not
// 'merge_group', so the PR's own head commit is used exactly as before.
const PR_NUMBER_IN_REF = /\/pr-(\d+)-[0-9a-f]+$/;

import { appendFileSync } from 'node:fs';
import { isDependencyOnlyChange, commitsAreTrusted, COMMITS_CAP } from './lib/dependency-only.mjs';

const env = process.env;

const cfg = {
  token: env.GITHUB_TOKEN,
  repository: env.GITHUB_REPOSITORY,
  apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
  prNumber: (env.INPUT_PR_NUMBER || '').trim(),
  mergeGroupHeadRef: (env.INPUT_MERGE_GROUP_HEAD_REF || '').trim(),
  statusContext: (env.INPUT_STATUS_CONTEXT || 'agent-review').trim(),
  exemptAuthors: (env.INPUT_EXEMPT_AUTHORS || 'dependabot[bot],renovate[bot]')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};

if (!cfg.prNumber && cfg.mergeGroupHeadRef) {
  const match = PR_NUMBER_IN_REF.exec(cfg.mergeGroupHeadRef);
  if (match) {
    cfg.prNumber = match[1];
  } else {
    console.error(
      `::error::Could not extract a pull request number from merge_group.head_ref ` +
        `"${cfg.mergeGroupHeadRef}". Expected it to end in "/pr-<number>-<sha>" -- if GitHub has ` +
        `changed this format, PR_NUMBER_IN_REF above needs updating.`,
    );
    process.exit(1);
  }
}

// The commit the merge queue actually evaluates required checks against. Empty for every
// trigger except merge_group, in which case it's the merge group's own temporary commit -- see
// the comment above.
const mergeGroupSha = env.GITHUB_EVENT_NAME === 'merge_group' ? (env.GITHUB_SHA || '').trim() : '';

if (!cfg.token || !cfg.repository || !cfg.prNumber) {
  console.error('::error::GITHUB_TOKEN, GITHUB_REPOSITORY and a resolvable PR number are all required.');
  process.exit(1);
}

const [owner, repo] = cfg.repository.split('/');

async function api(path) {
  const response = await fetch(`${cfg.apiUrl}${path}`, {
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/**
 * Follows pagination. Both endpoints return oldest first, so on a pull request with more than
 * one page the newest review is on the LAST page. Reading only the first would report "no review"
 * on exactly the busy pull requests where one is most likely to exist.
 */
async function apiAll(path, maxPages = 10) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await api(`${path}?per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

/**
 * Posts the commit status. Failing to post is itself a hard failure: a check that silently
 * does not report is indistinguishable from one that passed, and it would be required.
 */
async function postStatus(sha, state, description) {
  const response = await fetch(`${cfg.apiUrl}/repos/${owner}/${repo}/statuses/${sha}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    // GitHub truncates a description past 140 characters.
    body: JSON.stringify({ state, context: cfg.statusContext, description: description.slice(0, 140) }),
  });
  if (!response.ok) {
    console.error(`::error::Could not post the commit status: ${response.status} ${await response.text()}`);
    process.exit(1);
  }
  writeJobSummary(sha, state, description);
}


// Puts the check's ANSWER on the run page, not just the fact that it ran.
//
// This job goes green whenever it managed to post a status, whatever that status says -- which is
// deliberate, and the reason is at the top of this file. The cost is that the Checks list shows a
// green "Agent review" beside a red `agent-review` status, and those two mean different things.
// Someone reading the Checks tab to judge whether a pull request is healthy can reasonably take
// the green tick as the answer. That has already happened to a careful reader.
//
// The job summary is one click from the tick, so putting the verdict there closes the gap without
// touching the exit-code behaviour that the duplicate-check-run problem depends on.
function writeJobSummary(sha, state, description) {
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const verdict = state === 'success' ? 'PASS' : 'FAIL';
  const body = [
    `### \`${cfg.statusContext}\`: ${verdict}`,
    '',
    description,
    '',
    `Commit status \`${cfg.statusContext}\` is \`${state}\` on \`${sha}\`.`,
    '',
    '> This job is green whenever it succeeded in posting that status. The line above is the',
    "> check's answer; this job's own colour is not.",
    '',
  ].join('\n');

  try {
    appendFileSync(summaryPath, body + '\n');
  } catch (error) {
    // Never fail the job over a summary. The status is the contract; this is presentation.
    console.warn(`::warning::Could not write the job summary: ${error.message}`);
  }
}

/** `<!-- easylife-review sha=<sha> model=<id> effort=<level> findings=<n> -->` */
const MARKER = /<!--\s*easylife-review\s+([^>]*?)-->/g;

function markersIn(text) {
  if (!text) return [];
  const found = [];
  for (const match of text.matchAll(MARKER)) {
    const fields = {};
    for (const pair of match[1].trim().split(/\s+/)) {
      const index = pair.indexOf('=');
      if (index > 0) fields[pair.slice(0, index)] = pair.slice(index + 1);
    }
    found.push(fields);
  }
  return found;
}

const pull = await api(`/repos/${owner}/${repo}/pulls/${cfg.prNumber}`);
const headSha = pull.head.sha;
const author = (pull.user?.login || '').toLowerCase();

// Where the status is POSTED, as distinct from headSha (the pull request's real head, which the
// reviewed commit is compared with below). Identical to headSha outside a merge queue -- see the
// merge-queue comment near the top of this file.
const statusSha = mergeGroupSha || headSha;

// Drafts are not reviewed, so requiring a review of one would block work that is not asking
// to merge. The check reports success rather than skipping: a required check that never
// reports leaves the pull request stuck in "Expected" forever.
if (pull.draft) {
  await postStatus(statusSha, 'success', 'Draft - agent review not required yet');
  console.log('Draft pull request; agent review not required.');
  process.exit(0);
}

// Bump and dependency pull requests are exempt by design -- CI proves them, and a review of a
// version-number diff is spend with nothing to find.
//
// The exemption is by author AND by content AND by provenance (EasyLife365/.github#146). The author
// never changes when someone with write access pushes more commits to a dependabot/* branch, so on
// its own it would let a human ship arbitrary code under a bot's name with no review. So ALL of these
// must hold, or the normal review runs:
//   1. the files are only dependency manifests/lockfiles and paired `uses:` ref bumps in workflows;
//   2. the first commit is a bot commit committed by GitHub itself (web-flow, valid signature, bot
//      author), every commit is such a commit or the pin workflow app's commit touching only
//      package.json / yarn.lock / package-lock.json, and the last commit is the head. Route (a)
//      therefore TRUSTS GITHUB'S web-flow SIGNATURE: author alone is just an email anyone can set;
//      (RESIDUAL for the app commits: that identity is matched by name and email and is unsigned, so it is forgeable by
//      anyone who can push; the manifest-only file rule bounds it, and the follow-up is a signed commit);
//   3. the head did not move while this was being checked.
// Anything unreadable, truncated or failing falls through to review -- fail closed.
//
// WHAT REMAINS TRUSTED once the above holds: package.json scripts, lockfile resolved URLs and the
// contents of .csproj / .props / global.json are trusted IN FULL. This check judges which files
// changed and who committed them, not what a bot-authored manifest change does at install or build.
// See scripts/lib/dependency-only.mjs.
if (cfg.exemptAuthors.includes(author)) {
  let verdict;
  try {
    // The files API lists at most 3000 files, 100 per page; the commits API at most 250.
    const files = await apiAll(`/repos/${owner}/${repo}/pulls/${cfg.prNumber}/files`, 30);
    const commits = await apiAll(`/repos/${owner}/${repo}/pulls/${cfg.prNumber}/commits`, Math.ceil(COMMITS_CAP / 100));
    verdict = isDependencyOnlyChange(files);
    if (verdict.dependencyOnly && !commitsAreTrusted(commits, files, cfg.exemptAuthors, headSha)) {
      verdict = { dependencyOnly: false, offending: '(a commit that is not a verified bot commit)' };
    }
    if (verdict.dependencyOnly) {
      // Guard against a push between the reads above and the status below.
      const again = await api(`/repos/${owner}/${repo}/pulls/${cfg.prNumber}`);
      if (again.head.sha !== headSha) {
        verdict = { dependencyOnly: false, offending: '(the head moved while checking)' };
      }
    }
  } catch (error) {
    verdict = { dependencyOnly: false, offending: `(lookup failed: ${error.message})` };
  }
  if (verdict.dependencyOnly) {
    await postStatus(statusSha, 'success', `Exempt author (${author}): dependency files only`);
    console.log(`Author ${author} is exempt from agent review: the pull request changes dependency files only.`);
    process.exit(0);
  }
  console.log(`Author ${author} is exempt-listed but the pull request changes ${verdict.offending}; reviewing normally.`);
}

// WHO IS ALLOWED TO SATISFY THIS CHECK
//
// Reviews only, and only from someone with write standing. Both restrictions exist because the
// marker used to be accepted from any source by any author: pasting one line into an ordinary
// pull request comment turned the check green with no review behind it.
//
// Issue comments are no longer read. That closes the trivial path, and it also settles a real
// inconsistency -- the script accepted a delivery mechanism no caller observed, because a plain
// comment raises `issue_comment`, which is not a trigger. Accepting only reviews makes what the
// script reads and what the callers watch the same set.
//
// WHAT THIS DOES NOT DO, stated plainly so nobody mistakes it for enforcement: anyone with push
// access can post this commit status directly with their own token. Commit statuses carry no
// per-context write protection, unlike a GitHub App's check runs. So the ceiling here is "who
// can push", and no marker rule raises it. What these rules buy is that the LAZY path is no
// longer the wrong path -- clearing the gate without a review now takes deliberate effort
// rather than a copied line.
//
// A pull request author MAY satisfy this on their own pull request. Running /el-review before
// asking anyone to look is a good habit and banning it would only discourage it. Instead the
// status names who posted the marker, so a human approver can see it was self-run and decide
// whether to re-run it. Transparency rather than prohibition -- and the approval itself is a
// separate person either way, which GitHub enforces.
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// author_association is NOT a reliable statement of standing when read with github.token. The
// token is an app installation, not an org member, so GitHub reports a PRIVATE org member as
// CONTRIBUTOR (or NONE) to it, even when that person is an org admin. Their review then looked
// untrusted and the check stayed red however many times /el-review ran.
//
// The repository permission does not have that blind spot: it is a property of the repository,
// not of who may see someone's membership. So an untrusted association is not the end of the
// question for a review that carries a marker -- the reviewer's own permission on this repository
// is asked, and write or above counts, which is what "OWNER, MEMBER or COLLABORATOR" was standing
// in for.
//
// Fails closed: a 404 (not a collaborator), a 403 or any other error leaves the
// review untrusted, and the warning below says so. Only reviews that carry a marker are looked up,
// and once per login, so a pull request nobody has reviewed costs no extra calls.
// `permission` is the legacy field: admin, write, read or none, with maintain folded into write
// and triage into read. Unlike `role_name` it stays meaningful for a custom repository role.
const WRITE_PERMISSIONS = new Set(['admin', 'write']);
const permissionCache = new Map();

async function hasWriteAccess(login) {
  if (!login) return false;
  if (!permissionCache.has(login)) {
    let result = false;
    try {
      const response = await fetch(
        `${cfg.apiUrl}/repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
        {
          headers: {
            authorization: `Bearer ${cfg.token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
          },
        },
      );
      if (response.ok) {
        const body = await response.json();
        result = WRITE_PERMISSIONS.has(body.permission);
      } else if (response.status !== 404) {
        console.warn(`::warning::Could not read the repository permission of @${login}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`::warning::Could not read the repository permission of @${login}: ${error.message}`);
    }
    permissionCache.set(login, result);
  }
  return permissionCache.get(login);
}

const reviews = await apiAll(`/repos/${owner}/${repo}/pulls/${cfg.prNumber}/reviews`);

// Kept separately so an untrusted marker can be reported rather than silently ignored. Someone
// who ran /el-review without write standing did the work and deserves to be told why it did
// not count.
const untrusted = [];

const all = [];
for (const review of reviews) {
  // A dismissed review is GitHub's way of saying "this no longer counts". The reviews list still
  // returns it, and now that a push no longer retires a review, dismissing it is the one way left
  // to take it back.
  if (review.state === 'DISMISSED') continue;
  const entry = {
    body: review.body,
    at: review.submitted_at,
    by: review.user?.login,
    association: review.author_association,
    // The commit GitHub recorded the review against. It is set by the server when the review is
    // submitted, so it is used instead of the marker's own `sha` for everything below: the
    // marker text is free-form, this is not, and it can never name a commit pushed after the
    // review.
    sha: review.commit_id,
  };
  if (TRUSTED_ASSOCIATIONS.has(review.author_association)) {
    all.push(entry);
    continue;
  }
  const hasMarker = MARKER.test(review.body || '');
  MARKER.lastIndex = 0;
  if (!hasMarker) continue;
  // Only a person is looked up. An app's bot login is never trusted by this route, so that does
  // not depend on how the permission endpoint treats one.
  if (review.user?.type === 'User' && (await hasWriteAccess(entry.by))) all.push(entry);
  else untrusted.push(entry);
}

// Every trusted marker counts, whatever commit its review was recorded against. The one for the
// head commit wins when there is one, so a re-review of the head reports its own model and finding
// count; otherwise the most recent marker is the one described.
//
// A marker still has to carry a `sha` field to be well formed, but the value is not used: the
// review's own commit_id replaces it (the review's fields come last in the spread).
const markers = [];
for (const item of all) {
  for (const marker of markersIn(item.body)) {
    if (!marker.sha) continue;
    markers.push({ ...marker, ...item });
  }
}

if (markers.length > 0) {
  markers.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const best = markers.find((marker) => marker.sha === headSha) || markers[0];
  const detail = [best.model && `model ${best.model}`, best.effort && `effort ${best.effort}`,
    best.findings !== undefined && `${best.findings} finding(s)`].filter(Boolean).join(', ');

  // Naming the reviewer is the point of allowing self-review: an approver can see who ran it.
  const who = best.by ? ` by @${best.by}` : '';

  // How far the head has moved past the reviewed commit. Never a reason to fail: a comparison
  // that cannot be made (the commit is gone after a force-push, or the API is unavailable) is
  // reported as unknown rather than as a failure.
  let since = '';
  if (best.sha !== headSha) {
    let count = null;
    try {
      // Only a linear history gives a meaningful count. A reviewed commit that is no longer an
      // ancestor of the head (a force-push or rebase) compares as diverged or behind, and its
      // ahead_by would understate the change, so that case is reported as unknown.
      if (!/^[0-9a-f]{40}$/i.test(String(best.sha))) throw new Error('the review has no usable commit id');
      const comparison = await api(`/repos/${owner}/${repo}/compare/${best.sha}...${headSha}`);
      if (comparison.status === 'ahead' && Number.isInteger(comparison.ahead_by)) count = comparison.ahead_by;
    } catch (error) {
      console.warn(`::warning::Could not compare ${best.sha} with ${headSha}: ${error.message}`);
    }
    const noun = count === 1 ? 'commit' : 'commits';
    since = count === null
      ? ` at ${String(best.sha).slice(0, 7)}, commits since unknown`
      : ` at ${String(best.sha).slice(0, 7)}, ${count} ${noun} since`;
  }

  const summary = `Reviewed${who}${since}`;
  await postStatus(statusSha, 'success', detail ? `${summary} (${detail})` : summary);
  console.log(`Agent review found${who} for ${best.sha}${since ? `; head is ${headSha}${since}` : ''}${detail ? ` -- ${detail}` : ''}.`);
  if (best.by && best.by.toLowerCase() === author) {
    console.log('Note: the marker was posted by the pull request author. That is allowed, and the');
    console.log('status says so, so an approver can weigh it or re-run /el-review themselves.');
  }
  process.exit(0);
}

// A reviewer requested with NO review behind it at all is the ordering mistake the pull request
// rules exist to prevent, and it reads very differently from simply not having got to it yet.
//
// Both halves are needed. requested_reviewers holds only reviewers who have not yet submitted -- a
// human is removed from it the moment they review -- so on its own it would call a pull request
// with one approval in and a second reviewer pending "requested before any review", which is
// false. Teams live in a separate field, and a CODEOWNERS repository requests those instead.
const reviewersRequested =
  (pull.requested_reviewers || []).length > 0 || (pull.requested_teams || []).length > 0;
const nobodyHasReviewed = reviews.length === 0;

const description = reviewersRequested && nobodyHasReviewed
  ? 'Reviewer requested before any review - run /el-review'
  : 'No agent review on this pull request - run /el-review';

await postStatus(statusSha, 'failure', description);

// A warning, not an error: the job did what it was asked to do. The red lives in the commit
// status, where it belongs and where the ruleset reads it.
console.warn(`::warning::${description}`);
if (untrusted.length > 0) {
  console.warn(`::warning::Ignored ${untrusted.length} marker(s) from an author without write access.`);
  for (const item of untrusted) {
    console.warn(`  - @${item.by || 'unknown'} (${item.association}) -- needs OWNER, MEMBER or COLLABORATOR, or write access to this repository`);
  }
  console.warn('');
}
console.warn('');
console.warn('The approver of record runs /el-review in their own session before approving.');
console.warn('');
console.warn('NOT /code-review. That is Anthropic\'s built-in skill: it prints findings in the');
console.warn('terminal, posts nothing to the pull request unless given --comment, and never');
console.warn('writes the marker this check reads -- so it leaves this red however good its');
console.warn('findings were.');
console.warn('');
console.warn('/el-review posts the findings and records a marker naming the commit it reviewed.');
console.warn('One review per pull request is enough; later pushes do not turn this red again.');

// Exit 0: the status was posted and it is accurate. The pull request is gated by that status,
// not by this job's colour -- see the note at the top of this file.
process.exit(0);
