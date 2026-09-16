#!/usr/bin/env node
// EasyLife 365 agent-review check.
//
// Verifies that a Claude review exists FOR THE CURRENT HEAD COMMIT. It does not read the
// review, judge it, or care what it found -- the judgement lives in the review itself, posted
// by the /el-review skill in the approver's own session. This only answers "did one happen".
//
// The approval rule it enforces one half of:
//
//     One human approval plus a passing agent review on every pull request.
//
// Why the head commit matters: a review of an earlier commit must not satisfy the check for
// code pushed afterwards. Without that binding you can review once, push anything, and merge
// -- which is a formality wearing a gate's clothes.
//
// WHAT THIS SCRIPT'S EXIT CODE MEANS
//
// It reports whether the CHECK RAN, not what the check FOUND. Those are different questions and
// conflating them is a bug this script used to have.
//
// The finding lives in the commit status: red when no review exists for the head commit, green
// when one does. The status is the required context, so the gate is unaffected by the exit code.
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

const env = process.env;

const cfg = {
  token: env.GITHUB_TOKEN,
  repository: env.GITHUB_REPOSITORY,
  apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
  prNumber: (env.INPUT_PR_NUMBER || '').trim(),
  statusContext: (env.INPUT_STATUS_CONTEXT || 'agent-review').trim(),
  exemptAuthors: (env.INPUT_EXEMPT_AUTHORS || 'dependabot[bot],renovate[bot]')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};

if (!cfg.token || !cfg.repository || !cfg.prNumber) {
  console.error('::error::GITHUB_TOKEN, GITHUB_REPOSITORY and INPUT_PR_NUMBER are all required.');
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
 * one page the newest review -- the one most likely to match the head commit -- is on the LAST
 * page. Reading only the first would report "no review" on exactly the busy pull requests
 * where one is most likely to exist.
 */
async function apiAll(path) {
  const items = [];
  for (let page = 1; page <= 10; page++) {
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

// Drafts are not reviewed, so requiring a review of one would block work that is not asking
// to merge. The check reports success rather than skipping: a required check that never
// reports leaves the pull request stuck in "Expected" forever.
if (pull.draft) {
  await postStatus(headSha, 'success', 'Draft - agent review not required yet');
  console.log('Draft pull request; agent review not required.');
  process.exit(0);
}

// Bump and dependency pull requests are exempt by design -- CI proves them, and a review of a
// version-number diff is spend with nothing to find.
if (cfg.exemptAuthors.includes(author)) {
  await postStatus(headSha, 'success', `Exempt author (${author})`);
  console.log(`Author ${author} is exempt from agent review.`);
  process.exit(0);
}

// Reviews carry the marker (the /el-review skill posts through the reviews API). Issue comments
// are read too, so a review posted as a plain comment still counts -- the contract is the
// marker, not the mechanism that delivered it.
const [reviews, comments] = await Promise.all([
  apiAll(`/repos/${owner}/${repo}/pulls/${cfg.prNumber}/reviews`),
  apiAll(`/repos/${owner}/${repo}/issues/${cfg.prNumber}/comments`),
]);

const all = [
  ...reviews.map((r) => ({ body: r.body, at: r.submitted_at, by: r.user?.login })),
  ...comments.map((c) => ({ body: c.body, at: c.created_at, by: c.user?.login })),
];

const matched = [];
const stale = [];

for (const item of all) {
  for (const marker of markersIn(item.body)) {
    if (!marker.sha) continue;
    (marker.sha === headSha ? matched : stale).push({ ...marker, ...item });
  }
}

if (matched.length > 0) {
  // Most recent wins. A re-review of the same commit should report its own model and finding
  // count, not the first attempt's.
  matched.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const best = matched[0];
  const detail = [best.model && `model ${best.model}`, best.effort && `effort ${best.effort}`,
    best.findings !== undefined && `${best.findings} finding(s)`].filter(Boolean).join(', ');

  await postStatus(headSha, 'success', detail ? `Reviewed (${detail})` : 'Reviewed');
  console.log(`Agent review found for ${headSha}${detail ? ` -- ${detail}` : ''}.`);
  process.exit(0);
}

// A review of an older commit is the interesting failure, and it gets its own message: the
// author did the right thing and then pushed, which reads very differently from never having
// reviewed at all.
const description = stale.length > 0
  ? `Review is for an older commit - re-run /el-review on ${headSha.slice(0, 7)}`
  : `No agent review for ${headSha.slice(0, 7)} - run /el-review`;

await postStatus(headSha, 'failure', description);

// A warning, not an error: the job did what it was asked to do. The red lives in the commit
// status, where it belongs and where the ruleset reads it.
console.warn(`::warning::${description}`);
if (stale.length > 0) {
  console.warn(`::warning::Found ${stale.length} review marker(s), none matching the head commit ${headSha}.`);
  for (const item of stale) {
    console.warn(`  - ${item.sha} by ${item.by || 'unknown'} at ${item.at || 'unknown time'}`);
  }
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

// Exit 0: the status was posted and it is accurate. The pull request is gated by that status,
// not by this job's colour -- see the note at the top of this file.
process.exit(0);
