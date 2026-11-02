import type { Prisma } from "@prisma/client";
import { bookingOwnerProviderMetadata } from "../../booking-owner";
import { calendarDateOfDateOnlyInstant } from "../../club-time";
import logger from "../../logger";
import {
  BINDING_CHARGE_SOURCE_VERSION,
  bookingChargeEventIdentity,
  bookingComponentKey,
  planBookingChargeEvent,
  planMemberMergeTransfer,
  type BookingChargeEvent,
  type LegacyChargeLine,
} from "./booking-charges";
import { readBookingLiveComponents } from "./booking-journal-read";
import {
  planPendingBookingCharge,
  standingComponentTargets,
  type PendingChargeEvent,
  type StandingChargeLine,
} from "./booking-pending-charges";
import { memberMoneyEventKeys, type MemberMoneyEventKey } from "./keys";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { MemberMoneyPlanError, type MemberMoneyDebtor, type MemberMoneyPostingContext } from "./plan";
import { postMemberMoneyEvent } from "./post";
import { linkLegacyLinesToPostedBatch, type MemberMoneyPosting } from "./store";

/**
 * THE BOOKING DOORS' WAY INTO THE JOURNAL (#4627, Ledger M3b). Each legacy
 * chokepoint (confirmation, modification, review close, cancellation) calls
 * `postBookingLedgerJournal` right after its legacy write, in the same
 * transaction, with the posting keys it just wrote and a context resolved
 * before the transaction opened. Nothing here catches a refusal: a plan the
 * engine refuses, or a batch the database refuses at commit, rolls the door's
 * business change back with it (design section 3).
 *
 * PRECONDITION, the door's: it holds `pg_advisory_xact_lock(1)`, which is all
 * the engine asserts (it refuses a correction or re-charge without it). Most
 * doors also hold their lodge key, but an edit review's closure and the
 * organiser's per-child cancel do not, so nothing here reads capacity. This
 * takes the booking row's lock (`FOR NO KEY UPDATE`, an UPDATE's own strength)
 * before it reads the owner, so a member merge's owner move either commits
 * first and is seen here, or waits for this door and then sees what it posted.
 *
 * WHAT POSTS. R01 posts at a booking's first confirmation, as a ZERO event when
 * it carries no money. Every later event posts only for a booking whose R01 is
 * in the journal: a booking confirmed before M3b has its history back-posted by
 * M9, never piecemeal here. An event already posted is a no-op, as the legacy
 * write's `ON CONFLICT DO NOTHING` is; a closure and the back-post are named by
 * the first line they write, so a repeat finds nothing unbridged. A club whose
 * journal is inactive (`journal-activity.ts`) posts nothing at all; once it is
 * active again, the next event on a booking in the journal first posts, as one
 * gap-fill batch, every money line written meanwhile (`postCatchUp`).
 */

type Db = Prisma.TransactionClient;

/**
 * The booking's owner, read under its row lock: the receivable's debtor
 * (`bookingOwnerProviderMetadata`, exactly one). Lock raw, read typed (#2289): the lock
 * selects a constant, the owner comes back through the Prisma model.
 */
async function lockedBookingDebtor(tx: Db, bookingId: string): Promise<MemberMoneyDebtor> {
  await tx.$executeRaw`SELECT 1 FROM "Booking" WHERE "id" = ${bookingId} FOR NO KEY UPDATE`;
  const booking = await tx.booking.findUnique({ where: { id: bookingId }, select: { memberId: true, organisationId: true } });
  if (!booking) throw new MemberMoneyPlanError([`booking ${bookingId} does not exist`]);
  // `INV-SSOT-005`: who owns a booking is `booking-owner.ts`'s answer, never re-derived here.
  const owner = bookingOwnerProviderMetadata(booking);
  return "memberId" in owner ? { kind: "MEMBER", memberId: owner.memberId } : { kind: "ORGANISATION", organisationId: owner.organisationId };
}

async function eventPosted(tx: Db, eventKey: MemberMoneyEventKey): Promise<boolean> {
  return (await tx.memberMoneyEvent.findUnique({ where: { eventKey }, select: { id: true } })) !== null;
}

/**
 * Legacy lines no batch bridges yet: this event's, read back by the keys the
 * door just wrote, or (`"every charge line"`) every charge-side line of the
 * booking with money, for the catch-up below.
 */
async function unbridgedLines(tx: Db, bookingId: string, postingKeys: readonly string[] | "every charge line"): Promise<LegacyChargeLine[]> {
  if (postingKeys !== "every charge line" && postingKeys.length === 0) return [];
  const rows = await tx.bookingLedgerLine.findMany({
    where: postingKeys === "every charge line"
      ? { bookingId, side: { not: "SETTLEMENT" }, amountCents: { not: 0 }, memberMoneySourceLink: { is: null } }
      : { bookingId, postingKey: { in: [...postingKeys] }, memberMoneySourceLink: { is: null } },
    orderBy: { id: "asc" },
    select: {
      id: true, bookingId: true, lodgeId: true, side: true, kind: true, amountCents: true, quantity: true, unitCents: true,
      postingKey: true, reversesLineId: true, bookingGuestId: true, nightStart: true,
      reverses: { select: { postingKey: true } },
    },
  });
  return rows.map(({ reverses, nightStart, ...line }) => ({
    ...line,
    reversedPostingKey: reverses?.postingKey ?? null,
    night: nightStart === null ? null : calendarDateOfDateOnlyInstant(nightStart),
  }));
}

/** An event as a door names it; a closure and the back-post are named by the first line they write, read back here. */
export type BookingLedgerJournalEvent =
  | Exclude<BookingChargeEvent, { kind: "review-close" | "back-post" | "binding" | "restatement" }>
  | { kind: "review-close"; taskId: string; officerMemberId: string }
  | { kind: "back-post" };

export interface BookingLedgerJournalInput {
  bookingId: string;
  lodgeId: string;
  event: BookingLedgerJournalEvent;
  /** The posting keys of the legacy lines this event just wrote. */
  postingKeys: readonly string[];
}

/** Post one booking charge event beside its legacy lines; null when nothing is posted (see the module doc). */
export async function postBookingLedgerJournal(
  tx: Db,
  context: BookingJournalContext,
  input: BookingLedgerJournalInput,
): Promise<MemberMoneyPosting | null> {
  if (isBookingJournalInactive(context)) return null;
  // #4628: a bank-transfer booking charged at its binding moment links its
  // first legacy lines (its confirmation's) to that charge before anything
  // else reads them, so they are never charged a second time.
  await bridgeBindingCharge(tx, context, input.bookingId, input.lodgeId);
  const named = input.event;
  if (named.kind !== "back-post" && named.kind !== "review-close"
    && await eventPosted(tx, bookingChargeEventIdentity(input.bookingId, named).eventKey)) {
    return null;
  }
  const charged = named.kind !== "confirmation" && await eventPosted(tx, memberMoneyEventKeys.bookingCharge(input.bookingId));
  if (named.kind !== "confirmation" && !charged) return null;
  const lines = (await unbridgedLines(tx, input.bookingId, input.postingKeys)).filter((line) => line.amountCents !== 0);
  const debtor = await lockedBookingDebtor(tx, input.bookingId);
  // Self-healing: a booking in the journal whose money lines a door wrote while
  // the journal was inactive posts them first, as one gap-fill batch, so the
  // live components match the legacy lines before this event plans against them.
  if (charged) await postCatchUp(tx, context, input, new Set(lines.map((line) => line.id)), debtor);
  // A confirmation posts R01 even with no money (a ZERO event); nothing else does.
  if (lines.length === 0 && named.kind !== "confirmation") return null;
  const event: BookingChargeEvent = named.kind === "back-post" ? { kind: "back-post", firstLineId: lines[0]!.id }
    : named.kind === "review-close" ? { ...named, firstLineId: lines[0]!.id } : named;
  const plan = planBookingChargeEvent({
    bookingId: input.bookingId,
    lodgeId: input.lodgeId,
    event,
    debtor,
    lines,
    liveComponents: await readBookingLiveComponents(tx, input.bookingId),
  });
  return plan ? postMemberMoneyEvent(tx, context, plan) : null;
}

/** The catch-up: every unbridged charge line of the booking but this event's own, as one R26 batch. */
async function postCatchUp(
  tx: Db,
  context: MemberMoneyPostingContext,
  input: BookingLedgerJournalInput,
  own: ReadonlySet<string>,
  debtor: MemberMoneyDebtor,
): Promise<void> {
  const pending = (await unbridgedLines(tx, input.bookingId, "every charge line")).filter((line) => !own.has(line.id));
  if (pending.length === 0) return;
  const plan = planBookingChargeEvent({
    bookingId: input.bookingId,
    lodgeId: input.lodgeId,
    event: { kind: "back-post", firstLineId: pending[0]!.id },
    debtor,
    lines: pending,
    liveComponents: await readBookingLiveComponents(tx, input.bookingId),
  });
  if (plan) await postMemberMoneyEvent(tx, context, plan);
}

/**
 * #4628 (M3c): A BANK-TRANSFER BOOKING'S CHARGE BEFORE SETTLEMENT. The door
 * holds `lock(1)` (and its lodge key, where it has one) and has written its
 * business change; `standing` is what its legacy side planned the booking's
 * confirmation would post now (`booking-pending-charges.ts`). The binding R01
 * posts once, under the confirmation's own key; an edit or cancellation before
 * the legacy confirmation re-states the charge, and posts only for a booking
 * whose R01 is a binding R01 with no legacy line bridged yet. Any other booking
 * posts nothing here: one confirmed on the legacy ledger posts through
 * `postBookingLedgerJournal`, one never bound is not a sale. A repeat is a no-op.
 */
export async function postPendingBookingJournal(
  tx: Db,
  context: BookingJournalContext,
  input: {
    bookingId: string;
    lodgeId: string;
    event: Exclude<PendingChargeEvent, { kind: "restatement" }>;
    /**
     * Planned only once the booking is known to post, so a booking never bound
     * costs no plan; null where the legacy planner declined (it logs why), which posts nothing.
     */
    standing: () => Promise<readonly StandingChargeLine[] | null>;
  },
): Promise<MemberMoneyPosting | null> {
  if (isBookingJournalInactive(context)) return null;
  if (await eventPosted(tx, bookingChargeEventIdentity(input.bookingId, input.event).eventKey)) return null;
  if (input.event.kind !== "binding" && !(await pendingBindingCharge(tx, input.bookingId))) return null;
  const standing = await input.standing();
  if (standing === null) return null;
  const debtor = await lockedBookingDebtor(tx, input.bookingId);
  const plan = planPendingBookingCharge({
    bookingId: input.bookingId,
    lodgeId: input.lodgeId,
    event: input.event,
    debtor,
    standing,
    liveComponents: await readBookingLiveComponents(tx, input.bookingId),
  });
  return plan ? postMemberMoneyEvent(tx, context, plan) : null;
}

/**
 * The booking's binding R01, while its charge is still pending: posted at a
 * binding moment, and no legacy line of the booking yet bridged to the journal.
 * Null for a booking never bound, or one whose confirmation has been linked.
 */
async function pendingBindingCharge(tx: Db, bookingId: string): Promise<{ journalId: string; receivableLegId: string | null } | null> {
  const r01 = await tx.memberMoneyEvent.findUnique({
    where: { eventKey: memberMoneyEventKeys.bookingCharge(bookingId) },
    select: { sourceVersion: true, journal: { select: { id: true, lines: { where: { account: "MEMBER_RECEIVABLE" }, orderBy: { id: "asc" }, take: 1, select: { id: true } } } } },
  });
  if (r01?.sourceVersion !== BINDING_CHARGE_SOURCE_VERSION || !r01.journal) return null;
  const bridged = await tx.memberMoneySourceLink.findFirst({ where: { bookingLedgerLine: { bookingId } }, select: { id: true } });
  if (bridged) return null;
  return { journalId: r01.journal.id, receivableLegId: r01.journal.lines[0]?.id ?? null };
}

/**
 * THE CONFIRMATION BRIDGE (#4628; `INV-MONEY-042`). A booking charged at its
 * binding moment has no legacy line until its confirmation writes them, under
 * the same `lock(1)`. Its first legacy lines (whichever door writes them: the
 * settle, the Xero receipt, an edit's zero-dollar auto-pay, the back-post) are
 * linked here to the binding R01, by source links appended to that sealed batch
 * and postings naming its receivable leg. They post no second charge.
 *
 * The confirmation is planned from the same stored rows as the standing charge,
 * so its lines add up, component by component, to what the journal carries.
 * Where a writer moved the price without posting, they do not: the journal is
 * first re-stated to the lines, once (`chargeRestatement`), and that is logged,
 * because it means a door changed the price without a journal event.
 */
async function bridgeBindingCharge(tx: Db, context: MemberMoneyPostingContext, bookingId: string, lodgeId: string): Promise<void> {
  const pending = await pendingBindingCharge(tx, bookingId);
  if (!pending) return;
  const lines = (await unbridgedLines(tx, bookingId, "every charge line")).filter((line) => line.amountCents !== 0);
  if (lines.length === 0) return;
  const live = await readBookingLiveComponents(tx, bookingId);
  const targets = standingComponentTargets(bookingId, lines);
  const liveByKey = new Map(live.map((component) => [bookingComponentKey(component), component.liveGrossCents]));
  const moved = [...targets].some(([key, target]) => (liveByKey.get(key) ?? 0) !== target.grossCents)
    || live.some((component) => component.liveGrossCents !== 0 && !targets.has(bookingComponentKey(component)));
  if (moved) {
    const debtor = await lockedBookingDebtor(tx, bookingId);
    const plan = planPendingBookingCharge({ bookingId, lodgeId, event: { kind: "restatement" }, debtor, standing: lines, liveComponents: live });
    if (plan) await postMemberMoneyEvent(tx, context, plan);
    logger.warn(
      { bookingId, journal: live, lines: [...targets.values()] },
      "Member-money journal: a bank-transfer booking's confirmation lines differ from the charge posted before settlement; restated (#4628)",
    );
  }
  await linkLegacyLinesToPostedBatch(tx, {
    journalId: pending.journalId,
    receivableLegId: pending.receivableLegId,
    lines: lines.map((line) => ({ id: line.id, version: line.postingKey ?? line.id })),
  });
}

/**
 * D4 (#4627): after a merge has moved the merged-away member's bookings and
 * holds its `Member … FOR UPDATE`, transfer every receivable balance the
 * journal still carries for that member to the survivor. It re-reads the
 * balances there, so a door that posted to the merged-away member before the
 * owner move is counted, and every door after it posts to the survivor.
 */
export async function postMemberMergeTransfer(
  tx: Db,
  context: BookingJournalContext,
  input: { fromMemberId: string; toMemberId: string; actorMemberId: string },
): Promise<MemberMoneyPosting | null> {
  // Merge refuses before its transaction while the journal is inactive (a lost
  // transfer could never be recovered); reaching here inactive is a caller bug.
  if (isBookingJournalInactive(context)) throw new Error("A member merge cannot post its D4 transfer while the journal is inactive (#4627).");
  if (await eventPosted(tx, memberMoneyEventKeys.merge(input.fromMemberId, input.toMemberId))) return null;
  const sums = await tx.memberMoneyLine.groupBy({
    by: ["bookingId", "lodgeId", "side"],
    where: { account: "MEMBER_RECEIVABLE", debtorKind: "MEMBER", memberId: input.fromMemberId },
    orderBy: [{ bookingId: "asc" }, { lodgeId: "asc" }, { side: "asc" }],
    _sum: { amountCents: true },
  });
  const balances = new Map<string, { bookingId: string | null; lodgeId: string | null; cents: number }>();
  for (const row of sums) {
    const key = `${row.bookingId ?? ""}\u0000${row.lodgeId ?? ""}`;
    const entry = balances.get(key) ?? { bookingId: row.bookingId, lodgeId: row.lodgeId, cents: 0 };
    entry.cents += (row.side === "DEBIT" ? 1 : -1) * (row._sum.amountCents ?? 0);
    balances.set(key, entry);
  }
  const plan = planMemberMergeTransfer({ ...input, balances: [...balances.values()] });
  return plan ? postMemberMoneyEvent(tx, context, plan) : null;
}
