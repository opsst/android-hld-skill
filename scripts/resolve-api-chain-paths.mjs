#!/usr/bin/env node
/**
 * Deterministic Tier-1 path resolver — Fragment -> ViewModel -> UseCase ->
 * Repository -> Service -> API endpoint(s), for XML/ViewBinding Android
 * feature modules that follow the documented scaffold convention (see this
 * repo's own `.claude/skills/android-dev/references/api-service.md` and
 * `feature-flow.md`).
 *
 * No filesystem search happens anywhere in this script — every file path is
 * either computed directly from a class's fully-qualified name, or read out
 * of an exact `import` line already present in the source. That's what
 * keeps this Tier 1 (deterministic): the convention is strict enough that
 * "where is X defined" is answered by the file itself (its own imports),
 * never by grepping around for it.
 *
 * What this deliberately stops short of: if a resolved Service interface
 * declares more than one `@GET`/`@POST` endpoint, this script cannot tell
 * you which one a given screen's action actually calls — that's exactly the
 * kind of narrow, genuinely-semantic question Tier 2 exists for. It reports
 * every candidate endpoint and flags `needsTargetedRead: true` rather than
 * guessing.
 *
 * Usage:
 *   node resolve-api-chain-paths.mjs --nav-json <nav-graph.json> --repo-root <path> --out <output.json>
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

/** FQN ("com.example.myapp.feature.checkout.domain.x.YUseCase") -> repo-relative
 *  file path, purely from the string itself (no disk search): a "feature.<name>."
 *  segment means the module is `features/<name>`, a leading "core." segment means
 *  the module is `core`. Anything else is reported as moduleUnknown, not guessed. */
function fqnToPath(fqn) {
  const parts = fqn.split('.');
  const featureIdx = parts.indexOf('feature');
  let module = null;
  if (featureIdx !== -1 && parts[featureIdx + 1]) {
    module = `features/${parts[featureIdx + 1]}`;
  } else if (parts.includes('core')) {
    // com.example.myapp.core.* -> core module. Use indexOf rather than a
    // hardcoded position — a fixed positional index (e.g. parts[3]) breaks
    // the moment a real FQN has a different segment count, and silently
    // fails to resolve every core.* UseCase instead of erroring loudly.
    module = 'core';
  }
  if (!module) return { path: null, moduleUnknown: true };
  return { path: `${module}/src/main/java/${parts.join('/')}.kt`, moduleUnknown: false };
}

/** Find the exact `import <fqn>` line for a given simple type name in a
 *  Kotlin source file. Returns null (disclosed, not guessed) if the type
 *  isn't explicitly imported — most commonly because it arrived via a
 *  wildcard import (`import x.y.*`) or lives in the same package. */
function resolveImportFqn(src, simpleName) {
  const re = new RegExp(`^import\\s+([\\w.]+\\.${simpleName})\\s*$`, 'm');
  const m = src.match(re);
  return m ? m[1] : null;
}

/** Resolve one screen's chain. `repoRoot` is the monorepo root (parent of
 *  `features/` and `core/`). */
function resolveScreen(node, repoRoot) {
  const result = {
    screenId: node.id,
    fragmentClass: node.className || null,
    fragmentFile: null,
    viewModelFile: null,
    useCases: [], // [{ name, fqn, file, repository: {...} }]
    notes: [],
  };

  if (!node.className) {
    result.notes.push('no className on this node — nothing to resolve');
    return result;
  }

  const parts = node.className.split('.');
  const simpleName = parts.at(-1);
  const flowName = simpleName.replace(/(Fragment|Activity)$/, '');

  result.fragmentFile = findModuleFile(repoRoot, node.className);
  if (!result.fragmentFile) {
    result.notes.push('computed fragment path not found on disk (module not inferrable from FQN, or file moved)');
    return result;
  }

  const vmFqn = `${parts.slice(0, -1).join('.')}.${flowName}ViewModel`;
  const vmPathInfo = fqnToPath(vmFqn);
  const viewModelFile = vmPathInfo.path ? join(repoRoot, vmPathInfo.path) : null;
  if (!viewModelFile || !existsSync(viewModelFile)) {
    result.notes.push(`expected ViewModel not found at computed path (${vmPathInfo.path || 'module unknown'}) — screen may share a ViewModel with a sibling screen (activityViewModel), which this resolver doesn't follow yet`);
    return result;
  }
  result.viewModelFile = vmPathInfo.path;

  const vmSrc = readFileSync(viewModelFile, 'utf-8');
  const useCaseNames = [...new Set([...vmSrc.matchAll(/:\s*(\w+UseCase)\b/g)].map((m) => m[1]))];

  for (const ucName of useCaseNames) {
    const ucFqn = resolveImportFqn(vmSrc, ucName);
    const entry = { name: ucName, fqn: ucFqn, file: null, repository: null };
    if (!ucFqn) {
      entry.note = 'not explicitly imported (likely a wildcard import or same-package type) — path not resolvable without a search, which this script deliberately does not do';
      result.useCases.push(entry);
      continue;
    }
    const ucPathInfo = fqnToPath(ucFqn);
    entry.file = ucPathInfo.path;
    const ucAbsPath = ucPathInfo.path ? join(repoRoot, ucPathInfo.path) : null;
    if (!ucAbsPath || !existsSync(ucAbsPath)) {
      entry.note = 'computed UseCase path not found on disk';
      result.useCases.push(entry);
      continue;
    }

    const ucSrc = readFileSync(ucAbsPath, 'utf-8');
    // Repository interface: any referenced type ending in "Repository" (not "RepositoryImpl").
    const repoMatch = [...new Set([...ucSrc.matchAll(/\b(\w+Repository)\b/g)].map((m) => m[1]))]
      .find((n) => !n.endsWith('Impl'));
    if (!repoMatch) {
      entry.repository = { note: 'no *Repository type referenced in this UseCase' };
      result.useCases.push(entry);
      continue;
    }
    const repoFqn = resolveImportFqn(ucSrc, repoMatch);
    const repository = {
      interfaceName: repoMatch,
      interfaceFqn: repoFqn,
      interfaceFile: null,
      implFile: null,
      serviceFile: null,
      endpoints: [],
      needsTargetedRead: false,
    };
    if (repoFqn) {
      const repoPathInfo = fqnToPath(repoFqn);
      repository.interfaceFile = repoPathInfo.path;
      if (repoPathInfo.path) {
        // domain/<entity>/<Entity>Repository.kt -> data/<entity>/<Entity>RepositoryImpl.kt
        // (sibling layer, same filename with "Impl" inserted) -> data/<entity>/<Entity>Service.kt
        // (same folder, "RepositoryImpl" -> "Service"). Both are deterministic string
        // transforms per the documented convention, not searches.
        const implRel = repoPathInfo.path.replace('/domain/', '/data/').replace(/Repository\.kt$/, 'RepositoryImpl.kt');
        const implAbs = join(repoRoot, implRel);
        if (existsSync(implAbs)) {
          repository.implFile = implRel;
          const serviceRel = implRel.replace(/RepositoryImpl\.kt$/, 'Service.kt');
          const serviceAbs = join(repoRoot, serviceRel);
          if (existsSync(serviceAbs)) {
            repository.serviceFile = serviceRel;
            const serviceSrc = readFileSync(serviceAbs, 'utf-8');
            const endpoints = [...serviceSrc.matchAll(/@(GET|POST|PUT|DELETE)\(\s*"([^"]+)"/g)].map((m) => ({
              method: m[1],
              path: m[2],
            }));
            repository.endpoints = endpoints;
            repository.needsTargetedRead = endpoints.length > 1;
          } else {
            repository.note = 'computed Service path not found on disk';
          }
        } else {
          repository.note = 'computed RepositoryImpl path not found on disk';
        }
      }
    } else {
      repository.note = 'Repository interface not explicitly imported (wildcard or same-package)';
    }
    entry.repository = repository;
    result.useCases.push(entry);
  }

  return result;
}

/** Compute + verify a class's own file path (used for the Fragment itself). */
function findModuleFile(repoRoot, fqn) {
  const info = fqnToPath(fqn);
  if (!info.path) return null;
  const abs = join(repoRoot, info.path);
  return existsSync(abs) ? info.path : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['nav-json'] || !args['repo-root'] || !args.out) {
    console.error('Usage: node resolve-api-chain-paths.mjs --nav-json <nav-graph.json> --repo-root <path> --out <output.json>');
    process.exit(1);
  }

  const navGraph = JSON.parse(readFileSync(args['nav-json'], 'utf-8'));
  const screens = (navGraph.nodes || []).map((n) => resolveScreen(n, args['repo-root']));

  const totalUseCases = screens.reduce((n, s) => n + s.useCases.length, 0);
  const needingTier2 = screens.filter((s) =>
    s.useCases.some((u) => u.repository?.needsTargetedRead),
  ).length;

  const output = {
    generatedBy:
      'resolve-api-chain-paths.mjs (deterministic, no LLM, no filesystem search — path resolution via FQN + import parsing only)',
    screenCount: screens.length,
    useCaseCount: totalUseCases,
    screensNeedingTargetedRead: needingTier2,
    screens,
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(output, null, 2));
  console.log(
    `✓ ${screens.length} screens, ${totalUseCases} use case(s) resolved, ${needingTier2} screen(s) need a targeted Tier-2 read → ${args.out}`,
  );
}

main();
