#!/usr/bin/env node
/**
 * Turn TRX files into a readable failure report.
 *
 * The problem this solves: `dotnet test` output in Actions is one long blob, the run page shows
 * nothing at all, and finding out which test failed and why means opening the log and scrolling
 * past restore, build and setup noise. `gh run view --log-failed` does not help either -- it
 * returns the whole step, including the shell echoing its own script.
 *
 * So this reads the TRX the run already produces and writes three things:
 *
 *   1. A Markdown report to $GITHUB_STEP_SUMMARY, which appears on the run page itself. This is
 *      the one that matters for a scheduled run, where there is no pull request to annotate.
 *   2. One ::error:: annotation per failed test, so the failures appear in the run's annotation
 *      list with their message attached.
 *   3. The same summary on stdout, for whoever is reading the raw log.
 *
 * Usage:  node test-summary.mjs [resultsDir] [--title "..."] [--max-failures N]
 *
 * Exits 0 even when tests failed. Reporting a failure is not the same as being one -- the test
 * step has already set the job's exit code, and a reporter that fails the build hides the report
 * it just wrote.
 */

import { readdirSync, readFileSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const resultsDir = positional[0] ?? './TestResults';
const title = flag('title', 'Test results');
const maxFailures = Number(flag('max-failures', '50'));

/** Stack frames inside the test framework tell you nothing about your own failure. */
const NOISE = [
  /^\s*at Xunit\./,
  /^\s*at Microsoft\.Testing\./,
  /^\s*at Microsoft\.VisualStudio\.TestPlatform\./,
  /^\s*at System\.RuntimeMethodHandle\./,
  /^\s*at System\.Reflection\./,
  /^\s*at InvokeStub_/,
];

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", '#39': "'", '#x27': "'" };

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, code) => {
      if (ENTITIES[code]) return ENTITIES[code];
      if (code.startsWith('#x')) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return m;
    });
}

/**
 * TRX is machine-generated and its shape is stable, so a targeted reader beats pulling in an XML
 * parser this repository would otherwise not need. Only the two elements that carry the answer are
 * read: the counters, and each failed UnitTestResult with its ErrorInfo.
 */
function parseTrx(xml) {
  const counters = {};
  const counterMatch = xml.match(/<Counters\b([^>]*)\/?>/);
  if (counterMatch) {
    for (const [, key, value] of counterMatch[1].matchAll(/(\w+)="([^"]*)"/g)) {
      counters[key] = Number(value);
    }
  }

  const failures = [];
  // A forward scan over every opening tag, rather than one regex spanning open-to-close. A passing
  // result is written self-closing, and a pattern that allows `<UnitTestResult ...>` to pair with
  // any later `</UnitTestResult>` will happily match from a passing result to a failing one, read
  // the outcome from the wrong end, and drop the failure. That is not hypothetical: it lost one of
  // sixteen on the first run against real data.
  for (const m of xml.matchAll(/<UnitTestResult\b[^>]*>/g)) {
    const tag = m[0];
    const attrs = Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, decode(v)]));
    if (!/^(Failed|Error|Timeout|Aborted)$/i.test(attrs.outcome ?? '')) continue;

    // Self-closing means no ErrorInfo to read -- report it with whatever the attributes carry.
    const body = tag.endsWith('/>')
      ? ''
      : xml.slice(m.index + tag.length, (() => {
          const end = xml.indexOf('</UnitTestResult>', m.index);
          return end === -1 ? m.index + tag.length : end;
        })());
    const message = body.match(/<Message>([\s\S]*?)<\/Message>/);
    const stack = body.match(/<StackTrace>([\s\S]*?)<\/StackTrace>/);
    const stdout = body.match(/<StdOut>([\s\S]*?)<\/StdOut>/);

    failures.push({
      name: attrs.testName ?? '(unnamed test)',
      outcome: attrs.outcome,
      duration: attrs.duration ?? '',
      message: message ? decode(message[1]).trim() : '',
      stack: stack ? decode(stack[1]).trim() : '',
      stdout: stdout ? decode(stdout[1]).trim() : '',
    });
  }

  return { counters, failures };
}

/** `Namespace.Class.Method(arg: 1)` -> `Class.Method(arg: 1)`, which is what you actually scan for. */
function shortName(name) {
  const paren = name.indexOf('(');
  const head = paren === -1 ? name : name.slice(0, paren);
  const tail = paren === -1 ? '' : name.slice(paren);
  const parts = head.split('.');
  return (parts.length > 2 ? parts.slice(-2).join('.') : head) + tail;
}

function trimStack(stack, keep = 8) {
  const lines = stack
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !NOISE.some((re) => re.test(l)));
  return lines.length > keep
    ? [...lines.slice(0, keep), `... ${lines.length - keep} more frame(s)`].join('\n')
    : lines.join('\n');
}

function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max)}\n... truncated (${s.length - max} more characters)` : s;
}

// --- read -------------------------------------------------------------------------------

let files = [];
try {
  files = readdirSync(resultsDir)
    .filter((f) => f.toLowerCase().endsWith('.trx'))
    .map((f) => join(resultsDir, f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
} catch {
  console.log(`No results directory at ${resultsDir}; nothing to report.`);
  process.exit(0);
}

if (files.length === 0) {
  // Worth saying out loud rather than passing quietly. A run that produced no TRX at all usually
  // means the logger arguments did not match the runner, and that looks identical to a green run
  // on the summary page.
  console.log(`::warning::No .trx files in ${resultsDir}. Test results cannot be summarised.`);
  process.exit(0);
}

const reports = files.map((file) => ({ file, ...parseTrx(readFileSync(file, 'utf8')) }));

const totals = reports.reduce(
  (acc, r) => ({
    total: acc.total + (r.counters.total ?? 0),
    passed: acc.passed + (r.counters.passed ?? 0),
    failed: acc.failed + (r.counters.failed ?? 0),
    skipped: acc.skipped + (r.counters.notExecuted ?? 0),
  }),
  { total: 0, passed: 0, failed: 0, skipped: 0 },
);

const allFailures = reports.flatMap((r) => r.failures);

// --- annotations ------------------------------------------------------------------------

for (const f of allFailures.slice(0, maxFailures)) {
  // The first line of a .NET failure message is the assertion; everything after it is the inner
  // exception chain, which pushes the useful part off the end of an annotation. Lead with the
  // first line and say only that more exists -- the full text is in the step summary.
  const lines = f.message.split(/\r?\n/).filter((l) => l.trim());
  const head = (lines[0] ?? f.outcome).trim().slice(0, 400);
  const more = lines.length > 1 ? ` (+${lines.length - 1} more line(s) — see the job summary)` : '';
  console.log(`::error title=${shortName(f.name)}::${head}${more}`);
}

// --- summary ----------------------------------------------------------------------------

const out = [];
const verdict = totals.failed > 0 ? 'failed' : totals.total === 0 ? 'no tests ran' : 'passed';

out.push(`## ${title} — ${verdict}`);
out.push('');
out.push('| Total | Passed | Failed | Skipped |');
out.push('| ----: | -----: | -----: | ------: |');
out.push(`| ${totals.total} | ${totals.passed} | **${totals.failed}** | ${totals.skipped} |`);
out.push('');

if (allFailures.length > 0) {
  out.push(`### Failed tests (${allFailures.length})`);
  out.push('');
  // The list first, so the names are all visible without scrolling through the detail of each.
  for (const f of allFailures.slice(0, maxFailures)) {
    out.push(`- \`${shortName(f.name)}\``);
  }
  if (allFailures.length > maxFailures) {
    out.push(`- ... and ${allFailures.length - maxFailures} more`);
  }
  out.push('');

  for (const f of allFailures.slice(0, maxFailures)) {
    out.push(`<details><summary><code>${shortName(f.name)}</code></summary>`);
    out.push('');
    out.push(`**Full name:** \`${f.name}\``);
    if (f.duration) out.push(`**Duration:** ${f.duration}`);
    out.push('');
    if (f.message) {
      out.push('**Message**');
      out.push('');
      out.push('```');
      out.push(truncate(f.message, 2000));
      out.push('```');
      out.push('');
    }
    const stack = trimStack(f.stack);
    if (stack) {
      out.push('**Stack**');
      out.push('');
      out.push('```');
      out.push(truncate(stack, 2000));
      out.push('```');
      out.push('');
    }
    if (f.stdout) {
      out.push('**Test output**');
      out.push('');
      out.push('```');
      out.push(truncate(f.stdout, 1000));
      out.push('```');
      out.push('');
    }
    out.push('</details>');
    out.push('');
  }
} else if (totals.total === 0) {
  out.push('No tests ran. Check the test filter and the logger arguments for this project.');
  out.push('');
}

out.push('<sub>');
out.push(reports.map((r) => `${r.file} — ${r.counters.total ?? 0} test(s)`).join('<br>'));
out.push('</sub>');

const markdown = out.join('\n');

if (process.env.GITHUB_STEP_SUMMARY) {
  // 1 MiB is the documented cap; stay well inside it rather than losing the whole summary.
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown.slice(0, 900_000)}\n`);
}

// The log copy is deliberately short. Anyone reading the raw log wants the names; the detail is
// one click away on the summary page.
console.log('');
console.log(`${title}: ${totals.total} test(s), ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped`);
for (const f of allFailures.slice(0, maxFailures)) {
  console.log(`  FAILED  ${shortName(f.name)}`);
  const firstLine = f.message.split(/\r?\n/).find((l) => l.trim());
  if (firstLine) console.log(`          ${firstLine.trim().slice(0, 200)}`);
}
if (allFailures.length > maxFailures) {
  console.log(`  ... and ${allFailures.length - maxFailures} more`);
}
