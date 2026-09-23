#!/usr/bin/env node
/**
 * Detects which Android navigation framework a repo/module uses, purely from
 * file-naming convention — same idea as iOS's ArchitectureDetector.swift
 * (detects CleanSwift/MVVM/MVC/SwiftUI from filename suffixes, no LLM).
 *
 * Detection rules (checked in this order — first match wins):
 *   - Navigation 3    : any .../navigation/*NavKey.kt file exists
 *   - XML NavComponent: any res/navigation/*.xml file exists
 *   - unknown         : neither convention found — caller should fall back to
 *                       LLM-assisted (Tier 2) exploration instead of Tier-1 extraction
 *
 * Usage:
 *   node detect-nav-framework.mjs --dir <repo root>
 * Prints one of: nav3 | xml | unknown
 */
import { execSync } from 'node:child_process';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function countMatches(root, findExpr) {
  try {
    const raw = execSync(`find "${root}" -type f ${findExpr} -not -path "*/build/*" 2>/dev/null | wc -l`, {
      maxBuffer: 1024 * 1024 * 16,
    })
      .toString()
      .trim();
    return parseInt(raw, 10) || 0;
  } catch {
    return 0;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('Usage: node detect-nav-framework.mjs --dir <repo root>');
    process.exit(1);
  }

  const nav3Count = countMatches(args.dir, `-name "*NavKey.kt" -path "*navigation*"`);
  const xmlCount = countMatches(args.dir, `-path "*res/navigation/*.xml"`);

  let result = 'unknown';
  if (nav3Count > 0) result = 'nav3';
  else if (xmlCount > 0) result = 'xml';

  console.log(result);
  console.error(`(signals: ${nav3Count} NavKey.kt file(s), ${xmlCount} res/navigation/*.xml file(s))`);
}

main();
