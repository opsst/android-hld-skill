#!/usr/bin/env node
/**
 * Fetches the HLDGen Figma plugin (https://github.com/Ntpstv/HLDGen) that draws
 * `to-hldgen-bundle.mjs` output, pinned to the commit the bundle format was
 * built against, and prints the manifest path to import in Figma.
 *
 * The plugin is fetched rather than copied into this repo: it belongs to the
 * HLDGen project, which publishes no license yet.
 *
 * Usage:
 *   node get-hldgen-plugin.mjs [--dir <checkout dir>] [--ref <commit|branch>]
 */
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/Ntpstv/HLDGen.git';
const PINNED = 'd8daa31025a4e47721895af45bb30ca26ef4ef4a';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(args.dir || join(skillRoot, '.cache', 'HLDGen'));
const ref = args.ref || PINNED;
const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'ignore', 'inherit'] });

if (!existsSync(join(dir, '.git'))) {
  mkdirSync(dir, { recursive: true });
  git('init', '-q');
  git('remote', 'add', 'origin', args.repo || REPO);
}
git('fetch', '-q', '--depth', '1', 'origin', ref);
git('checkout', '-q', '--detach', 'FETCH_HEAD');

const manifest = join(dir, 'HLDFigmaPlugin', 'manifest.json');
if (!existsSync(manifest)) {
  console.error(`✗ ${manifest} not found — the HLDGen layout may have changed at ${ref}`);
  process.exit(1);
}
console.log(`✓ HLDGen plugin @ ${ref.slice(0, 7)}`);
console.log(`  Figma desktop → Plugins → Development → Import plugin from manifest… → ${manifest}`);
console.log('  Run "HLDGen — Scene Importer" and paste the bundle from to-hldgen-bundle.mjs.');
