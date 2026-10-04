export function used(): string {
  return 'used';
}

// Never referenced anywhere. Should be reported.
export function neverCalled(): string {
  return 'nope';
}

// A class nothing instantiates or extends.
export class Orphan {}

// A type nothing references.
export interface UnusedShape { x: number }

// A variable nothing reads.
export const UNUSED_CONST = 42;
