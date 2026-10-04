// Re-exported from index.ts, so this file IS reachable.
export function legacy(): string {
  return 'legacy';
}

// Local to this file and never used here.
const internalOnly = 1;
export function usesNothing(): void {}
