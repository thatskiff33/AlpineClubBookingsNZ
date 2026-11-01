import type { Prisma } from "@prisma/client";
import { bookingOwnerProviderMetadata } from "../../booking-owner";
import { calendarDateOfDateOnlyInstant } from "../../club-time";
import {
  bookingChargeEventIdentity,
  planBookingChargeEvent,
  planMemberMergeTransfer,
  type BookingChargeEvent,
  type LegacyChargeLine,
} from "./booking-charges";
import { readBookingLiveComponents } from "./booking-journal-read";
import { memberMoneyEventKeys, type MemberMoneyEventKey } from "./keys";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { MemberMoneyPlanError, type MemberMoneyDebtor } from "./plan";
import { postMemberMoneyEvent } from "./post";
import type { MemberMoneyPosting } from "./store";

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
 * journal is inactive (`journal-activity.ts`) posts nothing at all.
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

/** This event's legacy lines, read back by the keys the door just wrote, that no batch bridges yet. */
async function unbridgedLines(tx: Db, bookingId: string, postingKeys: readonly string[]): Promise<LegacyChargeLine[]> {
  if (postingKeys.length === 0) return [];
  const rows = await tx.bookingLedgerLine.findMany({
    where: { bookingId, postingKey: { in: [...postingKeys] }, memberMoneySourceLink: { is: null } },
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
  | Exclude<BookingChargeEvent, { kind: "review-close" | "back-post" }>
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
  const named = input.event;
  if (named.kind !== "back-post" && named.kind !== "review-close"
    && await eventPosted(tx, bookingChargeEventIdentity(input.bookingId, named).eventKey)) {
    return null;
  }
  if (named.kind !== "confirmation" && !(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(input.bookingId)))) {
    return null;
  }
  const lines = (await unbridgedLines(tx, input.bookingId, input.postingKeys)).filter((line) => line.amountCents !== 0);
  // A confirmation posts R01 even with no money (a ZERO event); nothing else does.
  if (lines.length === 0 && named.kind !== "confirmation") return null;
  const event: BookingChargeEvent = named.kind === "back-post" ? { kind: "back-post", firstLineId: lines[0]!.id }
    : named.kind === "review-close" ? { ...named, firstLineId: lines[0]!.id } : named;
  const debtor = await lockedBookingDebtor(tx, input.bookingId);
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
  if (isBookingJournalInactive(context)) return null;
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
