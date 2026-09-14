/**
 * The SHAPE of the erased-member Xero contact review (#3058, `INV-INT-024`):
 * what the review returns, and the constants it is measured against. The engine
 * is `xero-erased-member-contact-review.ts`; the design is in
 * `docs/xero/ARCHITECTURE.md` and the operator guide in `docs/guides/xero.md`.
 *
 * ## WHY THIS IS ITS OWN MODULE, AND WHY IT IMPORTS ALMOST NOTHING
 *
 * The same reason `xero-missing-contact-seeding-shape.ts` is: the admin panel
 * needs these unions so its reason-to-copy maps can be keyed on
 * `Record<ErasureKind, string>` rather than on `Record<string, string>`, which
 * turns a new erasure path into a compile error in the panel instead of a
 * fallback sentence shipped silently to a treasurer. But the panel is a
 * `"use client"` file, and a module reaching `@/lib/prisma` on its behalf is
 * exactly the shape `INV-OPS-013` exists to catch. A leaf cannot put anything
 * on the browser graph whatever a later reader adds to the engine.
 *
 * It imports NOTHING, not even the staleness threshold it is measured against.
 * That threshold belongs to the missing-contact census's shape module and the
 * engine reads it from there directly, because this review and that census read
 * the SAME contact cache and must agree on when it is old enough to mislead
 * (`INV-SSOT`). Re-exporting it through here would add a barrel hop that only
 * the dead-code gate would ever notice.
 */

/**
 * HOW the member was erased. Both are durable, structural records that outlive
 * the member's own row, which is what makes this review a read of decided facts
 * rather than an inference from what a row looks like now.
 *
 * - `ANONYMISED_BY_DELETION_REQUEST` — an approved `DeletionRequest`. Approval
 *   is claimed INSIDE the anonymisation transaction, so `APPROVED` and
 *   "anonymisation committed" are the same event.
 * - `HARD_DELETED` — an approved `MemberLifecycleActionRequest` with action
 *   `DELETE`. That row deliberately carries no foreign key to `Member`, so it
 *   survives the row it describes.
 *
 * Deliberately NOT the anonymisation MARKERS (`isDeletedAccountRecord`).
 * `INV-LIFE-015` says in as many words that the marker predicate is a strong
 * signal and not a schema invariant: the membership-application MAP branch
 * overwrites both markers, so a mapped-over row stops being recognisable as
 * erased — and the Xero contact the erasure orphaned is no less orphaned for
 * that. A review that reads the markers would silently lose exactly those rows.
 */
export type ErasureKind = "ANONYMISED_BY_DELETION_REQUEST" | "HARD_DELETED";

/**
 * What is known about the contact in Xero, from the local contact cache and
 * from nothing else. NO provider call is made to establish it.
 *
 * `UNKNOWN` is the honest answer, not a failure: the erasure DELETES the
 * contact's cache row, so a contact stays unknown until a later contact sync
 * observes it again. An unknown row is shown, because over-reporting review
 * work is the safe direction and under-reporting it is not.
 */
export type ReviewedContactStatus = "ACTIVE" | "ARCHIVED" | "UNKNOWN";

/**
 * ONE Xero contact that an erasure left behind.
 *
 * IDS ONLY, and that is the whole disclosure rule for this screen. The member
 * was erased; naming them here would undo the erasure this row exists to report
 * on. The contact's own name, email and address are in the cache and are
 * deliberately not read: the treasurer opens the contact in Xero, where that
 * data lives and where it is already theirs to see.
 */
export interface ErasedMemberXeroContactRow {
  /**
   * The local record the contact used to belong to. An opaque id: the member's
   * details are gone, and for a hard delete the row itself is gone.
   */
  memberId: string;
  xeroContactId: string;
  erasure: ErasureKind;
  /**
   * When the erasure was approved, ISO, or `null` when the surviving record
   * carries no review timestamp. A date, not a detail: it is what lets a
   * treasurer work oldest-first, and the row already discloses that this id was
   * erased.
   */
  erasedAt: string | null;
  contactStatus: ReviewedContactStatus;
}

export interface ErasedMemberXeroContactReview {
  /**
   * Rows a treasurer may want to look at: every row whose contact the cache
   * does not already show as archived in Xero.
   */
  needsReview: number;
  /**
   * Rows whose contact Xero already holds as archived. Counted and not listed:
   * somebody has already dealt with these, and the point of a count is that the
   * number stops being a surprise when the cache refreshes.
   */
  alreadyArchivedInXero: number;
  /** The `needsReview` rows, oldest erasure first, capped by the row limit. */
  rows: ErasedMemberXeroContactRow[];
  /** True when `rows` was cut short by that limit. */
  truncated: boolean;
  /** When the contact cache was last refreshed, and whether that is old news. */
  contactCacheLastRefreshedAt: string | null;
  contactCacheAgeHours: number | null;
  contactCacheStale: boolean;
}
