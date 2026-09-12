import type { Prisma } from "@prisma/client";

import {
  deriveNightAdjustmentState,
  NIGHT_ADJUSTMENT_INVARIANT,
} from "@/lib/night-adjustment-write";

export { NIGHT_ADJUSTMENT_INVARIANT };

function refuse(message: string): never {
  throw new Error(`${NIGHT_ADJUSTMENT_INVARIANT}: ${message}`);
}

/**
 * Stage 3's named money readers. The operation is part of the input because a
 * booking-wide amount and a whole-guest removal do not consume the recorded
 * rows at the same grain.
 */
export type BookingMoneyBuildUpOperation =
  | "GUEST_REMOVAL"
  | "REVIEW_REBASE"
  | "CREDIT_ELECTION"
  | "XERO_PROMO_LINE";

export type BookingMoneyBaseEvidence =
  | { kind: "EXACT"; amountCents: number }
  | {
      kind: "UNKNOWN";
      reason:
        | "NO_STORED_NIGHT_PRICES"
        | "PARTIAL_STORED_NIGHT_PRICES"
        | "INEXACT_STORED_NIGHT_PRICES"
        | "STORED_TOTAL_MISMATCH"
        | "COUNTERPART_STRAND_UNREADABLE";
    };

export type BookingMoneyCompatibilityClassification =
  | "STORED_SIDE_DEFECT"
  | "DERIVATION_DEFECT"
  | "LEGITIMATE_DIVERGENCE";

export type BookingMoneyBuildUpHistoryMetadata = {
  moneyBuildUpOperation: BookingMoneyBuildUpOperation;
  moneyBuildUpSource:
    | "STORED"
    | "DERIVED_COMPATIBILITY_FALLBACK"
    | "BASE_EVIDENCE_UNKNOWN";
  moneyBuildUpReason: string;
  moneyBuildUpStoredCents: number | null;
  moneyBuildUpDerivedCents: number;
  moneyBuildUpFallbackClassification: BookingMoneyCompatibilityClassification | null;
};

export type BookingMoneyBuildUpSelection =
  | {
      source: "STORED";
      reason: "STORED_MATCHES_DERIVED";
      storedCents: number;
      derivedCents: number;
      selectedCents: number;
      historyMetadata: BookingMoneyBuildUpHistoryMetadata;
    }
  | {
      source: "DERIVED_COMPATIBILITY_FALLBACK";
      reason: "ADJUSTMENT_BUILDUP_NOT_KNOWN" | "STORED_DERIVED_MISMATCH";
      storedCents: number | null;
      derivedCents: number;
      selectedCents: number;
      fallbackClassification: BookingMoneyCompatibilityClassification;
      historyMetadata: BookingMoneyBuildUpHistoryMetadata;
    }
  | {
      source: "BASE_EVIDENCE_UNKNOWN";
      reason: Extract<BookingMoneyBaseEvidence, { kind: "UNKNOWN" }>["reason"];
      storedCents: null;
      derivedCents: number;
      historyMetadata: BookingMoneyBuildUpHistoryMetadata;
    };

export type BookingMoneyBuildUpRow = {
  bookingGuestId: string;
  beneficiaryMemberId: string;
  amountCents: number | null;
};

export type LoadedBookingMoneyBuildUp = {
  operation: BookingMoneyBuildUpOperation;
  bookingGuestId?: string;
  baseEvidence: BookingMoneyBaseEvidence;
  rows: BookingMoneyBuildUpRow[];
  redemption: {
    priceAdjustmentCents: number;
    allocations: Array<{ memberId: string; priceAdjustmentCents: number }>;
  } | null;
};

type BookingMoneyBuildUpStore = Pick<Prisma.TransactionClient, "booking">;

function exactBaseAmount(
  operation: BookingMoneyBuildUpOperation,
  booking: {
    totalPriceCents: number;
    guests: Array<{
      id: string;
      priceCents: number;
      nights: Array<{
        id: string;
        priceCents: number | null;
        priceSource: "SOLD" | "OFFICER_PRICED" | "EVEN_SPLIT" | "UNKNOWN";
      }>;
    }>;
  },
  bookingGuestId?: string,
): BookingMoneyBaseEvidence {
  if (operation === "GUEST_REMOVAL") {
    const guest = booking.guests.find((candidate) => candidate.id === bookingGuestId);
    return guest && Number.isInteger(guest.priceCents) && guest.priceCents >= 0
      ? { kind: "EXACT", amountCents: guest.priceCents }
      : { kind: "UNKNOWN", reason: "NO_STORED_NIGHT_PRICES" };
  }
  if (operation === "CREDIT_ELECTION" || operation === "XERO_PROMO_LINE") {
    return Number.isInteger(booking.totalPriceCents) && booking.totalPriceCents >= 0
      ? { kind: "EXACT", amountCents: booking.totalPriceCents }
      : { kind: "UNKNOWN", reason: "STORED_TOTAL_MISMATCH" };
  }

  if (booking.guests.length === 0) {
    return { kind: "UNKNOWN", reason: "NO_STORED_NIGHT_PRICES" };
  }
  let totalCents = 0;
  for (const guest of booking.guests) {
    if (guest.nights.length === 0) {
      return { kind: "UNKNOWN", reason: "NO_STORED_NIGHT_PRICES" };
    }
    if (guest.nights.some((night) => night.priceCents === null)) {
      return { kind: "UNKNOWN", reason: "PARTIAL_STORED_NIGHT_PRICES" };
    }
    if (
      guest.nights.some(
        (night) => night.priceSource === "EVEN_SPLIT" || night.priceSource === "UNKNOWN",
      )
    ) {
      return { kind: "UNKNOWN", reason: "INEXACT_STORED_NIGHT_PRICES" };
    }
    const nightTotal = guest.nights.reduce((sum, night) => sum + night.priceCents!, 0);
    if (nightTotal !== guest.priceCents) {
      return { kind: "UNKNOWN", reason: "STORED_TOTAL_MISMATCH" };
    }
    totalCents += guest.priceCents;
  }
  return { kind: "EXACT", amountCents: totalCents };
}

/**
 * The one database projection for Stage 3 money readers. A transaction-owning
 * caller passes its transaction client; Xero passes the module client before
 * any provider call. No ambient client is imported here.
 */
export async function readBookingMoneyBuildUp(
  store: BookingMoneyBuildUpStore,
  args: {
    bookingId: string;
    operation: BookingMoneyBuildUpOperation;
    bookingGuestId?: string;
  },
): Promise<LoadedBookingMoneyBuildUp> {
  const booking = await store.booking.findUnique({
    where: { id: args.bookingId },
    select: {
      totalPriceCents: true,
      guests: {
        select: {
          id: true,
          priceCents: true,
          nights: { select: { id: true, priceCents: true, priceSource: true } },
        },
      },
      promoRedemption: {
        select: {
          priceAdjustmentCents: true,
          allocations: { select: { memberId: true, priceAdjustmentCents: true } },
        },
      },
      nightAdjustments: {
        select: {
          bookingGuestId: true,
          bookingGuestNightId: true,
          beneficiaryMemberId: true,
          amountCents: true,
        },
      },
    },
  });
  if (!booking) {
    refuse(`${args.operation}: booking ${args.bookingId} does not exist`);
  }
  const guestIdByNightId = new Map(
    booking.guests.flatMap((guest) => guest.nights.map((night) => [night.id, guest.id] as const)),
  );
  const rows = booking.nightAdjustments.map((row) => {
    const bookingGuestId =
      row.bookingGuestId ??
      (row.bookingGuestNightId
        ? guestIdByNightId.get(row.bookingGuestNightId)
        : undefined);
    if (!bookingGuestId) {
      refuse(`${args.operation}: an adjustment row is attached to neither a guest nor a night`);
    }
    return {
      bookingGuestId,
      beneficiaryMemberId: row.beneficiaryMemberId,
      amountCents: row.amountCents,
    };
  });
  return {
    operation: args.operation,
    ...(args.bookingGuestId ? { bookingGuestId: args.bookingGuestId } : {}),
    baseEvidence: exactBaseAmount(args.operation, booking, args.bookingGuestId),
    rows,
    redemption: booking.promoRedemption,
  };
}

export function selectLoadedBookingMoneyBuildUp(
  loaded: LoadedBookingMoneyBuildUp,
  args: {
    derivedCents: number;
    mismatchClassification?: BookingMoneyCompatibilityClassification;
  },
): BookingMoneyBuildUpSelection {
  return selectBookingMoneyBuildUp({
    ...loaded,
    derivedCents: args.derivedCents,
    ...(args.mismatchClassification
      ? { mismatchClassification: args.mismatchClassification }
      : {}),
  });
}

function buildUpHistoryMetadata(args: {
  operation: BookingMoneyBuildUpOperation;
  source: BookingMoneyBuildUpHistoryMetadata["moneyBuildUpSource"];
  reason: string;
  storedCents: number | null;
  derivedCents: number;
  classification?: BookingMoneyCompatibilityClassification | null;
}): BookingMoneyBuildUpHistoryMetadata {
  return {
    moneyBuildUpOperation: args.operation,
    moneyBuildUpSource: args.source,
    moneyBuildUpReason: args.reason,
    moneyBuildUpStoredCents: args.storedCents,
    moneyBuildUpDerivedCents: args.derivedCents,
    moneyBuildUpFallbackClassification: args.classification ?? null,
  };
}

/**
 * Compare the recorded build-up with today's calculation without ever changing
 * a member-visible amount. A mismatch has no default classification: callers
 * must name why the compatibility fallback is being taken, which is the
 * mutation-resistant guard against a silent `?? headline` path.
 */
export function selectBookingMoneyBuildUp(args: {
  operation: BookingMoneyBuildUpOperation;
  baseEvidence: BookingMoneyBaseEvidence;
  rows: ReadonlyArray<BookingMoneyBuildUpRow>;
  redemption: {
    priceAdjustmentCents: number;
    allocations: ReadonlyArray<{ memberId: string; priceAdjustmentCents: number }>;
  } | null;
  derivedCents: number;
  bookingGuestId?: string;
  mismatchClassification?: BookingMoneyCompatibilityClassification;
}): BookingMoneyBuildUpSelection {
  if (!Number.isInteger(args.derivedCents)) {
    refuse(`${args.operation}: today's result is not integer cents (${args.derivedCents})`);
  }
  if (args.baseEvidence.kind === "UNKNOWN") {
    const reason = args.baseEvidence.reason;
    return {
      source: "BASE_EVIDENCE_UNKNOWN",
      reason,
      storedCents: null,
      derivedCents: args.derivedCents,
      historyMetadata: buildUpHistoryMetadata({
        operation: args.operation,
        source: "BASE_EVIDENCE_UNKNOWN",
        reason,
        storedCents: null,
        derivedCents: args.derivedCents,
      }),
    };
  }

  const adjustmentState = deriveNightAdjustmentState({
    rows: args.rows,
    redemption: args.redemption,
  });
  if (adjustmentState === "NOT_KNOWN") {
    const reason = "ADJUSTMENT_BUILDUP_NOT_KNOWN" as const;
    const fallbackClassification = "STORED_SIDE_DEFECT" as const;
    return {
      source: "DERIVED_COMPATIBILITY_FALLBACK",
      reason,
      storedCents: null,
      derivedCents: args.derivedCents,
      selectedCents: args.derivedCents,
      fallbackClassification,
      historyMetadata: buildUpHistoryMetadata({
        operation: args.operation,
        source: "DERIVED_COMPATIBILITY_FALLBACK",
        reason,
        storedCents: null,
        derivedCents: args.derivedCents,
        classification: fallbackClassification,
      }),
    };
  }

  const operationRows =
    args.operation === "GUEST_REMOVAL"
      ? args.rows.filter((row) => row.bookingGuestId === args.bookingGuestId)
      : args.rows;
  const adjustmentCents = operationRows.reduce((sum, row) => sum + (row.amountCents ?? 0), 0);
  const storedCents =
    args.operation === "GUEST_REMOVAL"
      ? -(args.baseEvidence.amountCents + adjustmentCents)
      : args.operation === "XERO_PROMO_LINE"
        ? adjustmentCents
        : args.baseEvidence.amountCents + adjustmentCents;

  if (storedCents === args.derivedCents) {
    const reason = "STORED_MATCHES_DERIVED" as const;
    return {
      source: "STORED",
      reason,
      storedCents,
      derivedCents: args.derivedCents,
      selectedCents: storedCents,
      historyMetadata: buildUpHistoryMetadata({
        operation: args.operation,
        source: "STORED",
        reason,
        storedCents,
        derivedCents: args.derivedCents,
      }),
    };
  }

  if (!args.mismatchClassification) {
    refuse(
      `${args.operation}: stored ${storedCents} cents differs from today's ${args.derivedCents} cents without a classified compatibility fallback`,
    );
  }
  const reason = "STORED_DERIVED_MISMATCH" as const;
  return {
    source: "DERIVED_COMPATIBILITY_FALLBACK",
    reason,
    storedCents,
    derivedCents: args.derivedCents,
    selectedCents: args.derivedCents,
    fallbackClassification: args.mismatchClassification,
    historyMetadata: buildUpHistoryMetadata({
      operation: args.operation,
      source: "DERIVED_COMPATIBILITY_FALLBACK",
      reason,
      storedCents,
      derivedCents: args.derivedCents,
      classification: args.mismatchClassification,
    }),
  };
}
