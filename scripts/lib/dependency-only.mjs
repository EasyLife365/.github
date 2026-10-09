// Decides whether a pull request is a trusted dependency-only change.
//
// Used by pr-agent-review.mjs to limit the bot-author exemption (EasyLife365/.github#146). The PR
// author does not change when someone with write access pushes more commits to a dependabot/*
// branch, so the author alone cannot say that Dependabot wrote what is being merged. Two things
// can: the files (isDependencyOnlyChange) and the commits (commitsAreTrusted). BOTH must hold.
// This module is pure (no I/O, nothing runs on import) so it can be tested with node --test.

/** Manifests and lockfiles, in any directory. */
const DEPENDENCY_FILE_NAMES = new Set([
  'package.json',
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'packages.lock.json',
  'global.json',
]);

/** .NET project and central package files (Directory.Packages.props, Directory.Build.props). */
const DEPENDENCY_FILE_SUFFIXES = ['.csproj', '.props'];

/** The only files the pin workflow (dependabot_pin_indirect.yml) commits. */
const PIN_FILE_NAMES = new Set(['package.json', 'yarn.lock', 'package-lock.json']);

// The pin workflow's commit identity, as the commits API reports it (commit.author / commit.committer).
// The top-level `author` of such a commit is null (the noreply email is not linked to an account), so
// the identity is matched on name and email, never on author.login.
//
// This identity is NOT signed (verification: unsigned), so anyone who can push a commit with this name
// and email can forge it. The damage is bounded by the manifest-only file rule and is accepted so that
// the pin workflow's auto-fix pull requests stay exempt. The proper follow-up (EasyLife365/.github#146)
// is to have the pin workflow create its commit through the Git Data API so GitHub signs it, and then
// to require `verified` here as well.
export const APP_NAME = 'easylife-agents[bot]';
export const APP_EMAIL = '162133204+easylife-agents[bot]@users.noreply.github.com';

/**
 * One side of a Dependabot github-actions bump: `uses: owner/repo[/path]@ref`, optionally a list
 * item, optionally quoted, optionally a trailing comment, and nothing else. Groups: 1 indentation,
 * 2 list dash, 3 action (owner/repo[/path]), 4 ref. No docker:// and no ./local actions
 * (segments cannot start with a dot, so no ./ or ../).
 */
export const USES_LINE =
  /^[+-](\s*)(- )?uses:\s+["']?([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+)@([A-Za-z0-9._/-]+)["']?\s*(#.*)?\r?$/;

/** The files API stops listing at this many files; a listing this long may be truncated. */
export const FILES_API_CAP = 3000;
/** Commit listings this long are not trusted (the pull request commits API caps at 250). */
export const COMMITS_CAP = 250;

function baseName(path) {
  return path.split('/').pop();
}

function isDependencyFile(path) {
  const name = baseName(path);
  return DEPENDENCY_FILE_NAMES.has(name) || DEPENDENCY_FILE_SUFFIXES.some((s) => name.endsWith(s));
}

function isWorkflowFile(path) {
  return /^\.github\/workflows\/[^/]+\.yml$/.test(path);
}

/**
 * True when the patch only moves `uses:` refs: removed and added lines pair up in order, with the
 * same indentation, list dash and action, and only the ref differs. Context lines are irrelevant
 * because nothing but the ref changes. Unpaired, added-only and removed-only patches are rejected.
 */
function isRefBumpPatch(patch) {
  const removed = [];
  const added = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('-')) removed.push(line);
    else if (line.startsWith('+')) added.push(line);
  }
  if (removed.length === 0 || removed.length !== added.length) return false;
  return removed.every((oldLine, i) => {
    const before = USES_LINE.exec(oldLine);
    const after = USES_LINE.exec(added[i]);
    return (
      before !== null &&
      after !== null &&
      before[1] === after[1] &&
      (before[2] || '') === (after[2] || '') &&
      before[3] === after[3]
    );
  });
}

/**
 * @param {Array<{filename: string, status?: string, patch?: string, previous_filename?: string}>} files
 *   the pull request's files as returned by GET /pulls/{n}/files
 * @returns {{dependencyOnly: boolean, offending?: string}} `offending` is the first file that
 *   rules the exemption out. An empty or possibly truncated listing is never dependency-only.
 */
export function isDependencyOnlyChange(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { dependencyOnly: false, offending: '(no file listing)' };
  }
  if (files.length >= FILES_API_CAP) {
    return { dependencyOnly: false, offending: `(listing may be truncated at ${FILES_API_CAP} files)` };
  }
  for (const file of files) {
    const path = file.filename;
    // A rename moves content from somewhere else; do not reason about it.
    if (file.status === 'renamed' || (file.previous_filename && file.previous_filename !== path)) {
      return { dependencyOnly: false, offending: path };
    }
    if (file.status === 'removed') return { dependencyOnly: false, offending: path };
    if (isDependencyFile(path)) continue;
    if (
      isWorkflowFile(path) &&
      file.status === 'modified' &&
      typeof file.patch === 'string' &&
      isRefBumpPatch(file.patch)
    ) {
      continue;
    }
    return { dependencyOnly: false, offending: path };
  }
  return { dependencyOnly: true };
}

/**
 * Provenance: every commit must be either
 *  (a) authored by an exempt-listed bot (author.login, lowercased) AND GitHub-verified (Dependabot
 *      and Renovate commits are signed by GitHub), or
 *  (b) the pin workflow app's commit (APP_NAME / APP_EMAIL as author AND committer, unsigned) while
 *      the pull request's files are only package.json / yarn.lock / package-lock.json.
 * A human commit, an unverified bot commit or an "Update branch" merge commit by a person all fail,
 * as does any commit with a missing author, committer or commit object.
 * @param {Array<object>} commits as returned by GET /pulls/{n}/commits
 * @param {Array<{filename: string, status?: string}>} files
 * @param {string[]} exemptAuthors lowercase logins
 */
export function commitsAreTrusted(commits, files, exemptAuthors) {
  if (!Array.isArray(commits) || commits.length === 0) return false;
  if (commits.length >= COMMITS_CAP) return false;
  const pinFilesOnly =
    Array.isArray(files) &&
    files.length > 0 &&
    files.every((f) => f.status !== 'removed' && f.status !== 'renamed' && PIN_FILE_NAMES.has(baseName(f.filename)));
  const isAppIdentity = (who) => who?.name === APP_NAME && who?.email === APP_EMAIL;
  return commits.every((c) => {
    if (!c || typeof c !== 'object' || !c.commit) return false;
    const login = (c.author?.login || '').toLowerCase();
    if (login && exemptAuthors.includes(login)) return c.commit.verification?.verified === true;
    if (isAppIdentity(c.commit.author) && isAppIdentity(c.commit.committer)) return pinFilesOnly;
    return false;
  });
}
