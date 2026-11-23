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

const indentOf = (l) => l.match(/^ */)[0].length;
const dedent = (lines) => {
  const min = Math.min(...lines.filter((l) => l.trim()).map(indentOf));
  return lines.map((l) => l.slice(min));
};

// Every step called `name` in a workflow file: the whole step (`text`, dedented: name, if, env and
// run), its env: keys and its run: | block. A step without a literal `run: |` block fails.
function steps(file, name) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^( *)- name: (.*)$/);
    if (!head || head[2].trim() !== name) continue;
    const stepIndent = head[1].length;
    let end = i + 1;
    while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > stepIndent)) end++;
    const step = lines.slice(i, end);
    while (step.length && step[step.length - 1].trim() === '') step.pop();

    const runAt = step.findIndex((l) => /^ *run: \|\s*$/.test(l));
    assert.ok(runAt > 0, `"${name}" in ${file} has no literal "run: |" block`);
    const run = dedent(step.slice(runAt + 1)).join('\n') + '\n';

    const envAt = step.findIndex((l) => /^ *env:\s*$/.test(l));
    const env = [];
    if (envAt > 0) {
      for (let j = envAt + 1; j < step.length && indentOf(step[j]) > indentOf(step[envAt]); j++) {
        const key = step[j].match(/^ *([A-Za-z_][A-Za-z0-9_]*):/);
        if (key) env.push(key[1]);
      }
    }
    found.push({ text: dedent(step).join('\n'), env, run });
  }
  return found;
}

// git and bash run isolated from the machine's git configuration and from any GIT_* variable of
// the outer repository, with their temp files inside a folder this test removes.
function isolatedEnv(dir, extra = {}) {
  const globalConfig = join(dir, 'gitconfig');
  writeFileSync(globalConfig, '');
  return { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', TMPDIR: dir, ...extra };
}

function bash(script, env, cwd) {
  const dir = mkdtempSync(join(tmpdir(), 'wcag-step-'));
  const file = join(dir, 'step.sh');
  writeFileSync(file, script);
  try {
    return spawnSync('bash', [file], { cwd, env: isolatedEnv(dir, env), encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GATE = 'Refuse checkout-ref for anyone but an allow-listed bot';

test('every copy of the checkout-ref gate is the same step: if, env and run', () => {
  const copies = [];
  for (const f of readdirSync(workflows).filter((n) => n.endsWith('.yml'))) {
    for (const s of steps(join(workflows, f), GATE)) copies.push({ f, ...s });
  }
  assert.equal(copies.length, 11, copies.map((c) => c.f).join(', '));
  for (const c of copies) assert.equal(c.text, copies[0].text, `${c.f} differs from ${copies[0].f}`);
  assert.doesNotMatch(copies[0].run, /\$\{\{/);
  assert.match(copies[0].text, /PR_AUTHOR: \$\{\{ github\.event\.pull_request\.user\.login \}\}/);
});

test('the gate accepts only a bot pull request from the repository, at its head commit', () => {
  const [{ run: gate }] = steps(join(workflows, 'ci_wcag_check.yml'), GATE);
  const sha = 'a'.repeat(40);
  const ok = {
    CHECKOUT_REF: sha, EVENT_NAME: 'pull_request_target', ACTOR: 'dependabot[bot]',
    PR_AUTHOR: 'dependabot[bot]', PR_HEAD_SHA: sha, PR_HEAD_REPO: 'org/repo', REPOSITORY: 'org/repo',
  };
  const cases = [
    [{}, null],
    [{ ACTOR: 'renovate[bot]', PR_AUTHOR: 'renovate[bot]' }, null],
    [{ PR_AUTHOR: 'mallory' }, /opened by 'mallory'/],              // actor arranged to be the bot
    [{ PR_HEAD_REPO: 'mallory/repo' }, /lives in 'mallory\/repo'/], // branch in a fork
    [{ PR_HEAD_REPO: '' }, /lives in ''/],                          // fork deleted
    [{ ACTOR: 'alice' }, /caused by 'alice'/],                      // a person pushed to the bot's branch
    [{ EVENT_NAME: 'pull_request' }, /not pull_request_target/],
    [{ CHECKOUT_REF: 'main' }, /not the head commit/],
    [{ CHECKOUT_REF: '$(touch pwned)"; echo ::warning::x; #' }, /not the head commit/],
  ];
  const cwd = mkdtempSync(join(tmpdir(), 'wcag-gate-'));
  try {
    for (const [change, reason] of cases) {
      const r = bash(gate, { ...ok, ...change }, cwd);
      const label = `${JSON.stringify(change)}: ${r.stdout}${r.stderr}`;
      assert.equal(r.status, reason ? 1 : 0, label);
      if (reason) {
        assert.match(r.stdout, /^::error::Refusing to check out checkout-ref: /, label);
        assert.match(r.stdout, reason, label);
      }
      assert.doesNotMatch(r.stdout + r.stderr, /^::warning::/m, label);
    }
    assert.deepEqual(readdirSync(cwd), [], 'no command from checkout-ref ran');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the WCAG step reads only variables its env: sets', () => {
  const [step] = steps(join(workflows, 'ci_wcag_check.yml'), 'Run WCAG check on changed files');
  const assigned = new Set([
    ...[...step.run.matchAll(/^\s*([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]),
    ...[...step.run.matchAll(/mapfile\b[^\n<]*\s([A-Z_][A-Z0-9_]*)\s*</g)].map((m) => m[1]),
  ]);
  const read = new Set([...step.run.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]));
  const missing = [...read].filter((v) => !assigned.has(v) && !step.env.includes(v));
  assert.deepEqual(missing, []);
});

test('the WCAG step checks files directly under src/ and names with a space or an umlaut', () => {
  const [{ run: step }] = steps(join(workflows, 'ci_wcag_check.yml'), 'Run WCAG check on changed files');
  const dir = mkdtempSync(join(tmpdir(), 'wcag-files-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const gitEnv = isolatedEnv(dir);
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env: gitEnv, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    mkdirSync(join(repo, 'src', 'components'), { recursive: true });
    writeFileSync(join(repo, 'src', 'components', 'Ok.tsx'), 'export const Ok = () => <button aria-label="ok" />;\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    mkdirSync(join(repo, 'src', 'a b'));
    writeFileSync(join(repo, 'src', 'Root.tsx'), 'export const Root = () => <input />;\n');
    writeFileSync(join(repo, 'src', 'a b', 'ü.tsx'), 'export const U = () => <input />;\n');
    writeFileSync(join(repo, 'src', 'components', 'Deep.tsx'), 'export const D = () => <input />;\n');
    git('add', '.');
    git('commit', '-qm', 'change');
    mkdirSync(join(repo, '.shared-github', 'scripts'), { recursive: true });
    copyFileSync(join(root, 'scripts', 'check-wcag.mjs'), join(repo, '.shared-github', 'scripts', 'check-wcag.mjs'));

    const expectAll = (r, count) => {
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, new RegExp(`Checking ${count} file\\(s\\)\\.`));
      for (const f of ['src/Root.tsx', 'src/a b/ü.tsx', 'src/components/Deep.tsx']) {
        assert.ok(r.stderr.includes(`FAIL ${f}:1 [aria-label-interactive]`), `${f} not checked:\n${r.stderr}`);
      }
      assert.match(r.stderr, /3 violation\(s\) found\.$/m);
    };
    // Changed since the base commit: the three new files, not Ok.tsx.
    expectAll(bash(step, { EVENT_NAME: 'push', BEFORE_SHA: base, BASE_REF: '', MERGE_GROUP_BASE_SHA: '' }, repo), 3);
    // No merge base: every src file, through the ls-files fallback.
    expectAll(bash(step, { EVENT_NAME: 'merge_group', MERGE_GROUP_BASE_SHA: 'b'.repeat(40), BASE_REF: '', BEFORE_SHA: '' }, repo), 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
