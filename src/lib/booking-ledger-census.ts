/**
 * The typed operator census of `INV-PAY-047` (#3340), read once here so the
 * operator CLI (`scripts/audit-booking-ledger-residual.ts`) and the PostgreSQL
 * proofs read the same rows the same way. READ ONLY: it never writes and never
 * calls a provider.
 *
 * The arithmetic is `additional-payment-ask.ts`'s (`bookingLedgerResidualCents`)
 * and the verdict `booking-ledger-verdict.ts`'s; the Xero billing evidence
 * (#5288) is read through the invoices and statuses that module names, the
 * same ones the SQL twin (`bookingLedgerCensusSql`) folds in.
 */
import type { PrismaClient } from "@prisma/client";

import {
  BOOKING_LEDGER_CENSUS_CAPTURED_PAYMENT_STATUSES,
  BOOKING_LEDGER_CENSUS_EXCLUDED_BOOKING_STATUSES,
  bookingLedgerResidualCents,
  type BookingLedgerIdentityRow,
} from "@/lib/additional-payment-ask";
import {
  BOOKING_XERO_BILLING_INVOICES,
  BOOKING_XERO_BILLING_QUEUED_STATUSES,
  bookingLedgerVerdict,
  type BookingLedgerVerdict,
  type BookingXeroBillingFacts,
} from "@/lib/booking-ledger-verdict";
import { prisma } from "@/lib/prisma";

export interface BookingLedgerCensusRow extends BookingLedgerIdentityRow, BookingXeroBillingFacts {
  bookingId: string;
  bookingStatus: string;
  residualCents: number;
  verdict: Exclude<BookingLedgerVerdict, "balanced">;
}

type CensusClient = Pick<PrismaClient, "booking" | "xeroObjectLink" | "xeroSyncOperation">;

/** Every live booking with a captured payment whose residual is not zero, largest owed first. */
export async function loadBookingLedgerCensus(db: CensusClient = prisma): Promise<BookingLedgerCensusRow[]> {
  const bookings = await db.booking.findMany({
    where: {
      deletedAt: null,
      status: { notIn: [...BOOKING_LEDGER_CENSUS_EXCLUDED_BOOKING_STATUSES] },
      payment: { status: { in: [...BOOKING_LEDGER_CENSUS_CAPTURED_PAYMENT_STATUSES] } },
    },
    select: {
      id: true,
      status: true,
      finalPriceCents: true,
      payment: {
        select: {
          id: true,
          source: true,
          xeroInvoiceId: true,
          changeFeeCents: true,
          amountCents: true,
          refundedAmountCents: true,
          creditAppliedCents: true,
          additionalAmountCents: true,
          additionalPaymentStatus: true,
        },
      },
      modifications: { select: { id: true } },
    },
  });

  const unbalanced = bookings.flatMap((booking) => {
    if (!booking.payment) return [];
    const identity: BookingLedgerIdentityRow = {
      finalPriceCents: booking.finalPriceCents,
      changeFeeCents: booking.payment.changeFeeCents,
      amountCents: booking.payment.amountCents,
      refundedAmountCents: booking.payment.refundedAmountCents,
      creditAppliedCents: booking.payment.creditAppliedCents,
      additionalAmountCents: booking.payment.additionalAmountCents,
      additionalPaymentStatus: booking.payment.additionalPaymentStatus,
    };
    const residualCents = bookingLedgerResidualCents(identity);
    return residualCents === 0 ? [] : [{ booking, payment: booking.payment, identity, residualCents }];
  });

  // The billing invoices' local ids, by anchor: the payment, and each edit of the booking.
  const localIdsOf = (entry: (typeof unbalanced)[number]) => ({
    Payment: [entry.payment.id],
    BookingModification: entry.booking.modifications.map((modification) => modification.id),
  });
  const anchors = BOOKING_XERO_BILLING_INVOICES.map((invoice) => ({
    ...invoice,
    localIds: unbalanced.flatMap((entry) => localIdsOf(entry)[invoice.localModel]),
  }));
  const [links, queued] = await Promise.all([
    db.xeroObjectLink.findMany({
      where: {
        active: true,
        xeroObjectType: "INVOICE",
        OR: anchors.map(({ localModel, role, localIds }) => ({ localModel, role, localId: { in: localIds } })),
      },
      select: { localModel: true, localId: true },
    }),
    db.xeroSyncOperation.findMany({
      where: {
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        status: { in: [...BOOKING_XERO_BILLING_QUEUED_STATUSES] },
        OR: anchors.map(({ localModel, localIds }) => ({ localModel, localId: { in: localIds } })),
      },
      select: { localModel: true, localId: true },
    }),
  ]);
  const key = (localModel: string | null, localId: string | null) => `${localModel}:${localId}`;
  const linked = new Set(links.map((link) => key(link.localModel, link.localId)));
  const going = new Set(queued.map((operation) => key(operation.localModel, operation.localId)));

  const rows = unbalanced.map((entry): BookingLedgerCensusRow => {
    const anchorKeys = Object.entries(localIdsOf(entry)).flatMap(([localModel, ids]) => ids.map((id) => key(localModel, id)));
    const billing: BookingXeroBillingFacts = {
      paymentSource: entry.payment.source,
      xeroInvoiceId: entry.payment.xeroInvoiceId,
      activeInvoiceLink: anchorKeys.some((anchor) => linked.has(anchor)),
      queuedInvoiceCreate: anchorKeys.some((anchor) => going.has(anchor)),
    };
    return {
      bookingId: entry.booking.id,
      bookingStatus: entry.booking.status,
      ...entry.identity,
      ...billing,
      residualCents: entry.residualCents,
      verdict: bookingLedgerVerdict(entry.residualCents, billing) as BookingLedgerCensusRow["verdict"],
    };
  });
  return rows.sort((a, b) => b.residualCents - a.residualCents || a.bookingId.localeCompare(b.bookingId));
}
