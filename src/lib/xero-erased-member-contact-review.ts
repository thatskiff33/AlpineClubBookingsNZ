/**
 * The erased-member Xero contact review (#3058, `INV-INT-024`). Read-only.
 *
 * ## What it is for
 *
 * Erasing a member in this application changes NOTHING in Xero, and that is a
 * settled product decision rather than an omission: Xero is the club's
 * accounting system, administered separately by the treasurer, and any decision
 * about a contact in it belongs there. What erasure does locally is drop the
 * pointer — `Member.xeroContactId` is nulled and the canonical `CONTACT` link
 * is retired — so the contact goes on existing in Xero with nothing here
 * pointing at it, and nobody is told.
 *
 * This module is the telling. It answers one question for an authorised
 * officer: WHICH Xero contacts did an erasure leave behind? It is the mirror
 * image of the missing-contact census (`INV-INT-022`) — that one finds members
 * with no contact, this one finds contacts with no member — and it follows the
 * same discipline, because the same discipline is what makes either safe: it
 * reads, it hands the decision to a person, and it decides nothing itself.
 *
 * ## NON-DESTRUCTIVE, AND STRUCTURALLY SO
 *
 * There is no write in this file, no provider call in this file, and no route
 * that acts on what it returns: the API surface is a `GET` and there is no
 * `POST`. That is deliberate, and it is the strongest form of the guarantee
 * available — a rule held by the absence of the code that would break it,
 * rather than by the care of whoever writes the next caller.
 *
 * ## WHY THE ERASURE ITSELF IS PROVED, NOT INFERRED
 *
 * A retired `CONTACT` link is NOT evidence of an erasure. Four other paths
 * retire one, measured on this tree: the member-merge loser teardown
 * (`teardownLoserXero`), the admin manual unlink route
 * (`/api/admin/members/[id]/xero-unlink`), the stale-canonical-link cleanup
 * (`cleanupStaleCanonicalXeroObjectLinks`), and the one school transfer
 * (`takeXeroContactFromSchoolsOwnMember`, `INV-INT-020`). Reporting a retired
 * link as an erasure would tell a treasurer somebody had been forgotten when in
 * fact an administrator had deliberately unlinked them ten minutes earlier.
 *
 * So the erasure is established POSITIVELY, from a durable record of the
 * decision, and there are exactly two of those:
 *
 * - an **approved `DeletionRequest`** — the anonymising erasure. Approval is
 *   claimed INSIDE the anonymisation transaction, so `APPROVED` and
 *   "anonymisation committed" are one event rather than two.
 * - an **approved `MemberLifecycleActionRequest` with action `DELETE`** — the
 *   hard delete, which removes the `Member` row outright. That row carries no
 *   foreign key to `Member` by design, precisely so it survives what it
 *   describes.
 *
 * Both erasures orphan a contact in exactly the same way and neither touches
 * Xero, so both belong here. The school transfer and the three non-erasure
 * retirements have neither record and drop out.
 *
 * **NOT the anonymisation markers.** `isDeletedAccountRecord` is the canonical
 * predicate for "does this row look erased", and `INV-LIFE-015` says in as many
 * words that it is a strong signal rather than a schema invariant: the
 * membership-application MAP branch overwrites both markers, so a mapped-over
 * row stops being recognisable — while the contact the erasure orphaned is no
 * less orphaned for it. And the markers cannot speak for a hard delete at all,
 * because there is no row left to carry them.
 *
 * ## WHY "NO LOCAL HOME" IS ASKED OF BOTH COLUMNS
 *
 * A contact something local still points at was never orphaned, whoever points
 * at it. Since #3366 that is two columns rather than one — a school's contact
 * belongs to its `Organisation` — so the question goes through
 * {@link findXeroContactHomes}, which is `INV-INT-018`'s one home for which
 * columns count. A reader written against `Member.xeroContactId` alone would be
 * right about people and silently wrong about schools, reporting a school's
 * live Xero customer as abandoned. The active link ledger is consulted as well,
 * so a contact still claimed there is spared even where the column write is the
 * half that went missing.
 *
 * ## THE DISCLOSURE RULE: IDS, AND NOTHING ELSE
 *
 * A notice about an erased member is itself a disclosure surface, and a notice
 * that quotes them defeats the erasure it reports on. So a row carries a member
 * id, a contact id, which erasure it was and when — and nothing that is a
 * detail about a person. In particular the contact CACHE is read for exactly
 * two columns, `contactId` and `contactStatus`, while the row it is read from
 * also holds the contact's name, email, phone and address. Erasure deletes that
 * cache row; a later contact sync re-caches it from Xero, where the details
 * still are. Widening that `select` would quietly re-import an erased person's
 * details onto an admin screen (`INV-PRIV`).
 *
 * The treasurer follows the contact id into Xero, which is where that data
 * lives and where it is already theirs to see.
 *
 * ## WHAT THIS CANNOT SEE
 *
 * A contact whose link was never written to the ledger. Every writer of a
 * non-null `Member.xeroContactId` also writes the canonical `CONTACT` link —
 * measured across the eight writers on this tree — except
 * `createXeroContactForMember`, which commits the column in one transaction and
 * the link in the next, and says so. Pre-ledger history is repaired by
 * `backfillMemberContactLink`. The gap is therefore narrow and known; it is not
 * nothing, and it is why this screen is a review aid rather than a guarantee.
 */

import { prisma } from "@/lib/prisma";
import { readXeroContactCacheFreshness } from "@/lib/xero-contact-cache-freshness";
import type { XeroContactCacheFreshness } from "@/lib/xero-contact-cache-freshness";
import { findXeroContactHomes } from "@/lib/xero-contact-home";
import type {
  ErasedMemberXeroContactReview,
  ErasedMemberXeroContactRow,
  ErasureKind,
  ReviewedContactStatus,
} from "@/lib/xero-erased-member-contact-review-shape";

/** Rows returned. The counts are always the whole population. */
export const DEFAULT_ERASED_CONTACT_ROW_LIMIT = 200;

/** Xero's own word for a contact that has been retired in Xero. */
const XERO_ARCHIVED_STATUS = "ARCHIVED";

function emptyReview(
  freshness: XeroContactCacheFreshness,
): ErasedMemberXeroContactReview {
  return {
    needsReview: 0,
    alreadyArchivedInXero: 0,
    rows: [],
    truncated: false,
    contactCacheLastRefreshedAt: freshness.lastRefreshedAt,
    contactCacheAgeHours: freshness.ageHours,
    contactCacheStale: freshness.stale,
  };
}

export async function getErasedMemberXeroContactReview(options?: {
  limit?: number;
}): Promise<ErasedMemberXeroContactReview> {
  const limit = options?.limit ?? DEFAULT_ERASED_CONTACT_ROW_LIMIT;
  const freshness = await readXeroContactCacheFreshness();

  /*
    Every RETIRED member contact link. Once the column has been nulled this is
    the only durable local record of which Xero contact a member used to be —
    and it is a candidate list, not an answer: three of the paths that produce
    one are not erasures at all, and the two filters below are what separate
    them.

    Unbounded by shape and bounded in fact: a row here is one member whose
    contact link was retired, so the population is erasures plus merges plus
    manual unlinks, not the member table.
  */
  const retiredLinks = await prisma.xeroObjectLink.findMany({
    where: { localModel: "Member", xeroObjectType: "CONTACT", active: false },
    select: { localId: true, xeroObjectId: true },
  });
  if (retiredLinks.length === 0) return emptyReview(freshness);

  // One member may hold retired links to the same contact under more than one
  // `role` — the ledger's unique key includes it — and that is one fact, not
  // two rows on a treasurer's screen.
  const candidates = new Map<string, { memberId: string; contactId: string }>();
  for (const link of retiredLinks) {
    if (!link.localId || !link.xeroObjectId) continue;
    candidates.set(`${link.localId}|${link.xeroObjectId}`, {
      memberId: link.localId,
      contactId: link.xeroObjectId,
    });
  }
  const candidateContactIds = [
    ...new Set([...candidates.values()].map((row) => row.contactId)),
  ];

  /*
    FILTER ONE — a contact something local still points at was never orphaned.

    Both questions are asked, because they can disagree and the safe answer is
    the union of what they spare. `findXeroContactHomes` asks the two OWNERSHIP
    columns `INV-INT-018` governs, which is the question that matters now #3366
    has given an organisation its own; the ledger read additionally spares a
    contact that is still actively linked.
  */
  const [homes, activeLinks] = await Promise.all([
    findXeroContactHomes(prisma, candidateContactIds),
    prisma.xeroObjectLink.findMany({
      where: {
        xeroObjectType: "CONTACT",
        xeroObjectId: { in: candidateContactIds },
        active: true,
      },
      select: { xeroObjectId: true },
    }),
  ]);
  const stillHeld = new Set<string>([
    ...homes.keys(),
    ...activeLinks.map((link) => link.xeroObjectId),
  ]);
  const orphaned = [...candidates.values()].filter(
    (row) => !stillHeld.has(row.contactId),
  );
  if (orphaned.length === 0) return emptyReview(freshness);

  /*
    FILTER TWO — and the member was ERASED, proved from the decision rather
    than inferred from what the row looks like now. The header says why the
    anonymisation markers are deliberately not what is read here.
  */
  const orphanedMemberIds = [...new Set(orphaned.map((row) => row.memberId))];
  const [anonymisations, hardDeletes] = await Promise.all([
    prisma.deletionRequest.findMany({
      where: { memberId: { in: orphanedMemberIds }, status: "APPROVED" },
      select: { memberId: true, reviewedAt: true },
    }),
    prisma.memberLifecycleActionRequest.findMany({
      where: {
        memberId: { in: orphanedMemberIds },
        action: "DELETE",
        status: "APPROVED",
      },
      select: { memberId: true, reviewedAt: true, processedAt: true },
    }),
  ]);

  const erasures = new Map<string, { kind: ErasureKind; at: Date | null }>();
  for (const request of anonymisations) {
    erasures.set(request.memberId, {
      kind: "ANONYMISED_BY_DELETION_REQUEST",
      at: request.reviewedAt,
    });
  }
  // Hard delete is applied second and therefore wins. A member cannot normally
  // hold both records — a hard delete cascades the `DeletionRequest` away — but
  // where anything leaves both, the terminal act is the truer answer, and the
  // tie resolves the same way every time rather than by row order.
  for (const request of hardDeletes) {
    erasures.set(request.memberId, {
      kind: "HARD_DELETED",
      at: request.processedAt ?? request.reviewedAt,
    });
  }

  /*
    What Xero itself holds, from the LOCAL CACHE and no provider call — and from
    exactly two of that row's columns. The rest of it is the erased person's
    name, email, phone and address, re-cached from Xero by a later contact sync;
    see the header.
  */
  const erasedContactIds = orphaned
    .filter((row) => erasures.has(row.memberId))
    .map((row) => row.contactId);
  const cached = erasedContactIds.length
    ? await prisma.xeroContactCache.findMany({
        where: { contactId: { in: [...new Set(erasedContactIds)] } },
        select: { contactId: true, contactStatus: true },
      })
    : [];
  const statusByContactId = new Map<string, ReviewedContactStatus>(
    cached.map((entry) => [
      entry.contactId,
      entry.contactStatus?.toUpperCase() === XERO_ARCHIVED_STATUS
        ? "ARCHIVED"
        : "ACTIVE",
    ]),
  );

  let alreadyArchivedInXero = 0;
  const needsReviewRows: ErasedMemberXeroContactRow[] = [];
  for (const row of orphaned) {
    const erasure = erasures.get(row.memberId);
    if (!erasure) continue;
    const contactStatus = statusByContactId.get(row.contactId) ?? "UNKNOWN";
    /*
      An archived contact is counted, not listed. Archiving is the treasurer's
      own act in Xero, so that row has been dealt with — and it is the only
      thing that ever makes this list shrink, because nothing local can observe
      what somebody does in the accounting system except by seeing it in the
      cache the next contact sync fills.
    */
    if (contactStatus === "ARCHIVED") {
      alreadyArchivedInXero += 1;
      continue;
    }
    needsReviewRows.push({
      memberId: row.memberId,
      xeroContactId: row.contactId,
      erasure: erasure.kind,
      erasedAt: erasure.at?.toISOString() ?? null,
      contactStatus,
    });
  }

  // Oldest erasure first, so a treasurer works down the list in the order the
  // club incurred it. A row with no recorded review time sorts LAST rather than
  // first: "unknown" is not "long ago". Ties break on the ids, so the same data
  // produces the same page every time.
  needsReviewRows.sort((a, b) => {
    if (a.erasedAt !== b.erasedAt) {
      if (a.erasedAt === null) return 1;
      if (b.erasedAt === null) return -1;
      return a.erasedAt < b.erasedAt ? -1 : 1;
    }
    if (a.memberId !== b.memberId) return a.memberId < b.memberId ? -1 : 1;
    return a.xeroContactId < b.xeroContactId ? -1 : 1;
  });

  return {
    needsReview: needsReviewRows.length,
    alreadyArchivedInXero,
    rows: needsReviewRows.slice(0, limit),
    truncated: needsReviewRows.length > limit,
    contactCacheLastRefreshedAt: freshness.lastRefreshedAt,
    contactCacheAgeHours: freshness.ageHours,
    contactCacheStale: freshness.stale,
  };
}
