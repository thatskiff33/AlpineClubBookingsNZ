/**
 * The bookings both derived-filter pre-filter suites seed (#4939): the unit
 * suite (`admin-bookings-derived-prefilter.test.ts`) builds them as mock rows,
 * the realdb suite as PostgreSQL rows. One declaration, so the two prove the
 * same population.
 *
 * Each pre-filter in `admin-bookings-service.ts` must keep every booking the
 * JavaScript derivation would show for its filter value. The scenarios are
 * chosen so that every plausible way of writing a pre-filter too NARROWLY
 * drops at least one of them:
 *
 * | Filter value               | Necessary condition the pre-filter states       | Scenario that catches a narrower one |
 * | -------------------------- | ----------------------------------------------- | ------------------------------------ |
 * | xero operationFailed       | a FAILED operation on the booking, its payment  | failed-on-payment, failed-on-       |
 * |                            | or any modification — any of them, resolved too | modification, failed-then-succeeded, |
 * |                            |                                                 | failed-resolved                      |
 * | xero operationPartial      | a PARTIAL operation on any of the three records | partial-on-payment                   |
 * | xero operationPending      | a PENDING/RUNNING/WAITING_PAYMENT operation     | pending-waiting, pending-running     |
 * | xero invoiceLinked         | a payment row                                   | linked-by-object-link                |
 * | xero invoiceMissing        | a payment in an invoice-expected status         | missing-refunded                     |
 * | bed unallocated            | allocatable status, no hold, a guest            | unallocated-stray-row                |
 * | bed partial                | the above, and an allocation row                | bed-partial                          |
 * | bed warning                | no hold, an allocation row (any status)         | warning-cancelled                    |
 * | bed complete               | none — the fall-through state                   | —                                    |
 * | change requiresReview      | the review flag, or a PENDING review status     | review-status-pending                |
 * | change pendingRequest      | a REQUESTED change request                      | change-requested                     |
 * | change hasModification     | a modification row                              | failed-on-modification               |
 * | change creditGenerated     | a cancellation credit or a modification credit  | credit-from-modification             |
 *
 * `expected` is the state the derivation must report for each scenario; the
 * suites check it so a mis-seeded fixture fails loudly rather than proving
 * nothing.
 */

export type XeroRecord = "booking" | "payment" | "modification";

export interface DerivedScenario {
  key: string;
  status?: "PAID" | "CANCELLED" | "DRAFT" | "PAYMENT_PENDING";
  wholeLodgeHold?: boolean;
  requiresAdminReview?: boolean;
  adminReviewStatus?: "PENDING" | "APPROVED";
  payment?: {
    status: "SUCCEEDED" | "REFUNDED" | "PENDING";
    /** A stored `Payment.xeroInvoiceId`. */
    storedInvoice?: boolean;
    /** An active PRIMARY_INVOICE object link instead of a stored id. */
    linkedInvoice?: boolean;
  };
  /** One guest, on these night offsets from the booking's check-in. */
  guest?: { ageTier: "ADULT" | "CHILD"; nights: number[] };
  /** Allocation rows for that guest, by night offset (one room). */
  allocatedNights?: number[];
  /** Modifications, each optionally carrying a credit it generated. */
  modifications?: Array<{ credit: boolean }>;
  changeRequests?: Array<"REQUESTED" | "APPROVED">;
  cancellationCredit?: boolean;
  /**
   * Xero sync operations, oldest first. `on: "modification"` names the first
   * modification. `resolved` sets `manuallyResolvedAt`.
   */
  xeroOperations?: Array<{ on: XeroRecord; status: string; resolved?: boolean }>;
  /** What the derivation reports; null for a booking the list never shows. */
  expected: {
    xero: string;
    bed: string;
    change: ReadonlyArray<"requiresReview" | "pendingRequest" | "hasModification" | "creditGenerated">;
  } | null;
}

const NONE = { xero: "none", bed: "complete", change: [] } as const;

export const DERIVED_SCENARIOS: readonly DerivedScenario[] = [
  // ── Xero ──────────────────────────────────────────────────────────────
  {
    key: "failed-then-succeeded",
    // The failure is not the latest operation; the summary counts it anyway.
    xeroOperations: [
      { on: "booking", status: "FAILED" },
      { on: "booking", status: "SUCCEEDED" },
    ],
    expected: { ...NONE, xero: "operationFailed" },
  },
  {
    key: "failed-on-payment",
    payment: { status: "SUCCEEDED", storedInvoice: true },
    xeroOperations: [{ on: "payment", status: "FAILED" }],
    expected: { ...NONE, xero: "operationFailed" },
  },
  {
    key: "failed-on-modification",
    modifications: [{ credit: false }],
    xeroOperations: [{ on: "modification", status: "FAILED" }],
    expected: { ...NONE, xero: "operationFailed", change: ["hasModification"] },
  },
  {
    key: "failed-resolved",
    // An officer resolved it in Xero; the list still reports the failure.
    xeroOperations: [{ on: "booking", status: "FAILED", resolved: true }],
    expected: { ...NONE, xero: "operationFailed" },
  },
  {
    key: "partial-on-payment",
    payment: { status: "SUCCEEDED" },
    xeroOperations: [
      { on: "payment", status: "PARTIAL" },
      { on: "booking", status: "PENDING" },
    ],
    expected: { ...NONE, xero: "operationPartial" },
  },
  {
    key: "failed-beats-partial",
    modifications: [{ credit: false }],
    xeroOperations: [
      { on: "booking", status: "PARTIAL" },
      { on: "modification", status: "FAILED" },
    ],
    expected: { ...NONE, xero: "operationFailed", change: ["hasModification"] },
  },
  {
    key: "pending-waiting",
    payment: { status: "PENDING" },
    xeroOperations: [{ on: "payment", status: "WAITING_PAYMENT" }],
    expected: { ...NONE, xero: "operationPending" },
  },
  {
    key: "pending-running",
    modifications: [{ credit: false }],
    xeroOperations: [{ on: "modification", status: "RUNNING" }],
    expected: { ...NONE, xero: "operationPending", change: ["hasModification"] },
  },
  {
    key: "linked-stored-id",
    payment: { status: "SUCCEEDED", storedInvoice: true },
    expected: { ...NONE, xero: "invoiceLinked" },
  },
  {
    key: "linked-by-object-link",
    payment: { status: "SUCCEEDED", linkedInvoice: true },
    expected: { ...NONE, xero: "invoiceLinked" },
  },
  {
    key: "missing-refunded",
    payment: { status: "REFUNDED" },
    expected: { ...NONE, xero: "invoiceMissing" },
  },
  {
    key: "missing-succeeded",
    payment: { status: "SUCCEEDED" },
    expected: { ...NONE, xero: "invoiceMissing" },
  },
  {
    key: "none-payment-pending",
    payment: { status: "PENDING" },
    expected: NONE,
  },
  { key: "none-no-payment", expected: NONE },
  {
    key: "draft-failed",
    // Drafts never list, whatever their state.
    status: "DRAFT",
    xeroOperations: [{ on: "booking", status: "FAILED" }],
    expected: null,
  },

  // ── Beds ──────────────────────────────────────────────────────────────
  {
    key: "unallocated",
    guest: { ageTier: "ADULT", nights: [0, 1] },
    expected: { ...NONE, bed: "unallocated" },
  },
  {
    key: "unallocated-stray-row",
    // Sparse nights {0, 2}; the only allocation row is on the gap night, so
    // the booking has an allocation row yet none of its expected nights.
    guest: { ageTier: "ADULT", nights: [0, 2] },
    allocatedNights: [1],
    expected: { ...NONE, bed: "unallocated" },
  },
  {
    key: "bed-partial",
    guest: { ageTier: "ADULT", nights: [0, 1] },
    allocatedNights: [0],
    expected: { ...NONE, bed: "partial" },
  },
  {
    key: "bed-complete",
    guest: { ageTier: "ADULT", nights: [0] },
    allocatedNights: [0],
    expected: NONE,
  },
  {
    key: "warning",
    guest: { ageTier: "CHILD", nights: [0] },
    allocatedNights: [0],
    expected: { ...NONE, bed: "warning" },
  },
  {
    key: "warning-cancelled",
    // Warnings are read off allocation rows whatever the status.
    status: "CANCELLED",
    guest: { ageTier: "CHILD", nights: [0] },
    allocatedNights: [0],
    expected: { ...NONE, bed: "warning" },
  },
  {
    key: "whole-lodge-hold",
    wholeLodgeHold: true,
    guest: { ageTier: "ADULT", nights: [0] },
    expected: NONE,
  },
  {
    key: "cancelled-no-beds",
    status: "CANCELLED",
    guest: { ageTier: "ADULT", nights: [0] },
    expected: NONE,
  },

  // ── Change state ──────────────────────────────────────────────────────
  {
    key: "review-flag",
    requiresAdminReview: true,
    expected: { ...NONE, change: ["requiresReview"] },
  },
  {
    key: "review-status-pending",
    adminReviewStatus: "PENDING",
    expected: { ...NONE, change: ["requiresReview"] },
  },
  { key: "review-approved", adminReviewStatus: "APPROVED", expected: NONE },
  {
    key: "change-requested",
    changeRequests: ["APPROVED", "REQUESTED"],
    expected: { ...NONE, change: ["pendingRequest"] },
  },
  { key: "change-approved", changeRequests: ["APPROVED"], expected: NONE },
  {
    key: "credit-from-cancellation",
    status: "CANCELLED",
    cancellationCredit: true,
    expected: { ...NONE, change: ["creditGenerated"] },
  },
  {
    key: "credit-from-modification",
    modifications: [{ credit: false }, { credit: true }],
    expected: { ...NONE, change: ["hasModification", "creditGenerated"] },
  },

  // ── Combinations: one booking in each combined case below ─────────────
  {
    key: "warning-with-credit",
    status: "CANCELLED",
    guest: { ageTier: "CHILD", nights: [0] },
    allocatedNights: [0],
    cancellationCredit: true,
    expected: { ...NONE, bed: "warning", change: ["creditGenerated"] },
  },
  {
    key: "missing-in-review",
    payment: { status: "SUCCEEDED" },
    adminReviewStatus: "PENDING",
    expected: { ...NONE, xero: "invoiceMissing", change: ["requiresReview"] },
  },
];

/** Every filter value the derived-filter path accepts, other than `all`. */
export const DERIVED_FILTER_CASES = [
  ...(["invoiceLinked", "invoiceMissing", "operationFailed", "operationPartial", "operationPending"] as const).map(
    (value) => ({ xeroState: value })
  ),
  ...(["unallocated", "partial", "complete", "warning"] as const).map((value) => ({ bedState: value })),
  ...(["requiresReview", "pendingRequest", "hasModification", "creditGenerated"] as const).map(
    (value) => ({ changeState: value })
  ),
  // Combinations AND their pre-filters together.
  { xeroState: "operationFailed", changeState: "hasModification" },
  { bedState: "warning", changeState: "creditGenerated" },
  { xeroState: "invoiceMissing", bedState: "complete", changeState: "requiresReview" },
] as const;

export type DerivedFilterCase = (typeof DERIVED_FILTER_CASES)[number];

/** Whether a row's derived operational state passes a filter case — the JS authority's answer. */
export function rowMatchesCase(
  operational: {
    xeroState: string;
    bedState: string;
    requiresReview: boolean;
    pendingChangeRequest: boolean;
    hasModification: boolean;
    creditGenerated: boolean;
  },
  filterCase: DerivedFilterCase,
  bedAllocationEnabled = true
): boolean {
  const changeFlags = {
    requiresReview: operational.requiresReview,
    pendingRequest: operational.pendingChangeRequest,
    hasModification: operational.hasModification,
    creditGenerated: operational.creditGenerated,
  };
  if ("xeroState" in filterCase && operational.xeroState !== filterCase.xeroState) return false;
  if (bedAllocationEnabled && "bedState" in filterCase && operational.bedState !== filterCase.bedState) {
    return false;
  }
  if ("changeState" in filterCase && !changeFlags[filterCase.changeState]) return false;
  return true;
}
