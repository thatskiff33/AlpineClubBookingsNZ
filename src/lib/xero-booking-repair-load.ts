// Scope-where construction and audit-data loading (bookings, links, operations)
// for the booking-vs-Xero repair tool. Extracted verbatim from
// xero-booking-repair.ts (#1208 item 2).
import {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  Prisma,
} from "@prisma/client";
import {
  bookingRepairSelect,
  xeroObjectLinkSelect,
  xeroOperationSelect,
  type BookingCancellationRefundRecoveryRecord,
  type BookingClassificationContext,
  type BookingXeroRepairScope,
  type XeroObjectLinkRecord,
  type XeroOperationRecord,
} from "./xero-booking-repair-types";
import {
  buildBookingCancellationRefundIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey,
  isEditFinancialReviewAdditionalIntentRecoveryKey,
} from "./payment-recovery-keys";
import {
  editReviewChargeShareTaskSelect,
  editReviewChargeShareTaskWhere,
  sumEditReviewChargeSharesByAnchor,
  type EditReviewChargeShareRow,
} from "@/lib/edit-financial-review-charge-shape";
import type { RepairDependencies } from "./xero-booking-repair-deps";
import { makeLocalKey, parseRepairScopeDay } from "./xero-booking-repair-utils";
import {
  addDaysDateOnly,
  formatDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import {
  requireCalendarDate,
  startOfClubDay,
  type ClubTimeZone,
} from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";

/** A settled edit-review charge share, carrying the booking it was raised on. */
type EditReviewChargeShareRecord = EditReviewChargeShareRow & {
  bookingId: string;
};

/**
 * An edit-review charge whose additional PaymentIntent has NOT been minted yet
 * and is still owed by the recovery replay (#3187 fix round).
 *
 * Only PENDING and PROCESSING count as open. A FAILED row is terminal - nothing
 * will replay it - and the #1491 cancellation arm already treats FAILED that
 * way, so a terminal row must not hold the repair tool off forever. SUCCEEDED
 * means the intent exists, and the request row it minted answers the question
 * on its own.
 */
const OPEN_PAYMENT_RECOVERY_STATUSES = [
  PaymentRecoveryOperationStatus.PENDING,
  PaymentRecoveryOperationStatus.PROCESSING,
] as const;

type EditReviewChargeIntentRecoveryRecord = {
  bookingId: string;
  idempotencyKey: string;
};

/**
 * The club calendar day after `day`, as `yyyy-MM-dd`.
 *
 * The result is re-validated because the last representable day does not have
 * one: `9999-12-31` — which the day validator accepts, since it is a real date
 * — steps to the expanded-year form `"+010000-01"`, and that reaches Prisma as
 * a nonsense bound and fails there with an error naming neither the flag nor
 * the day. Refusing it here fails just as closed, one layer earlier, and says
 * which day it was.
 */
function nextDateOnly(day: string): string {
  const next = formatDateOnly(addDaysDateOnly(parseDateOnly(day), 1));
  if (!isDateOnlyString(next)) {
    throw new Error(
      `The repair scope's end day ${JSON.stringify(day)} has no representable next day, so its exclusive upper bound cannot be built.`
    );
  }
  return next;
}

/**
 * The `[from, to]` scope window, as the four different comparisons it really is
 * (#2868, INV-DATE-013).
 *
 * The operator names two club calendar days and the sweep matches a booking
 * whose check-in, creation, last update, or any modification falls inside them.
 * Those four columns are not the same kind of thing, so one bound value cannot
 * be right for all of them:
 *
 * - `Booking.checkIn` is `DateTime @db.Date` in `prisma/schema.prisma` — a
 *   lodge night, a calendar day with no time in it. `@prisma/adapter-pg`
 *   narrows whatever `Date` is bound against such a column to its UTC calendar
 *   date and throws the time away, so this arm takes the date-only value
 *   `parseDateOnly` produces (UTC midnight, which reads as the same calendar
 *   day everywhere).
 * - `Booking.createdAt`, `Booking.updatedAt` and `BookingModification.createdAt`
 *   are bare `DateTime` in `prisma/schema.prisma` — real instants, kept whole
 *   by the adapter. These arms take the instant the club day STARTS at,
 *   `startOfDateOnlyForTimeZone`.
 *
 * The two differ by the club's UTC offset — twelve hours in NZST — and each is
 * wrong in the other's place. Handing the instants a date-only value would put
 * their boundary at club MIDDAY (the hazard #2838 recorded when it kept
 * `startOfDateOnlyForTimeZone` for `draftExpiresAt`); handing `checkIn` a
 * club-midnight instant is the defect this fixes, because club midnight is the
 * previous UTC day and therefore the previous DATE, all day, every day.
 *
 * The upper bound is exclusive in both cases and is built from the day AFTER
 * `to`, which is what makes `to` itself an included day. Either end may be
 * omitted, giving a half-open sweep; a day that is PRESENT but not a real
 * calendar day is refused rather than dropped, because "not supplied" and
 * "supplied wrongly" must not mean the same thing on a tool that can `--apply`.
 *
 * CT-5 (#2869) changed one thing and nothing else: the club day the instant
 * arms start at is now the PERSISTED club timezone rather than `APP_TIME_ZONE`,
 * which was `process.env.TZ`. The operator naming two days means the club's
 * days, so which container the repair happens to run in must not move the
 * window (`INV-CONFIG-002`). The `checkIn` arm still takes the date-only value
 * and takes no zone at all, for exactly the reason above.
 */
function buildScopeWhere(
  scope: BookingXeroRepairScope,
  clubTimeZone: ClubTimeZone,
): Prisma.BookingWhereInput {
  const and: Prisma.BookingWhereInput[] = [];

  if (scope.bookingId) {
    and.push({ id: scope.bookingId });
  }

  // Validate before the emptiness test, not with it. Reading these through
  // truthiness — as this did — silently treats `""` as "no lower bound" and
  // widens the sweep to all of history.
  const fromDay =
    scope.from === undefined ? undefined : parseRepairScopeDay(scope.from, "The repair scope's start day");
  const toDay =
    scope.to === undefined ? undefined : parseRepairScopeDay(scope.to, "The repair scope's end day");

  if (fromDay || toDay) {
    const dayAfterTo = toDay ? nextDateOnly(toDay) : undefined;

    const checkInRange = {
      ...(fromDay ? { gte: parseDateOnly(fromDay) } : {}),
      ...(dayAfterTo ? { lt: parseDateOnly(dayAfterTo) } : {}),
    };
    const instantRange = {
      ...(fromDay
        ? { gte: startOfClubDay(requireCalendarDate(fromDay), clubTimeZone) }
        : {}),
      ...(dayAfterTo
        ? { lt: startOfClubDay(requireCalendarDate(dayAfterTo), clubTimeZone) }
        : {}),
    };

    and.push({
      OR: [
        { createdAt: instantRange },
        { updatedAt: instantRange },
        { checkIn: checkInRange },
        {
          modifications: {
            some: {
              createdAt: instantRange,
            },
          },
        },
      ],
    });
  }

  if (scope.all || and.length === 0) {
    return and.length > 0 ? { AND: and } : {};
  }

  return { AND: and };
}

export async function loadAuditData(
  scope: BookingXeroRepairScope,
  deps: RepairDependencies
) {
  const bookings = await deps.prisma.booking.findMany({
    where: buildScopeWhere(scope, await readClubTimeZoneOutsideRequest()),
    select: bookingRepairSelect,
    orderBy: [
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });

  const paymentIds = bookings
    .map((booking) => booking.payment?.id)
    .filter((value): value is string => Boolean(value));
  const bookingIds = bookings.map((booking) => booking.id);
  const modificationIds = bookings.flatMap((booking) =>
    booking.modifications.map((modification) => modification.id)
  );

  const linkScopes: Prisma.XeroObjectLinkWhereInput[] = [];
  if (paymentIds.length > 0) {
    linkScopes.push({ localModel: "Payment", localId: { in: paymentIds } });
  }
  if (bookingIds.length > 0) {
    linkScopes.push({ localModel: "Booking", localId: { in: bookingIds } });
  }
  if (modificationIds.length > 0) {
    linkScopes.push({
      localModel: "BookingModification",
      localId: { in: modificationIds },
    });
  }

  const operationScopes: Prisma.XeroSyncOperationWhereInput[] = [];
  if (paymentIds.length > 0) {
    operationScopes.push({ localModel: "Payment", localId: { in: paymentIds } });
  }
  if (bookingIds.length > 0) {
    operationScopes.push({ localModel: "Booking", localId: { in: bookingIds } });
  }
  if (modificationIds.length > 0) {
    operationScopes.push({
      localModel: "BookingModification",
      localId: { in: modificationIds },
    });
  }

  /**
   * The recovery key each loaded edit would have written had its intent mint
   * failed, so the query below matches by EXACT key and reads the anchor back
   * out of this map rather than by slicing a prefix off a string - the mistake
   * `bookingModificationIdForAdditionalIntentRecoveryKey` documents.
   */
  const modificationIdByIntentRecoveryKey = new Map<string, string>(
    modificationIds.map((modificationId) => [
      buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey(
        modificationId
      ),
      modificationId,
    ])
  );

  const [
    links,
    operations,
    cancellationRefundRecoveryOperations,
    editReviewChargeShares,
    editReviewChargeIntentRecoveries,
  ] = await Promise.all([
    linkScopes.length > 0
      ? deps.prisma.xeroObjectLink.findMany({
          where: {
            active: true,
            OR: linkScopes,
          },
          select: xeroObjectLinkSelect,
          orderBy: [
            { updatedAt: "desc" },
            { createdAt: "desc" },
          ],
        })
      : Promise.resolve([] as XeroObjectLinkRecord[]),
    operationScopes.length > 0
      ? deps.prisma.xeroSyncOperation.findMany({
          where: {
            OR: operationScopes,
          },
          select: xeroOperationSelect,
          orderBy: [
            { updatedAt: "desc" },
            { createdAt: "desc" },
          ],
        })
      : Promise.resolve([] as XeroOperationRecord[]),
    // #1491: booking-cancel card refunds freeze their decision as a recovery
    // operation keyed booking_cancel_refund_recovery_<bookingId> — matched by
    // exact key so booking-modification refund recoveries never alias in.
    bookingIds.length > 0
      ? deps.prisma.paymentRecoveryOperation.findMany({
          where: {
            idempotencyKey: {
              in: bookingIds.map((bookingId) =>
                buildBookingCancellationRefundIdempotencyKey(bookingId)
              ),
            },
          },
          select: {
            id: true,
            bookingId: true,
            status: true,
            amountCents: true,
            createdAt: true,
          },
        })
      : Promise.resolve([] as BookingCancellationRefundRecoveryRecord[]),
    // #3187: the money a parked booking edit actually owes. It is on the review
    // TASKS, never on the `BookingModification` row the edit wrote - parking
    // exists so the structural change can commit while the money stays
    // unresolved, so that row's `priceDiffCents` is 0 and stays 0. Scoped to the
    // bookings this sweep loaded, and selected through the charge feature's own
    // criteria (`editReviewChargeShareTaskWhere`) so the repair tool and the
    // settlement it audits cannot disagree about which rows count as owed.
    bookingIds.length > 0
      ? deps.prisma.manualRefundTask.findMany({
          where: {
            bookingId: { in: bookingIds },
            ...editReviewChargeShareTaskWhere,
          },
          select: { bookingId: true, ...editReviewChargeShareTaskSelect },
        })
      : Promise.resolve([] as EditReviewChargeShareRecord[]),
    // #3187 fix round: an edit whose additional PaymentIntent mint FAILED at the
    // provider. `edit-financial-review-charge.ts` writes this row and returns
    // `not-raised`, and the live settlement then queues no supplementary invoice
    // at all - "deferred, not short". The repair tool has to be able to tell
    // that state from the internet-banking route, which looks identical from the
    // ledger (no request row) and needs the opposite answer.
    modificationIdByIntentRecoveryKey.size > 0
      ? deps.prisma.paymentRecoveryOperation.findMany({
          where: {
            type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
            status: { in: [...OPEN_PAYMENT_RECOVERY_STATUSES] },
            idempotencyKey: {
              in: [...modificationIdByIntentRecoveryKey.keys()],
            },
          },
          select: { bookingId: true, idempotencyKey: true },
        })
      : Promise.resolve([] as EditReviewChargeIntentRecoveryRecord[]),
  ]);

  const linksByLocalKey = new Map<string, XeroObjectLinkRecord[]>();
  for (const link of links) {
    const key = makeLocalKey(link.localModel, link.localId);
    const list = linksByLocalKey.get(key) ?? [];
    list.push(link);
    linksByLocalKey.set(key, list);
  }

  const cancellationRecoveryByBookingId = new Map<
    string,
    BookingCancellationRefundRecoveryRecord[]
  >();
  for (const operation of cancellationRefundRecoveryOperations) {
    if (!operation.bookingId) {
      continue;
    }
    const list = cancellationRecoveryByBookingId.get(operation.bookingId) ?? [];
    list.push(operation);
    cancellationRecoveryByBookingId.set(operation.bookingId, list);
  }

  /**
   * Per BOOKING, then per anchor. Grouping by booking first is not decoration:
   * the anchor is read out of a stored JSON context, and a context naming a
   * modification that belongs to a DIFFERENT booking must not contribute to that
   * booking's expected invoice. Summing globally would let one unreadable or
   * mis-written row move another booking's money.
   */
  const editReviewChargeSharesByBookingId = new Map<
    string,
    EditReviewChargeShareRecord[]
  >();
  for (const share of editReviewChargeShares) {
    const list = editReviewChargeSharesByBookingId.get(share.bookingId) ?? [];
    list.push(share);
    editReviewChargeSharesByBookingId.set(share.bookingId, list);
  }

  /**
   * Per BOOKING again, and for the same reason as the shares above: a recovery
   * row is joined to its edit through a key, and a key naming a modification on
   * a DIFFERENT booking must not defer this one's repair.
   */
  const editReviewChargeIntentRecoveriesByBookingId = new Map<
    string,
    Set<string>
  >();
  for (const recovery of editReviewChargeIntentRecoveries) {
    // Redundant with the exact-key `in` filter above, and deliberately kept: if
    // that query is ever widened, an ORDINARY edit's recovery row must not be
    // read as a review charge's. Fail closed rather than defer the wrong edit.
    if (!isEditFinancialReviewAdditionalIntentRecoveryKey(recovery.idempotencyKey)) {
      continue;
    }
    const modificationId = modificationIdByIntentRecoveryKey.get(
      recovery.idempotencyKey
    );
    if (!modificationId) {
      continue;
    }
    const anchors =
      editReviewChargeIntentRecoveriesByBookingId.get(recovery.bookingId) ??
      new Set<string>();
    anchors.add(modificationId);
    editReviewChargeIntentRecoveriesByBookingId.set(recovery.bookingId, anchors);
  }

  const operationsByLocalKey = new Map<string, XeroOperationRecord[]>();
  for (const operation of operations) {
    if (!operation.localModel || !operation.localId) {
      continue;
    }
    const key = makeLocalKey(operation.localModel, operation.localId);
    const list = operationsByLocalKey.get(key) ?? [];
    list.push(operation);
    operationsByLocalKey.set(key, list);
  }

  return bookings.map<BookingClassificationContext>((booking) => ({
    booking,
    paymentLinks: booking.payment
      ? linksByLocalKey.get(makeLocalKey("Payment", booking.payment.id)) ?? []
      : [],
    bookingLinks: linksByLocalKey.get(makeLocalKey("Booking", booking.id)) ?? [],
    modificationLinksById: new Map(
      booking.modifications.map((modification) => [
        modification.id,
        linksByLocalKey.get(makeLocalKey("BookingModification", modification.id)) ?? [],
      ])
    ),
    paymentOperations: booking.payment
      ? operationsByLocalKey.get(makeLocalKey("Payment", booking.payment.id)) ?? []
      : [],
    bookingOperations: operationsByLocalKey.get(makeLocalKey("Booking", booking.id)) ?? [],
    modificationOperationsById: new Map(
      booking.modifications.map((modification) => [
        modification.id,
        operationsByLocalKey.get(makeLocalKey("BookingModification", modification.id)) ?? [],
      ])
    ),
    cancellationRefundRecoveryOperations:
      cancellationRecoveryByBookingId.get(booking.id) ?? [],
    editReviewChargeCentsByModificationId: sumEditReviewChargeSharesByAnchor(
      editReviewChargeSharesByBookingId.get(booking.id) ?? []
    ),
    openEditReviewChargeIntentRecoveryModificationIds:
      editReviewChargeIntentRecoveriesByBookingId.get(booking.id) ??
      new Set<string>(),
  }));
}
