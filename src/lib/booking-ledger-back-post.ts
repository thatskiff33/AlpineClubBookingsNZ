import "server-only";

/**
 * THE BACK-POST: HISTORY'S LEDGER LINES, POSTED BY THE LIVE POSTERS (#3583 PR 2,
 * programme #3527; design `docs/design/booking-ledger.md` §6, §7, owner decision
 * D-3532-1).
 *
 * Every booking made before #3580–#3582 has money columns and no lines. This
 * posts them, one booking per transaction, by running the posters production
 * runs — not a second statement of how a line is shaped (`INV-SSOT`):
 *
 *   settlement   `syncBookingLedgerSettlements` (captures, receipts, cash, refunds)
 *   credit       `syncBookingLedgerCredits` (applied, issued, restored)
 *   hand-back    `postHandBackLedgerLine`, for a completed task the resolver's
 *                route rule sends by hand (`chooseEditReviewSettlementRoute`)
 *   confirmation `planConfirmationChargeLines` over the night rows as they stand:
 *                every strand night by night, an inexact one included (orchestrator
 *                decision A on #3583 — a strand-sized line would fail
 *                `isSingleNightLine`, and every later closure would post nothing)
 *   an old edit  `planModificationChargeLines`: its change fee, and, on a booking
 *                already confirmed on the ledger, the nights it moved — re-derived
 *                from the live lines and the night rows as they stand, its stored
 *                `priceLines` read only to check the total (LANE-SYNC from #3582);
 *                which edits still await lines is the census's own rule
 *                (`postConfirmationEditsWithoutLines`), so a second run agrees
 *   cancellation `postCancellationLedgerLines`, with the kept figure the CANCELLED
 *                event froze (#3611), or replayed from the frozen retained figure
 *                and the booking's credit rows through `cancellationKeptCents`
 *   group child  its share, plan refund and organiser-cancel kept figure through
 *                the live group posters' planners and keys (#3854,
 *                `booking-ledger-back-post-group.ts`)
 *
 * Every key is built by `booking-ledger-posting-keys.ts`, every row goes through
 * the one write door, and an edit that already has a line anchored on it is
 * skipped: it posted all its lines or none (§6, "The back-post skips an edit
 * that has already posted").
 *
 * NEVER GUESSED. After posting, and inside the same transaction, the booking is
 * judged by the census's own evaluation (`evaluateBookingLedgerIdentities`) on
 * the row it now reads. A booking left with a disagreement, a coverage gap or an
 * integrity finding is rolled back and LISTED with the reason and both figures;
 * a named class is not a refusal (the census reports it, and the owner signs it
 * off). A booking that cannot be planned at all — an unpriced night, a price its
 * nights do not reach — is listed the same way, a group-settled child included:
 * the census plans that child's lines itself and holds the gate on one that
 * could not be posted (#3854 F1), so it never stays `GROUP_SETTLEMENT_OFF_LEDGER`.
 *
 * CONCURRENCY. Each booking's transaction takes the locks its live posters take,
 * in canonical order (`INV-LOCK-002`, `docs/CONCURRENCY_AND_LOCKING.md`): the
 * global `lock(1)` every settle, cancel, edit and closure posts under; the
 * booking's lodge key; the member credit-ledger key of every member whose credit
 * rows it reads; then the payment and booking rows. Everything is read again
 * under them, so a booking that changes mid-run is either seen whole or waited
 * for. Idempotent by construction: every key is deterministic and the write
 * skips one already posted, and the confirmation is fenced per booking (§4.1a).
 *
 * A DRY RUN IS THE SAME TRANSACTION, ROLLED BACK. It takes the same locks, posts,
 * judges and then throws, so what it reports is exactly what `--apply` would
 * post. Nothing it does is visible to anyone else.
 *
 * ONE BOOKING'S SURPRISE IS ITS OWN. Any error in a booking's transaction rolls
 * that booking back and lists it (`UNEXPECTED_ERROR`, or `LOCK_TIMEOUT` for a
 * re-run); the run goes on, and every outcome is reported as it happens. Each
 * run has an id and a window, and every line it inserted is named by id, so
 * what a run posted can always be found again.
 */
import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import { planGroupChildBackPost } from "@/lib/booking-ledger-back-post-group";
import { postHandBackLedgerLine } from "@/lib/booking-ledger-hand-back";
import { postCancellationLedgerLines } from "@/lib/booking-ledger-cancellation-sync";
import { planConfirmationChargeLines } from "@/lib/booking-ledger-confirmation-posting";
import { syncBookingLedgerCredits } from "@/lib/booking-ledger-credit-sync";
import {
  liveLines,
  planModificationChargeLines,
  pricingSideFromLiveLedger,
  type ModificationPostingPlan,
} from "@/lib/booking-ledger-modification-posting";
import { handBackKey, modificationChangeFeeKey } from "@/lib/booking-ledger-posting-keys";
import {
  evaluateBookingLedgerIdentities,
  postConfirmationEditsWithoutLines,
  type BookingLedgerEvaluation,
} from "@/lib/booking-ledger-projection-census";
import type { BookingLedgerCensusRow } from "@/lib/booking-ledger-projection-census-row";
import { cancelledSnapshotKept, readBookingLedgerCensusRow } from "@/lib/booking-ledger-projection-census-store";
import { bookingHasConfirmationLines, findPostedChargeLines } from "@/lib/booking-ledger-read";
import { syncBookingLedgerSettlements } from "@/lib/booking-ledger-settlement-sync";
import {
  buildBookingLedgerRows,
  ledgerLineAmountCents,
  writeBookingLedgerRows,
  type BookingLedgerPosting,
} from "@/lib/booking-ledger-write";
import { modificationPromoDeltaCents } from "@/lib/booking-modification-promo-delta";
import {
  diffGuestNights,
  parseModificationLines,
  pricingSideFromWrittenGuests,
  sumModificationLines,
  type ModificationPricingSide,
} from "@/lib/booking-modification-lines";
import {
  type BackPostRefusal,
  type BookingBackPostOutcome,
  type BookingLedgerBackPostRun,
} from "@/lib/booking-ledger-back-post-report";
import { bookingOwner } from "@/lib/booking-owner";
import { isPaidLikeBookingStatus } from "@/lib/booking-status";
import { handsBackByHand } from "@/lib/manual-refund-hand-back-route";
import { acquireLodgeCapacityLock } from "@/lib/lodge-capacity-lock";
import { deriveBookingAppliedCreditCents, lockMemberCreditLedger } from "@/lib/member-credit";
import { cancellationKeptCents } from "@/lib/cancellation-kept";
import { bookingsCreditRowsWhere } from "@/lib/member-credit-booking-rows";

type CannotPost = Extract<BookingBackPostOutcome, { kind: "CANNOT_POST" }>;

function cannotPost(bookingId: string, reason: BackPostRefusal, detail: string, evaluation?: BookingLedgerEvaluation): CannotPost {
  return {
    bookingId,
    kind: "CANNOT_POST",
    reason,
    detail,
    disagreements: (evaluation?.identities ?? [])
      .filter((identity) => identity.status === "DISAGREE")
      .map(({ identity, columnCents, ledgerCents, deltaCents }) => ({ identity, columnCents, ledgerCents, deltaCents })),
    coverage: evaluation?.coverage ?? [],
    integrity: (evaluation?.integrity ?? []).map((finding) => `${finding.kind} on line ${finding.lineId}: ${finding.detail}`),
  };
}

/** Thrown to end a booking's transaction without committing it: a refusal, or any dry run. */
class BackPostRollback extends Error {
  constructor(readonly outcome: BookingBackPostOutcome) {
    super("booking ledger back-post: rolled back");
    this.name = "BackPostRollback";
  }
}

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Locks: the live posters' own, in canonical order (INV-LOCK-002)
// ---------------------------------------------------------------------------

/**
 * Global `lock(1)` → the lodge key → every member credit-ledger key the
 * booking's credit rows name (sorted, so two lockers cannot deadlock) → the
 * payment row → the booking row. Returns false where the booking is gone.
 */
async function lockBookingForBackPost(tx: Tx, bookingId: string): Promise<boolean> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  // Every later wait in this transaction happens while the global key is held,
  // so it is bounded: a booking whose rows another writer holds for longer is
  // rolled back and listed for a re-run (`LOCK_TIMEOUT`), never left blocking
  // every settle behind it. `lock(1)` itself waits as every poster's does.
  await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  // The lodge never changes for a booking; read once, under lock(1).
  const lodge = await tx.booking.findUnique({ where: { id: bookingId }, select: { lodgeId: true } });
  if (!lodge) return false;
  await acquireLodgeCapacityLock(tx, lodge.lodgeId);
  // The owner is read only under the lodge key, which member merge holds when
  // it re-points a booking's owner (the settle path's order since #3792).
  const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { memberId: true } });
  const creditMembers = await tx.memberCredit.findMany({
    where: bookingsCreditRowsWhere([bookingId]),
    select: { memberId: true },
    distinct: ["memberId"],
  });
  const owner = bookingOwner(booking).memberId;
  const members = [...new Set([...(owner ? [owner] : []), ...creditMembers.map((row) => row.memberId)])].sort();
  for (const memberId of members) await lockMemberCreditLedger(memberId, tx);
  // The payment row before the booking row, as the card-refund writer takes it
  // (`lockPaymentForRefundedTotal`) — the one settlement writer that reaches the
  // ledger without lock(1) — and NO KEY UPDATE on both, so a ledger line's
  // foreign-key share lock on the booking is not refused. Booking-first with
  // FOR UPDATE deadlocked against a live card refund on real PostgreSQL.
  await tx.$executeRaw`SELECT 1 FROM "Payment" WHERE "bookingId" = ${bookingId} FOR NO KEY UPDATE`;
  await tx.$executeRaw`SELECT 1 FROM "Booking" WHERE "id" = ${bookingId} FOR NO KEY UPDATE`;
  return true;
}

// ---------------------------------------------------------------------------
// What the booking holds, read under the locks
// ---------------------------------------------------------------------------

const BOOKING_SELECT = {
  id: true,
  lodgeId: true,
  status: true,
  totalPriceCents: true,
  promoAdjustmentCents: true,
  finalPriceCents: true,
  payment: { select: { id: true, source: true } },
  guests: {
    orderBy: { id: "asc" },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      isMember: true,
      rateMembershipTypeId: true,
      nights: { orderBy: { stayDate: "asc" }, select: { stayDate: true, priceCents: true } },
    },
  },
  modifications: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, modificationType: true, priceDiffCents: true, changeFeeCents: true, priceLines: true, createdAt: true },
  },
  manualRefundTasks: {
    orderBy: { id: "asc" },
    select: {
      id: true,
      kind: true,
      status: true,
      amountCents: true,
      settlementDirection: true,
      paymentId: true,
      lateCaptureApprovalIntentId: true,
      completedByMemberId: true,
      payment: { select: { source: true } },
    },
  },
  events: {
    where: { type: "CANCELLED" },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: 1,
    select: { snapshot: true },
  },
} as const satisfies Prisma.BookingSelect;

type BackPostBooking = Prisma.BookingGetPayload<{ select: typeof BOOKING_SELECT }>;

/**
 * What the club kept on a cancellation, from the paid path's CANCELLED snapshot
 * (`cancelledSnapshotKept`, the reading the census plans a group child by). A
 * snapshot from before #3611 froze only the retained figure, from which the
 * kept figure is replayed with the booking's credit rows through the one
 * formula (`cancellationKeptCents`). Null where the snapshot holds neither.
 */
async function cancellationKept(
  tx: Tx,
  booking: BackPostBooking,
): Promise<{ keptCents: number; policyKeptCents?: number } | null> {
  const kept = cancelledSnapshotKept(booking.events[0]?.snapshot);
  if (kept === null || !("retainedAmountCents" in kept)) return kept;
  const restored = await tx.memberCredit.aggregate({
    where: { restoredFromBookingId: booking.id },
    _sum: { amountCents: true },
  });
  return {
    keptCents: cancellationKeptCents({
      retainedAmountCents: kept.retainedAmountCents,
      appliedCreditCents: await deriveBookingAppliedCreditCents(booking.id, tx),
      creditRestoredCents: restored._sum.amountCents ?? 0,
    }),
  };
}

// ---------------------------------------------------------------------------
// The charge side
// ---------------------------------------------------------------------------

const EMPTY_SIDE: ModificationPricingSide = { guests: [], promoAdjustmentCents: 0 };

/**
 * One edit's change fee alone, through the edit planner itself: with no nights
 * on either side it plans exactly the `CHANGE_FEE` line a live edit posts,
 * under the same key and anchor.
 */
function changeFeeOnlyPlan(bookingId: string, lodgeId: string, modificationId: string, changeFeeCents: number): ModificationPostingPlan {
  return planModificationChargeLines({
    bookingId,
    lodgeId,
    bookingModificationId: modificationId,
    before: EMPTY_SIDE,
    after: EMPTY_SIDE,
    changeFeeCents,
    expectedCents: changeFeeCents,
    postedLines: [],
  });
}

/** The figure an unposted edit moved the price by, checked against its own stored lines. */
function editMovementCents(
  modification: BackPostBooking["modifications"][number],
  census: BookingLedgerCensusRow,
): { cents: number } | { refusal: BackPostRefusal; detail: string } {
  if (modification.modificationType === "PRICE_REBASE") {
    const rebase = census.modifications.find((row) => row.id === modification.id)?.reviewRebase ?? null;
    if (!rebase) return { refusal: "REBASE_MOVEMENT_UNREADABLE", detail: `re-price ${modification.id} records no readable movement` };
    return { cents: rebase.movementCents };
  }
  if (modification.priceLines !== null) {
    const lines = parseModificationLines(modification.priceLines);
    const total = lines === null ? null : sumModificationLines(lines);
    if (total !== modification.priceDiffCents) {
      return {
        refusal: "PRICE_LINES_DISAGREE",
        detail: `edit ${modification.id}: stored lines come to ${total ?? "unreadable"}, its price difference is ${modification.priceDiffCents}`,
      };
    }
  }
  return { cents: modification.priceDiffCents };
}

type ChargePlan = { postings: BookingLedgerPosting[]; steps: string[] };

/**
 * The charge lines history owes this booking: its confirmation where it has
 * none, its old edits' change fees and nights, then (in a later step, once
 * these are written) its cancellation.
 */
async function planHistoricChargeLines(
  tx: Tx,
  booking: BackPostBooking,
  census: BookingLedgerCensusRow,
  /** A child a group settlement paid: confirmed as the group settle confirms it, cancelled or not (#3854). */
  groupPaid: boolean,
): Promise<ChargePlan | CannotPost> {
  const cancelled = booking.status === "CANCELLED";
  const postings: ChargePlan["postings"] = [];
  const steps: string[] = [];
  const confirmedLines = census.lines.filter((line) => line.anchorKind === "CONFIRMATION");
  const confirmedAt = confirmedLines.length > 0 ? Math.min(...confirmedLines.map((line) => line.postedAt.getTime())) : null;
  const postedAnchors = new Set(census.lines.filter((line) => line.anchorKind === "MODIFICATION").map((line) => line.anchorId));
  // LANE-SYNC from #3582: an edit with any line anchored on it posted all of them.
  const unposted = booking.modifications.filter((modification) => !postedAnchors.has(modification.id));
  const cancellationPosted = census.lines.some((line) => line.anchorKind === "CANCELLATION" && line.side !== "SETTLEMENT");

  if (confirmedAt === null) {
    // The census's own rule for who must be confirmed: a paid-like booking, or
    // one the paid path cancelled (it froze a snapshot).
    const mustConfirm = isPaidLikeBookingStatus(booking.status) || (cancelled && census.cancellation !== null) || groupPaid;
    if (!mustConfirm) return { postings, steps };
    const plan = planConfirmationChargeLines({
      id: booking.id,
      lodgeId: booking.lodgeId,
      totalPriceCents: booking.totalPriceCents,
      promoAdjustmentCents: booking.promoAdjustmentCents,
      guests: booking.guests,
    });
    if (plan.unpricedStrandIds.length > 0) {
      return cannotPost(booking.id, "UNPRICED_NIGHT", `strand(s) ${plan.unpricedStrandIds.join(", ")} hold a night with no price`);
    }
    if (!plan.reconciles) {
      const posted = plan.postings.reduce((sum, posting) => sum + ledgerLineAmountCents(posting), 0);
      return cannotPost(
        booking.id,
        "CONFIRMATION_DOES_NOT_RECONCILE",
        `the night rows and promotion come to ${posted}, the final price is ${booking.finalPriceCents}`,
      );
    }
    postings.push(...plan.postings);
    steps.push(`confirmation (${plan.postings.length})`);
    // Every edit predates this confirmation, so its price is already in the
    // nights just confirmed; only the fee it charged is still to post.
    for (const modification of unposted) {
      if (modification.changeFeeCents <= 0) continue;
      const fee = changeFeeOnlyPlan(booking.id, booking.lodgeId, modification.id, modification.changeFeeCents);
      if (fee.kind === "none") return cannotPost(booking.id, "EDIT_NOT_DERIVABLE", `edit ${modification.id}'s change fee: ${fee.reason}`);
      postings.push(...fee.postings);
      steps.push(`change fee of edit ${modification.id}`);
    }
    return { postings, steps };
  }

  // Confirmed on the ledger already (C1 onward). An edit before the
  // confirmation is in the nights it confirmed; a fee it charged was never
  // posted (#3611 V4) and posts now.
  const beforeConfirmation = unposted.filter((modification) => modification.createdAt.getTime() <= confirmedAt);
  for (const modification of beforeConfirmation) {
    if (modification.changeFeeCents <= 0) continue;
    const fee = changeFeeOnlyPlan(booking.id, booking.lodgeId, modification.id, modification.changeFeeCents);
    if (fee.kind === "none") return cannotPost(booking.id, "EDIT_NOT_DERIVABLE", `edit ${modification.id}'s change fee: ${fee.reason}`);
    postings.push(...fee.postings);
    steps.push(`change fee of edit ${modification.id}`);
  }
  // Once a cancellation has posted, the stay is gone and no edit could move it.
  if (cancellationPosted) return { postings, steps };

  // An edit after it that posted nothing (before #3582, or refused live) is
  // re-derived from the live lines and the night rows as they stand. Which edits
  // are still awaiting lines is the census's own rule
  // (`postConfirmationEditsWithoutLines`): those, or — only where the ledger is
  // still out of step with the night rows — the ones a later posted edit passed.
  const byId = new Map(booking.modifications.map((modification) => [modification.id, modification]));
  const split = postConfirmationEditsWithoutLines(census.modifications, census.lines);
  const awaiting = split.awaiting.map((id) => byId.get(id)!);
  const carried = split.carriedByLater.map((id) => byId.get(id)!);
  if (awaiting.length === 0 && carried.length === 0) return { postings, steps };

  const postedLines = await findPostedChargeLines(tx, booking.id);
  const livePromotionCents = liveLines(postedLines)
    .filter((line) => line.kind === "PROMOTION")
    .reduce((sum, line) => sum + ledgerLineAmountCents(line), 0);
  const beforeSide = pricingSideFromLiveLedger(postedLines, booking.guests, livePromotionCents);
  if (beforeSide === null) {
    return cannotPost(booking.id, "LIVE_LINE_NOT_ONE_NIGHT", "a live night line is not one guest's one night");
  }
  const afterSide = pricingSideFromWrittenGuests(booking.guests, { promoAdjustmentCents: booking.promoAdjustmentCents });
  // In step: the live lines already hold every night as the rows do (the
  // edit planner's own per-night differ), and the promotion has not moved.
  const nights = diffGuestNights(beforeSide, afterSide);
  const ledgerInStep =
    nights.kind === "nights" &&
    nights.guests.every((change) => change.removed.length === 0 && change.added.length === 0) &&
    modificationPromoDeltaCents(beforeSide, afterSide) === 0;
  // Which edits' nights to re-derive, tried in order, each sum-checked by the
  // planner and then re-judged by the census (#3583 delta, M-1): the awaiting
  // ones alone; then, where that does not sum, the carried ones too — a live
  // edit that posted after a refused one never absorbed its movement. Carried
  // edits alone are tried only while the ledger is out of step with the rows;
  // once it is in step (a second run), their nights are done.
  const candidates: Array<typeof awaiting> =
    awaiting.length > 0 ? [awaiting, ...(carried.length > 0 ? [[...carried, ...awaiting]] : [])] : ledgerInStep ? [] : [carried];
  let derived: { edits: typeof awaiting; postings: ChargePlan["postings"] } | null = null;
  for (const [index, edits] of candidates.entries()) {
    let movementCents = 0;
    for (const modification of edits) {
      const movement = editMovementCents(modification, census);
      if ("refusal" in movement) return cannotPost(booking.id, movement.refusal, movement.detail);
      movementCents += movement.cents;
    }
    // The latest of them carries the nights they all moved: the night rows hold
    // only their end state, never which edit moved which night.
    const latest = edits[edits.length - 1]!;
    const plan = planModificationChargeLines({
      bookingId: booking.id,
      lodgeId: booking.lodgeId,
      bookingModificationId: latest.id,
      before: beforeSide,
      after: afterSide,
      changeFeeCents: latest.changeFeeCents,
      expectedCents: movementCents + latest.changeFeeCents,
      postedLines,
    });
    if (plan.kind === "lines") {
      derived = { edits, postings: plan.postings };
      break;
    }
    if (plan.reason === "SUM_MISMATCH" && index < candidates.length - 1) continue;
    // A parked edit's review still open: its closure posts the nights, as live.
    const openReview = booking.manualRefundTasks.some((task) => task.kind === "EDIT_FINANCIAL_REVIEW" && task.status === "OPEN");
    if (plan.reason === "UNPRICED_NIGHT" && openReview) break;
    return cannotPost(
      booking.id,
      "EDIT_NOT_DERIVABLE",
      `edit(s) ${edits.map((modification) => modification.id).join(", ")}: ${plan.reason}${plan.plannedCents === undefined ? "" : ` (planned ${plan.plannedCents}, the edits moved ${movementCents + latest.changeFeeCents})`}`,
    );
  }
  const anchor = derived ? derived.edits[derived.edits.length - 1]!.id : null;
  if (derived && derived.postings.length > 0) {
    postings.push(...derived.postings);
    steps.push(`edit ${anchor} (${derived.postings.length}, for ${derived.edits.length} unposted edit(s))`);
  }
  // Every other edit without lines posts the fee it charged under its own key,
  // whatever its nights' state — a carried edit's included (delta M-2).
  const feeKeys = new Set(census.lines.flatMap((line) => (line.postingKey ? [line.postingKey] : [])));
  for (const modification of [...carried, ...awaiting]) {
    if (modification.id === anchor || modification.changeFeeCents <= 0) continue;
    if (feeKeys.has(modificationChangeFeeKey(modification.id))) continue;
    // An awaiting edit the plan did not take (an open review) waits with its nights.
    if (!derived && awaiting.includes(modification)) continue;
    const fee = changeFeeOnlyPlan(booking.id, booking.lodgeId, modification.id, modification.changeFeeCents);
    if (fee.kind === "none") return cannotPost(booking.id, "EDIT_NOT_DERIVABLE", `edit ${modification.id}'s change fee: ${fee.reason}`);
    postings.push(...fee.postings);
    steps.push(`change fee of edit ${modification.id}`);
  }
  return { postings, steps };
}

// ---------------------------------------------------------------------------
// One booking
// ---------------------------------------------------------------------------

function namedClasses(evaluation: BookingLedgerEvaluation): string[] {
  const names = new Set<string>();
  for (const identity of evaluation.identities) {
    if (identity.status === "CLASSIFIED") for (const component of identity.explainedBy) names.add(component.name);
  }
  for (const instance of evaluation.bookingInstances) names.add(instance.name);
  return [...names].sort();
}

/**
 * Post one booking's history inside the caller's transaction, under its locks,
 * and judge the result. Throws `BackPostRollback` for a refusal; returns the
 * outcome otherwise (the caller rolls a dry run back itself).
 */
async function backPostBooking(tx: Tx, bookingId: string): Promise<BookingBackPostOutcome> {
  if (!(await lockBookingForBackPost(tx, bookingId))) return { bookingId, kind: "NOTHING_TO_POST", classes: [] };
  const lineIds = async () =>
    (await tx.bookingLedgerLine.findMany({ where: { bookingId }, select: { id: true } })).map((line) => line.id);
  const before = new Set(await lineIds());

  const first = await readBookingLedgerCensusRow(tx, bookingId);
  if (!first) return { bookingId, kind: "NOTHING_TO_POST", classes: [] };
  // A group child with no lines that cannot be posted is refused like any
  // other booking: the census plans the same lines and holds the gate on it
  // (#3854 F1), so it is never left in `GROUP_SETTLEMENT_OFF_LEDGER`.
  const refuse = (outcome: CannotPost) => new BackPostRollback(outcome);

  const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: BOOKING_SELECT });
  const steps: string[] = [];
  const group = await planGroupChildBackPost(tx, {
    census: first,
    lodgeId: booking.lodgeId,
    cancelledWithoutSnapshot: booking.status === "CANCELLED" && (booking.events[0]?.snapshot ?? null) === null,
  });
  if (group?.kind === "refuse") throw refuse(cannotPost(bookingId, group.reason, group.detail));

  // Settlement and credit lines: the live syncs converge the whole booking.
  if (booking.payment) await syncBookingLedgerSettlements({ paymentId: booking.payment.id, store: tx });
  await syncBookingLedgerCredits({ bookingId, store: tx });

  // Hand-backs: a completed task the resolver sends by hand, on its own rule
  // (`handsBackByHand`, shared with `chooseEditReviewSettlementRoute`). The
  // poster itself declines a card payment's, whose money went back on the card.
  for (const task of booking.manualRefundTasks) {
    const byHand =
      task.status === "COMPLETED" &&
      handsBackByHand(task) &&
      task.settlementDirection !== "CHARGE_TO_MEMBER" &&
      (task.amountCents ?? 0) > 0 &&
      task.completedByMemberId !== null;
    if (!byHand || first.lines.some((line) => line.postingKey === handBackKey(task.id))) continue;
    await postHandBackLedgerLine({
      bookingId,
      lodgeId: booking.lodgeId,
      manualRefundTaskId: task.id,
      amountCents: task.amountCents ?? 0,
      refundMethod: "internet-banking",
      paymentSource: task.payment?.source ?? null,
      officerMemberId: task.completedByMemberId!,
      store: tx,
    });
  }

  const charges = await planHistoricChargeLines(tx, booking, first, group !== null);
  if ("kind" in charges) throw refuse(charges);
  await writeBookingLedgerRows(tx, buildBookingLedgerRows([...charges.postings, ...(group?.postings ?? [])]));
  steps.push(...charges.steps, ...(group?.steps ?? []));

  // The cancellation, once the stay it takes back is on the ledger.
  const cancellationPosted = first.lines.some((line) => line.anchorKind === "CANCELLATION" && line.side !== "SETTLEMENT");
  if (booking.status === "CANCELLED" && !cancellationPosted && (await bookingHasConfirmationLines(tx, bookingId))) {
    const kept = group?.cancellationKeptCents != null ? { keptCents: group.cancellationKeptCents } : await cancellationKept(tx, booking);
    if (kept === null) {
      throw refuse(cannotPost(bookingId, "CENSUS_WOULD_NOT_PASS", "the CANCELLED event's snapshot holds no kept or retained figure"));
    }
    await postCancellationLedgerLines({ store: tx, bookingId, lodgeId: booking.lodgeId, ...kept, site: "booking-ledger-back-post" });
    steps.push(`cancellation (kept ${kept.keptCents})`);
  }

  // Judged by the census, on what this transaction now reads.
  const after = await readBookingLedgerCensusRow(tx, bookingId);
  const evaluation = evaluateBookingLedgerIdentities(after ?? first);
  const disagrees = evaluation.identities.some((identity) => identity.status === "DISAGREE");
  if (disagrees || evaluation.coverage.length > 0 || evaluation.integrity.length > 0) {
    const what = [
      ...(disagrees ? ["a disagreement"] : []),
      ...(evaluation.coverage.length > 0 ? [`coverage ${evaluation.coverage.join(", ")}`] : []),
      ...(evaluation.integrity.length > 0 ? ["an integrity finding"] : []),
    ].join(", ");
    throw refuse(cannotPost(bookingId, "CENSUS_WOULD_NOT_PASS", `the census would report ${what}`, evaluation));
  }
  const inserted = (await lineIds()).filter((id) => !before.has(id)).sort();
  const classes = namedClasses(evaluation);
  if (inserted.length === 0) return { bookingId, kind: "NOTHING_TO_POST", classes };
  return { bookingId, kind: "POSTED", lines: inserted.length, lineIds: inserted, steps, classes };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Bookings in id order (stable across runs), after `after`, one page. */
async function bookingIdPage(client: Pick<PrismaClient, "booking">, after: string | null, take: number): Promise<string[]> {
  const rows = await client.booking.findMany({
    where: after === null ? {} : { id: { gt: after } },
    orderBy: { id: "asc" },
    take,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * PostgreSQL's `lock_not_available` (SQLSTATE 55P03), read from the error's code
 * fields — through the driver adapter, Prisma reports it as P2010 with
 * `meta.driverAdapterError.cause.originalCode` — never from its message text.
 */
function isLockTimeout(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 4) return false;
  const fields = error as { code?: unknown; originalCode?: unknown; meta?: unknown; driverAdapterError?: unknown; cause?: unknown };
  if (fields.code === "55P03" || fields.originalCode === "55P03") return true;
  return [fields.meta, fields.driverAdapterError, fields.cause].some((inner) => isLockTimeout(inner, depth + 1));
}

/**
 * One booking, in its own transaction. A refusal or a dry run rolls back through
 * `BackPostRollback`; ANY other error rolls the booking back too and is listed
 * against it, so one booking's surprise never loses the run or its report.
 */
async function backPostOne(
  client: Pick<PrismaClient, "$transaction">,
  bookingId: string,
  apply: boolean,
): Promise<BookingBackPostOutcome> {
  try {
    return await client.$transaction(
      async (tx) => {
        const result = await backPostBooking(tx, bookingId);
        // A dry run posts, judges and then rolls everything back.
        if (!apply) throw new BackPostRollback(result.kind === "POSTED" ? { ...result, lineIds: [] } : result);
        return result;
      },
      { maxWait: 30_000, timeout: 120_000 },
    );
  } catch (error) {
    if (error instanceof BackPostRollback) return error.outcome;
    const message = errorMessage(error).replace(/\s+/g, " ").trim();
    return isLockTimeout(error)
      ? cannotPost(bookingId, "LOCK_TIMEOUT", `another writer held this booking's locks too long; re-run to retry it (${message})`)
      : cannotPost(bookingId, "UNEXPECTED_ERROR", message);
  }
}

export async function runBookingLedgerBackPost(args: {
  client: Pick<PrismaClient, "$transaction" | "booking">;
  apply: boolean;
  /** These bookings only, in this order; otherwise every booking by id. */
  bookingIds?: readonly string[] | null;
  limit?: number | null;
  /** Called as each booking finishes, so an operator sees progress and a crash loses nothing reported. */
  onOutcome?: (outcome: BookingBackPostOutcome) => void;
}): Promise<BookingLedgerBackPostRun> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const outcomes: BookingBackPostOutcome[] = [];
  const one = async (bookingId: string) => {
    const outcome = await backPostOne(args.client, bookingId, args.apply);
    outcomes.push(outcome);
    args.onOutcome?.(outcome);
  };

  if (args.bookingIds && args.bookingIds.length > 0) {
    for (const id of args.bookingIds) await one(id);
  } else {
    let after: string | null = null;
    const limit = args.limit ?? Number.POSITIVE_INFINITY;
    while (outcomes.length < limit) {
      const page = await bookingIdPage(args.client, after, Math.min(500, limit - outcomes.length));
      if (page.length === 0) break;
      for (const id of page) await one(id);
      after = page[page.length - 1]!;
    }
  }

  const totals = {
    bookings: outcomes.length,
    posted: outcomes.filter((outcome) => outcome.kind === "POSTED").length,
    lines: outcomes.reduce((sum, outcome) => sum + (outcome.kind === "POSTED" ? outcome.lines : 0), 0),
    nothingToPost: outcomes.filter((outcome) => outcome.kind === "NOTHING_TO_POST").length,
    cannotPost: outcomes.filter((outcome) => outcome.kind === "CANNOT_POST").length,
  };
  return { mode: args.apply ? "apply" : "dry-run", runId, startedAt, finishedAt: new Date().toISOString(), outcomes, totals };
}
