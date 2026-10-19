// Runs licence-report.mjs as the workflow does, as a child process, and checks what a caller of it
// can observe: the exit code and the workflow commands, in report-only and enforcing mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../licence-report.mjs', import.meta.url));
const policy = fileURLToPath(new URL('../../licence-policy/policy.json', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'licence-report-'));

function run(ecosystem, listing, { enforce, ignore } = {}) {
  const input = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(input, typeof listing === 'string' ? listing : JSON.stringify(listing));
  const summary = join(dir, 'summary.md');
  writeFileSync(summary, '');
  const args = [script, '--ecosystem', ecosystem, '--input', input, '--policy', policy, '--enforce', String(Boolean(enforce))];
  if (ignore !== undefined) {
    const f = join(dir, 'ignore');
    writeFileSync(f, ignore);
    args.push('--ignore', f);
  }
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  return { code: r.status, out: r.stdout, summary: readFileSync(summary, 'utf8') };
}

const npm = (licences) => Object.fromEntries(Object.entries(licences).map(([k, v]) => [k, { licenses: v }]));

test('clean listing exits 0 in both modes', () => {
  for (const enforce of [false, true]) assert.equal(run('npm', npm({ 'a@1.0.0': 'MIT' }), { enforce }).code, 0);
});

test('a forbidden licence exits 0 when reporting and 1 when enforcing', () => {
  const listing = npm({ 'a@1.0.0': 'MIT', 'bad@2.0.0': 'GPL-3.0' });
  const report = run('npm', listing);
  assert.equal(report.code, 0);
  assert.match(report.out, /::warning title=Licence check::bad@2\.0\.0: GPL-3\.0/);
  const enforced = run('npm', listing, { enforce: true });
  assert.equal(enforced.code, 1);
  assert.match(enforced.out, /::error title=Licence check::bad@2\.0\.0/);
  assert.match(enforced.summary, /Forbidden \| 1/);
});

test('unknown and needs-review licences never fail, even when enforcing', () => {
  const unknown = run('npm', npm({ 'u@1.0.0': 'UNKNOWN' }), { enforce: true });
  assert.equal(unknown.code, 0);
  assert.match(unknown.out, /::warning title=Licence check::u@1\.0\.0: UNKNOWN \(unknown, not enforced\)/);
  assert.ok(!unknown.out.includes('::error'));
  assert.match(unknown.summary, /Unknown \| 1/);
  assert.equal(run('npm', npm({ 'm@1.0.0': 'MPL-2.0' }), { enforce: true }).code, 0);
});

test('an unlicensed NuGet package (no License key) is warned about, not failed', () => {
  const nuget = [{ PackageId: 'diskann-garnet', PackageVersion: '5.0.3', ValidationErrors: [{ Error: 'No license information found' }] }];
  const r = run('dotnet', nuget, { enforce: true });
  assert.equal(r.code, 0);
  assert.match(r.out, /::warning title=Licence check::diskann-garnet@5\.0\.3: no licence information/);
});

test('forbidden next to unknown still fails once, on the forbidden one', () => {
  const r = run('npm', npm({ 'u@1.0.0': 'UNKNOWN', 'bad@1.0.0': 'AGPL-3.0' }), { enforce: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /::error title=Licence check::bad@1\.0\.0/);
});

test('an excluded unknown package is counted as excluded and no longer warned about', () => {
  const r = run('npm', npm({ 'u@1.0.0': 'UNKNOWN' }), { enforce: true, ignore: '# reviewed\nu\n' });
  assert.equal(r.code, 0);
  assert.ok(!r.out.includes('::warning'));
  assert.match(r.summary, /Excluded .* \| 1/);
  assert.match(r.summary, /Unknown \| 0/);
});

test('an exclusion removes the finding, and the summary counts it', () => {
  const r = run('npm', npm({ 'x@1.0.0': 'GPL-3.0' }), { enforce: true, ignore: '# reviewed\nx\n' });
  assert.equal(r.code, 0);
  assert.match(r.summary, /Excluded .* \| 1/);
});

test('an excluded package that is now forbidden still warns', () => {
  const r = run('npm', npm({ 'x@2.0.0': 'AGPL-3.0' }), { enforce: true, ignore: 'x\n' });
  assert.equal(r.code, 0);
  assert.match(r.out, /::warning title=Licence check::x@2\.0\.0 is excluded/);
});

test('a missing or unreadable listing warns when reporting and fails when enforcing', () => {
  for (const [enforce, code, level] of [[false, 0, 'warning'], [true, 1, 'error']]) {
    const r = run('npm', 'this is not json', { enforce });
    assert.equal(r.code, code);
    assert.match(r.out, new RegExp(`::${level} title=Licence check::`));
  }
});

test('an empty listing is not a clean result', () => {
  for (const listing of [{}, []]) {
    const eco = Array.isArray(listing) ? 'dotnet' : 'npm';
    const report = run(eco, listing);
    assert.equal(report.code, 0);
    assert.match(report.out, /::warning title=Licence check::.*no packages/);
    assert.equal(run(eco, listing, { enforce: true }).code, 1);
  }
});

test('workflow commands and Markdown in package metadata cannot break out', () => {
  const evil = { 'a@1.0.0': 'MIT\n::error::injected', 'b|c@1.0.0': '<img src=x>' };
  const r = run('npm', npm(evil));
  // Every line the annotation emits starts with its own command; the newline is escaped, not honoured.
  assert.ok(!r.out.split('\n').some((l) => l.startsWith('::error::injected')));
  assert.ok(r.out.includes('%0A'));
  assert.ok(!r.summary.includes('<img'));
});

test('usage error without arguments exits 2', () => {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
