import type { Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { formatDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";

/**
 * The audit row every hut-leader assignment write records (#2698).
 *
 * Until #2698 the three writers recorded NOTHING: an officer could hold a bed
 * for a custodian, move it to another bed or hand it back, and the only trace
 * was the row itself — which a delete then removed. A custodian bed hold takes
 * a bed out of the bookable and allocatable pools for a whole season, so who
 * did it and when is exactly the kind of fact the audit log exists for.
 *
 * ## The category, cited rather than guessed
 *
 * `lodge`. `docs/guides/audit-log.md`'s category table gives that row as
 * "Rosters, guest arrival and departure, **all bed allocation** — an
 * administrator's manual, bulk, range and approval actions as well as the
 * automatic ones — display layouts, templates, devices and the lodge display
 * configuration, lodge kiosk accounts, and induction". A hut-leader assignment
 * IS the lodge roster, and with a bed it is a bed-allocation fact too; both
 * halves of that row point here. Its AI Diagnostics gate is Support + Lodge,
 * which every officer who can write one already holds, so nothing here widens
 * who can read what (`INV-PRIV`).
 *
 * The amendment that can accompany one of these — the officer accepting that a
 * custodian bed narrows an existing whole-lodge hold — is a separate row under
 * `booking`, written by `recordWholeLodgeHoldAmendment`
 * (`custodian-assignment.ts`), because what narrowed there is a BOOKING's sole
 * occupancy rather than the lodge roster. Two rows, two Category filters, one
 * transaction.
 *
 * ## What the row carries, and what it must not
 *
 * The lodge, the covered dates and the held bed id — the facts that say what
 * moved in and out of the bookable pool. No booking, no guest and no party
 * data: an assignment can sit over somebody else's sole-occupancy booking, and
 * nothing about that booking belongs in the roster's audit trail (`INV-PRIV`).
 * The member is named the way every other audit row names one, through
 * `subjectMemberId`, not by copying their name into the metadata.
 *
 * ## Its own module rather than a helper in either route
 *
 * A Next.js route module may only export route handlers and a small set of
 * config symbols, so a helper shared by `route.ts` and `[id]/route.ts` cannot
 * live in either of them — the same reason `custodian-assignment-routes.ts`
 * exists. Writing it three times instead would be the `INV-SSOT-002` shape, and
 * the category decision above is exactly the kind of fact that must be
 * changeable in one place.
 */
export type HutLeaderAssignmentAuditEvent = "created" | "updated" | "deleted";

type HutLeaderAuditDb = typeof prisma | Prisma.TransactionClient;

const SUMMARIES: Record<HutLeaderAssignmentAuditEvent, string> = {
  created: "Hut leader assignment created",
  updated: "Hut leader assignment updated",
  deleted: "Hut leader assignment deleted",
};

/**
 * Which way an edit moved capacity, from the bed on each side of it.
 *
 * The `updated` sentence used to be one string saying a bed "was released",
 * whichever way the edit went. That is backwards on the path #2698 cares about
 * most: the inline bed picker on a role-only assignment TAKES a bed out of the
 * bookable pool, and it is the write the amendment accept runs through — so the
 * PR's most consequential capacity event was recorded as its own opposite in
 * the trail an operator reconstructs capacity from. Both bed ids are already in
 * scope at both call sites, so nothing has to be read to say it correctly.
 */
type HutLeaderAuditBeds = {
  /** The bed held AFTER this write; null for a role-only assignment. */
  bedId: string | null;
  /** The bed held BEFORE it; null on a create, and on an edit that had none. */
  previousBedId: string | null;
};

const DETAILS: Record<
  HutLeaderAssignmentAuditEvent,
  (beds: HutLeaderAuditBeds) => string
> = {
  created: ({ bedId }) =>
    bedId
      ? "An officer created a hut-leader assignment holding a bed for the custodian; that bed is out of the bookable pool for the covered nights."
      : "An officer created a hut-leader assignment with no bed held (a role only, with no capacity effect).",
  updated: ({ bedId, previousBedId }) => {
    if (bedId && !previousBedId) {
      return "An officer changed a hut-leader assignment and held a bed for the custodian that it was not holding before; that bed is out of the bookable pool for the covered nights, and it leaves the represented bed set of any booking holding the whole lodge on those nights, from the moment this committed.";
    }
    if (!bedId && previousBedId) {
      return "An officer changed a hut-leader assignment and released the bed it was holding; that bed is bookable again, and any booking holding the whole lodge on those nights covers it again from the moment this committed.";
    }
    if (bedId && previousBedId && bedId !== previousBedId) {
      return "An officer moved the bed a hut-leader assignment holds. The bed it left is bookable again and the bed it took is out of the bookable pool for the covered nights, both from the moment this committed.";
    }
    if (bedId) {
      return "An officer changed a hut-leader assignment's dates or lodge while it went on holding the same bed; the covered dates recorded here and the previous ones say which bed-nights moved into and out of the bookable pool.";
    }
    return "An officer changed a hut-leader assignment's dates or lodge. It held no bed before or after, so nothing moved into or out of the bookable pool.";
  },
  deleted: ({ bedId, previousBedId }) =>
    (bedId ?? previousBedId)
      ? "An officer deleted a hut-leader assignment that was holding a bed; that bed is bookable again, and any booking holding the whole lodge on those nights covers it again from the moment this committed."
      : "An officer deleted a hut-leader assignment that held no bed (a role only, with no capacity effect).",
};

/**
 * Record one hut-leader assignment write, on the caller's transaction client so
 * a rolled-back write records nothing.
 *
 * `previous` is present only on an update and a delete, and only to say what
 * the row looked like before — a released bed and a moved date range are both
 * capacity changes a reader needs to reconstruct.
 */
export async function recordHutLeaderAssignmentAudit(
  db: HutLeaderAuditDb,
  input: {
    event: HutLeaderAssignmentAuditEvent;
    actorMemberId: string;
    /** The hut leader the assignment is for. */
    subjectMemberId: string;
    assignmentId: string;
    lodgeId: string;
    /** Inclusive first covered date. */
    startDate: Date;
    /** Inclusive last covered date. */
    endDate: Date;
    /** The bed held after this write; null for a role-only assignment. */
    bedId: string | null;
    previous?: {
      lodgeId: string;
      startDate: Date;
      endDate: Date;
      bedId: string | null;
    };
    requestId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  // A bed on either side of the write makes this a capacity event rather than a
  // roster note, including the edit that RELEASED one.
  const beds = {
    bedId: input.bedId,
    previousBedId: input.previous?.bedId ?? null,
  };
  const heldBed = Boolean(beds.bedId ?? beds.previousBedId);
  await createAuditLog(
    {
      action: `lodge.hut-leader-assignment.${input.event}`,
      memberId: input.actorMemberId,
      actorMemberId: input.actorMemberId,
      subjectMemberId: input.subjectMemberId,
      targetId: input.assignmentId,
      entityType: "HutLeaderAssignment",
      entityId: input.assignmentId,
      category: "lodge",
      severity: heldBed ? "important" : "info",
      outcome: "success",
      summary: SUMMARIES[input.event],
      details: DETAILS[input.event](beds),
      metadata: {
        lodgeId: input.lodgeId,
        startDate: formatDateOnly(input.startDate),
        endDate: formatDateOnly(input.endDate),
        bedId: input.bedId,
        ...(input.previous
          ? {
              previousLodgeId: input.previous.lodgeId,
              previousStartDate: formatDateOnly(input.previous.startDate),
              previousEndDate: formatDateOnly(input.previous.endDate),
              previousBedId: input.previous.bedId,
            }
          : {}),
      },
      requestId: input.requestId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
}
