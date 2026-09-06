// #2693: the TypeScript surface of `contention-invariant.js`, which stays
// JavaScript because the k6 load harness (`load/scenarios/*.js`) imports it
// under the k6 runtime. `src/lib/__tests__/contention-invariant.test.ts`
// proves the oracle from Vitest; keep this in step with the `.js`.
export declare function evaluateContentionOccupancy(input: {
  readonly capacity: number;
  readonly baseline: number;
  readonly attempts: number;
  readonly finalOccupied: number;
}): { expectedFinal: number; passed: boolean };
