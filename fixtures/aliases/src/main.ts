import { fromAlias } from '@app/services/api.js';
import { libThing, onlyUsedViaAlias } from '@lib';
import { cjs } from './legacy.cjs';
import * as ns from '@app/namespace.js';

// Aliases: `@app/*` and the exact `@lib`, plus a CommonJS import, plus a
// namespace import whose only reference is `ns.viaNamespace()`.
export function boot(): string {
  return `${fromAlias()}-${libThing()}-${cjs()}-${onlyUsedViaAlias()}-${ns.viaNamespace()}`;
}

// Nothing imports this file, and it is not the package entry point.
export function orphan(): void {}