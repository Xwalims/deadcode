import { fromAlias } from '@app/services/api.js';
import { libThing, onlyUsedViaAlias } from '@lib';
import { cjs } from './legacy.cjs';

// Aliases: `@app/*` and the exact `@lib`, plus a CommonJS import.
export function boot(): string {
  return `${fromAlias()}-${libThing()}-${cjs()}-${onlyUsedViaAlias()}`;
}

// Nothing imports this file, and it is not the package entry point.
export function orphan(): void {}