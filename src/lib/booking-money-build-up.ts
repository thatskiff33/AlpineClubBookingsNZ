import type { BookingGuestNightPriceSource, Prisma } from "@prisma/client";

import type { EditFinancialReviewCause } from "@/lib/edit-financial-review-context";
import {
  deriveNightAdjustmentState,
  memberBenefitAllocations,
} from "@/lib/night-adjustment-write";
import { storedSoldPriceEvidenceForGuest } from "@/lib/stored-sold-price-evidence";

export const BOOKING_MONEY_BUILD_UP_INVARIANT = "INV-MONEY-030";

function refuse(message: string): never {
  throw new Error(`${BOOKING_MONEY_BUILD_UP_INVARIANT}: ${message}`);
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
      /**
       * The one cause vocabulary (`INV-SSOT-001`, #3506): this is fed straight
       * from `storedSoldPriceEvidenceForGuest(...).cause`, so a value added to
       * `EDIT_FINANCIAL_REVIEW_CAUSES` flows through here with no edit.
       */
      reason: EditFinancialReviewCause;
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

export type BookingMoneyBuildUpProjection = {
  checkIn: Date;
  checkOut: Date;
  totalPriceCents: number;
  guests: Array<{
    id: string;
    priceCents: number;
    stayStart: Date | null;
    stayEnd: Date | null;
    nights: Array<{
      id: string;
      stayDate: Date;
      priceCents: number | null;
      priceSource: BookingGuestNightPriceSource;
    }>;
  }>;
  promoRedemption: {
    priceAdjustmentCents: number;
    // The column as it is since #3369: a school's booker-slot allocation names
    // no member. `bookingMoneyBuildUpFromProjection` narrows it through the
    // writer's own rule, so `LoadedBookingMoneyBuildUp` stays member-keyed.
    allocations: Array<{ memberId: string | null; priceAdjustmentCents: number }>;
  } | null;
  nightAdjustments: Array<{
    bookingGuestId: string | null;
    bookingGuestNightId: string | null;
    beneficiaryMemberId: string;
    amountCents: number | null;
  }>;
};

function exactBaseAmount(
  operation: BookingMoneyBuildUpOperation,
  booking: Pick<
    BookingMoneyBuildUpProjection,
    "checkIn" | "checkOut" | "totalPriceCents" | "guests"
  >,
  bookingGuestId?: string,
): BookingMoneyBaseEvidence {
  if (operation === "GUEST_REMOVAL") {
    const guest = booking.guests.find((candidate) => candidate.id === bookingGuestId);
    if (!guest) {
      return { kind: "UNKNOWN", reason: "NO_STORED_NIGHT_PRICES" };
    }
    const evidence = storedSoldPriceEvidenceForGuest(guest, booking, "WHOLE_GUEST");
    return evidence.kind === "exact"
      ? { kind: "EXACT", amountCents: evidence.totalCents }
      : { kind: "UNKNOWN", reason: evidence.cause };
  }

  const grain = operation === "REVIEW_REBASE" ? "INDIVIDUAL_NIGHT" : "WHOLE_GUEST";
  if (booking.guests.length === 0) {
    return { kind: "UNKNOWN", reason: "NO_STORED_NIGHT_PRICES" };
  }
  let totalCents = 0;
  for (const guest of booking.guests) {
    const evidence = storedSoldPriceEvidenceForGuest(guest, booking, grain);
    if (evidence.kind === "unusable") {
      return { kind: "UNKNOWN", reason: evidence.cause };
    }
    totalCents += evidence.totalCents;
  }
  if (operation === "REVIEW_REBASE") {
    // A review rebase deliberately replaces a stale booking headline with the
    // exact surviving-night total. Requiring the old headline to agree here
    // would make the operation incapable of correcting that stale value.
    return { kind: "EXACT", amountCents: totalCents };
  }
  return totalCents === booking.totalPriceCents
    ? { kind: "EXACT", amountCents: totalCents }
    : { kind: "UNKNOWN", reason: "STORED_TOTAL_MISMATCH" };
}

/**
 * The one database loader for transaction-owning Stage 3 money readers. The
 * caller passes its transaction client; no ambient client is imported here.
 * Xero already needs a wider booking snapshot and uses the pure projector
 * below against that same query instead of performing a second unlocked read.
 */
export async function readBookingMoneyBuildUp(
  store: BookingMoneyBuildUpStore,
  args: {
    bookingId: string;
    purpose: BookingMoneyBuildUpOperation;
    bookingGuestId?: string;
  },
): Promise<LoadedBookingMoneyBuildUp> {
  const booking = await store.booking.findUnique({
    where: { id: args.bookingId },
    select: {
      totalPriceCents: true,
      checkIn: true,
      checkOut: true,
      guests: {
        select: {
          id: true,
          priceCents: true,
          stayStart: true,
          stayEnd: true,
          nights: {
            select: {
              id: true,
              stayDate: true,
              priceCents: true,
              priceSource: true,
            },
          },
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
    refuse(`${args.purpose}: booking ${args.bookingId} does not exist`);
  }
  return bookingMoneyBuildUpFromProjection(booking, args);
}

/**
 * Project the canonical Stage 3 evidence from a coherent booking snapshot.
 * Xero uses this with its invoice query so the headline and build-up cannot
 * come from different commits; transaction-owning paths use the loader above.
 */
export function bookingMoneyBuildUpFromProjection(
  booking: BookingMoneyBuildUpProjection,
  args: {
    purpose: BookingMoneyBuildUpOperation;
    bookingGuestId?: string;
  },
): LoadedBookingMoneyBuildUp {
  const guestIdByNightId = new Map(
    booking.guests.flatMap((guest) =>
      guest.nights.map((night) => [night.id, guest.id] as const),
    ),
  );
  const rows = booking.nightAdjustments.map((row) => {
    const bookingGuestId =
      row.bookingGuestId ??
      (row.bookingGuestNightId
        ? guestIdByNightId.get(row.bookingGuestNightId)
        : undefined);
    if (!bookingGuestId) {
      refuse(`${args.purpose}: an adjustment row is attached to neither a guest nor a night`);
    }
    return {
      bookingGuestId,
      beneficiaryMemberId: row.beneficiaryMemberId,
      amountCents: row.amountCents,
    };
  });
  return {
    operation: args.purpose,
    ...(args.bookingGuestId ? { bookingGuestId: args.bookingGuestId } : {}),
    baseEvidence: exactBaseAmount(
      args.purpose,
      booking,
      args.bookingGuestId,
    ),
    rows,
    redemption: booking.promoRedemption && {
      priceAdjustmentCents: booking.promoRedemption.priceAdjustmentCents,
      allocations: memberBenefitAllocations(booking.promoRedemption.allocations),
    },
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

/**
 * The amount Stage 3 may feed into today's writer under D3. An unknown base has
 * no stored candidate, so the existing derived amount remains authoritative;
 * every other selection already carries either the identical stored amount or
 * the explicitly classified derived compatibility fallback.
 */
export function d3CompatibleBookingMoneyBuildUpCents(
  selection: BookingMoneyBuildUpSelection,
): number {
  return selection.source === "BASE_EVIDENCE_UNKNOWN"
    ? selection.derivedCents
    : selection.selectedCents;
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
