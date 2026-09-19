// Reads etc/binaries.conf, the absolute paths resolved once at install time by
// bin/ps-mcp-resolve. Nothing here searches PATH: that lookup happened in the
// operator's own shell, under a human, not at tool-call time with model input.
import { readFileSync } from 'node:fs';

export function parseBinaries(text) {
  const paths = new Map();
  const prefixes = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (!value.startsWith('/')) continue;
    if (key === 'prefix') prefixes.push(value);
    else paths.set(key, value);
  }
  return { paths, prefixes };
}

export function loadBinaries(file) {
  try {
    return { ...parseBinaries(readFileSync(file, 'utf8')), present: true };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // Not fatal: sdk tools still work, and every exec tool is skipped with a
    // warning that says exactly what to run.
    return { paths: new Map(), prefixes: [], present: false };
  }
}
