/**
 * What each Finance officer action in `catalogue/finance-xero-contacts.ts` returns
 * (ALP-721, `INV-MCP-006`): the one place a catalogue entry's `returns`
 * and its route's projection both read (`INV-SSOT`). Money is integer cents.
 *
 * An officer's connection sends what it reads to the officer's AI provider,
 * so each shape keeps what the officer needs and leaves out contact details,
 * tokens, raw provider payloads and free text the answer does not need.
 * Types only: nothing here reaches the database.
 *
 * Across this module: no email address (a member's or a Xero contact's), no
 * Xero contact, document or group id except the contact id the link action
 * takes, and no Xero deep link (each carries a raw contact id and the
 * organisation's short code; the finance screens keep them).
 */
import { connectionShapeFor, type ConnectionShapeFor } from "@/lib/connection-projection";
import type { MissingXeroInvoicesSnapshot } from "@/lib/xero-admin-health";
import type { XeroCashCreditQueue, XeroCashCreditSnapshotResult } from "@/lib/xero-cash-credits";
import type { XeroContactLinkMismatchSnapshot } from "@/lib/xero-contact-link-mismatches";
import type { findDuplicateContacts } from "@/lib/xero-duplicate-contacts";
import type { ErasedMemberXeroContactReview } from "@/lib/xero-erased-member-contact-review-shape";
import type { ErasedContactStatusCheckSummary } from "@/lib/xero-erased-member-contact-status-check";
import type { MemberGroupingSnapshot } from "@/lib/xero-member-grouping-resync";
import type { XeroContactResyncSummary } from "@/lib/xero-mismatch-resync";
import type { MissingContactSnapshot, SeedingRunResult } from "@/lib/xero-missing-contact-seeding-shape";

/** `POST /api/admin/members/[id]/xero-link`: the contact the member is now linked to. */
export const XERO_MEMBER_LINKED_CONNECTION_SHAPE = connectionShapeFor<{
  xeroContactId: string;
  contactName: string | undefined;
  xeroLink: string;
  warning?: string;
}>({
  // The id the app sent, so the answer says which contact it was.
  xeroContactId: true,
  contactName: true,
  warning: true,
});

/** `POST /api/admin/members/[id]/xero-push`: whether the joining fee invoice was queued. */
export const XERO_MEMBER_PUSHED_CONNECTION_SHAPE = connectionShapeFor<{
  xeroContactId: string;
  xeroLink: string;
  entranceFeeInvoiceQueued: boolean;
  entranceFeeInvoiceMessage: string | undefined;
  warning?: string;
}>({
  entranceFeeInvoiceQueued: true,
  entranceFeeInvoiceMessage: true,
  warning: true,
});

/**
 * The `409` the push answers when Xero already holds contacts that look like
 * the member. A refusal reaches the app verbatim, so a connection is sent each
 * suggestion's id (what the link action takes), name and why it matched,
 * never its email address or deep link.
 */
export const XERO_MEMBER_PUSH_SUGGESTIONS_CONNECTION_SHAPE = connectionShapeFor<{
  error: string;
  suggestedContacts: Array<{
    contactId: string;
    name: string;
    email: string | null;
    isLinked: boolean;
    linkedMemberName: string | null;
    matchReasons: string[];
    xeroLink: string;
  }>;
}>({
  error: true,
  suggestedContacts: {
    contactId: true,
    name: true,
    isLinked: true,
    linkedMemberName: true,
    matchReasons: true,
  },
});

/** `POST /api/admin/members/[id]/xero-unlink`. */
export const XERO_MEMBER_UNLINKED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  clearedSubscriptionHistoryCount: number;
}>({
  success: true,
  clearedSubscriptionHistoryCount: true,
});

/**
 * `GET /api/admin/xero/search-contacts`: enough to pick the contact to link.
 * The contact id is what the link action takes; whether it is already linked,
 * and to whom, is what stops a link the route would refuse. The email address
 * is left out: an officer who cannot tell two same-named contacts apart
 * searches again with the member's email as `q`, and only the matching
 * contact comes back.
 */
export const XERO_CONTACT_SEARCH_CONNECTION_SHAPE = connectionShapeFor<{
  contacts: Array<{
    contactId: string;
    name: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    isLinked: boolean;
    linkedMemberId: string | null;
    linkedMemberName: string | null;
    existingMemberId: string | null;
    existingMemberName: string | null;
    canImportAsMember: boolean;
    importBlockReason: string | null;
  }>;
}>({
  contacts: {
    contactId: true,
    name: true,
    isLinked: true,
    linkedMemberId: true,
    linkedMemberName: true,
    existingMemberId: true,
    existingMemberName: true,
  },
});

/** One open overpayment or prepayment, in cents, with the member whose contact holds it. */
const CASH_CREDIT_QUEUE_FIELDS = {
  rows: {
    id: true,
    kind: true,
    currencyCode: true,
    documentDate: true,
    totalCents: true,
    remainingCents: true,
    member: { id: true, name: true },
  },
  refreshedAt: true,
} as const satisfies ConnectionShapeFor<XeroCashCreditQueue>;

/** `GET /api/admin/xero/cash-credits`. */
export const XERO_CASH_CREDITS_CONNECTION_SHAPE = connectionShapeFor<XeroCashCreditQueue>(CASH_CREDIT_QUEUE_FIELDS);

/** `POST /api/admin/xero/cash-credits`: what the refresh wrote, and the queue after it. */
export const XERO_CASH_CREDITS_REFRESHED_CONNECTION_SHAPE = connectionShapeFor<{
  result: XeroCashCreditSnapshotResult;
  queue: XeroCashCreditQueue;
}>({
  result: { open: true, written: true, zeroed: true, current: true },
  queue: CASH_CREDIT_QUEUE_FIELDS,
});

const RESYNC_SUMMARY_FIELDS = {
  requestedContacts: true,
  resyncedContacts: true,
  removedContacts: true,
  resyncedAt: true,
} as const satisfies ConnectionShapeFor<XeroContactResyncSummary>;

/**
 * The contact-group review: counts, and each member whose Xero groups differ
 * from the rules, by name. Group ids and the plan digests are left out; the
 * group's name says which one.
 */
const CONTACT_GROUP_MISMATCH_FIELDS = {
  mode: true,
  cacheReady: true,
  lastRefreshedAt: true,
  activeRuleCount: true,
  membersConsidered: true,
  mismatchCount: true,
  addCount: true,
  removeCount: true,
  estimatedXeroCalls: true,
  skippedNoContact: { memberId: true, memberName: true },
  mismatches: { memberId: true, memberName: true, ageTier: true, managedGroup: { name: true } },
  informationalCount: true,
  informational: { memberId: true, memberName: true, ageTier: true, unexpectedManagedGroups: { name: true } },
} as const satisfies ConnectionShapeFor<MemberGroupingSnapshot>;

/** `GET /api/admin/xero/contact-group-mismatches`. */
export const XERO_CONTACT_GROUP_MISMATCHES_CONNECTION_SHAPE =
  connectionShapeFor<MemberGroupingSnapshot>(CONTACT_GROUP_MISMATCH_FIELDS);

/** `POST /api/admin/xero/contact-group-mismatches`: the review after the resync, and what it re-read. */
export const XERO_CONTACT_GROUP_MISMATCHES_RESYNCED_CONNECTION_SHAPE = connectionShapeFor<
  MemberGroupingSnapshot & { resync: XeroContactResyncSummary }
>({ ...CONTACT_GROUP_MISMATCH_FIELDS, resync: RESYNC_SUMMARY_FIELDS });

/** Each member whose name differs from their linked Xero contact's, by name and reason. */
const CONTACT_LINK_MISMATCH_FIELDS = {
  cacheReady: true,
  lastRefreshedAt: true,
  count: true,
  mismatches: { memberId: true, memberName: true, active: true, xeroContactName: true, reasons: true },
} as const satisfies ConnectionShapeFor<XeroContactLinkMismatchSnapshot>;

/** `GET /api/admin/xero/contact-link-mismatches`. */
export const XERO_CONTACT_LINK_MISMATCHES_CONNECTION_SHAPE =
  connectionShapeFor<XeroContactLinkMismatchSnapshot>(CONTACT_LINK_MISMATCH_FIELDS);

/** `POST /api/admin/xero/contact-link-mismatches`. */
export const XERO_CONTACT_LINK_MISMATCHES_RESYNCED_CONNECTION_SHAPE = connectionShapeFor<
  XeroContactLinkMismatchSnapshot & { resync: XeroContactResyncSummary }
>({ ...CONTACT_LINK_MISMATCH_FIELDS, resync: RESYNC_SUMMARY_FIELDS });

/**
 * `GET /api/admin/xero/duplicate-contacts`: groups of Xero contacts that share
 * an email address, with names and invoice counts. The shared address is the
 * group's key on the screen and is left out here, as are the contact ids and
 * deep links; merging happens in Xero.
 */
export const XERO_DUPLICATE_CONTACTS_CONNECTION_SHAPE = connectionShapeFor<
  Awaited<ReturnType<typeof findDuplicateContacts>>
>({
  duplicateGroups: {
    contacts: {
      name: true,
      hasInvoices: true,
      invoiceCount: true,
      contactStatus: true,
      updatedDateUTC: true,
      memberId: true,
      memberActive: true,
    },
    canCreateFamilyGroup: true,
    eligibleMemberIds: true,
    suggestedGroupName: true,
  },
  totalContacts: true,
  totalDuplicateEmails: true,
  filteredByFamilyGroup: true,
});

/**
 * The erased-member contact review (`INV-INT-024`). Each row is already ids
 * only; a connection is sent less still: how and when the member was erased
 * and what is known of the contact in Xero, never the erased member's record
 * id or the Xero contact id. Either would let the AI provider tie the row
 * back to a person who asked to be forgotten, and neither is anything an app
 * action takes. The treasurer opens the contacts from the website's review
 * screen.
 */
const ERASED_MEMBER_CONTACT_REVIEW_FIELDS = {
  needsReview: true,
  alreadyRetiredInXero: true,
  rows: { erasure: true, erasedAt: true, contactStatus: true, contactStatusCheckedAt: true },
  truncated: true,
  lastContactStatusCheckAt: true,
  contactCacheLastRefreshedAt: true,
  contactCacheAgeHours: true,
  contactCacheStale: true,
} as const satisfies ConnectionShapeFor<ErasedMemberXeroContactReview>;

/** `GET /api/admin/xero/erased-member-contacts`. */
export const XERO_ERASED_MEMBER_CONTACTS_CONNECTION_SHAPE = connectionShapeFor<{
  review: ErasedMemberXeroContactReview;
}>({ review: ERASED_MEMBER_CONTACT_REVIEW_FIELDS });

/** `POST /api/admin/xero/erased-member-contacts`: the review after asking Xero, and the counts it observed. */
export const XERO_ERASED_MEMBER_CONTACTS_CHECKED_CONNECTION_SHAPE = connectionShapeFor<{
  review: ErasedMemberXeroContactReview;
  check: ErasedContactStatusCheckSummary;
}>({
  review: ERASED_MEMBER_CONTACT_REVIEW_FIELDS,
  check: {
    checkedContacts: true,
    observedContacts: true,
    notFoundInXero: true,
    retiredInXero: true,
    checkedAt: true,
  },
});

/**
 * `GET /api/admin/xero/missing-contacts`: the dry run. `plannedDigest` and the
 * member ids are what the run action takes; email addresses and the cached
 * contact ids are left out.
 */
export const XERO_MISSING_CONTACTS_CONNECTION_SHAPE = connectionShapeFor<{
  snapshot: MissingContactSnapshot;
  notReadyMessage: string | null;
}>({
  snapshot: {
    cacheReady: true,
    plannedDigest: true,
    chunkSize: true,
    estimatedXeroCallsPerChunk: true,
    eligible: true,
    alreadyLinked: true,
    unlinked: true,
    pushable: true,
    excluded: true,
    ambiguous: true,
    pushableRows: { memberId: true, memberName: true, evidence: true },
    excludedRows: { memberId: true, memberName: true, reason: true },
    ambiguousRows: { memberId: true, memberName: true, reason: true },
    contactCacheLastRefreshedAt: true,
    contactCacheAgeHours: true,
    contactCacheStale: true,
  },
  notReadyMessage: true,
});

/** `POST /api/admin/xero/missing-contacts`: what one chunk of the run did, member by member. */
export const XERO_MISSING_CONTACTS_RUN_CONNECTION_SHAPE = connectionShapeFor<{ result: SeedingRunResult }>({
  result: {
    processed: true,
    linkedExisting: true,
    created: true,
    resolvedUnlabelled: true,
    failed: true,
    failures: { memberId: true, kind: true, error: true },
    outcomes: { memberId: true, memberName: true, outcome: true, plannedEvidence: true, kind: true, error: true },
    skipped: { memberId: true, reason: true },
    remaining: true,
    outstandingPushable: true,
    done: true,
    haltedByDailyLimit: true,
    haltedByTimeBudget: true,
  },
});

/** `GET /api/admin/xero/missing-invoices`: paid bookings with no Xero invoice, by member name. */
export const XERO_MISSING_INVOICES_CONNECTION_SHAPE = connectionShapeFor<MissingXeroInvoicesSnapshot>({
  count: true,
  bookings: {
    bookingId: true,
    paymentId: true,
    memberId: true,
    memberName: true,
    status: true,
    checkIn: true,
    checkOut: true,
    createdAt: true,
  },
});

/** `POST /api/admin/xero/missing-invoices`: how many invoices were queued, and why any were not. */
export const XERO_MISSING_INVOICES_QUEUED_CONNECTION_SHAPE = connectionShapeFor<{
  ok: boolean;
  found: number;
  queued: number;
  skipped: number;
  skippedBookings?: Array<{ bookingId: string; reason: string }>;
  message: string;
}>({
  ok: true,
  found: true,
  queued: true,
  skipped: true,
  skippedBookings: { bookingId: true, reason: true },
  message: true,
});
