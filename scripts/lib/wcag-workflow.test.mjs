// Runs the real run: blocks of the shared workflows (taken from the YAML, unchanged) so that the
// file listing of the WCAG check and the checkout-ref gate cannot regress unnoticed
// (EasyLife365/.github#191). Needs bash and git, as on the ubuntu runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflows = join(root, '.github', 'workflows');

// Every run: block of every step called `name` in a workflow file, dedented.
function runBlocks(file, name) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const blocks = [];
  const indentOf = (l) => l.match(/^ */)[0].length;
  for (let i = 0; i < lines.length; i++) {
    const step = lines[i].match(/^( *)- name: (.*)$/);
    if (!step || step[2].trim() !== name) continue;
    const stepIndent = step[1].length;
    let j = i + 1;
    while (j < lines.length && !/^ *run: \|\s*$/.test(lines[j])) j++;
    const runIndent = indentOf(lines[j]);
    assert.ok(runIndent > stepIndent, `run: of "${name}" in ${file}`);
    const body = [];
    for (j++; j < lines.length; j++) {
      if (lines[j].trim() !== '' && indentOf(lines[j]) <= runIndent) break;
      body.push(lines[j]);
    }
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    const min = Math.min(...body.filter((l) => l.trim()).map(indentOf));
    blocks.push(body.map((l) => l.slice(min)).join('\n') + '\n');
  }
  return blocks;
}

function bash(script, env, cwd) {
  const dir = mkdtempSync(join(tmpdir(), 'wcag-step-'));
  const file = join(dir, 'step.sh');
  writeFileSync(file, script);
  try {
    return spawnSync('bash', [file], { cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GATE = 'Refuse checkout-ref for anyone but an allow-listed bot';

test('every copy of the checkout-ref gate is the same script', () => {
  const copies = [];
  for (const f of readdirSync(workflows).filter((n) => n.endsWith('.yml'))) {
    for (const b of runBlocks(join(workflows, f), GATE)) copies.push({ f, b });
  }
  assert.equal(copies.length, 11, copies.map((c) => c.f).join(', '));
  for (const c of copies) assert.equal(c.b, copies[0].b, `${c.f} differs from ${copies[0].f}`);
  assert.doesNotMatch(copies[0].b, /\$\{\{/);
});

test('the gate accepts only a bot pull request from the repository, at its head commit', () => {
  const [gate] = runBlocks(join(workflows, 'ci_wcag_check.yml'), GATE);
  const sha = 'a'.repeat(40);
  const ok = {
    CHECKOUT_REF: sha, EVENT_NAME: 'pull_request_target', ACTOR: 'dependabot[bot]',
    PR_AUTHOR: 'dependabot[bot]', PR_HEAD_SHA: sha, PR_HEAD_REPO: 'org/repo', REPOSITORY: 'org/repo',
  };
  const cases = [
    [{}, 0],
    [{ ACTOR: 'renovate[bot]', PR_AUTHOR: 'renovate[bot]' }, 0],
    [{ PR_AUTHOR: 'mallory' }, 1],                                  // actor arranged to be the bot
    [{ PR_HEAD_REPO: 'mallory/repo' }, 1],                          // branch in a fork
    [{ PR_HEAD_REPO: '' }, 1],                                      // fork deleted
    [{ ACTOR: 'alice' }, 1],                                        // a person pushed to the bot's branch
    [{ EVENT_NAME: 'pull_request' }, 1],
    [{ CHECKOUT_REF: 'main' }, 1],
    [{ CHECKOUT_REF: '$(touch pwned)"; echo ::warning::x; #', PR_AUTHOR: 'alice' }, 1],
  ];
  const cwd = mkdtempSync(join(tmpdir(), 'wcag-gate-'));
  try {
    for (const [change, status] of cases) {
      const r = bash(gate, { ...ok, ...change }, cwd);
      assert.equal(r.status, status, `${JSON.stringify(change)}: ${r.stdout}${r.stderr}`);
      if (status) assert.match(r.stdout, /^::error::Refusing to check out checkout-ref: /);
    }
    assert.deepEqual(readdirSync(cwd), [], 'no command from checkout-ref ran');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the WCAG step checks files directly under src/ and names with a space or an umlaut', () => {
  const [step] = runBlocks(join(workflows, 'ci_wcag_check.yml'), 'Run WCAG check on changed files');
  const dir = mkdtempSync(join(tmpdir(), 'wcag-files-'));
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    mkdirSync(join(dir, 'src', 'components'), { recursive: true });
    writeFileSync(join(dir, 'src', 'components', 'Ok.tsx'), 'export const Ok = () => <button aria-label="ok" />;\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    mkdirSync(join(dir, 'src', 'a b'));
    writeFileSync(join(dir, 'src', 'Root.tsx'), 'export const Root = () => <input />;\n');
    writeFileSync(join(dir, 'src', 'a b', 'ü.tsx'), 'export const U = () => <input />;\n');
    writeFileSync(join(dir, 'src', 'components', 'Deep.tsx'), 'export const D = () => <input />;\n');
    git('add', '.');
    git('commit', '-qm', 'change');
    mkdirSync(join(dir, '.shared-github', 'scripts'), { recursive: true });
    copyFileSync(join(root, 'scripts', 'check-wcag.mjs'), join(dir, '.shared-github', 'scripts', 'check-wcag.mjs'));

    const expectAll = (r, count) => {
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, new RegExp(`Checking ${count} file\\(s\\)\\.`));
      for (const f of ['src/Root.tsx', 'src/a b/ü.tsx', 'src/components/Deep.tsx']) {
        assert.ok(r.stderr.includes(`FAIL ${f}:1 [aria-label-interactive]`), `${f} not checked:\n${r.stderr}`);
      }
      assert.match(r.stderr, /3 violation\(s\) found\.$/m);
    };
    // Changed since the base commit: the three new files, not Ok.tsx.
    expectAll(bash(step, { EVENT_NAME: 'push', BEFORE_SHA: base, BASE_REF: '', MERGE_GROUP_BASE_SHA: '' }, dir), 3);
    // No merge base: every src file, through the ls-files fallback.
    expectAll(bash(step, { EVENT_NAME: 'merge_group', MERGE_GROUP_BASE_SHA: 'b'.repeat(40), BASE_REF: '', BEFORE_SHA: '' }, dir), 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
