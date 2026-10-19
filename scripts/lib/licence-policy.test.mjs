import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyLicence, loadPolicy, parseIgnore, isExcluded, assess, readNuget, readNpm } from './licence-policy.mjs';

// The real policy file, so a typo in it fails here rather than on a caller's pull request.
const policy = loadPolicy(JSON.parse(readFileSync(new URL('../../licence-policy/policy.json', import.meta.url), 'utf8')));
const c = (e) => classifyLicence(e, policy);

test('allowed licences, case-insensitively', () => {
  for (const l of ['MIT', 'mit', 'Apache-2.0', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense', 'CC0-1.0', 'MS-PL']) assert.equal(c(l), 'allowed', l);
});

test('copyleft is forbidden, including the -only / -or-later / + spellings', () => {
  for (const l of ['GPL-3.0-only', 'GPL-2.0+', 'AGPL-3.0-or-later', 'LGPL-2.1', 'SSPL-1.0', 'CC-BY-NC-4.0']) assert.equal(c(l), 'forbidden', l);
});

test('a recognisable licence on neither list needs review', () => {
  for (const l of ['MPL-2.0', 'CC-BY-4.0', 'EPL-2.0']) assert.equal(c(l), 'needs-review', l);
});

test('missing, URL, file name, custom and UNLICENSED are unknown', () => {
  for (const l of [undefined, null, '', 'undefined', 'UNLICENSED', 'Custom: LICENSE', 'LICENSE.txt', 'https://example.com/LICENSE', 'SEE LICENSE IN LICENSE.md']) {
    assert.equal(c(l), 'unknown', String(l));
  }
});

test('OR lets the consumer pick, AND needs every licence', () => {
  assert.equal(c('(MIT OR GPL-3.0-only)'), 'allowed');
  assert.equal(c('MPL-2.0 OR Apache-2.0'), 'allowed');
  assert.equal(c('(CC-BY-4.0 AND MIT)'), 'needs-review');
  assert.equal(c('MIT AND GPL-3.0-only'), 'forbidden');
  assert.equal(c('GPL-3.0-only OR LGPL-3.0-only'), 'forbidden');
  assert.equal(c('MIT OR (GPL-2.0 AND BSD-3-Clause)'), 'allowed');
});

test('a WITH exception does not rescue a forbidden licence', () => {
  assert.equal(c('GPL-2.0-only WITH Classpath-exception-2.0'), 'forbidden');
});

test('a malformed expression is unknown, never allowed', () => {
  for (const l of ['MIT OR', '(MIT', 'MIT AND AND ISC', 'MIT)']) assert.equal(c(l), 'unknown', l);
});

test('a licence npm guessed from a file (trailing *) is at least needs-review', () => {
  assert.equal(c('MIT*'), 'needs-review');
  assert.equal(c('GPL-3.0*'), 'forbidden');
});

test('a GPL-ish name that is not GPL is not caught by accident', () => {
  assert.equal(c('GPLv3-lookalike'), 'needs-review');
});

test('exclusion file: comments, CRLF, wildcards, exact versions', () => {
  const entries = parseIgnore('# why\r\nFoo.Bar  # reviewed 2026-10\r\n\r\nMicrosoft.AspNetCore.*\r\nleft-pad@1.3.0\r\n');
  assert.deepEqual(entries, ['Foo.Bar', 'Microsoft.AspNetCore.*', 'left-pad@1.3.0']);
  assert.equal(isExcluded('Foo.Bar', '1.0.0', entries), true);
  assert.equal(isExcluded('Microsoft.AspNetCore.Http', '2.2.2', entries), true);
  assert.equal(isExcluded('left-pad', '1.3.0', entries), true);
  assert.equal(isExcluded('left-pad', '1.4.0', entries), false);
  assert.equal(isExcluded('Foo.BarBaz', '1.0.0', entries), false);
});

test('regex metacharacters in an entry are literal', () => {
  assert.equal(isExcluded('FooXBar', '1', ['Foo.Bar']), false);
  assert.equal(isExcluded('a+b', '1', ['a+b']), true);
});

test('assess separates own, excluded and findings', () => {
  const pkgs = [
    { id: '@easylife365/react-core', version: '1', licence: 'Custom: LICENSE' },
    { id: 'EL.Core.Api', version: '1', licence: undefined },
    { id: 'ok', version: '1', licence: 'MIT' },
    { id: 'legacy', version: '1', licence: 'https://x/LICENSE' },
    { id: 'legacy2', version: '1', licence: 'https://x/LICENSE' },
    { id: 'bad', version: '1', licence: 'AGPL-3.0-only' },
  ];
  const r = assess(pkgs, policy, ['legacy']);
  assert.deepEqual([r.own.length, r.allowed.length, r.excluded.length, r.unknown.length, r.forbidden.length], [2, 1, 1, 1, 1]);
});

test('nuget reader dedupes a package used by several projects', () => {
  const p = { PackageId: 'A', PackageVersion: '1', License: 'MIT' };
  assert.deepEqual(readNuget([p, { ...p }, { ...p, PackageVersion: '2' }]).map((x) => x.version), ['1', '2']);
});

test('npm reader splits scoped names at the last @', () => {
  assert.deepEqual(
    readNpm({ '@azure/msal-browser@5.24.0': { licenses: 'MIT' }, 'x@1.0.0': { licenses: ['MIT', 'ISC'] } }),
    [{ id: '@azure/msal-browser', version: '5.24.0', licence: 'MIT' }, { id: 'x', version: '1.0.0', licence: '(MIT OR ISC)' }],
  );
});
