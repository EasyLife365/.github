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
 * item, optionally quoted (the closing quote must match the opening one), optionally a trailing
 * comment that starts after whitespace and uses only harmless characters, and nothing else. A
 * comment glued to the ref (`@v2#$(x)`) or carrying shell/JS metacharacters (`$`, backtick,
 * parentheses, quotes) is rejected, because such a line could execute if it sits inside a `run: |`
 * or github-script block of the existing file. Groups: 1 indentation, 2 list dash, 3 quote,
 * 4 action (owner/repo[/path]), 5 ref. No docker:// and no ./local actions (segments cannot start
 * with a dot, so no ./ or ../).
 *
 * What no regex can catch: a ref that points at an impostor commit in a fork of the same
 * owner/repo. Only provenance (who committed this) covers that.
 */
export const USES_LINE =
  /^[+-](\s*)(- )?uses:\s+(["']?)([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+)@([A-Za-z0-9._/-]+)\3(\s+#[ A-Za-z0-9._+/:-]*)?\s*\r?$/;

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
 * True when the patch only moves `uses:` refs, the shape Dependabot produces: inside each hunk, a run
 * of removed lines is IMMEDIATELY followed by an equal run of added lines (no context between), and
 * the i-th removed line pairs with the i-th added line with the same indentation, list dash and
 * action, so only the ref differs. A pair split across hunks or separated by context is a moved
 * line (which could reattach the following with:/env:/secrets block to another step) and is
 * rejected, as are added-only and removed-only runs.
 */
function isRefBumpPatch(patch) {
  let removed = [];
  let added = [];
  let pairs = 0;
  const flush = () => {
    if (removed.length === 0 && added.length === 0) return true;
    if (removed.length === 0 || removed.length !== added.length) return false;
    const ok = removed.every((oldLine, i) => {
      const before = USES_LINE.exec(oldLine);
      const after = USES_LINE.exec(added[i]);
      return (
        before !== null &&
        after !== null &&
        before[1] === after[1] &&
        (before[2] || '') === (after[2] || '') &&
        before[4] === after[4]
      );
    });
    pairs += removed.length;
    removed = [];
    added = [];
    return ok;
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('-')) {
      if (added.length > 0 && !flush()) return false;
      removed.push(line);
    } else if (line.startsWith('+')) {
      added.push(line);
    } else if (!flush()) {
      return false; // context, hunk header or "\ No newline" line ends a run
    }
  }
  return flush() && pairs > 0;
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

// ---- Internal library bumps (EasyLife365/.github-private#593) ----
//
// A pull request that only moves the version of our own packages (@easylife365/* on GitHub Packages,
// the EL.* NuGet suite) to a higher plain X.Y.Z, whoever wrote it. The code of that version was
// reviewed in the library's own pull request and published by its release workflow; the consumer
// pull request only moves the pointer. Unlike the Dependabot route this judges every CHANGED LINE,
// not only the file names, so no provenance is needed: nothing but those version strings can change.

const SEMVER = String.raw`(\d+)\.(\d+)\.(\d+)`;
const NPM_NAME = String.raw`@easylife365\/[a-z0-9][a-z0-9._-]*`;
const EOL = String.raw`\s*\r?$`;

/** package.json: `"@easylife365/x": "[^~]X.Y.Z"[,]`. Groups: 1 indent, 2 name, 3 range prefix, 4 version, 8 comma. */
const NPM_DEP_LINE = new RegExp(String.raw`^[+-](\s*)"(${NPM_NAME})":\s*"([\^~]?)(${SEMVER})"(,?)${EOL}`);
/** .csproj/.props: `<PackageReference|PackageVersion Include|Update="EL.X" Version="X.Y.Z" />`. Groups: 1 indent, 2 element, 3 attribute, 4 name, 5 version. */
const NUGET_LINE = new RegExp(
  String.raw`^[+-](\s*)<(PackageReference|PackageVersion)\s+(Include|Update)="(EL\.[A-Za-z0-9][A-Za-z0-9._]*)"\s+Version="(${SEMVER})"\s*\/>${EOL}`,
);
/** yarn.lock v1 entry of an internal package: header, version, resolved on GitHub Packages, integrity. */
const LOCK_HEADER = new RegExp(String.raw`^[+-]"(${NPM_NAME})@([\^~]?)(${SEMVER})":${EOL}`);
const LOCK_VERSION = new RegExp(String.raw`^[+-]  version "(${SEMVER})"${EOL}`);
const LOCK_RESOLVED = new RegExp(
  String.raw`^[+-]  resolved "https:\/\/npm\.pkg\.github\.com\/download\/(${NPM_NAME})\/(${SEMVER})\/[0-9a-f]{40}#[0-9a-f]{40}"${EOL}`,
);
const LOCK_INTEGRITY = new RegExp(String.raw`^[+-]  integrity sha512-[A-Za-z0-9+/]+={0,2}${EOL}`);

function isHigher(oldVersion, newVersion) {
  const a = oldVersion.split('.').map(Number);
  const b = newVersion.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) return b[i] > a[i];
  }
  return false;
}

/**
 * Splits a patch into change runs: removed lines immediately followed by added lines, as git prints a
 * changed block. Returns null for an added-only or removed-only run, a '-' after a '+' in one run, or a
 * patch with no change at all.
 */
function changeRuns(patch) {
  const runs = [];
  let removed = [];
  let added = [];
  let ok = true;
  const flush = () => {
    if (removed.length === 0 && added.length === 0) return;
    if (removed.length === 0 || added.length === 0) ok = false;
    runs.push({ removed, added });
    removed = [];
    added = [];
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('-')) {
      if (added.length > 0) ok = false;
      removed.push(line);
    } else if (line.startsWith('+')) {
      added.push(line);
    } else {
      flush();
    }
  }
  flush();
  return ok && runs.length > 0 ? runs : null;
}

function pairwise(run, check) {
  return run.removed.length === run.added.length && run.removed.every((oldLine, i) => check(oldLine, run.added[i]));
}

function npmDependencyPair(oldLine, newLine) {
  const a = NPM_DEP_LINE.exec(oldLine);
  const b = NPM_DEP_LINE.exec(newLine);
  return a !== null && b !== null && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[8] === b[8] && isHigher(a[4], b[4]);
}

function nugetPair(oldLine, newLine) {
  const a = NUGET_LINE.exec(oldLine);
  const b = NUGET_LINE.exec(newLine);
  return a !== null && b !== null && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && isHigher(a[5], b[5]);
}

/** One side of a lock run: [header?] version resolved integrity, all naming one internal package at one version. */
function lockEntry(lines) {
  let rest = lines;
  let header = null;
  if (rest.length === 4) {
    header = LOCK_HEADER.exec(rest[0]);
    if (header === null) return null;
    rest = rest.slice(1);
  }
  if (rest.length !== 3) return null;
  const version = LOCK_VERSION.exec(rest[0]);
  const resolved = LOCK_RESOLVED.exec(rest[1]);
  if (version === null || resolved === null || !LOCK_INTEGRITY.test(rest[2])) return null;
  if (resolved[2] !== version[1]) return null;
  if (header !== null && header[1] !== resolved[1]) return null;
  return { name: resolved[1], version: version[1], prefix: header?.[2], spec: header?.[3] };
}

function lockRun(run) {
  if (run.removed.length !== run.added.length) return false;
  const a = lockEntry(run.removed);
  const b = lockEntry(run.added);
  if (a === null || b === null || a.name !== b.name || !isHigher(a.version, b.version)) return false;
  if ((a.spec === undefined) !== (b.spec === undefined)) return false;
  return a.spec === undefined || (a.prefix === b.prefix && isHigher(a.spec, b.spec));
}

function internalBumpFileOk(file) {
  const name = baseName(file.filename);
  const runs = changeRuns(file.patch);
  if (runs === null) return false;
  if (name === 'package.json') return runs.every((run) => pairwise(run, npmDependencyPair));
  if (name === 'yarn.lock') return runs.every(lockRun);
  if (name.endsWith('.csproj') || name.endsWith('.props')) return runs.every((run) => pairwise(run, nugetPair));
  return false;
}

/**
 * @param {Array<{filename: string, status?: string, patch?: string, previous_filename?: string}>} files
 *   the pull request's files as returned by GET /pulls/{n}/files
 * @returns {{internalBump: boolean, offending?: string}} `offending` is the first file that rules it
 *   out. Anything unreadable (no patch, a truncated listing) is never an internal bump.
 */
export function isInternalBumpOnly(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { internalBump: false, offending: '(no file listing)' };
  }
  if (files.length >= FILES_API_CAP) {
    return { internalBump: false, offending: `(listing may be truncated at ${FILES_API_CAP} files)` };
  }
  for (const file of files) {
    const path = file?.filename;
    if (
      typeof path !== 'string' ||
      file.status !== 'modified' ||
      (file.previous_filename && file.previous_filename !== path) ||
      typeof file.patch !== 'string' ||
      !internalBumpFileOk(file)
    ) {
      return { internalBump: false, offending: typeof path === 'string' ? path : '(a file without a name)' };
    }
  }
  return { internalBump: true };
}

/**
 * Provenance: the commit list must satisfy all of
 *  - the first commit is a route-(a) commit, and every commit is route (a) or route (b);
 *  - (a) a bot commit: author.login (lowercased) is an exempt-listed bot AND GitHub itself committed
 *    it: committer.login is web-flow, the committer email is noreply@github.com, and the signature
 *    is verified with reason valid. The author login comes from the author EMAIL, which anyone can
 *    set, and `verified` only says the signer's key matches the committer email -- so author plus
 *    verified alone would let a human forge a Dependabot author and sign with their own key. It is
 *    the web-flow committer plus a valid signature that a human cannot obtain from their own key.
 *    This route therefore TRUSTS GITHUB'S web-flow SIGNATURE. An "Update branch" merge commit has
 *    web-flow as committer but the human as author, so it fails on the author;
 *  - (b) the pin workflow app's commit (APP_NAME / APP_EMAIL as author AND committer, unsigned) while
 *    the pull request's files are only package.json / yarn.lock / package-lock.json. Route (b) is
 *    never enough alone: requiring a route-(a) FIRST commit stops a force-push that replaces every
 *    commit with forged pin commits;
 *  - when headSha is given, the last commit is the head, which ties the listing to the head.
 * A human commit, an unverified bot commit, or a missing author, committer or commit object fails
 * closed, as do 250 or more commits and non-array input.
 * @param {Array<object>} commits as returned by GET /pulls/{n}/commits (oldest first)
 * @param {Array<{filename: string, status?: string}>} files
 * @param {string[]} exemptAuthors lowercase logins
 * @param {string} [headSha]
 */
export function commitsAreTrusted(commits, files, exemptAuthors, headSha) {
  if (!Array.isArray(commits) || commits.length === 0) return false;
  if (commits.length >= COMMITS_CAP) return false;
  if (headSha !== undefined && commits[commits.length - 1]?.sha !== headSha) return false;
  const pinFilesOnly =
    Array.isArray(files) &&
    files.length > 0 &&
    files.every((f) => f.status !== 'removed' && f.status !== 'renamed' && PIN_FILE_NAMES.has(baseName(f.filename)));
  const isAppIdentity = (who) => who?.name === APP_NAME && who?.email === APP_EMAIL;
  const isBotCommit = (c) => {
    if (!c || typeof c !== 'object' || !c.commit) return false;
    const login = (c.author?.login || '').toLowerCase();
    return (
      login !== '' &&
      exemptAuthors.includes(login) &&
      c.committer?.login === 'web-flow' &&
      c.commit.committer?.email === 'noreply@github.com' &&
      c.commit.verification?.verified === true &&
      c.commit.verification?.reason === 'valid'
    );
  };
  if (!isBotCommit(commits[0])) return false;
  return commits.every((c) => {
    if (!c || typeof c !== 'object' || !c.commit) return false;
    if (isBotCommit(c)) return true;
    if (isAppIdentity(c.commit.author) && isAppIdentity(c.commit.committer)) return pinFilesOnly;
    return false;
  });
}
