/**
 * The ONE place a member-money event key is built (#4626, Ledger M3a; the M3
 * plan on #4515). A key names the business event a batch records, so a retry of
 * that event finds the batch it already posted. It is built only from stable
 * source identities and revisions, never wall-clock time, amounts or array
 * position (design section 3), and each part is checked so two different events
 * can never spell the same key.
 */
declare const eventKeyBrand: unique symbol;
/** A key only `memberMoneyEventKeys` produces: a plan cannot carry a hand-written one. */
export type MemberMoneyEventKey = string & { readonly [eventKeyBrand]: true };
const key = (value: string) => value as MemberMoneyEventKey;

function part(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || (value.includes(":") || value.includes("|"))) {
    throw new Error(`A member-money event key's ${label} must be a non-empty identity without ':' or '|' or surrounding space.`);
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
  bookingCharge: (bookingId: string) => key(`booking-charge:${part(bookingId, "booking id")}`),
  /** R02/R03: one per modification row. */
  modification: (modificationId: string) => key(`modification:${part(modificationId, "modification id")}`),
  /** R04: a booking can be cancelled, restored and cancelled again, so the revision is part of the key. */
  cancellation: (bookingId: string, cancellationRevision: number) =>
    key(`cancellation:${part(bookingId, "booking id")}:${revision(cancellationRevision)}`),
  /**
   * R21: one per closure of a review task. A task can be reopened and closed
   * again, so the closure is named by the first legacy line it writes, as the
   * back-post is: a line is written once, so a retry finds its batch.
   */
  reviewClose: (taskId: string, firstLineId: string) =>
    key(`review-close:${part(taskId, "task id")}:${part(firstLineId, "first legacy line id")}`),
  /**
   * R26: the booking-ledger back-post filling lines a door could not post, for a
   * booking whose R01 is in the journal (#4627). Named by the first legacy line
   * it posts: a line is written once, so a retry finds its batch, and a run that
   * writes nothing posts nothing.
   */
  backPost: (firstLineId: string) => key(`back-post:${part(firstLineId, "first legacy line id")}`),
  /**
   * #4628 (M3c): the one restatement a bank-transfer booking's legacy
   * confirmation may need, when the lines it writes add up to other than the
   * charge its binding R01 and pre-settlement edits left in the journal. A
   * booking is confirmed on the legacy ledger once (`INV-MONEY-033`), so once.
   */
  chargeRestatement: (bookingId: string) => key(`charge-restatement:${part(bookingId, "booking id")}`),
  /** D4: one transfer per merge of two members. */
  merge: (fromMemberId: string, toMemberId: string) =>
    key(`merge:${part(fromMemberId, "merged-away member id")}:${part(toMemberId, "surviving member id")}`),
  capture: (id: string) => key(`capture:${part(id, "capture intent")}`),
  receipt: (transactionId: string, settlementLineId: string) => key(`receipt:${part(transactionId, "transaction")}:${part(settlementLineId, "settlement line")}`),
  collect: (receipt: MemberMoneyEventKey) => key(`collect|${receipt}`),
  chargeOpen: (id: string) => key(`charge-open:${part(id, "booking")}`),
  refundObligation: (scope: RefundObligationScope, id: string) => key(`refund-obligation|${scope}|${nestedPart(id)}`),
  refundFunding: (attemptKey: string) => key(`refund-funding|${nestedPart(attemptKey)}`),
  refund: (id: string) => key(`refund:${part(id, "refund")}`),
  refundAnswer: (id: string) => key(`refund-answer:${part(id, "refund")}`),
  paidAnotherWay: (id: string) => key(`paid-another-way:${part(id, "record")}`),
  handBackPaid: (id: string) => key(`hand-back-paid:${part(id, "task")}`),
  refundCloseOut: (obligation: MemberMoneyEventKey) => key(`refund-close-out|${obligation}`),
  keptCapture: (id: string) => key(`kept-capture:${part(id, "capture")}`),
  successor: (obligationKey: string, from: string, to: string) => key(`successor|${obligationKey}|${nestedPart(from)}|${nestedPart(to)}`),
  mergeResidue: (from: string, to: string, event: MemberMoneyEventKey) => key(`merge-residue:${part(from, "from")}:${part(to, "to")}|${event}`),
  /**
   * #4516 review: a receipt's credit that a merge's snapshot netted into the survivor's balance, named on the
   * owner that now collects it as a zero-net stand-in, so its application keeps the obligation's debtor.
   */
  mergeFollow: (event: MemberMoneyEventKey, to: string) => key(`merge-follow|${event}|${nestedPart(to)}`),
  /** An exact whole-batch reversal: the database allows one per journal, so the journal names it. */
  reversal: (journalId: string) => key(`reversal:${part(journalId, "journal id")}`),
} as const;

/** An embedded identity may contain colons; a pipe always belongs to the builder. */
function nestedPart(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("|")) {
    throw new Error("A nested member-money identity must be non-empty and contain no '|'.");
  }
  return value;
}

export type RefundObligationScope = "cancellation" | "modification" | "refund-request" | "review" | "capture-return" | "hand-back";

/** What joins an obligation's key to its successor's: only the successor builder and its readers below use it. */
const SUCCESSOR = "|for|";

/** M4 identities. Composite arguments must themselves come from these builders. */
export const memberMoneyApplicationKeys = {
  application: (event: MemberMoneyEventKey, sourceIdentity: string, obligationKey: string) =>
    `${event}|${nestedPart(sourceIdentity)}|${obligationKey}`,
  successor: (obligationKey: string, debtorKind: "MEMBER" | "ORGANISATION", id: string) =>
    `${obligationKey}${SUCCESSOR}${debtorKind}|${nestedPart(id)}`,
  /** Whether `candidate` is a successor `successor` built from `obligationKey`, at any depth of its chain. */
  succeeds: (candidate: string, obligationKey: string) => candidate.startsWith(`${obligationKey}${SUCCESSOR}`),
  /** The root key a successor chain started from: the key itself for a root obligation. */
  root: (obligationKey: string) => obligationKey.split(SUCCESSOR)[0]!,
};

/** The first posting uses the base; a retry after reversal names that exact reversal. */
export function memberMoneyChainKey(base: MemberMoneyEventKey, reversalJournalId?: string): MemberMoneyEventKey {
  return reversalJournalId === undefined ? base : key(`${base}|after|${nestedPart(reversalJournalId)}`);
}

/** Walk exact reversal identities; a retry returns the same live tip. No revision counter or clock. */
export async function walkMemberMoneyChain(
  base: MemberMoneyEventKey,
  find: (eventKey: MemberMoneyEventKey) => Promise<{ reversedBy: { id: string } | null } | null>,
): Promise<MemberMoneyEventKey> {
  let current = base;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) throw new Error("Cyclic member-money reversal chain");
    seen.add(current);
    const journal = await find(current);
    if (!journal?.reversedBy) return current;
    current = memberMoneyChainKey(base, journal.reversedBy.id);
  }
}
