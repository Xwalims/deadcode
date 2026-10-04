// Entry point: everything reachable from here is alive.
import { used } from './used.js';
import { alsoUsed } from './nested/also-used.js';

export function main(): string {
  return `${used()}-${alsoUsed()}`;
}

export { legacy } from './legacy.js';
