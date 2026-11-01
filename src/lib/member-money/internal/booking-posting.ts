import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { calendarDateOfDateOnlyInstant } from "../../club-time";
import { decodeRawRows } from "../../raw-sql-rows";
import {
  bookingChargeEventIdentity,
  bookingComponentKey,
  journalComponentOfLegacyLine,
  planBookingChargeEvent,
  planMemberMergeTransfer,
  type BookingChargeComponent,
  type BookingChargeEvent,
  type LegacyChargeLine,
} from "./booking-charges";
import { liveComponentGross } from "./components";
import { memberMoneyEventKeys, type MemberMoneyEventKey } from "./keys";
import { MemberMoneyPlanError, type MemberMoneyDebtor, type MemberMoneyPostingContext } from "./plan";
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
 * PRECONDITIONS, the door's: it holds `pg_advisory_xact_lock(1)` (the engine
 * refuses a correction or re-charge without it) and its lodge key, and it has
 * already written the booking's row in this transaction, or this takes that
 * row's lock itself (`FOR NO KEY UPDATE`, an UPDATE's own strength) before it
 * reads the owner: so a member merge's owner move either commits first and is
 * seen here, or waits for this door and then sees what it posted.
 *
 * WHAT POSTS. R01 posts when the confirmation wrote lines. Every later event
 * posts only for a booking whose R01 is in the journal: a booking confirmed
 * before M3b has its history back-posted by M9, never piecemeal here. An event
 * already posted is a no-op, as the legacy write's `ON CONFLICT DO NOTHING` is.
 */

type Db = Prisma.TransactionClient;

const OWNER_ROW = z.object({ memberId: z.string().nullable(), organisationId: z.string().nullable() });

/** The booking's owner, read under its row lock: the receivable's debtor (`bookingOwner`'s rule: exactly one). */
async function lockedBookingDebtor(tx: Db, bookingId: string): Promise<MemberMoneyDebtor> {
  const rows = decodeRawRows(
    await tx.$queryRaw`SELECT "memberId", "organisationId" FROM "Booking" WHERE "id" = ${bookingId} FOR NO KEY UPDATE`,
    OWNER_ROW,
    "booking owner",
  );
  const owner = rows[0];
  if (!owner) throw new MemberMoneyPlanError([`booking ${bookingId} does not exist`]);
  if (owner.organisationId !== null && owner.memberId === null) return { kind: "ORGANISATION", organisationId: owner.organisationId };
  if (owner.memberId !== null && owner.organisationId === null) return { kind: "MEMBER", memberId: owner.memberId };
  throw new MemberMoneyPlanError([`booking ${bookingId} has no single owner to owe its charges`]);
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

/** The live gross each component carries, from its posted revenue legs. A read only. */
async function readLiveGross(tx: Db, components: readonly BookingChargeComponent[]): Promise<Map<string, number>> {
  if (components.length === 0) return new Map();
  const posted = await tx.memberMoneyLine.findMany({
    where: { OR: components.map(({ account, chargeIdentity }) => ({ account, chargeIdentity })) },
    select: { account: true, chargeIdentity: true, side: true, amountCents: true,
      grossCents: true, netCents: true, taxCents: true, taxCode: true, bookingId: true, lodgeId: true },
  });
  return liveComponentGross(posted);
}

export interface BookingLedgerJournalInput {
  bookingId: string;
  lodgeId: string;
  event: BookingChargeEvent;
  /** The posting keys of the legacy lines this event just wrote. */
  postingKeys: readonly string[];
}

/** Post one booking charge event beside its legacy lines; null when nothing is posted (see the module doc). */
export async function postBookingLedgerJournal(
  tx: Db,
  context: MemberMoneyPostingContext,
  input: BookingLedgerJournalInput,
): Promise<MemberMoneyPosting | null> {
  const { eventKey } = bookingChargeEventIdentity(input.bookingId, input.event);
  if (await eventPosted(tx, eventKey)) return null;
  if (input.event.kind !== "confirmation" && !(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(input.bookingId)))) {
    return null;
  }
  const lines = (await unbridgedLines(tx, input.bookingId, input.postingKeys)).filter((line) => line.amountCents !== 0);
  if (lines.length === 0) return null;
  const debtor = await lockedBookingDebtor(tx, input.bookingId);
  const components = new Map<string, BookingChargeComponent>();
  for (const line of lines) {
    const component = journalComponentOfLegacyLine(line);
    if (component) components.set(bookingComponentKey(component), component);
  }
  const plan = planBookingChargeEvent({
    bookingId: input.bookingId,
    lodgeId: input.lodgeId,
    event: input.event,
    debtor,
    lines,
    liveGrossCents: await readLiveGross(tx, [...components.values()]),
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
  context: MemberMoneyPostingContext,
  input: { fromMemberId: string; toMemberId: string; actorMemberId: string },
): Promise<MemberMoneyPosting | null> {
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
