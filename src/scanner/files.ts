/**
 * File discovery.
 *
 * Walks the tree once, asks `shouldAnalyse` about every path, and reads only
 * what survives. Reading happens after the walk so a large `exclude` costs
 * directory entries rather than file contents.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative as pathRelative, resolve } from 'node:path';
import { shouldAnalyse, extensionOf } from '../config/load.js';
import { normalisePath } from '../utils/path.js';
import type { DeadcodeConfig, SourceFile } from '../types.js';

/** Directories never descended into, regardless of configuration. */
const HARD_SKIP = new Set(['.git', 'node_modules']);

/** Classify a path into the kind the parser needs. */
function kindOf(path: string): SourceFile['kind'] {
  if (path.endsWith('.d.ts')) return 'd.ts';
  const extension = extensionOf(path);
  switch (extension) {
    case '.ts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    case '.mts':
    case '.cts':
      return 'ts';
    case '.js':
      return 'js';
    case '.jsx':
      return 'jsx';
    case '.mjs':
      return 'mjs';
    case '.cjs':
      return 'cjs';
    default:
      return 'ts';
  }
}

export interface ScanResult {
  readonly files: readonly SourceFile[];
  /** Root-relative paths of directories that could not be read. */
  readonly skipped: readonly string[];
}

/**
 * List every analysable file under `root`.
 *
 * Symlinked directories are not followed. Following them can walk out of the
 * project entirely, and a symlink cycle would hang the scan rather than report
 * anything useful.
 */
export async function scanProject(
  root: string,
  config: DeadcodeConfig,
): Promise<ScanResult> {
  const found: string[] = [];
  const skipped: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      skipped.push(normalisePath(pathRelative(root, directory) || '.'));
      return;
    }

    for (const entry of entries) {
      const full = join(directory, entry.name);
      const rel = normalisePath(pathRelative(root, full));

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (HARD_SKIP.has(entry.name)) continue;
        // Respect a configured exclude before descending, so a large build
        // directory is one stat call rather than thousands.
        const excluded = config.exclude.some(
          (pattern) =>
            !pattern.includes('/') &&
            !pattern.startsWith('!') &&
            pattern.replace(/\/$/, '') === entry.name,
        );
        if (excluded) continue;
        await walk(full);
        continue;
      }

      if (!entry.isFile()) continue;
      if (shouldAnalyse(rel, config)) found.push(rel);
    }
  };

  await walk(resolve(root));

  const files: SourceFile[] = [];
  for (const rel of found.sort()) {
    try {
      const text = await readFile(join(root, rel), 'utf8');
      files.push({ path: resolve(root, rel), kind: kindOf(rel), text });
    } catch {
      skipped.push(rel);
    }
  }

  return { files, skipped };
}

/** True when a directory exists, used to detect a monorepo workspace root. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}