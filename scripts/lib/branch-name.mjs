// The branch name convention checked by pr-compliance.mjs (check 7).
//
// `pr<issue>` (and `pr<issue>-<n>` after a name collision) is the convention. The older
// `<type>/pr<issue>` and `<type>/<repositoryName><issue>` forms stay valid so existing branches
// do not start warning. This module is pure (nothing runs on import) so node --test can load it.

export const BRANCH_OK = /^(pr\d+|[a-z][a-z-]*\/(pr\d+|[A-Za-z0-9._-]*\d+))(-\d+)?$/;

export function isValidBranchName(branch) {
  return BRANCH_OK.test(branch);
}

export function branchNameMessage(branch) {
  return (
    `Branch "${branch}" does not follow the convention: pr<issue> -- issue #456 becomes pr456, ` +
    'with no separator. Append -1, -2 on a name collision (pr456-1). Across repositories use ' +
    '<repositoryName><issue>. The older <type>/pr<issue> form is still accepted.'
  );
}
