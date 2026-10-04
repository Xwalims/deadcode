// Reached only through the `@app/*` alias, and re-exported by the alias target
// `src/lib/index.ts`. Both the symbol-level and the file-level resolver have to
// agree this is live.
export function onlyUsedViaAlias(): string {
  return 'helper';
}