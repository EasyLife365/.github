// Classifies a package's licence against licence-policy/policy.json.
//
// Used by licence-report.mjs, the reporter behind the Security gate's licence checks. Pure (no I/O,
// nothing runs on import) so it can be tested with node --test.
//
// Four outcomes, worst last:
//   allowed       every licence that applies is on the policy's allowed list
//   needs-review  a recognisable SPDX licence that is on neither list (MPL-2.0, CC-BY-4.0, ...),
//                 or an npm licence guessed from a file (license-checker marks it with a trailing *)
//   unknown       no licence, a URL, a file name, "Custom: ...", UNLICENSED, or anything that does not
//                 parse as an SPDX expression -- nobody can tell what the package permits
//   forbidden     matches the policy's forbidden list (GPL, AGPL, LGPL, SSPL, ...)
//
// An SPDX expression is evaluated, not matched as text: `MIT OR GPL-3.0-only` is allowed because the
// consumer may pick MIT, `MIT AND CC-BY-4.0` needs review because both apply. WITH exceptions are
// ignored, so `GPL-2.0 WITH Classpath-exception-2.0` stays forbidden -- conservative on purpose.

export const RANK = { allowed: 0, 'needs-review': 1, unknown: 2, forbidden: 3 };
const BY_RANK = Object.keys(RANK);

/**
 * `*` is the only wildcard; everything else is literal. Case-insensitive unless asked otherwise:
 * licence ids and package names are matched loosely, own-package prefixes exactly. Consecutive
 * stars collapse to one so a hostile entry cannot build a backtracking pattern.
 */
export function globToRegExp(glob, caseSensitive = false) {
  const body = glob.replace(/\*+/g, '*').split('*').map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, caseSensitive ? '' : 'i');
}

const SPDX_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

function classifyId(raw, policy) {
  let id = raw;
  const guessed = id.endsWith('*');
  if (guessed) id = id.slice(0, -1);
  const bare = id.replace(/\+$/, '');
  let outcome;
  if (!SPDX_ID.test(id) || /^(UNLICENSED|UNKNOWN|NONE|NOASSERTION|UNDEFINED|NULL|SEE|LICENSE|LICENCE)$/i.test(bare)
    || /^(https?:|custom)/i.test(id) || /\.(txt|md|html?)$/i.test(id)) {
    outcome = 'unknown';
  } else if (policy.allowedSet.has(bare.toLowerCase()) && !id.endsWith('+')) {
    outcome = 'allowed';
  } else if (policy.forbiddenRegExps.some((re) => re.test(bare))) {
    outcome = 'forbidden';
  } else {
    outcome = 'needs-review';
  }
  return guessed && RANK[outcome] < RANK['needs-review'] ? 'needs-review' : outcome;
}

export function loadPolicy(json) {
  return {
    allowedSet: new Set(json.allowed.map((s) => s.toLowerCase())),
    forbiddenRegExps: json.forbidden.map(globToRegExp),
    ownRegExps: (json.ownPackages ?? []).map((g) => globToRegExp(g, true)),
  };
}

/** Parses `a OR (b AND c)`; throws on anything that is not an SPDX expression. */
function evaluate(tokens, policy) {
  let pos = 0;
  const word = (w) => tokens[pos] !== undefined && tokens[pos].toUpperCase() === w;
  function atom() {
    const t = tokens[pos++];
    if (t === undefined || t === ')' || /^(AND|OR|WITH)$/i.test(t)) throw new Error('unexpected token');
    if (t === '(') {
      const r = or();
      if (tokens[pos++] !== ')') throw new Error('missing )');
      return r;
    }
    const r = classifyId(t, policy);
    if (word('WITH')) {
      pos++;
      if (tokens[pos++] === undefined) throw new Error('missing exception');
    }
    return r;
  }
  function and() {
    let r = atom();
    while (word('AND')) {
      pos++;
      r = BY_RANK[Math.max(RANK[r], RANK[atom()])];
    }
    return r;
  }
  function or() {
    let r = and();
    while (word('OR')) {
      pos++;
      r = BY_RANK[Math.min(RANK[r], RANK[and()])];
    }
    return r;
  }
  const result = or();
  if (pos !== tokens.length) throw new Error('trailing tokens');
  return result;
}

/** @returns {'allowed'|'needs-review'|'unknown'|'forbidden'} */
export function classifyLicence(expression, policy) {
  if (typeof expression !== 'string' || expression.trim() === '') return 'unknown';
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  try {
    return evaluate(tokens, policy);
  } catch {
    return 'unknown';
  }
}

/** Reads the exclusion file: one package per line, `#` comments, `*` wildcard. */
export function parseIgnore(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, '').replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean);
}

/** An entry matches the package name, or name@version for one exact version. */
export function isExcluded(id, version, entries) {
  return entries.some((e) => {
    const re = globToRegExp(e);
    return re.test(id) || re.test(`${id}@${version}`);
  });
}

/** nuget-license JSON -> [{id, version, licence}], one per package however many projects use it. */
export function readNuget(json) {
  const seen = new Map();
  for (const p of json) {
    const key = `${p.PackageId}@${p.PackageVersion}`;
    if (!seen.has(key)) seen.set(key, { id: p.PackageId, version: p.PackageVersion, licence: p.License });
  }
  return [...seen.values()];
}

/** license-checker-rseidelsohn JSON (keyed `name@version`) -> [{id, version, licence}]. */
export function readNpm(json) {
  return Object.entries(json).map(([key, v]) => {
    const at = key.lastIndexOf('@');
    // An array is the legacy "several licences" form. It does not say whether they are alternatives
    // or all apply, so assume the stricter reading: every one must be acceptable.
    const licence = Array.isArray(v.licenses) ? v.licenses.join(' AND ') : v.licenses;
    return { id: key.slice(0, at), version: key.slice(at + 1), licence };
  });
}

/**
 * Sorts packages into the four outcomes plus the excluded and own ones. `excludedForbidden` lists
 * excluded packages whose current licence is forbidden: an exclusion records a decision about a
 * package as reviewed, and a new version can change its licence.
 */
export function assess(packages, policy, ignoreEntries) {
  const result = { allowed: [], 'needs-review': [], unknown: [], forbidden: [], excluded: [], excludedForbidden: [], own: [] };
  for (const p of packages) {
    if (policy.ownRegExps.some((re) => re.test(p.id))) result.own.push(p);
    else if (isExcluded(p.id, p.version, ignoreEntries)) {
      result.excluded.push(p);
      if (classifyLicence(p.licence, policy) === 'forbidden') result.excludedForbidden.push(p);
    }
    else result[classifyLicence(p.licence, policy)].push(p);
  }
  return result;
}
