// Resolved through the exact `@lib` alias, which has no wildcard. The second
// export is itself reached through the `@app/*` alias, so it is only found when
// the symbol-level resolver understands aliases and not just relative paths.
export { onlyUsedViaAlias } from '@app/aliased/helper.js';

export const libThing = (): string => 'lib';