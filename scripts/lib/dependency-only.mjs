// Decides whether a pull request is a trusted dependency-only change, for pr-agent-review.mjs's two
// routes past the agent review.
//
// The bot-author exemption (EasyLife365/.github#146). The PR author does not change when someone with
// write access pushes more commits to a dependabot/* branch, so the author alone cannot say that
// Dependabot wrote what is being merged. Two things can: the files (isDependencyOnlyChange) and the
// commits (commitsAreTrusted). BOTH must hold.
//
// The internal library bump, for any author (EasyLife365/.github-private#593): every changed line is
// the version of one of our own packages (isInternalBumpOnly), and for NuGet every nuget.config of the
// base branch takes EL.* from our feed only (nugetConfigPinsInternal).
//
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
  const runs = changeRuns(patch);
  return (
    runs !== null &&
    runs.every((run) =>
      pairwise(run, (oldLine, newLine) => {
        const before = USES_LINE.exec(oldLine);
        const after = USES_LINE.exec(newLine);
        return (
          before !== null &&
          after !== null &&
          before[1] === after[1] &&
          (before[2] || '') === (after[2] || '') &&
          before[4] === after[4]
        );
      }),
    )
  );
}

/**
 * Splits a patch into change runs: removed lines immediately followed by added lines, as git prints a
 * changed block. A context line, a hunk header or a "\ No newline" line ends a run. Returns null for an
 * added-only or removed-only run, a '-' after a '+' in one run, or a patch with no change at all.
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

/** The i-th removed line pairs with the i-th added line. */
function pairwise(run, check) {
  return run.removed.length === run.added.length && run.removed.every((oldLine, i) => check(oldLine, run.added[i]));
}

/** Why a listing cannot be judged (empty, not a list, possibly truncated), or null. */
function unreadableListing(files) {
  if (!Array.isArray(files) || files.length === 0) return '(no file listing)';
  if (files.length >= FILES_API_CAP) return `(listing may be truncated at ${FILES_API_CAP} files)`;
  return null;
}

/**
 * @param {Array<{filename: string, status?: string, patch?: string, previous_filename?: string}>} files
 *   the pull request's files as returned by GET /pulls/{n}/files
 * @returns {{dependencyOnly: boolean, offending?: string}} `offending` is the first file that
 *   rules the exemption out. An empty or possibly truncated listing is never dependency-only.
 */
export function isDependencyOnlyChange(files) {
  const unreadable = unreadableListing(files);
  if (unreadable !== null) return { dependencyOnly: false, offending: unreadable };
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
// the EL.* NuGet suite) to a higher plain X.Y.Z, whoever wrote it; on a hotfix/ base, only a higher
// patch of the same MAJOR.MINOR. The shared publish workflows publish a release version only from a
// release whose tag commit is on main or a hotfix/ branch (ci_react_publish.yml,
// release_nuget_packages.yml); the consumer pull request only moves the pointer. Unlike the Dependabot
// route this judges every CHANGED LINE, not only the file names, so no provenance is needed.
//
// RESIDUAL: until the hotfix and tag rulesets are active (EasyLife365/.github-private#325), anyone with
// Write on a library repository can create a hotfix/ branch with unreviewed code and release it, and a
// person with package write access can push a version by hand; versions published before the gate are
// trusted as they are. @easylife365/pricing-calculator is published by its own job, outside the gate,
// so it is not an internal package here.
//
// What pins the bytes to the version: in yarn.lock, the resolved URL carries the tarball's SHA-1 twice
// (path and fragment, required equal here) and GitHub Packages answers 409 for a hash that is not the
// one of that name and version (checked 2026-11-24 with @easylife365/react 0.15.3 and 0.15.4), and yarn
// checks the integrity of what it downloads. For NuGet the line carries no source, so every nuget.config
// of the base branch must take EL.* from the EasyLife365 feed only (nugetConfigPinsInternal).

const SEMVER = String.raw`(\d+)\.(\d+)\.(\d+)`;
const NPM_NAME = String.raw`@easylife365\/(?!pricing-calculator(?![a-z0-9._-]))[a-z0-9][a-z0-9._-]*`;
const EOL = String.raw`[ \t]*\r?$`;

/** package.json: `"@easylife365/x": "[^~]X.Y.Z"[,]`. Groups: 1 indent, 2 name, 3 range prefix, 4 version, 8 comma. */
const NPM_DEP_LINE = new RegExp(String.raw`^[+-]([ \t]*)"(${NPM_NAME})":[ \t]*"([\^~]?)(${SEMVER})"(,?)${EOL}`);
/** .csproj/.props: `<PackageReference|PackageVersion Include|Update="EL.X" Version="X.Y.Z" />`. Groups: 1 indent, 2 element, 3 attribute, 4 name, 5 version. */
const NUGET_LINE = new RegExp(
  String.raw`^[+-]([ \t]*)<(PackageReference|PackageVersion)[ \t]+(Include|Update)="(EL\.[A-Za-z0-9][A-Za-z0-9._]*)"[ \t]+Version="(${SEMVER})"[ \t]*\/>${EOL}`,
);
/** yarn.lock v1 entry of an internal package: header, version, resolved on GitHub Packages, integrity. */
const LOCK_HEADER = new RegExp(String.raw`^[+-]"(${NPM_NAME})@([\^~]?)(${SEMVER})":${EOL}`);
const LOCK_VERSION = new RegExp(String.raw`^[+-]  version "(${SEMVER})"${EOL}`);
/** Groups: 1 name, 2 version, 6 path hash; the fragment must repeat the path hash. */
const LOCK_RESOLVED = new RegExp(
  String.raw`^[+-]  resolved "https:\/\/npm\.pkg\.github\.com\/download\/(${NPM_NAME})\/(${SEMVER})\/([0-9a-f]{40})#\6"${EOL}`,
);
const LOCK_INTEGRITY = new RegExp(String.raw`^[+-]  integrity sha512-[A-Za-z0-9+/]+={0,2}${EOL}`);

/** A higher patch of the same MAJOR.MINOR (a hotfix/ base). */
function isHigherPatch(oldVersion, newVersion) {
  const a = oldVersion.split('.');
  const b = newVersion.split('.');
  return a[0] === b[0] && a[1] === b[1] && Number(b[2]) > Number(a[2]);
}

function isHigher(oldVersion, newVersion) {
  const a = oldVersion.split('.').map(Number);
  const b = newVersion.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) return b[i] > a[i];
  }
  return false;
}

function npmDependencyPair(oldLine, newLine, up) {
  const a = NPM_DEP_LINE.exec(oldLine);
  const b = NPM_DEP_LINE.exec(newLine);
  return a !== null && b !== null && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[8] === b[8] && up(a[4], b[4]);
}

function nugetPair(oldLine, newLine, up) {
  const a = NUGET_LINE.exec(oldLine);
  const b = NUGET_LINE.exec(newLine);
  return a !== null && b !== null && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && up(a[5], b[5]);
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

function lockRun(run, up) {
  if (run.removed.length !== run.added.length) return false;
  const a = lockEntry(run.removed);
  const b = lockEntry(run.added);
  if (a === null || b === null || a.name !== b.name || !up(a.version, b.version)) return false;
  if ((a.spec === undefined) !== (b.spec === undefined)) return false;
  return a.spec === undefined || (a.prefix === b.prefix && up(a.spec, b.spec));
}

const isNugetFile = (name) => name.endsWith('.csproj') || name.endsWith('.props');

function internalBumpFileOk(file, up) {
  const name = baseName(file.filename);
  const runs = changeRuns(file.patch);
  if (runs === null) return false;
  // The patch must be whole: its lines add up to the file's own counts (a cut-off patch does not).
  const additions = runs.reduce((n, run) => n + run.added.length, 0);
  const deletions = runs.reduce((n, run) => n + run.removed.length, 0);
  if (additions !== file.additions || deletions !== file.deletions) return false;
  if (name === 'package.json') return runs.every((run) => pairwise(run, (o, n) => npmDependencyPair(o, n, up)));
  if (name === 'yarn.lock') return runs.every((run) => lockRun(run, up));
  if (isNugetFile(name)) return runs.every((run) => pairwise(run, (o, n) => nugetPair(o, n, up)));
  return false;
}

/**
 * @param {Array<{filename: string, status?: string, patch?: string, previous_filename?: string,
 *   additions?: number, deletions?: number}>} files the pull request's files as returned by GET /pulls/{n}/files
 * @param {{patchOnly?: boolean}} [options] patchOnly: only a higher patch of the same MAJOR.MINOR (a hotfix/ base)
 * @returns {{internalBump: boolean, nuget?: boolean, offending?: string}} `nuget` says a .csproj or .props
 *   file moved, so the caller must also check the nuget.config files (nugetConfigPinsInternal).
 *   `offending` is the first file that rules it out. Anything unreadable (no patch, a patch that does not
 *   add up to the file's counts, a truncated listing) is never an internal bump.
 */
export function isInternalBumpOnly(files, { patchOnly = false } = {}) {
  const up = patchOnly ? isHigherPatch : isHigher;
  const unreadable = unreadableListing(files);
  if (unreadable !== null) return { internalBump: false, offending: unreadable };
  for (const file of files) {
    const path = file?.filename;
    if (
      typeof path !== 'string' ||
      file.status !== 'modified' ||
      (file.previous_filename && file.previous_filename !== path) ||
      typeof file.patch !== 'string' ||
      !internalBumpFileOk(file, up)
    ) {
      return { internalBump: false, offending: typeof path === 'string' ? path : '(a file without a name)' };
    }
  }
  return { internalBump: true, nuget: files.some((file) => isNugetFile(baseName(file.filename))) };
}

export const EASYLIFE_NUGET_FEED = 'https://nuget.pkg.github.com/EasyLife365/index.json';

/**
 * True when every nuget.config text (the caller also requires one at the repository root) takes EL.* package
 * ids from the EasyLife365 feed only, in the plain shape this reads: it has a
 * packageSourceMapping with `EL.*` under a source whose value is that feed, and every pattern that
 * starts with `EL.` sits under such a source. Without it, an EL.* id can come from nuget.org, where
 * anybody can publish a higher version. Anything unusual (no text, a clear inside the mapping, a
 * source defined twice) is false.
 * @param {string[]} texts the nuget.config files of the base branch, every one of them
 */
export function nugetConfigPinsInternal(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return false;
  return texts.every((raw) => {
    if (typeof raw !== 'string') return false;
    const text = raw.replace(/<!--[\s\S]*?-->/g, '');
    // Only the plain shape is read. Anything the patterns would skip (single quotes, another attribute
    // order or an extra attribute, a second block) is not understood, so it is not trusted.
    const count = (s, re) => (s.match(re) || []).length;
    if (/='/.test(text)) return false;
    const sourcesBlocks = [...text.matchAll(/<packageSources>([\s\S]*?)<\/packageSources>/g)];
    if (sourcesBlocks.length !== 1 || count(text, /<packageSources\b/g) !== 1) return false;
    const adds = [...sourcesBlocks[0][1].matchAll(/<add key="([^"]*)" value="([^"]*)" \/>/g)];
    if (adds.length !== count(sourcesBlocks[0][1], /<add\b/g)) return false;
    const sources = new Map();
    for (const add of adds) {
      if (sources.has(add[1])) return false;
      sources.set(add[1], add[2]);
    }
    const mappings = [...text.matchAll(/<packageSourceMapping>([\s\S]*?)<\/packageSourceMapping>/g)];
    if (mappings.length !== 1 || count(text, /<packageSourceMapping\b/g) !== 1 || /<clear\b/.test(mappings[0][1])) return false;
    const blocks = [...mappings[0][1].matchAll(/<packageSource key="([^"]*)">([\s\S]*?)<\/packageSource>/g)];
    if (blocks.length !== count(mappings[0][1], /<packageSource\b/g)) return false;
    let pinned = false;
    for (const source of blocks) {
      const isFeed = sources.get(source[1]) === EASYLIFE_NUGET_FEED;
      const patterns = [...source[2].matchAll(/<package pattern="([^"]*)" \/>/g)];
      if (patterns.length !== count(source[2], /<package\b/g)) return false;
      for (const pattern of patterns) {
        if (/^el\./i.test(pattern[1]) && !isFeed) return false;
        if (pattern[1] === 'EL.*' && isFeed) pinned = true;
      }
    }
    return pinned;
  });
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
