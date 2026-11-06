import type { DeletionRequestStatus, Prisma } from "@prisma/client";

type DeletionRequestDecisionDb = Pick<
  Prisma.TransactionClient,
  "deletionRequest"
>;

/**
 * The release also takes the row FOR UPDATE, so it needs the raw seam too. It
 * must be handed a TRANSACTION client — see
 * {@link releaseDeletionRequestApprovalClaim}.
 */
type DeletionRequestReleaseTx = Pick<
  Prisma.TransactionClient,
  "deletionRequest" | "$executeRaw"
>;

/**
 * The statuses of a self-service deletion request that is still open: awaiting
 * a decision, or mid-approval. Every "is there an outstanding request?" read —
 * admin queue, pending counts, dashboard, member re-request guard, merge
 * blocker — must use this, because a request that has begun approval is
 * emphatically not resolved: it still owes the member their anonymisation, and
 * it may already have cancelled future bookings.
 *
 * Deliberately a mutable array: Prisma's generated `in` filter rejects a
 * `readonly` tuple.
 */
export const OPEN_DELETION_REQUEST_STATUSES: DeletionRequestStatus[] = [
  "PENDING",
  "APPROVAL_IN_PROGRESS",
];

export const DELETION_REQUEST_ALREADY_REVIEWED_CODE =
  "DELETION_REQUEST_ALREADY_REVIEWED";
export const DELETION_REQUEST_ALREADY_REVIEWED_MESSAGE =
  "This request has already been reviewed.";

export class DeletionRequestDecisionLostError extends Error {
  readonly code = DELETION_REQUEST_ALREADY_REVIEWED_CODE;
  readonly statusCode = 409;

  constructor() {
    super(DELETION_REQUEST_ALREADY_REVIEWED_MESSAGE);
    this.name = "DeletionRequestDecisionLostError";
  }
}

export const DELETION_REQUEST_CLAIM_NOT_HELD_CODE =
  "DELETION_REQUEST_CLAIM_NOT_HELD";
export const DELETION_REQUEST_CLAIM_NOT_HELD_MESSAGE =
  "This deletion request is no longer mid-approval, so there is no approval claim to release. Reload the deletion queue to see its current state.";

/**
 * Raised when a release loses the race to a finalisation that was already
 * committing (or to another release). See
 * {@link releaseDeletionRequestApprovalClaim}.
 */
export class DeletionRequestClaimNotHeldError extends Error {
  readonly code = DELETION_REQUEST_CLAIM_NOT_HELD_CODE;
  readonly statusCode = 409;

  constructor() {
    super(DELETION_REQUEST_CLAIM_NOT_HELD_MESSAGE);
    this.name = "DeletionRequestClaimNotHeldError";
  }
}

/**
 * The durable, in-row marker that a started approval was RELEASED back to
 * `PENDING`: a `PENDING` request that carries a `reviewedAt` and no
 * `reviewedBy`.
 *
 * ## Why a released request has to be marked at all
 *
 * A release re-opens a decision that had been closed to rejection, on the one
 * path where future bookings may already have been cancelled. Without a marker
 * the row renders as an ordinary **Pending** request: an admin can reject it in
 * good faith, the member is emailed that their request was declined, and their
 * stays are already cancelled with nobody told. The release itself is
 * Full-Admin-gated with a mandatory reason — but the release is not the harmful
 * step, the later rejection is, and a free-text admin note ("blocker won't
 * clear") conveys nothing about bookings. The marker is what carries the fact
 * from the one to the other.
 *
 * ## Why this combination, and not a new column
 *
 * No other writer of this row can produce `PENDING` + `reviewedAt`, so this is a
 * marker and not a heuristic. The complete set of writers is:
 *
 * - the member's own `create` — `PENDING`, both review fields defaulted null;
 * - {@link claimDeletionRequestApproval} — `APPROVAL_IN_PROGRESS`, `reviewedBy`
 *   set, `reviewedAt` explicitly null (a claim is ownership, not an outcome);
 * - {@link claimDeletionRequestDecision} — `APPROVED` / `REJECTED`, `reviewedAt`
 *   set;
 * - {@link releaseDeletionRequestApprovalClaim} — `PENDING`, `reviewedBy` null,
 *   `reviewedAt` set. Only this one.
 *
 * `src/lib/__tests__/deletion-request-decision.test.ts` pins that truth table by
 * DERIVING each of the three library writers' rows from the `data` they actually
 * write, rather than restating what they are believed to write; the member's own
 * `create` lives in another module and is pinned there, field for field, by
 * `src/lib/__tests__/phase10b.test.ts`. The release's own real-PostgreSQL race
 * test pins the marker surviving the transition it is written by.
 *
 * This predicate is what every *display* and gate reads. It is deliberately not
 * the authority for the rejection: that is the `reviewedAt` shape inside the
 * rejection's own guarded `updateMany` (see
 * {@link DeletionRequestRejectionOrigin}), because a predicate evaluated over a
 * row read earlier is a check-then-act.
 *
 * The trade-off, stated plainly: it overloads `reviewedAt` on a status that has
 * no reviewer, so the meaning lives here rather than in the schema, and every
 * reader must go through this predicate instead of reading `reviewedAt`
 * directly. In exchange the marker is written by the same single guarded
 * mutation as the transition — it cannot be lost, cannot be forged by an admin
 * typing a note, needs no second query to derive, and needs no migration on a
 * table that predates this defect. A re-claim clears it (`reviewedAt: null`),
 * which is correct: from `APPROVAL_IN_PROGRESS` a rejection cannot win at all,
 * and if that claim is released in turn the marker is written again.
 */
export function deletionApprovalWasReleased(request: {
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | string | null;
}): boolean {
  return (
    request.status === "PENDING" &&
    request.reviewedBy === null &&
    request.reviewedAt !== null
  );
}

/**
 * What a decider must be told about a started approval that is being, or has
 * been, released — the release dialog, the queue row, the reject dialog and the
 * route's own refusals all render THIS string, so a copy edit cannot drop the
 * disclosure from one of them while the others keep promising it. It names "the
 * started approval" rather than leaning on a preceding sentence for its
 * antecedent, which is what lets all four sites share one string.
 */
export const DELETION_APPROVAL_RELEASED_DISCLOSURE =
  "Any future bookings the started approval already cancelled stay cancelled — rejecting this request will not restore them.";

/** The lead-in every site shares before {@link DELETION_APPROVAL_RELEASED_DISCLOSURE}. */
export const DELETION_APPROVAL_RELEASED_LEAD =
  "A started approval on this request was released back to pending.";

export const DELETION_REJECT_AFTER_RELEASE_FULL_ADMIN_MESSAGE = `Rejecting this request needs Full Admin access. ${DELETION_APPROVAL_RELEASED_LEAD} ${DELETION_APPROVAL_RELEASED_DISCLOSURE}`;

export const DELETION_REJECT_AFTER_RELEASE_CONFIRM_CODE =
  "DELETION_REJECT_AFTER_RELEASE_CONFIRM_REQUIRED";
export const DELETION_REJECT_AFTER_RELEASE_CONFIRM_MESSAGE = `${DELETION_APPROVAL_RELEASED_LEAD} ${DELETION_APPROVAL_RELEASED_DISCLOSURE} Reload the deletion queue, read that warning on the request, and confirm the rejection from there.`;

/**
 * The two things a confirmed reject-after-release owes the MEMBER, as opposed to
 * the two the confirmation owes the decider.
 *
 * Everything else about this state is admin-facing: the Full-Admin gate, the
 * warning on the row, the dialog, the confirmation flag and the audit metadata
 * are all seen only by administrators. The member's stays are the thing that was
 * destroyed, and until now they could be declined over them with an empty note
 * and `notifyMember: false` — told nothing at all. So on this one path the
 * release's own mandatory reason is mirrored onto the rejection, and the email is
 * not optional. Ordinary rejections keep #1788's free choice: nothing has been
 * destroyed there, so silence is a legitimate (and audited) option.
 */
export const DELETION_REJECT_AFTER_RELEASE_REASON_REQUIRED_CODE =
  "DELETION_REJECT_AFTER_RELEASE_REASON_REQUIRED";
export const DELETION_REJECT_AFTER_RELEASE_REASON_REQUIRED_MESSAGE = `A reason is required to reject this request. ${DELETION_APPROVAL_RELEASED_DISCLOSURE} The note is the only thing the member is told, so it is mandatory here — exactly as it was for the release that produced this state.`;

export const DELETION_REJECT_AFTER_RELEASE_NOTICE_REQUIRED_CODE =
  "DELETION_REJECT_AFTER_RELEASE_NOTICE_REQUIRED";
export const DELETION_REJECT_AFTER_RELEASE_NOTICE_REQUIRED_MESSAGE = `This rejection must be emailed to the member. ${DELETION_APPROVAL_RELEASED_DISCLOSURE} Declining the request silently would leave them with cancelled stays and no notice at all.`;

/**
 * The release's answer to Prisma's transaction contention (P2028, P2034:
 * `isTransactionContention`), the same 503 as `src/app/api/admin/site-style/route.ts`
 * and `admin-bed-allocation-routes.ts`, for the same reason those chose it: the
 * counterpart writer legitimately holds the row for the length of a whole
 * transaction, so an exhausted wait is contention rather than a fault, nothing
 * was written, and trying again shortly is the real remedy. See
 * `docs/CONCURRENCY_AND_LOCKING.md`.
 */
export const DELETION_REQUEST_RELEASE_CONTENDED_CODE =
  "DELETION_REQUEST_RELEASE_CONTENDED";
export const DELETION_REQUEST_RELEASE_CONTENDED_MESSAGE =
  "Another decision on this deletion request is still committing, so the release could not take the request row in time. Nothing was changed and the claim is still there to release — try again shortly.";

/**
 * A decision lost its guarded transition to a release: the request is `PENDING`
 * again. Distinct from {@link DELETION_REQUEST_ALREADY_REVIEWED_CODE} because
 * nothing was decided, and emphatically distinct from "the final state could not
 * be confirmed" — this state is known exactly.
 *
 * Two losers reach it. An approval finalising from its claim matches zero rows
 * once the claim has been released. And an *unconfirmed* rejection — one whose
 * decider was shown no disclosure because the row carried no marker when the
 * route read it — matches zero rows once the marker exists, which is what stops
 * it landing over cancellations nobody told it about (see
 * {@link DeletionRequestRejectionOrigin}). The wording therefore has to be true
 * of both, which is why it says "decided nothing" rather than describing an
 * approval.
 */
export const DELETION_REQUEST_APPROVAL_RELEASED_CODE =
  "DELETION_REQUEST_APPROVAL_RELEASED";
export const DELETION_REQUEST_APPROVAL_RELEASED_MESSAGE =
  "Another administrator released this request's started approval, so it is pending again: this action decided nothing and anonymised nobody. Reload the deletion queue and decide the request from there — the row shows that future bookings may already have been cancelled.";

/**
 * The status an approval finalises FROM (#2627).
 *
 * `APPROVAL_IN_PROGRESS` when the approval took the durable claim because it
 * had irreversible cleanup to protect; `PENDING` when it had none, so nothing
 * was consumed and an ordinary rejection could still have won right up to the
 * moment the anonymisation transaction committed.
 */
export type DeletionRequestApprovalOrigin = "PENDING" | "APPROVAL_IN_PROGRESS";

/**
 * Which flavour of `PENDING` a rejection is authorised to take (#2627).
 *
 * `PENDING` is an ordinary undecided request. `PENDING_RELEASED` is one whose
 * started approval was released back to pending, so it carries the marker
 * ({@link deletionApprovalWasReleased}) meaning the member's future bookings may
 * already have been cancelled. The route gates and confirms the second — but it
 * evaluates that gate against a row it read BEFORE this transition, and Prisma
 * queues on an exhausted connection pool, so seconds of latency can sit in that
 * window. A release committing inside it would otherwise turn an ordinary
 * rejection into a reject-after-release with no Full-Admin check and no
 * confirmation: precisely the state `docs/DOMAIN_INVARIANTS.md` says cannot
 * happen, produced by a check-then-act.
 *
 * So the flavour is part of the guard, not a precondition read beforehand. The
 * two `where` shapes partition `PENDING` exactly — `reviewedAt: null` against
 * `reviewedAt: { not: null }` — so a rejection can only ever win the flavour it
 * was authorised against, and the loser gets the ordinary 409 and re-reads the
 * row (`DELETION_REQUEST_APPROVAL_RELEASED`). Nothing but a release can add the
 * marker and nothing but a claim can clear it, and a claim also moves `status`
 * out of `PENDING`, so neither shape can be reached by accident.
 *
 * Omitting it therefore fails closed on the strict variant: a caller that has
 * not shown anybody a disclosure cannot take a released row.
 */
export type DeletionRequestRejectionOrigin = "PENDING" | "PENDING_RELEASED";

/**
 * Durably owns approval before any separately committed booking cancellation.
 * A later approval request may resume the existing claim, while rejection and
 * final approval remain mutually exclusive guarded transitions.
 *
 * #2627: the caller takes this ONLY when the approval genuinely has something
 * irreversible to protect (future bookings to cancel), or when it is resuming a
 * claim that already exists. An approval with nothing to cancel commits
 * everything it does in one transaction, so claiming would burn the ability to
 * reject in exchange for nothing.
 */
export async function claimDeletionRequestApproval(
  db: DeletionRequestDecisionDb,
  input: {
    id: string;
    reviewedBy: string;
    adminNote: string | null;
  },
): Promise<"CLAIMED" | "RESUMED"> {
  const claimed = await db.deletionRequest.updateMany({
    where: { id: input.id, status: "PENDING" },
    data: {
      status: "APPROVAL_IN_PROGRESS",
      adminNote: input.adminNote,
      reviewedBy: input.reviewedBy,
      // A claim is ownership, not an outcome, so it carries no reviewed
      // timestamp. This also clears any release marker
      // ({@link deletionApprovalWasReleased}) — deliberately: from
      // APPROVAL_IN_PROGRESS a rejection cannot win at all, and a release of
      // THIS claim writes the marker again.
      reviewedAt: null,
    },
  });
  if (claimed.count === 1) return "CLAIMED";

  const current = await db.deletionRequest.findUnique({
    where: { id: input.id },
    select: { status: true },
  });
  if (current?.status === "APPROVAL_IN_PROGRESS") return "RESUMED";
  throw new DeletionRequestDecisionLostError();
}

/**
 * The final decision protocol. Rejection owns a still-PENDING request directly.
 *
 * Approval becomes final from the status its caller declares in
 * `approvalFrom` — its durable `APPROVAL_IN_PROGRESS` claim when it had
 * irreversible cleanup to protect, otherwise `PENDING`. Either way the
 * transition is a single guarded mutation inside the anonymisation transaction,
 * so a later failure rolls finalisation back to exactly the state it started
 * from and sends no receipt.
 *
 * The claimed variant is what makes a rejection unable to overtake committed
 * booking cancellations. The `PENDING` variant is only reachable when there
 * were none: an approval and a rejection then race for the same guarded
 * transition, exactly one wins, and the loser is told the request was already
 * reviewed — with nothing destructive having happened either way.
 *
 * Rejection likewise declares which flavour of `PENDING` it is authorised
 * against in `rejectFrom` (see {@link DeletionRequestRejectionOrigin}), so the
 * release marker is enforced by the same guarded mutation as the transition
 * instead of by a read taken before it.
 */
export async function claimDeletionRequestDecision(
  db: DeletionRequestDecisionDb,
  input: {
    id: string;
    decision: "APPROVED" | "REJECTED";
    reviewedBy: string;
    adminNote: string | null;
    approvalFrom?: DeletionRequestApprovalOrigin;
    rejectFrom?: DeletionRequestRejectionOrigin;
  },
): Promise<void> {
  const claimed = await db.deletionRequest.updateMany({
    where:
      input.decision === "APPROVED"
        ? {
            id: input.id,
            status: input.approvalFrom ?? "APPROVAL_IN_PROGRESS",
          }
        : {
            id: input.id,
            status: "PENDING",
            // The release marker, inside the guard. Absent `rejectFrom` this is
            // the strict shape, so a caller who showed nobody the disclosure
            // cannot take a released row.
            reviewedAt:
              input.rejectFrom === "PENDING_RELEASED" ? { not: null } : null,
          },
    data:
      input.decision === "APPROVED"
        ? { status: "APPROVED", reviewedAt: new Date() }
        : {
            status: "REJECTED",
            adminNote: input.adminNote,
            reviewedBy: input.reviewedBy,
            reviewedAt: new Date(),
          },
  });
  if (claimed.count !== 1) {
    throw new DeletionRequestDecisionLostError();
  }
}

/**
 * The way OUT of `APPROVAL_IN_PROGRESS` without anonymising anybody (#2627).
 *
 * Before this existed the claim was a one-way door: the only exit was a
 * successful anonymisation. A transient failure resumed fine, but a permanent
 * blocker wedged the request forever — and while wedged the member could not
 * lodge a new deletion request and their duplicate could not be merged, because
 * every "is there an outstanding request?" reader treats the state as open.
 *
 * It returns the request to `PENDING` rather than straight to `REJECTED` so the
 * decision itself is still made through the ordinary reject path, with its
 * guard, its audit entry, and its notify choice. `PENDING -> REJECTED` then
 * closes the loop.
 *
 * How this cannot race a finalisation that is already committing: the release is
 * the same guarded `updateMany` protocol as every other transition on this row.
 * A finalisation holds this exact row's write lock from its own guarded update
 * until its anonymisation transaction commits or rolls back, so a release that
 * arrives mid-commit blocks on that lock and only then re-evaluates its
 * `status: APPROVAL_IN_PROGRESS` predicate against the committed row — matching
 * zero rows and refusing with {@link DeletionRequestClaimNotHeldError} if the
 * approval won. If the release commits first, the finalisation's own guarded
 * update matches zero rows, raises
 * {@link DeletionRequestDecisionLostError}, and its whole anonymisation
 * transaction rolls back: no anonymisation, no approval receipt. There is no
 * interleaving in which both succeed. Both winner orders are pinned against real
 * PostgreSQL in `adult-member-hosting-queue-merge.realdb.test.ts`.
 *
 * ## Why this one takes the row lock, and must run in a transaction
 *
 * The release destroys the claim's own attribution, so the audit entry is the
 * only surviving record of who held it and what their note said — and the
 * previous holder must be read from the SAME serialised point as the mutation.
 * Read outside the lock it is an ABA guess: a claim taken, released and re-taken
 * between the read and the write would be recorded against the wrong admin.
 *
 * So the caller passes a transaction client and this function takes the row
 * `FOR UPDATE` first, reads the previous attribution through the Prisma model
 * under that lock (`docs/CONCURRENCY_AND_LOCKING.md` -> "Lock raw, read typed"),
 * and only then performs the transition — whose `status` guard is retained, so
 * the protocol above is unchanged and the transition still cannot be lost. The
 * caller writes the audit row inside the same transaction, awaited, so the
 * record and the transition commit or roll back together: neither can survive
 * without the other.
 *
 * Because that lock is the FIRST statement and its counterpart legitimately
 * holds the row for a whole anonymisation transaction, the caller must give the
 * transaction a budget bigger than Prisma's 5 s default and map an exhausted
 * wait to a retry-later rather than a bare 500 — see
 * `isTransactionContention` (`prisma-errors.ts`) and the route's release branch.
 *
 * @returns the attribution the transition destroyed, and the `reviewedAt` it
 * stamped — the durable release marker, see {@link deletionApprovalWasReleased}.
 */
export async function releaseDeletionRequestApprovalClaim(
  tx: DeletionRequestReleaseTx,
  input: {
    id: string;
    adminNote: string;
  },
): Promise<{
  releasedAt: Date;
  previousClaimHeldBy: string | null;
  previousAdminNote: string | null;
}> {
  // The lock key is this row's immutable cuid, so the zero-match exception under
  // "Lock raw, read typed" cannot bite: nothing can appear on this key after the
  // lock ran. Zero matched rows means the request itself is gone (a member hard
  // delete cascades it), which is emphatically not a held claim.
  const locked = await tx.$executeRaw`
    SELECT 1
    FROM "DeletionRequest"
    WHERE "id" = ${input.id}
    FOR UPDATE
  `;
  if (locked !== 1) {
    throw new DeletionRequestClaimNotHeldError();
  }

  const current = await tx.deletionRequest.findUnique({
    where: { id: input.id },
    select: { status: true, reviewedBy: true, adminNote: true },
  });
  if (current?.status !== "APPROVAL_IN_PROGRESS") {
    throw new DeletionRequestClaimNotHeldError();
  }

  const releasedAt = new Date();
  const released = await tx.deletionRequest.updateMany({
    where: { id: input.id, status: "APPROVAL_IN_PROGRESS" },
    data: {
      status: "PENDING",
      adminNote: input.adminNote,
      // Back to genuinely undecided: the claim's attribution described an
      // approval that is being abandoned, and a PENDING request has no
      // reviewer. Who released it, and who had held the claim, are recorded in
      // the audit entry this transaction also writes.
      reviewedBy: null,
      // NOT null: on a PENDING row with no reviewer this timestamp IS the
      // durable marker that an approval was started and released here, which is
      // what the queue and the reject dialog show the next decider
      // ({@link deletionApprovalWasReleased}). Written by the same guarded
      // mutation as the transition, so it cannot lag or go missing.
      reviewedAt: releasedAt,
    },
  });
  // Unreachable while this transaction holds the row lock taken above — kept
  // because the guard, not the lock, is the protocol every transition on this
  // row shares, and a future caller that forgets the transaction still fails
  // closed rather than silently reporting a release that did not happen.
  if (released.count !== 1) {
    throw new DeletionRequestClaimNotHeldError();
  }

  return {
    releasedAt,
    previousClaimHeldBy: current.reviewedBy,
    previousAdminNote: current.adminNote,
  };
}
