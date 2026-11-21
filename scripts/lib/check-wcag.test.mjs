import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-wcag.mjs');

function run(cwd, files) {
  return spawnSync(process.execPath, [script, ...files], { cwd, encoding: 'utf8' });
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'check-wcag-'));
  mkdirSync(join(dir, 'src', 'a b'), { recursive: true });
  return dir;
}

test('a path that cannot be read fails the run and is named', () => {
  const dir = workspace();
  try {
    writeFileSync(join(dir, 'src', 'Root.tsx'), 'export const Root = () => <div />;\n');
    const r = run(dir, ['src/Root.tsx', 'src/missing file.tsx']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL src\/missing file\.tsx could not be read/);
    assert.match(r.stderr, /1 file\(s\) could not be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file with a space and an umlaut in its path is read and checked', () => {
  const dir = workspace();
  try {
    writeFileSync(join(dir, 'src', 'a b', 'ü.tsx'), 'export const B = () => <input />;\n');
    const r = run(dir, ['src/a b/ü.tsx']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAIL src\/a b\/ü\.tsx:1 \[aria-label-interactive\]/);
    assert.doesNotMatch(r.stderr, /could not be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readable files without violations pass', () => {
  const dir = workspace();
  try {
    writeFileSync(join(dir, 'src', 'Root.tsx'), 'export const Root = () => <button aria-label="Close" />;\n');
    writeFileSync(join(dir, 'src', 'a b', 'ü.css'), '.x { color: red; }\n');
    const r = run(dir, ['src/Root.tsx', 'src/a b/ü.css']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /WCAG check passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
