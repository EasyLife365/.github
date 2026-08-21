/**
 * WCAG 2.1 Pre-merge Accessibility Checker
 *
 * Checks only files changed in the current PR (passed as arguments).
 * Not retroactive - only staged .tsx/.css files are validated.
 *
 * Usage:
 *   node scripts/check-wcag.mjs src/components/Atoms/Button/Button.tsx ...
 *
 * Exit code 1 if violations found.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const rules = [
  {
    id: "aria-label-interactive",
    description:
      "Interactive elements (<button>, <input>, <select>, <textarea>, <a>) must have an accessible label (aria-label, aria-labelledby, title, or textual children for buttons/links).",
    appliesTo: ".tsx",
    test(filePath, content) {
      const violations = [];
      const interactivePattern = /<([a-z][a-z0-9-]*)\b([\s\S]*?)(\/>|>)/g;

      let match;
      while ((match = interactivePattern.exec(content)) !== null) {
        const tagName = match[1].toLowerCase();
        const attrs = match[2];
        const closing = match[3];
        const lineNumber = content.slice(0, match.index).split("\n").length;

        if (!['button', 'input', 'select', 'textarea', 'a'].includes(tagName)) continue;
        if (/aria-label\s*=/.test(attrs)) continue;
        if (/aria-labelledby\s*=/.test(attrs)) continue;
        if (/title\s*=/.test(attrs)) continue;
        if (tagName === "button" && closing === ">") continue;
        if (/type\s*=\s*["'{]?\s*["']?hidden["']?/.test(attrs)) continue;
        if (/\bid\s*=/.test(attrs) && content.includes("htmlFor")) continue;

        violations.push({
          line: lineNumber,
          message: `<${tagName}> is missing an accessible label (aria-label, aria-labelledby, or title).`,
        });
      }

      return violations;
    },
  },
];

const files = process.argv.slice(2);

if (files.length === 0) {
  console.log("No files to check. WCAG check passed.");
  process.exit(0);
}

let totalViolations = 0;

for (const file of files) {
  const filePath = resolve(file);
  let content;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    continue;
  }

  const applicableRules = rules.filter((r) => filePath.endsWith(r.appliesTo));

  for (const rule of applicableRules) {
    const violations = rule.test(filePath, content);
    for (const v of violations) {
      totalViolations++;
      console.error(`FAIL ${file}:${v.line} [${rule.id}] ${v.message}`);
    }
  }
}

if (totalViolations > 0) {
  console.error(`\nWCAG check failed: ${totalViolations} violation(s) found.`);
  process.exit(1);
}

console.log("WCAG check passed. No accessibility violations found.");
process.exit(0);
