import { helper } from '../used.js';

// Referenced by index.ts, so the file is reachable.
export function alsoUsed(): string {
  return helper();
}

export function helper(): string {
  return 'helper';
}
