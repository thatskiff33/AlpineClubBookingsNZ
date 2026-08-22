// Scope-where construction and audit-data loading (bookings, links, operations)
// for the booking-vs-Xero repair tool. Extracted verbatim from
// xero-booking-repair.ts (#1208 item 2).
import { Prisma } from "@prisma/client";
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
import { buildBookingCancellationRefundIdempotencyKey } from "./payment-recovery-keys";
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

  const [links, operations, cancellationRefundRecoveryOperations] = await Promise.all([
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
  }));
}
