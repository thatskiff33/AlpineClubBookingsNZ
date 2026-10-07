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
 * ## NON-DESTRUCTIVE TOWARD XERO, WHICH IS THE CLAIM THAT MATTERS
 *
 * There is no write in this file and no provider call in this file. The route
 * over it has a `POST`, and it asks Xero exactly one thing — `getContacts` on
 * the ids already listed, archived included — so that a contact the treasurer
 * archived can stop being reported. That is a READ toward Xero; nothing here,
 * on any path, asks Xero to change, archive, blank or delete anything.
 *
 * An earlier revision claimed the guarantee was structural, held by there being
 * no `POST` at all. That claim was worth less than it looked: the ERASURE path
 * itself already reaches provider writes — cancelling the member's paid future
 * bookings enqueues credit notes — through modules the guard could not see. The
 * honest guarantee is the narrow one, and it is guarded by name in
 * `member-erasure-no-xero-mutation-contract.test.ts`.
 *
 * ## HOW LONG A ROW STAYS, WHICH IS A RETENTION QUESTION
 *
 * A row here is a durable, on-screen record that a particular member id was
 * erased and when. It is retired when Xero is observed to hold its contact as
 * archived, or as asked-to-be-erased — and ONLY then, because nothing else can
 * observe what somebody does in the accounting system. So:
 *
 * - archive the contact in Xero and press the check: the row goes, for good;
 * - leave the contact live in Xero: the row stays, indefinitely, by design —
 *   there genuinely is an orphaned customer and a treasurer has not decided
 *   about it;
 * - delete the retired `CONTACT` link, and the row goes with it. Nothing does
 *   that, and nothing should: that link is the club's own record of an
 *   accounting identity.
 *
 * The bulk contact sync will NOT retire a row and must not be described as
 * doing so. It fetches changed contacts with `includeArchived: false` — the
 * only fetcher it uses for them — so the moment a treasurer archives a contact
 * it becomes invisible to that sync for ever; and the erasure deleted the cache
 * row, so there is nothing for it to update either.
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
 * **NOT the live-row deletion predicate.** `isDeletedAccountRecord` is the
 * canonical guard wherever a Member row still exists. This review instead
 * needs durable evidence of the event that orphaned the contact, including a
 * hard delete where no Member row remains, so it reads the approved decision.
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
 * non-null `Member.xeroContactId` also writes the canonical `CONTACT` link,
 * except `createXeroContactForMember`, which commits the column in one
 * transaction and the link in the next, and says so. Pre-ledger history is
 * repaired by `backfillMemberContactLink`. The gap is therefore narrow and
 * known; it is not nothing, and it is why this screen is a review aid rather
 * than a guarantee.
 *
 * (An earlier revision published a COUNT of those writers. Nothing pinned it,
 * so it was a number that could only ever go stale — unlike the four retiring
 * paths named above, which the review's own test enumerates. The sentence does
 * not need it.)
 */

import { prisma } from "@/lib/prisma";
import { readXeroContactCacheFreshness } from "@/lib/xero-contact-cache-freshness";
import type { XeroContactCacheFreshness } from "@/lib/xero-contact-cache-freshness";
import { findXeroContactHomes } from "@/lib/xero-contact-home";
import { reportContactCacheFreshness } from "@/lib/xero-contact-cache-freshness-shape";
import {
  classifyXeroContactStatus,
  type XeroContactLiveness,
} from "@/lib/xero-contact-status";
import {
  readErasedContactStatusObservation,
  type ErasedContactStatusObservation,
} from "@/lib/xero-erased-member-contact-status-check";
import type {
  ErasedMemberXeroContactReview,
  ErasedMemberXeroContactRow,
  ErasureKind,
  ListedContactStatus,
} from "@/lib/xero-erased-member-contact-review-shape";

/** Rows returned. The counts are always the whole population. */
export const DEFAULT_ERASED_CONTACT_ROW_LIMIT = 200;

/**
 * Which provider statuses mean "somebody has dealt with this one".
 *
 * `ARCHIVED` is the treasurer retiring the contact in Xero. `GDPR_ERASED` is
 * Xero's own `GDPRREQUEST` — somebody has asked for that contact to be erased
 * IN XERO, which is the one row on this screen most certainly needing no
 * further attention, and which the earlier denylist reported as "Active in
 * Xero". Both are counted rather than listed. `INV-SSOT`: which spelling means
 * which lives in `xero-contact-status.ts`, not here.
 */
function isRetiredInXero(status: XeroContactLiveness): boolean {
  return status === "ARCHIVED" || status === "GDPR_ERASED";
}

function emptyReview(
  freshness: XeroContactCacheFreshness,
): ErasedMemberXeroContactReview {
  return {
    needsReview: 0,
    alreadyRetiredInXero: 0,
    rows: [],
    truncated: false,
    lastContactStatusCheckAt: null,
    ...reportContactCacheFreshness(freshness),
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

    ## The read is unbounded, deliberately, and it is served exactly

    Since #3471 the composite index
    `XeroObjectLink_localModel_xeroObjectType_active_idx` matches all three of
    this query's filters, so the read touches only the retired member contact
    links themselves. Before it, the only usable index began with `localModel`,
    which nearly every `XeroObjectLink` row carries, so the scan read most of
    that index plus a heap fetch per row and discarded almost all of it — a cost
    that grew for the life of an installation.

    It stays unbounded anyway, because the alternatives are worse. A `take`
    would make `needsReview` and `alreadyRetiredInXero` lie: this shape's
    contract is that the COUNTS are the whole population and only `rows` is
    capped, which is what lets a treasurer see the backlog they are working
    through. And the population is genuinely small and slowly grown — erasures,
    merges, manual unlinks, stale-link cleanups and school transfers, over the
    life of one club — not the member table and not a per-booking volume. The
    result still feeds an `in` list to four further queries.
  */
  const retiredLinks = await prisma.xeroObjectLink.findMany({
    where: { localModel: "Member", xeroObjectType: "CONTACT", active: false },
    // `metadata` carries this review's own status OBSERVATION, stamped by the
    // live check. It is the only durable home available for it: the erasure
    // deleted the contact's cache row, and re-creating one would manufacture
    // the NZBN write permission that deletion exists to remove
    // (`xero-erased-member-contact-status-check.ts` has the argument in full).
    select: { localId: true, xeroObjectId: true, metadata: true },
  });
  if (retiredLinks.length === 0) return emptyReview(freshness);

  // One member may hold retired links to the same contact under more than one
  // `role` — the ledger's unique key includes it — and that is one fact, not
  // two rows on a treasurer's screen.
  const candidates = new Map<string, { memberId: string; contactId: string }>();
  // Keyed by CONTACT, because the observation is about the contact rather than
  // about a link. Where several retired rows name one contact the freshest
  // observation wins, so an older stamp on a second role cannot un-retire a row.
  const observations = new Map<string, ErasedContactStatusObservation>();
  for (const link of retiredLinks) {
    if (!link.localId || !link.xeroObjectId) continue;
    candidates.set(`${link.localId}|${link.xeroObjectId}`, {
      memberId: link.localId,
      contactId: link.xeroObjectId,
    });
    const observation = readErasedContactStatusObservation(link.metadata);
    if (!observation) continue;
    const held = observations.get(link.xeroObjectId);
    if (!held || held.observedAt < observation.observedAt) {
      observations.set(link.xeroObjectId, observation);
    }
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
    than inferred from what a surviving row looks like now. The header says why
    the durable decision is deliberately read here.
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
  const cachedStatusByContactId = new Map<string, XeroContactLiveness>(
    cached.map((entry) => [
      entry.contactId,
      classifyXeroContactStatus(entry.contactStatus),
    ]),
  );

  let alreadyRetiredInXero = 0;
  let lastContactStatusCheckAt: string | null = null;
  const needsReviewRows: ErasedMemberXeroContactRow[] = [];
  for (const row of orphaned) {
    const erasure = erasures.get(row.memberId);
    if (!erasure) continue;
    /*
      TWO SOURCES, and the OBSERVATION wins. The live check asked Xero about
      this exact contact with archived contacts included; the cache is what a
      bulk sync happened to leave behind, and for an erased member's contact it
      is usually nothing at all — the erasure deletes the row and the bulk sync
      never re-fetches an archived contact. So a cache row can only ever be
      staler news than an observation about the same id.
    */
    const observation = observations.get(row.contactId);
    if (
      observation &&
      (lastContactStatusCheckAt === null ||
        lastContactStatusCheckAt < observation.observedAt)
    ) {
      lastContactStatusCheckAt = observation.observedAt;
    }
    const known: XeroContactLiveness | null =
      observation?.contactStatus ??
      cachedStatusByContactId.get(row.contactId) ??
      null;

    /*
      A retired contact is counted, not listed: archiving it, or asking Xero to
      erase it, is somebody's own act in the accounting system, so that row has
      been dealt with. Nothing local can observe such an act by itself — the
      bulk contact sync fetches with `includeArchived: false` and the erasure
      deleted the cache row — which is why the live check on this screen is the
      one thing that ever makes this list shrink.
    */
    if (known !== null && isRetiredInXero(known)) {
      alreadyRetiredInXero += 1;
      continue;
    }
    const contactStatus: ListedContactStatus =
      known === null ? "UNKNOWN" : known === "ACTIVE" ? "ACTIVE" : "UNRECOGNISED";
    needsReviewRows.push({
      memberId: row.memberId,
      xeroContactId: row.contactId,
      erasure: erasure.kind,
      erasedAt: erasure.at?.toISOString() ?? null,
      contactStatus,
      contactStatusCheckedAt: observation?.observedAt ?? null,
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
    alreadyRetiredInXero,
    rows: needsReviewRows.slice(0, limit),
    truncated: needsReviewRows.length > limit,
    lastContactStatusCheckAt,
    ...reportContactCacheFreshness(freshness),
  };
}
