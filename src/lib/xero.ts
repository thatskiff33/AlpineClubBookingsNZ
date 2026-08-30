/**
 * Xero Integration Library — compatibility facade.
 *
 * The Xero integration is composed of focused domain modules. This file
 * re-exports their public surface so existing callers can continue to
 * import from `@/lib/xero` without churn:
 *
 *   - infrastructure (OAuth, token storage, metered API + retry) in
 *     xero-oauth, xero-token-store, xero-api-client
 *   - reference mappings in xero-mappings
 *   - contact CRUD + retry-with-repair in xero-contacts
 *   - cached contact snapshots in xero-contact-cache
 *   - contact group cache + managed group sync in xero-contact-groups
 *   - duplicate detection / link suggestions in xero-duplicate-contacts
 *   - bulk contact sync in xero-bulk-contact-sync
 *   - member import in xero-member-import
 *   - membership invoice sync in xero-membership-sync
 *   - shared invoice / allocation helpers in xero-invoice-helpers
 *   - Stripe-to-Xero payment + refund payment in xero-invoice-payments
 *   - booking invoice create/update in xero-booking-invoices
 *   - refund + unapplied credit notes + allocation in xero-credit-notes
 *   - supplementary invoices in xero-supplementary-invoices
 *   - modification credit notes in xero-modification-credit-notes
 *   - entrance-fee invoices in xero-entrance-fee-invoices
 *
 * Prefer importing directly from the focused modules for new code. This
 * facade exists to preserve the long-standing `@/lib/xero` import path.
 */

/**
 * `import "server-only"` makes the production build REFUSE this module in a
 * browser bundle, at any depth (`INV-OPS-013`, #2850). Operator CLIs reach it
 * under plain Node, where that marker would throw at import, so every `tsx`
 * invocation that reaches it runs with `--conditions=react-server` — which
 * resolves `server-only` to an empty module. `cli-server-only-reach-census.ts`
 * enforces that pairing; `docs/invariants/operations.md` carries the reasoning.
 */
import "server-only";

// ---------------------------------------------------------------------------
// Infrastructure (OAuth / tokens / metered API client)
// ---------------------------------------------------------------------------

export {
  callXeroApi,
  getAuthenticatedXeroClient,
  // test seam
  isRetryableXeroContactReferenceError,
  // test seam
  resetXeroRateLimitStateForTests,
  // test seam
  withXeroRetry,
  XeroDailyLimitError,
  // test seam
  XeroTransientOutageError,
} from "./xero-api-client";

export {
  disconnectXero,
  getXeroConsentUrl,
  handleXeroCallback,
} from "./xero-oauth";

export {
  // test seam
  decryptToken,
  // test seam
  encryptToken,
  getXeroConnectionStatus,
  getXeroTokenReadability,
  isXeroConnected,
  XeroTokenDecryptError,
} from "./xero-token-store";

// ---------------------------------------------------------------------------
// Reference mappings (chart of accounts, items, entrance-fee categories)
// ---------------------------------------------------------------------------

export {
  buildEntranceFeeInvoiceIdempotencyKey,
  // test seam
  getAccountMapping,
  getEntranceFeeContext,
  getResolvedAccountMapping,
} from "./xero-mappings";
export type {
  EntranceFeeContext,
} from "./xero-mappings";

// ---------------------------------------------------------------------------
// Contacts (CRUD, retry-with-repair, normalisation)
// ---------------------------------------------------------------------------

export {
  createXeroContactForMember,
  findOrCreateXeroContact,
  // test seam
  retryXeroWriteWithContactRepair,
  updateXeroContact,
  XeroContactCreatePartialSuccessError,
  XeroContactValidationError,
} from "./xero-contacts";
export type {
  XeroContactCreatePartialSuccessPhase,
  XeroContactUpdateData,
} from "./xero-contacts";

// ---------------------------------------------------------------------------
// Contact cache snapshot + group cache + managed groups
// ---------------------------------------------------------------------------

export {
  refreshXeroContactCachesFromContact,
} from "./xero-contact-cache";

export {
  getXeroContactGroupCacheLastRefreshedAt,
  getXeroContactGroupMemberships,
  getXeroContactGroups,
  getXeroContactIdsForGroup,
  // test seam
  refreshXeroContactGroupCache,
  syncManagedXeroContactGroupForMember,
} from "./xero-contact-groups";

// ---------------------------------------------------------------------------
// Bulk sync + duplicate detection + import
// ---------------------------------------------------------------------------

export { syncContactsFromXero } from "./xero-bulk-contact-sync";

export {
  importMembersFromXeroGroups,
  XeroMemberImportValidationError,
  type XeroImportGroupMapping,
} from "./xero-member-import";

export {
  findDuplicateContacts,
  findPotentialXeroContactsForMember,
} from "./xero-duplicate-contacts";

// ---------------------------------------------------------------------------
// Membership subscription sync
// ---------------------------------------------------------------------------

export {
  checkMembershipStatus,
  // test seam
  determineSubscriptionStatus,
  findSubscriptionInvoice,
  flushMemberSubscriptionHistory,
  refreshAllMembershipStatuses,
  // test seam
  shouldBackfillMembershipStatus,
  syncMemberSubscriptionHistoryForLinkedContact,
} from "./xero-membership-sync";

// ---------------------------------------------------------------------------
// Invoice / credit note / payment document services
// ---------------------------------------------------------------------------

export {
  createXeroPaymentForInvoice,
  // test seam
  createXeroRefundPaymentForInvoice,
} from "./xero-invoice-payments";

export {
  // test seam
  buildInvoiceLineItems,
  createXeroInvoiceForBooking,
  updateXeroBookingInvoiceForBooking,
} from "./xero-booking-invoices";

export {
  allocateCreditNoteToInvoice,
  createUnappliedXeroCreditNote,
  createUnappliedXeroCreditNoteForModification,
  createXeroCreditNote,
} from "./xero-credit-notes";

export { createXeroSupplementaryInvoice } from "./xero-supplementary-invoices";

export { createXeroCreditNoteForModification } from "./xero-modification-credit-notes";

export {
  // test seam
  buildEntranceFeeLineItem,
  createXeroEntranceFeeInvoice,
} from "./xero-entrance-fee-invoices";
