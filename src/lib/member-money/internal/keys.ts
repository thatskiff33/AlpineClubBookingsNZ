/**
 * The ONE place a member-money event key is built (#4626, Ledger M3a; the M3
 * plan on #4515). A key names the business event a batch records, so a retry of
 * that event finds the batch it already posted. It is built only from stable
 * source identities and revisions, never wall-clock time, amounts or array
 * position (design section 3), and each part is checked so two different events
 * can never spell the same key.
 */
function part(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.includes(":")) {
    throw new Error(`A member-money event key's ${label} must be a non-empty identity without ':' or surrounding space.`);
  }
  return value;
}

function revision(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`A member-money event key's revision must be a non-negative integer; got ${value}.`);
  }
  return String(value);
}

export const memberMoneyEventKeys = {
  /** R01: once per booking, as the legacy confirmation posts once (`INV-MONEY-033`). */
  bookingCharge: (bookingId: string) => `booking-charge:${part(bookingId, "booking id")}`,
  /** R02/R03: one per modification row. */
  modification: (modificationId: string) => `modification:${part(modificationId, "modification id")}`,
  /** R04: a booking can be cancelled, restored and cancelled again, so the revision is part of the key. */
  cancellation: (bookingId: string, cancellationRevision: number) =>
    `cancellation:${part(bookingId, "booking id")}:${revision(cancellationRevision)}`,
  /** R21: one per review task close. */
  reviewClose: (taskId: string) => `review-close:${part(taskId, "task id")}`,
  /** D4: one transfer per merge of two members. */
  merge: (fromMemberId: string, toMemberId: string) =>
    `merge:${part(fromMemberId, "merged-away member id")}:${part(toMemberId, "surviving member id")}`,
  /** An exact whole-batch reversal: the database allows one per journal, so the journal names it. */
  reversal: (journalId: string) => `reversal:${part(journalId, "journal id")}`,
} as const;
