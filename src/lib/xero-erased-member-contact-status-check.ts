/**
 * "HAS THE TREASURER DEALT WITH THIS ONE YET?" — asked of Xero, for the
 * contacts an erasure left behind (#3058, `INV-INT-024`).
 *
 * ## The loop that did not close
 *
 * The erased-member review lists a Xero contact nothing local points at any
 * more, and invites the treasurer to decide about it in Xero. The obvious
 * decision is to archive it. Before this module that archive was **invisible
 * here, permanently**, and four separate places said otherwise.
 *
 * Two facts, both measured, closed the loop shut:
 *
 * 1. The bulk contact sync's paging fetcher — `fetchChangedXeroContactsFromXero`
 *    — passes `includeArchived: false`, and it is the ONLY fetcher that sync
 *    uses for changed contacts, on the incremental and the full-resync path
 *    alike. The three call sites in this repository that do pass `true` are all
 *    driven by id sets derived from records that still HOLD a contact id, and
 *    an erased member holds none, by construction.
 * 2. Both erasure paths delete the `XeroContactCache` row first.
 *
 * So the row was listed at `UNKNOWN` for ever, the archived counter was
 * permanently zero, and the archived branch was dead code in production.
 *
 * ## What this does instead, and what it deliberately does NOT do
 *
 * It asks Xero about exactly the contact ids the screen is already listing,
 * **with archived contacts included**, and keeps ONE FIELD of the answer: the
 * contact's status. The observation is stamped on the RETIRED `CONTACT` link —
 * the row the review already reads, and the only durable local record that this
 * member ever had this contact.
 *
 * **It does not write to `XeroContactCache`, and that is not fussiness.** Two
 * independent reasons, either sufficient:
 *
 * - A cache row is an OBSERVATION of Xero, and
 *   `buildXeroContactCompanyNumberPatch` reads a row that exists holding a
 *   `null` company number as "we looked, and Xero's NZBN field is empty" —
 *   which is its permission to write. A status-only stub would MANUFACTURE that
 *   permission about a field that still holds a value in Xero, and a later
 *   namesake matched onto the same contact would have a real business number
 *   overwritten by a birthday. That is exactly the defect
 *   `deletion-requests/[id]/route.ts` deletes the row to avoid; re-creating it
 *   from the privacy screen would be the privacy fix re-creating the bug.
 * - A FULL cache refresh avoids that by writing the truth — and re-imports the
 *   erased person's name, email, phone, address and (because this application
 *   writes a birthday into the NZBN field) their date of birth, back onto this
 *   server. "Erasing a member removes their details from this application" is
 *   the product promise; a button on the erasure screen that copies them back
 *   would break it.
 *
 * So: a read toward Xero, one field kept, and nothing about a person written
 * anywhere. It changes NOTHING in Xero — `getContacts` and no more.
 *
 * ## Why it is a button and not the page load
 *
 * It costs Xero API budget, metered through `callXeroApi` like every other
 * provider read. The list itself is computed from local state and stays free.
 */

import type { Prisma } from "@prisma/client";

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { fetchXeroContactsByIdsFromXero } from "@/lib/xero-contact-cache";
import {
  classifyXeroContactStatus,
  type XeroContactLiveness,
} from "@/lib/xero-contact-status";
import { isXeroConnected } from "@/lib/xero-token-store";
import { XeroResyncUnavailableError } from "@/lib/xero-mismatch-resync";

/**
 * The metadata key the observation is stamped under. One key, namespaced to
 * this review, merged into whatever the link row already carries — `linkedVia`
 * and friends are untouched.
 */
export const ERASED_CONTACT_REVIEW_METADATA_KEY = "erasedContactReview";

export interface ErasedContactStatusObservation {
  /** What Xero said, classified through `INV-SSOT`'s one classifier. */
  contactStatus: XeroContactLiveness;
  /** When it said it, ISO. */
  observedAt: string;
}

export interface ErasedContactStatusCheckSummary {
  /** Distinct contact ids asked about. */
  checkedContacts: number;
  /** Ids Xero answered for. */
  observedContacts: number;
  /**
   * Ids Xero did not return even with archived included — merged away, or
   * belonging to another organisation. Left listed rather than retired: the
   * screen over-reports by design, and "Xero has never heard of this" is not
   * the same statement as "somebody dealt with it".
   */
  notFoundInXero: number;
  /** Of the observed, how many Xero now holds as archived or GDPR-erased. */
  retiredInXero: number;
  checkedAt: string;
}

/**
 * Read `erasedContactReview` off a link row's metadata, or `null`.
 *
 * Defensive about shape rather than trusting it: `metadata` is a free-form
 * `Json?` column written by several unrelated writers, so a value of the wrong
 * shape must read as "no observation" and never as a status.
 */
export function readErasedContactStatusObservation(
  metadata: Prisma.JsonValue | null | undefined,
): ErasedContactStatusObservation | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const entry = (metadata as Record<string, unknown>)[
    ERASED_CONTACT_REVIEW_METADATA_KEY
  ];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const status = record.contactStatus;
  const observedAt = record.observedAt;
  if (typeof status !== "string" || typeof observedAt !== "string") return null;
  const classified: XeroContactLiveness[] = [
    "ACTIVE",
    "ARCHIVED",
    "GDPR_ERASED",
    "UNRECOGNISED",
  ];
  if (!classified.includes(status as XeroContactLiveness)) return null;
  return {
    contactStatus: status as XeroContactLiveness,
    observedAt,
  };
}

/**
 * Ask Xero about these contact ids and record what it says.
 *
 * Returns a summary for the officer; the review is recomputed by the caller,
 * which is what turns a newly-archived contact into a row that has gone.
 */
export async function checkErasedMemberContactStatuses(
  contactIds: readonly string[],
): Promise<ErasedContactStatusCheckSummary> {
  const ids = [...new Set(contactIds.filter((id) => id.length > 0))];
  const checkedAt = new Date();
  if (ids.length === 0) {
    return {
      checkedContacts: 0,
      observedContacts: 0,
      notFoundInXero: 0,
      retiredInXero: 0,
      checkedAt: checkedAt.toISOString(),
    };
  }

  if (!(await isXeroConnected())) {
    throw new XeroResyncUnavailableError(
      "Xero is not connected — connect it before checking these contacts.",
      409,
    );
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  /*
    `includeArchived: true` is the WHOLE POINT. Without it a contact the
    treasurer archived comes back as if Xero had never heard of it, which is the
    same answer as a merged-away id — and the row would stay listed for ever,
    which is the state this function exists to end.
  */
  const contacts = await fetchXeroContactsByIdsFromXero({
    xero,
    tenantId,
    contactIds: ids,
    workflow: "erasedMemberContactStatusCheck",
    contextPrefix: "erasedMemberContactStatusCheck",
    includeArchived: true,
  });

  const observed = new Map<string, XeroContactLiveness>();
  for (const contact of contacts) {
    if (!contact.contactID) continue;
    // ONE FIELD. `contact` also carries the erased person's name, email, phone
    // and address, and none of it is read, kept or written anywhere.
    observed.set(
      contact.contactID,
      classifyXeroContactStatus(contact.contactStatus?.toString()),
    );
  }

  let retiredInXero = 0;
  for (const [contactId, contactStatus] of observed) {
    if (contactStatus === "ARCHIVED" || contactStatus === "GDPR_ERASED") {
      retiredInXero += 1;
    }
    await recordObservation(contactId, {
      contactStatus,
      observedAt: checkedAt.toISOString(),
    });
  }

  return {
    checkedContacts: ids.length,
    observedContacts: observed.size,
    notFoundInXero: ids.length - observed.size,
    retiredInXero,
    checkedAt: checkedAt.toISOString(),
  };
}

/**
 * Stamp one contact's observation onto every RETIRED `Member` → `CONTACT` link
 * that names it.
 *
 * Read-modify-write per row rather than an `updateMany`, because Prisma cannot
 * merge into a `Json` column and a blind overwrite would drop `linkedVia` and
 * anything else a link already carries. Bounded by the review's own row limit,
 * and each write is its own short statement: a failure part-way leaves earlier
 * rows correctly stamped and later ones simply unobserved, which is the state
 * they were already in.
 *
 * ACTIVE links are deliberately not touched. A contact something local still
 * points at is not on this screen at all, and stamping it would put a key about
 * erasure on a live member's link.
 */
async function recordObservation(
  contactId: string,
  observation: ErasedContactStatusObservation,
): Promise<void> {
  const rows = await prisma.xeroObjectLink.findMany({
    where: {
      localModel: "Member",
      xeroObjectType: "CONTACT",
      xeroObjectId: contactId,
      active: false,
    },
    select: { id: true, metadata: true },
  });
  for (const row of rows) {
    const existing =
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    try {
      await prisma.xeroObjectLink.update({
        where: { id: row.id },
        data: {
          metadata: {
            ...existing,
            [ERASED_CONTACT_REVIEW_METADATA_KEY]: { ...observation },
          },
        },
      });
    } catch (error) {
      // A row deleted under us is not a failure of the check: the observation
      // it would have carried is about a link that no longer exists.
      logger.warn(
        { err: error, xeroContactId: contactId },
        "Could not record an erased-member contact status observation",
      );
    }
  }
}
