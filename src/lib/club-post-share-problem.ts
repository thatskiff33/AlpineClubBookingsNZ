import type { Prisma } from "@prisma/client";

/**
 * Which of this club's message-board posts have a sharing problem the admin
 * should see (#5246), decided from the row alone so the list query, the post
 * badges and the tests agree. Pure: no database, no clock of its own.
 *
 * Mirrors (posts from other clubs) never have one: their copy on the central
 * server belongs to the club that wrote them.
 */

/**
 * How long a claimed send may go unrecorded before its outcome is called
 * unknown. Far longer than any send and its recording take (the API client's
 * own timeouts are seconds), so a share still in flight is never reported.
 */
export const SHARE_OUTCOME_GRACE_MS = 15 * 60_000;

export type ShareProblemKind =
  /** The server accepted a copy this site could not record as the share; its id is held. */
  | "copy-not-recorded"
  /** Removed here; the server has not confirmed taking the recorded share down. */
  | "withdrawal-pending"
  /** Sent, and no result was ever recorded: there may be a copy, and no id is held. */
  | "outcome-unknown"
  /** The share ended in a recorded failure and nothing went to other clubs. */
  | "share-failed";

/** The kinds that may leave a copy on other clubs' boards: the "Sharing problems" panel. */
export const STRAY_COPY_KINDS: readonly ShareProblemKind[] = [
  "copy-not-recorded",
  "withdrawal-pending",
  "outcome-unknown",
];

export interface ShareProblem {
  kind: ShareProblemKind;
  /** The recorded reason, as stored (bounded at 300 characters). */
  shareError: string | null;
  /** The central server's id for the copy still to take down, when one is known. */
  serverPostId: string | null;
}

export interface ShareProblemRow {
  originClubCode: string | null;
  removedAt: Date | null;
  shareRequestedAt: Date | null;
  shareSentAt: Date | null;
  shareError: string | null;
  sharedAt: Date | null;
  serverPostId: string | null;
  withdrawnAt: Date | null;
  unrecordedServerPostId: string | null;
}

/** The fields {@link classifyShareProblem} reads, for a Prisma `select`. */
export const SHARE_PROBLEM_SELECT = {
  originClubCode: true,
  removedAt: true,
  shareRequestedAt: true,
  shareSentAt: true,
  shareError: true,
  sharedAt: true,
  serverPostId: true,
  withdrawnAt: true,
  unrecordedServerPostId: true,
} satisfies Record<keyof ShareProblemRow, true>;

/**
 * The id of an accepted copy that is NOT this post's recorded share, or null.
 * An `unrecordedServerPostId` equal to `serverPostId` is the post's own share
 * (a stamp that committed with its answer lost), never a stray to withdraw.
 */
export function strayCopyId(row: Pick<ShareProblemRow, "serverPostId" | "unrecordedServerPostId">): string | null {
  const id = row.unrecordedServerPostId;
  return id && id !== row.serverPostId ? id : null;
}

/**
 * A removed post's recorded share that the central server has not yet
 * confirmed taken down (#3091 review 1). A live post's own share never
 * qualifies: it is never withdrawn from the admin screen.
 */
export function recordedShareAwaitsWithdrawal(
  row: Pick<ShareProblemRow, "removedAt" | "serverPostId" | "withdrawnAt">,
): row is typeof row & { serverPostId: string } {
  return Boolean(row.removedAt && row.serverPostId && !row.withdrawnAt);
}

/**
 * This club's posts with a copy on the central server for the withdrawal
 * sweep to take down (#3091 review 1, #5246): removed here, and either
 * {@link recordedShareAwaitsWithdrawal} or an unrecorded copy still held.
 * Own-club only: a mirror's copy belongs to the club that wrote it, and the
 * server refuses another club's withdrawal anyway.
 */
export const OUTSTANDING_WITHDRAWAL_WHERE = {
  removedAt: { not: null },
  originClubCode: null,
  OR: [
    { serverPostId: { not: null }, withdrawnAt: null },
    { unrecordedServerPostId: { not: null } },
  ],
} satisfies Prisma.ClubPostWhereInput;

export function classifyShareProblem(row: ShareProblemRow, now: Date): ShareProblem | null {
  if (row.originClubCode !== null) return null;
  const stray = strayCopyId(row);
  if (stray) return { kind: "copy-not-recorded", shareError: row.shareError, serverPostId: stray };
  if (recordedShareAwaitsWithdrawal(row)) {
    return { kind: "withdrawal-pending", shareError: row.shareError, serverPostId: row.serverPostId };
  }
  if (row.sharedAt || row.serverPostId) return null;
  if (row.shareSentAt) {
    // Inside the grace the send may simply still be running.
    if (now.getTime() - row.shareSentAt.getTime() <= SHARE_OUTCOME_GRACE_MS) return null;
    return { kind: "outcome-unknown", shareError: row.shareError, serverPostId: null };
  }
  // Still being retried, or removed (nothing left to share): not a problem.
  if (row.shareError && !row.shareRequestedAt && !row.removedAt) {
    return { kind: "share-failed", shareError: row.shareError, serverPostId: null };
  }
  return null;
}

/**
 * The rows that can classify as one of {@link STRAY_COPY_KINDS}, removed posts
 * included. A superset filter: callers classify each row, which is what
 * decides.
 */
export function strayCopyWhere(now: Date): Prisma.ClubPostWhereInput {
  return {
    originClubCode: null,
    OR: [
      OUTSTANDING_WITHDRAWAL_WHERE,
      // A live post's stray copy too: the admin decides when it comes down.
      { unrecordedServerPostId: { not: null } },
      {
        shareSentAt: { lt: new Date(now.getTime() - SHARE_OUTCOME_GRACE_MS) },
        sharedAt: null,
        serverPostId: null,
      },
    ],
  };
}
