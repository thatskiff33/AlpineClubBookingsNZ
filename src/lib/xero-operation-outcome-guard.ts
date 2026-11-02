/**
 * The write guard of a Xero operation outcome (#4356, `INV-INT-029`), used by
 * `completeXeroSyncOperation` and `failXeroSyncOperation` (`xero-sync.ts`).
 */
import type { Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import { XERO_REPAIR_CLAIM_RUNNING_CODES } from "@/lib/xero-stale-operations";

/** #4356: the recorded successes, full or part, that a worse outcome may not replace. */
const XERO_RECORDED_SUCCESS_STATUSES: readonly string[] = ["SUCCEEDED", "PARTIAL"];

/** #4356: a row whose outcome is a recorded success. */
export function holdsRecordedXeroSuccess(status: string): boolean {
  return XERO_RECORDED_SUCCESS_STATUSES.includes(status);
}

/**
 * #4356 (`INV-INT-029`): a row that is not a repair's RUNNING claim
 * (`XERO_REPAIR_CLAIM_RUNNING_CODES`). Spelled with the null case explicit, as
 * the stale reset is: a negated match on a nullable column would also refuse
 * every RUNNING row with no code.
 */
export const NOT_A_XERO_REPAIR_CLAIM = {
  OR: [
    { status: { not: "RUNNING" } },
    { lastErrorCode: null },
    { lastErrorCode: { notIn: [...XERO_REPAIR_CLAIM_RUNNING_CODES] } },
  ],
} satisfies Prisma.XeroSyncOperationWhereInput;

/**
 * #4373 (`INV-INT-029`): the claim an outcome is written under - the row's id
 * and the `startedAt` its RUNNING claim was stamped with when this caller
 * started it (`startXeroSyncOperation`'s row) or claimed it
 * (`claimXeroSyncOperationToRunning`, a retry's claim). A started row is one as
 * it stands. Null `startedAt`: a caller handed a row no claim holds yet; its
 * failure lands on no live row (#4673).
 */
export interface XeroOperationClaim {
  readonly id: string;
  readonly startedAt: Date | null;
}

/**
 * #4373: a row that is not RUNNING under another claim. A RUNNING row whose
 * `startedAt` is not this claim's is a later attempt's (a retry's, after a
 * stale reset or a failure), and no outcome of this attempt lands there.
 */
function notAnotherClaim(claim: XeroOperationClaim): Prisma.XeroSyncOperationWhereInput {
  return { OR: [{ status: { not: "RUNNING" } }, { startedAt: claim.startedAt }] };
}

/**
 * #4673 (`INV-INT-029`): the statuses a FAILED outcome may land on, and only
 * on a row carrying its own claim's `startedAt`: that claim's RUNNING row, or
 * the FAILED end that claim (or a stale reset of it) already wrote. Never a
 * PENDING row - an officer's Retry queued it in place, or the outbox gave it
 * back - nor one waiting, skipped or ended under another claim. PR #4687
 * review: nor CANCELLED, whoever's: a withdrawal cancels a FAILED row keeping
 * its `startedAt`, and a failure there would make a withdrawn row retryable.
 */
const XERO_FAILURE_OWN_CLAIM_STATUSES = ["RUNNING", "FAILED"] as const;

/**
 * #4673: a FAILED outcome's rows - this claim's own, in a status a failure may
 * replace. A failure that lost its claim is dropped: the run or retry that
 * holds the row now writes its own outcome.
 */
function ownClaimFailureRow(claim: XeroOperationClaim): Prisma.XeroSyncOperationWhereInput {
  return { status: { in: [...XERO_FAILURE_OWN_CLAIM_STATUSES] }, startedAt: claim.startedAt };
}

/**
 * #4356 (`INV-INT-029`): the write guard of an outcome (`status`) on an
 * operation row. Two callers can hold one row - a start that loses the insert
 * race is handed the winner's ACTIVE row (#1354) - and each records its own
 * outcome of the same keyed Xero call there. So an outcome never replaces a
 * better one already recorded: only SUCCEEDED lands on SUCCEEDED, only
 * SUCCEEDED or PARTIAL on PARTIAL. Nor does any outcome but SUCCEEDED land on
 * a repair's RUNNING claim (`XERO_REPAIR_CLAIM_RUNNING_CODES`): it would
 * replace the payload the repair reads and make the repair's own give-back
 * lose. #4373: and no outcome, a success included, lands on a RUNNING row
 * another claim holds - a late outcome of an earlier attempt never lands on a
 * retry's claim. #4673: and a failure (FAILED, from either writer) lands only
 * on this claim's own RUNNING or FAILED row (`ownClaimFailureRow`), so a
 * stalled run's late failure never undoes the Retry an officer queued after a
 * stale reset, nor a withdrawal (CANCELLED). A
 * SUCCEEDED write lands on anything else; `alsoKeep` keeps one more status
 * out. `retryClaim` writes onto this RUNNING claim only, which no recorded
 * outcome is.
 */
export function outcomeWriteGuard(
  claim: XeroOperationClaim,
  status: string,
  options: { retryClaim?: true; alsoKeep?: string },
): Prisma.XeroSyncOperationWhereInput {
  // An `updateMany` reads an undefined id as no filter at all: never let one through.
  if (!claim.id) throw new Error("A Xero operation outcome needs the operation's id.");
  if (options.retryClaim) {
    if (!claim.startedAt) throw new Error("A retry's claim outcome needs the claim's startedAt.");
    return { status: "RUNNING", startedAt: claim.startedAt };
  }
  if (status === "SUCCEEDED") return notAnotherClaim(claim);
  // #4673: a failure keeps every recorded success and CANCELLED by construction (`alsoKeep` adds nothing).
  if (status === "FAILED") return { AND: [ownClaimFailureRow(claim), NOT_A_XERO_REPAIR_CLAIM] };
  const kept = XERO_RECORDED_SUCCESS_STATUSES.filter((held) => held !== status);
  if (options.alsoKeep) kept.push(options.alsoKeep);
  return {
    AND: [
      { status: kept.length === 1 ? { not: kept[0] } : { notIn: kept } },
      NOT_A_XERO_REPAIR_CLAIM,
      notAnotherClaim(claim),
    ],
  };
}

type OutcomeRowReader = Pick<Prisma.TransactionClient, "xeroSyncOperation">;

/**
 * A guarded outcome write that matched no row: nothing written, nothing
 * alerted; answers null. A row that is not there at all is said so: an outcome
 * written without `retryClaim` or `keepCancelled` throws, as the unguarded
 * `update` it was before #4356 did, and one with either logs it.
 *
 * #4373 review F1: a success or part-success refused only because a later
 * claim holds the row RUNNING still records its links (`lateSuccess`): the
 * Xero object exists, and if that claim then fails it would be recorded
 * nowhere. The row's status and claim are left as they are, and it is logged
 * at warn. A refusal for any other reason (INV-INT-029's recorded outcome, a
 * repair's marker, a retry's own lost claim, #4673's failure on a row no longer
 * this claim's) still records nothing.
 */
export async function refusedOutcomeWrite(
  db: OutcomeRowReader,
  claim: XeroOperationClaim,
  status: string,
  caller: { retryClaim?: true; keepCancelled?: boolean },
  lateSuccess?: { xeroObjectId: string | null; recordLinks: () => Promise<void> },
): Promise<null> {
  const operationId = claim.id;
  const row = await db.xeroSyncOperation.findUnique({ where: { id: operationId }, select: { status: true, startedAt: true } });
  if (!row) {
    if (!caller.retryClaim && !caller.keepCancelled) {
      throw new Error(`Xero operation ${operationId} was not found, so its ${status} outcome was not recorded.`);
    }
    logger.warn({ operationId, status }, "Xero operation outcome not recorded: the operation row was not found");
    return null;
  }
  // A retry's claim reports its own lost claim.
  if (caller.retryClaim) return null;
  if (lateSuccess && holdsRecordedXeroSuccess(status) && heldByAnotherClaim(row, claim)) {
    await lateSuccess.recordLinks();
    logger.warn(
      { operationId, status, xeroObjectId: lateSuccess.xeroObjectId, claimStartedAt: claim.startedAt, heldClaimStartedAt: row.startedAt },
      "Xero operation outcome not recorded on a later claim's RUNNING row; its Xero links were recorded (INV-INT-029)",
    );
    return null;
  }
  logger.info(
    { operationId, status, heldStatus: row.status },
    "Xero operation outcome not recorded: the row kept the outcome or claim it holds (INV-INT-029)",
  );
  return null;
}

/** #4373: the row is RUNNING under a claim other than this one. */
function heldByAnotherClaim(row: { status: string; startedAt: Date | null }, claim: XeroOperationClaim): boolean {
  return row.status === "RUNNING" && (row.startedAt?.getTime() ?? null) !== (claim.startedAt?.getTime() ?? null);
}
