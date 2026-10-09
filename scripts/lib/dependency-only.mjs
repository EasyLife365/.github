// Decides whether a pull request changes nothing but dependency files.
//
// Used by pr-agent-review.mjs to limit the bot-author exemption (EasyLife365/.github#146). The PR
// author does not change when someone with write access pushes more commits to a dependabot/*
// branch, so the author alone cannot say that Dependabot wrote what is being merged. The files
// can. This module is pure (no I/O, nothing runs on import) so it can be tested with node --test.

/** Manifests and lockfiles, in any directory. */
const DEPENDENCY_FILE_NAMES = new Set([
  'package.json',
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'packages.lock.json',
  'global.json',
]);

/** .NET project and central package files (Directory.Packages.props, Directory.Build.props). */
const DEPENDENCY_FILE_SUFFIXES = ['.csproj', '.props'];

/** A Dependabot github-actions update only ever touches `uses:` lines (optionally a list item). */
const USES_LINE = /^[+-]\s*(?:-\s+)?uses:\s/;

/** The files API stops listing at this many files; a listing this long may be truncated. */
export const FILES_API_CAP = 3000;

function isDependencyFile(path) {
  const name = path.split('/').pop();
  return DEPENDENCY_FILE_NAMES.has(name) || DEPENDENCY_FILE_SUFFIXES.some((s) => name.endsWith(s));
}

function isWorkflowFile(path) {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

/** True when every added or removed line of the patch is a `uses:` line. */
function isUsesOnlyPatch(patch) {
  const changed = patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)\s/.test(l));
  return changed.length > 0 && changed.every((l) => USES_LINE.test(l));
}

/**
 * @param {Array<{filename: string, status?: string, patch?: string, previous_filename?: string}>} files
 *   the pull request's files as returned by GET /pulls/{n}/files
 * @returns {{dependencyOnly: boolean, offending?: string}} `offending` is the first file that
 *   rules the exemption out. An empty or possibly truncated listing is never dependency-only.
 */
export function isDependencyOnlyChange(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { dependencyOnly: false, offending: '(no file listing)' };
  }
  if (files.length >= FILES_API_CAP) {
    return { dependencyOnly: false, offending: `(listing may be truncated at ${FILES_API_CAP} files)` };
  }
  for (const file of files) {
    const path = file.filename;
    // A rename moves content from somewhere else; both ends must qualify.
    if (file.previous_filename && file.previous_filename !== path) {
      return { dependencyOnly: false, offending: path };
    }
    if (isDependencyFile(path)) continue;
    if (
      isWorkflowFile(path) &&
      file.status === 'modified' &&
      typeof file.patch === 'string' &&
      isUsesOnlyPatch(file.patch)
    ) {
      continue;
    }
    return { dependencyOnly: false, offending: path };
  }
  return { dependencyOnly: true };
}
