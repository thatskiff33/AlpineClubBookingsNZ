import type { StructuredAuditEvent } from "@/lib/audit";
import logger from "@/lib/logger";

/**
 * The per-member step both bulk seasonal-membership actions share (#2107
 * membership type, #5248 subscription category). Each bulk loop calls
 * `saveSeasonalMembershipAssignment` once per member; this module owns what
 * happens around that call so the two loops cannot drift (INV-SSOT):
 * the throw isolation, the mapping of the save's result to a per-member
 * outcome, the outcome counts and the summary audit's outcome.
 */

export type BulkSeasonalMembershipOutcome =
  | "changed"
  | "unchanged"
  | "stale"
  | "blocked_linked_guests"
  | "error";

/** How many linked-guest bookings a bulk preview lists per member. */
export const BULK_LINKED_GUEST_LABEL_LIMIT = 3;

/** Shown when a member's save threw; the detail goes to the log, not the admin. */
export const BULK_SEASONAL_SAVE_THREW_MESSAGE =
  "The change failed unexpectedly for this member. Try again; if it keeps failing, check the server log.";

type SaveResult = { body: unknown; init?: ResponseInit };

export type BulkSeasonalSaveClassification<TLinkedGuests> = {
  outcome: BulkSeasonalMembershipOutcome;
  status?: number;
  error?: string;
  linkedGuestBookings?: TLinkedGuests;
  /** True when the save wrote and its preview repaired an age-tier drift. */
  ageTierChanged: boolean;
};

/**
 * Map one single-member save result to its bulk outcome:
 * a 409 carrying linked-guest bookings is `blocked_linked_guests`, any other
 * 409 is `stale` (preview again), any other 4xx/5xx is `error`, and a success
 * is `changed` or `unchanged` by the save's own no-op check.
 */
export function classifyBulkSeasonalSaveResult<TLinkedGuests>(
  saveResult: SaveResult,
): BulkSeasonalSaveClassification<TLinkedGuests> {
  const status = saveResult.init?.status;
  const body = (saveResult.body ?? {}) as {
    changed?: boolean;
    error?: string;
    linkedGuestBookings?: TLinkedGuests;
    preview?: { ageTierChanged?: boolean };
  };
  if (status && status >= 400) {
    if (status === 409 && body.linkedGuestBookings) {
      return {
        outcome: "blocked_linked_guests",
        status,
        error: body.error,
        linkedGuestBookings: body.linkedGuestBookings,
        ageTierChanged: false,
      };
    }
    return {
      outcome: status === 409 ? "stale" : "error",
      status,
      error: body.error,
      ageTierChanged: false,
    };
  }
  if (body.changed) {
    return { outcome: "changed", status, ageTierChanged: body.preview?.ageTierChanged === true };
  }
  return { outcome: "unchanged", status, ageTierChanged: false };
}

/**
 * Run one member's save so a throw (deadlock, P2025, a sweep failure) never
 * aborts the batch: it is logged with `logContext` and becomes that member's
 * `error` outcome with a generic message.
 */
export async function runBulkSeasonalSave<TLinkedGuests>(
  save: () => Promise<SaveResult>,
  logContext: Record<string, unknown>,
  logMessage: string,
): Promise<BulkSeasonalSaveClassification<TLinkedGuests>> {
  let saveResult: SaveResult;
  try {
    saveResult = await save();
  } catch (err) {
    logger.error({ err, ...logContext }, logMessage);
    return {
      outcome: "error",
      error: BULK_SEASONAL_SAVE_THREW_MESSAGE,
      ageTierChanged: false,
    };
  }
  return classifyBulkSeasonalSaveResult<TLinkedGuests>(saveResult);
}

/** Count per-member outcomes, starting every listed outcome at zero. */
export function countBulkOutcomes<TOutcome extends string>(
  results: ReadonlyArray<{ outcome: TOutcome }>,
  outcomes: readonly TOutcome[],
): Record<TOutcome, number> {
  const counts = Object.fromEntries(outcomes.map((outcome) => [outcome, 0])) as Record<
    TOutcome,
    number
  >;
  for (const entry of results) counts[entry.outcome] += 1;
  return counts;
}

/**
 * The bulk summary audit's outcome: `failure` when nothing changed and at least
 * one member was stale, blocked or errored; otherwise `success` (the audit
 * schema has no partial outcome — the counts in metadata carry the split).
 */
export function bulkSummaryAuditOutcome(
  counts: Pick<
    Record<BulkSeasonalMembershipOutcome, number>,
    "changed" | "stale" | "blocked_linked_guests" | "error"
  >,
): NonNullable<StructuredAuditEvent["outcome"]> {
  const failed = counts.stale + counts.blocked_linked_guests + counts.error;
  return counts.changed === 0 && failed > 0 ? "failure" : "success";
}
