// #4940: the TypeScript surface of `stay-window.js`, which stays JavaScript
// because the k6 load harness imports it. `src/lib/__tests__/load-stay-window.test.ts`
// proves it from Vitest; keep this in step with the `.js`.
export interface LoadStay {
  lodgeIndex: number;
  checkIn: string;
  checkOut: string;
}
export declare function addDaysIso(dateOnly: string, days: number): string;
export declare function utcDayOf(epochMs: number): string;
export declare function nightsBetween(from: string, toExclusive: string): string[];
export declare function monthsTouched(
  nights: readonly string[],
): Array<{ year: number; month: number }>;
export declare function mixedWriteStay(
  start: string,
  vu: number,
  iter: number,
  spread: number,
  lodgeCount: number,
): LoadStay;
export declare function mixedWriteNights(start: string, spread: number): string[];
export declare function paymentStay(
  start: string,
  vu: number,
  iter: number,
  lodgeCount: number,
): LoadStay;
