#!/usr/bin/env node
// EasyLife 365 pull request compliance checks.
//
// The deterministic half of PR review: facts a script can settle, with no model involved and
// no false positives. The judgement half -- correctness, conformance, reuse, simplification --
// runs separately in pr_code_review.yml and is told not to restate anything checked here.
//
// Everything below was an honour-system checkbox in the contributing guide, self-attested by
// the author of the change.
//
// Design rules for anything added here:
//
//   1. A check fails only on something the author of THIS pull request can fix. Pre-existing
//      state is a warning, never an error -- an unrelated change must not be blocked by a
//      condition it did not create.
//   2. A check reads the checkout, not the diff, wherever the checkout gives a clearer answer,
//      but only runs when the pull request touched the relevant files.
//   3. Every finding names the file and says what to do. An annotation nobody can act on is
//      noise, and noise is how a required check gets disabled.
//
// Configuration arrives as environment variables set from the reusable workflow's inputs.
// See .github/workflows/pr_compliance.yml.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { basename } from 'node:path';

const env = process.env;

const cfg = {
  solutionFile: (env.INPUT_SOLUTION_FILE || '').trim(),
  testFolderPolicy: (env.INPUT_TEST_FOLDER_POLICY || 'off').trim(),
  failOnBranchName: (env.INPUT_FAIL_ON_BRANCH_NAME || 'false') === 'true',
  strictPackageVersions: (env.INPUT_STRICT_PACKAGE_VERSIONS || 'false') === 'true',
  skipChecks: (env.INPUT_SKIP_CHECKS || '').split(',').map((s) => s.trim()).filter(Boolean),
};

const errors = [];
const warnings = [];
const notices = [];

/** GitHub Actions annotation, plus a row for the job summary. */
function report(level, check, message, file, line) {
  const bucket = level === 'error' ? errors : level === 'warning' ? warnings : notices;
  bucket.push({ check, message, file });

  const props = [];
  if (file) props.push(`file=${file}`);
  if (line) props.push(`line=${line}`);
  const location = props.length ? ` ${props.join(',')}` : '';
  // A literal newline would terminate the workflow command, so fold the message onto one line.
  const flat = message.replace(/\r?\n/g, ' ');
  console.log(`::${level}${location},title=${check}::${flat}`);
}

const fail = (check, message, file, line) => report('error', check, message, file, line);
const warn = (check, message, file, line) => report('warning', check, message, file, line);
const note = (check, message, file, line) => report('notice', check, message, file, line);

const enabled = (check) => !cfg.skipChecks.includes(check);

// ---------------------------------------------------------------------------------------------
// Pull request context

if (!env.GITHUB_EVENT_PATH || !existsSync(env.GITHUB_EVENT_PATH)) {
  console.error('No GITHUB_EVENT_PATH. This script runs on a pull_request event.');
  process.exit(1);
}

const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const pr = event.pull_request;

if (!pr) {
  console.error('Event payload has no pull_request. Trigger this on pull_request.');
  process.exit(1);
}

const title = pr.title || '';
const body = pr.body || '';
const branch = pr.head?.ref || '';
const baseSha = pr.base?.sha;
const headSha = pr.head?.sha;
const author = pr.user?.login || '';

const isBot = pr.user?.type === 'Bot' || /\[bot\]$/.test(author);

// ---------------------------------------------------------------------------------------------
// Changed files
//
// Three-dot diff against the merge base, so a stale branch is not blamed for what has landed
// on main since it was cut. Requires fetch-depth: 0 in the caller.

function changedFiles() {
  if (!baseSha || !headSha) return [];
  let raw;
  try {
    raw = execFileSync('git', ['diff', '--name-status', '-M', `${baseSha}...${headSha}`], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`Could not diff ${baseSha}...${headSha}. Is the caller using fetch-depth: 0?`);
    console.error(err.stderr?.toString?.() ?? err.message);
    process.exit(1);
  }

  return raw
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const parts = row.split('\t');
      const status = parts[0][0];
      // A rename row is "R100\told\tnew": the new path is what the pull request adds.
      const path = parts[parts.length - 1];
      return { status, path };
    });
}

const files = changedFiles();
const added = files.filter((f) => f.status === 'A' || f.status === 'R').map((f) => f.path);
const touched = files.filter((f) => f.status !== 'D').map((f) => f.path);
const touchedSet = new Set(touched);

const touchedAny = (pattern) => touched.some((p) => pattern.test(p));

console.log(`Pull request #${pr.number} by ${author}${isBot ? ' (bot)' : ''}`);
console.log(`Branch: ${branch}`);
console.log(`Changed files: ${files.length} (${added.length} added)`);
console.log('');

// ---------------------------------------------------------------------------------------------
// 1. Issue keyword
//
// The body is the hard requirement: GitHub links on the body, and sync-pr-title.yml reads the
// body's linked issues to correct the title. So a missing keyword in the title is a warning --
// that workflow is about to fix it -- while a missing keyword in the body is a failure, because
// nothing can recover it and the traceability record is lost.

const KEYWORD_IN_BODY = /\b(Closes|Fixes|Associates|Resolves)\s+(?:[\w.-]+\/[\w.-]+)?#\d+/i;
const KEYWORD_SUFFIX = /\.\s*(Closes|Fixes|Associates)\s+#\d+\.?\s*$/;

if (enabled('pr-title')) {
  if (!KEYWORD_IN_BODY.test(body)) {
    fail(
      'pr-title',
      'The pull request body has no issue keyword. Add "Closes #<n>", "Fixes #<n>" for a bug, ' +
        'or "Associates #<n>" when the work does not fully resolve the issue. GitHub links on ' +
        'the body, and sync-pr-title reads it to correct the title.',
    );
  } else if (!KEYWORD_SUFFIX.test(title)) {
    warn(
      'pr-title',
      `The title does not end with the keyword and issue number: "${title}". ` +
        'sync-pr-title should correct this automatically; if it has not, the expected form is ' +
        '"<statement>. Closes #<n>".',
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Secrets and credential artifacts
//
// Only newly added paths. Several repositories already track files matching these patterns --
// Exchange has seven integration settings files holding live keys -- and blocking every
// unrelated pull request in those repositories would achieve nothing but getting this check
// switched off. Removing what is already tracked is separate, deliberate work.

const DENIED = [
  { re: /(^|\/)local\.settings\.json$/i, why: 'holds connection strings and tenant secrets' },
  { re: /\.(pfx|p12|pem|key|jks)$/i, why: 'is a private key or certificate store' },
  { re: /(^|\/)integration\.json$/i, why: 'holds live tenant credentials in this estate' },
  { re: /(^|\/)appsettings\.Integration\.json$/i, why: 'holds live tenant credentials in this estate' },
  { re: /\.publishsettings$/i, why: 'holds deployment credentials' },
  { re: /(^|\/)\.env$/i, why: 'holds environment secrets; commit .env.example instead' },
  { re: /(^|\/)secrets?\.(json|ya?ml)$/i, why: 'is named as a secret store' },
];

if (enabled('secrets')) {
  for (const path of added) {
    for (const rule of DENIED) {
      if (rule.re.test(path)) {
        fail(
          'secrets',
          `${basename(path)} ${rule.why}, and this pull request adds it to the repository. ` +
            'Remove it from the branch and rotate anything it contained -- git history keeps ' +
            'it even after a later deletion.',
          path,
        );
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 3. react-table
//
// A hard estate rule: both React libraries pin the peer dependency below 9, and v9 is a
// different library with an incompatible API. Only checked when the pull request touched
// dependency manifests, so it cannot block unrelated work.

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function majorOf(range) {
  const m = String(range).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

if (enabled('react-table') && touchedAny(/(^|\/)(package\.json|yarn\.lock|package-lock\.json)$/)) {
  const manifests = touched.filter((p) => /(^|\/)package\.json$/.test(p) && existsSync(p));
  for (const manifest of manifests) {
    const pkg = readJson(manifest);
    if (!pkg) continue;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'resolutions']) {
      const range = pkg[section]?.['react-table'];
      if (!range) continue;
      const major = majorOf(range);
      if (major !== null && major >= 9) {
        fail(
          'react-table',
          `${section}.react-table is "${range}". react-table 9 is a different library with an ` +
            'incompatible API, and both EasyLife React libraries pin their peer dependency ' +
            'below 9. This upgrade is declined by standing decision, not deferred.',
          manifest,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 4. EL.* package version uniformity
//
// Mixed versions of the shared suite in one repository produce NU1605. Warned rather than
// failed by default: a repository can arrive at this state without the current pull request
// having caused it, and the three published client packages version independently on purpose.

const INDEPENDENT_PACKAGES = new Set([
  'EL.Approvals.Interface',
  'EL.EasyHub.Client',
  'EL.Notification.Client',
]);

if (enabled('el-package-versions') && touchedAny(/\.csproj$|(^|\/)Directory\.Packages\.props$/i)) {
  const projects = execFileSync('git', ['ls-files', '*.csproj', 'Directory.Packages.props'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

  /** package name -> Map(version -> [files]) */
  const versions = new Map();

  for (const project of projects) {
    if (!existsSync(project)) continue;
    const xml = readFileSync(project, 'utf8');
    const re = /<PackageReference\s+(?:Update|Include)="(EL\.[^"]+)"[^>]*?Version="([^"]+)"/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const [, name, version] = m;
      if (INDEPENDENT_PACKAGES.has(name)) continue;
      if (!versions.has(name)) versions.set(name, new Map());
      const byVersion = versions.get(name);
      if (!byVersion.has(version)) byVersion.set(version, []);
      byVersion.get(version).push(project);
    }
  }

  // The suite moves together, so compare across packages as well as within one.
  const suiteVersions = new Map();
  for (const [name, byVersion] of versions) {
    for (const [version, inFiles] of byVersion) {
      if (!suiteVersions.has(version)) suiteVersions.set(version, []);
      suiteVersions.get(version).push(`${name} in ${inFiles.length} project(s)`);
    }
  }

  if (suiteVersions.size > 1) {
    const detail = [...suiteVersions.entries()]
      .map(([version, uses]) => `${version} (${uses.join('; ')})`)
      .join(' vs ');
    const message =
      `The EL.* suite is on more than one version in this repository: ${detail}. ` +
      'Mixed versions produce NU1605 at restore. Upgrade the suite together.';
    if (cfg.strictPackageVersions) fail('el-package-versions', message);
    else warn('el-package-versions', message);
  }
}

// ---------------------------------------------------------------------------------------------
// 5. Solution membership
//
// A project missing from the solution builds locally through a project reference and is
// invisible to CI, which builds the solution.

if (enabled('solution-membership') && cfg.solutionFile) {
  const newProjects = added.filter((p) => /\.csproj$/i.test(p));
  if (newProjects.length > 0) {
    if (!existsSync(cfg.solutionFile)) {
      warn(
        'solution-membership',
        `solution-file input is "${cfg.solutionFile}", which does not exist in this repository. ` +
          'Correct the caller workflow.',
      );
    } else {
      const solution = readFileSync(cfg.solutionFile, 'utf8');
      for (const project of newProjects) {
        const name = basename(project);
        // .sln stores backslash paths, .slnx forward -- match on the file name, which both carry.
        if (!solution.includes(name)) {
          fail(
            'solution-membership',
            `${name} is not in ${cfg.solutionFile}. It will build locally through a project ` +
              'reference and never build in CI, which builds the solution.',
            project,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 6. Test folder placement
//
// Opt-in, because it is true of exactly one repository today. Collaboration's PR CI selects unit
// tests by namespace with the xunit v3 query filter "/*/*Unit*/*/*", so a test outside a Unit/
// folder is never executed on a pull request. It does not fail -- it does not run, and its
// green status means nothing.

if (enabled('test-folder') && cfg.testFolderPolicy === 'unit-integration') {
  const newTests = added.filter(
    (p) => /\.cs$/i.test(p) && /(Tests?|UnitTests)[./\\]/i.test(p) && /Tests?\b/i.test(p),
  );
  for (const path of newTests) {
    const segments = path.split(/[\\/]/);
    const inUnit = segments.some((s) => /^Unit$/i.test(s));
    const inIntegration = segments.some((s) => /^Integration$/i.test(s));
    if (!inUnit && !inIntegration) {
      fail(
        'test-folder',
        `${basename(path)} is outside a Unit/ or Integration/ folder. PR CI selects unit tests ` +
          'by namespace with --filter-query "/*/*Unit*/*/*", so this test will not run on a ' +
          'pull request and its passing status would be meaningless. Move it under Unit/ ' +
          '(or Integration/ if it needs a tenant or Azurite).',
        path,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 7. Branch naming
//
// Warned by default. The convention is real but predates most live branches, and renaming a
// branch mid-review costs more than it returns. Bots are exempt: their branch names are theirs.

const BRANCH_OK = /^[a-z][a-z-]*\/(pr\d+|[A-Za-z0-9._-]*\d+)(-\d+)?$/;

if (enabled('branch-name') && !isBot && branch && !BRANCH_OK.test(branch)) {
  const message =
    `Branch "${branch}" does not follow the convention: <type>/pr<issue> in the same ` +
    'repository, or <type>/<repositoryName><issue> across repositories -- issue #456 becomes ' +
    'pr456, with no separator. Append -1, -2 on a name collision.';
  if (cfg.failOnBranchName) fail('branch-name', message);
  else warn('branch-name', message);
}

// ---------------------------------------------------------------------------------------------
// 8. Restricted paths
//
// A notice, not a gate. The rule these carry is a human one: workflow and infrastructure
// changes always need explicit human approval, and an automated approval is not sufficient.
// A workflow cannot enforce that -- branch protection and a reviewer can -- so this exists to
// make sure nobody merges one without noticing what it was.

const RESTRICTED = [
  { re: /^\.github\/workflows\//, what: 'a GitHub Actions workflow' },
  { re: /^(bicep|infra)\//, what: 'infrastructure as code' },
];

if (enabled('restricted-paths')) {
  const hits = new Map();
  for (const path of touched) {
    for (const rule of RESTRICTED) {
      if (rule.re.test(path)) {
        if (!hits.has(rule.what)) hits.set(rule.what, []);
        hits.get(rule.what).push(path);
      }
    }
  }
  for (const [what, paths] of hits) {
    note(
      'restricted-paths',
      `This pull request changes ${what} (${paths.length} file(s), e.g. ${paths[0]}). ` +
        'These always require explicit human approval before merge -- an automated approval is ' +
        'not sufficient. Tag a tech lead as a required reviewer and tick the restricted-path ' +
        'box in the pull request body.',
      paths[0],
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Summary

const rows = [
  ...errors.map((f) => ({ ...f, level: 'Error' })),
  ...warnings.map((f) => ({ ...f, level: 'Warning' })),
  ...notices.map((f) => ({ ...f, level: 'Notice' })),
];

if (env.GITHUB_STEP_SUMMARY) {
  const lines = ['## PR compliance', ''];
  if (rows.length === 0) {
    lines.push('No findings. Every deterministic check passed.', '');
  } else {
    lines.push('| | Check | Where | Finding |', '|---|---|---|---|');
    for (const r of rows) {
      const icon = r.level === 'Error' ? ':x:' : r.level === 'Warning' ? ':warning:' : ':information_source:';
      const where = r.file ? `\`${r.file}\`` : '—';
      lines.push(`| ${icon} | ${r.check} | ${where} | ${r.message.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  lines.push(
    `Checked ${files.length} changed file(s).`,
    '',
    'These are facts, not opinions. Judgement-level review runs separately in `pr_code_review.yml`.',
    '',
  );
  appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join('\n'));
}

console.log('');
console.log(`Errors: ${errors.length}  Warnings: ${warnings.length}  Notices: ${notices.length}`);

if (errors.length > 0) {
  console.log('');
  console.log('Failing checks:');
  for (const e of errors) console.log(`  - ${e.check}: ${e.file ?? '(pull request)'}`);
  process.exit(1);
}

process.exit(0);
