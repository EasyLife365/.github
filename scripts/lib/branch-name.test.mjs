import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidBranchName, branchNameMessage } from './branch-name.mjs';

test('pr<n> and pr<n>-<m> are accepted', () => {
  for (const b of ['pr123', 'pr1', 'pr123-1', 'pr123-12']) assert.equal(isValidBranchName(b), true, b);
});

test('the older <type>/ forms are still accepted', () => {
  for (const b of ['feature/pr123', 'fix/pr9-1', 'agents/operations477', 'docs/pr5']) {
    assert.equal(isValidBranchName(b), true, b);
  }
});

test('names that are not the convention are rejected', () => {
  for (const b of ['feature-x', 'main', 'pr', 'prabc', 'pr123x', 'pr123-', 'pr123-a', 'pr123-1-2', 'PR123', 'xpr123', 'feature/x', 'fix/pr123-']) {
    assert.equal(isValidBranchName(b), false, b);
  }
});

test('the message names the branch and the preferred form', () => {
  const m = branchNameMessage('feature-x');
  assert.match(m, /"feature-x"/);
  assert.match(m, /pr456/);
});
