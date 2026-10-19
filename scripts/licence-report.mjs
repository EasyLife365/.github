#!/usr/bin/env node
/**
 * Turn a dependency-licence listing into a report, and decide whether it fails the job.
 *
 * Behind the Security gate's licence checks (security_gate.yml). The listing comes from
 * nuget-license (.NET) or license-checker-rseidelsohn (npm); this file reads it, classifies every
 * package against licence-policy/policy.json (scripts/lib/licence-policy.mjs) and writes
 *
 *   1. a Markdown report to $GITHUB_STEP_SUMMARY, which appears on the run page itself
 *   2. one annotation per forbidden or unknown package (the first 20), so they show on the run
 *   3. the same counts on stdout
 *
 * Usage:  node licence-report.mjs --ecosystem dotnet|npm --input <listing.json> --policy <policy.json>
 *                                 [--ignore <exclusions>] [--enforce true|false] [--title "..."]
 *
 * Report-only unless --enforce true: findings are then ::warning:: and the exit code is 0. With
 * --enforce true a forbidden or unknown licence is an ::error:: and the exit code is 1. Packages that
 * need review (a real licence that is on neither list) are listed in both modes and never fail.
 *
 * Package names and licence strings come from third-party metadata, so everything printed is
 * escaped: workflow-command characters in annotations, Markdown and HTML in the summary table.
 */

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { loadPolicy, parseIgnore, assess, readNuget, readNpm } from './lib/licence-policy.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const ecosystem = flag('ecosystem');
const input = flag('input');
const policyPath = flag('policy');
const ignorePath = flag('ignore');
const enforce = flag('enforce', 'false') === 'true';
const title = flag('title', `${ecosystem} licences`);
const MAX_ANNOTATIONS = 20;
const MAX_ROWS = 200;

if (!['dotnet', 'npm'].includes(ecosystem) || !input || !policyPath) {
  console.error('Usage: licence-report.mjs --ecosystem dotnet|npm --input <file> --policy <file> [--ignore <file>] [--enforce true|false]');
  process.exit(2);
}

const annotate = (level, message) => {
  // Workflow commands are line-based and `%`/`\r`/`\n` are the escapes GitHub defines for their data.
  const safe = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::${level} title=Licence check::${safe}`);
};
const cell = (s) =>
  String(s ?? '(none)').replace(/[|`<>&\r\n]/g, (ch) => ({ '|': '\\|', '`': "'", '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch] ?? ' ');

let packages;
try {
  const json = JSON.parse(readFileSync(input, 'utf8'));
  packages = ecosystem === 'dotnet' ? readNuget(json) : readNpm(json);
} catch (e) {
  // A listing that is missing or unreadable means the tool failed, which is not the same as
  // "no findings": say so, and fail only when the gate is enforcing.
  annotate(enforce ? 'error' : 'warning', `${title}: could not read the licence listing (${e.message}).`);
  process.exit(enforce ? 1 : 0);
}

const policy = loadPolicy(JSON.parse(readFileSync(policyPath, 'utf8')));
const ignore = ignorePath && existsSync(ignorePath) ? parseIgnore(readFileSync(ignorePath, 'utf8')) : [];
const r = assess(packages, policy, ignore);

const failing = r.forbidden.length + r.unknown.length;
const level = enforce ? 'error' : 'warning';

const lines = [`### ${title}`, ''];
lines.push(enforce ? '_Enforced: forbidden and unknown licences fail this job._' : '_Report only: findings do not fail this job._', '');
lines.push('| Outcome | Packages |', '|---|---:|');
lines.push(`| Allowed | ${r.allowed.length} |`);
lines.push(`| Needs review | ${r['needs-review'].length} |`);
lines.push(`| Unknown | ${r.unknown.length} |`);
lines.push(`| Forbidden | ${r.forbidden.length} |`);
lines.push(`| Excluded (listed in .licenceignore on the default branch) | ${r.excluded.length} |`);
lines.push(`| Own packages (not checked) | ${r.own.length} |`, '');

for (const [key, heading] of [['forbidden', 'Forbidden'], ['unknown', 'Unknown'], ['needs-review', 'Needs review']]) {
  const list = [...r[key]].sort((a, b) => a.id.localeCompare(b.id));
  if (list.length === 0) continue;
  lines.push(`#### ${heading}`, '', '| Package | Version | Licence |', '|---|---|---|');
  for (const p of list.slice(0, MAX_ROWS)) lines.push(`| ${cell(p.id)} | ${cell(p.version)} | ${cell(p.licence)} |`);
  if (list.length > MAX_ROWS) lines.push(`| ... ${list.length - MAX_ROWS} more | | |`);
  lines.push('');
}
if (failing > 0) {
  lines.push('To accept a package after review, add its name (or `name@version`) to `.licenceignore` on the default branch, with a comment saying why.', '');
}

const report = lines.join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

for (const p of [...r.forbidden, ...r.unknown].slice(0, MAX_ANNOTATIONS)) {
  annotate(level, `${p.id}@${p.version}: ${p.licence ?? 'no licence information'}`);
}
if (failing > 0) {
  annotate(level, `${title}: ${r.forbidden.length} forbidden and ${r.unknown.length} unknown licences (${r['needs-review'].length} more need review).`);
}

process.exit(enforce && failing > 0 ? 1 : 0);
