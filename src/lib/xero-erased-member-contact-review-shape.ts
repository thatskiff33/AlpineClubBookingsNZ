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
 * What is known about the contact in Xero, for a row that is LISTED.
 *
 * Deliberately narrower than the provider's own status set, and narrower than
 * what the engine reads. A contact Xero holds as `ARCHIVED` or `GDPRREQUEST` is
 * counted and never listed, so those two cannot appear here — a fact the type
 * states rather than a comment promising it. The panel's copy map is keyed on
 * this union, so it has no branch that can never render.
 *
 * - `ACTIVE` — Xero holds it as a live contact.
 * - `UNRECOGNISED` — Xero reports a status this application does not know.
 *   Listed, because over-reporting review work is the safe direction.
 * - `UNKNOWN` — nothing has looked. The honest answer, not a failure: the
 *   erasure DELETES the contact's cache row and the bulk contact sync never
 *   re-fetches an archived contact, so a contact stays unknown until somebody
 *   asks Xero from this screen.
 */
export type ListedContactStatus = "ACTIVE" | "UNRECOGNISED" | "UNKNOWN";

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
  contactStatus: ListedContactStatus;
  /**
   * When Xero was last asked about this contact from this screen, ISO, or
   * `null` if it never has been. A date about a CONTACT, not about a person.
   */
  contactStatusCheckedAt: string | null;
}

export interface ErasedMemberXeroContactReview {
  /**
   * Rows a treasurer may want to look at: every row whose contact is not
   * already known to be retired in Xero.
   */
  needsReview: number;
  /**
   * Rows whose contact Xero holds as archived, or as asked-to-be-erased
   * (`GDPRREQUEST`). Counted and not listed: somebody has already dealt with
   * these. The count is what makes the work visible landing, and it can only
   * move when somebody asks Xero from this screen — see `checkedAt` below.
   */
  alreadyRetiredInXero: number;
  /** The `needsReview` rows, oldest erasure first, capped by the row limit. */
  rows: ErasedMemberXeroContactRow[];
  /** True when `rows` was cut short by that limit. */
  truncated: boolean;
  /**
   * The freshest moment any contact on this review was last asked about in
   * Xero, ISO, or `null` when none ever has been. The one number the screen
   * needs to say honestly whether it is looking at old news.
   */
  lastContactStatusCheckAt: string | null;
  /** When the contact cache was last refreshed, and whether that is old news. */
  contactCacheLastRefreshedAt: string | null;
  contactCacheAgeHours: number | null;
  contactCacheStale: boolean;
}
