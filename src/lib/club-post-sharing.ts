import "server-only";

import logger from "@/lib/logger";
import { readPostImage } from "@/lib/post-image-storage";
import { prisma } from "@/lib/prisma";
import { ServerNzApiError, shareClubPost, withdrawClubPost } from "@/lib/servernz-api";

/**
 * Sending a board post to the central server (epic #2992).
 *
 * SHARING NEVER BLOCKS POSTING. A member writes to their own club's board and
 * that write succeeds or fails on its own terms; ticking "share with all
 * clubs" records an INTENTION (`shareRequestedAt`) which this module then tries
 * to satisfy. If the central server is down, mid-deploy or slow, the post is
 * still on this club's board and the attempt is retried later — the alternative
 * is losing a member's post to somebody else's outage.
 *
 * `sharedAt` therefore means "the server took it", never "we tried".
 */

/**
 * Most attempts before a post stops being retried automatically (#3091
 * review 5). At the cap the request is CLEARED with the reason recorded on
 * `shareError`, so a permanently failing share ends as an explained failure
 * on the member's post rather than an eternal retry.
 */
export const MAX_SHARE_ATTEMPTS = 8;

/**
 * Posts per sweep pass. Separate from the attempt cap above — the two were
 * one constant once, which made the cap a page size that capped nothing.
 */
export const SHARE_SWEEP_PAGE_SIZE = 8;

export type ShareOutcome =
  | { status: "shared"; serverPostId: string }
  | { status: "failed"; error: string; retryable: boolean }
  | { status: "skipped"; reason: "already-shared" | "not-requested" | "gone" };

/**
 * Decide whether a failure is worth trying again.
 *
 * A 4xx other than 429 is the server saying the REQUEST is wrong — a body too
 * long, a scope the token lacks, a payload it will not accept. Retrying that
 * unchanged just produces the same refusal on a schedule, so it stops and says
 * why. Everything else (network, timeout, 5xx, rate limit) is the server or
 * the path being temporarily unavailable, which is exactly what retrying is
 * for.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof ServerNzApiError) {
    if (error.status === 429) return true;
    return error.status < 400 || error.status >= 500;
  }
  return true;
}

/**
 * Try to share one post.
 *
 * Idempotent on `serverPostId`: a post that already carries one is not sent
 * again, so a retry that crashed after the remote accepted it but before the
 * local row was updated cannot produce a duplicate on every other club's
 * board.
 */
export async function shareOnePost(postId: string): Promise<ShareOutcome> {
  const post = await prisma.clubPost.findUnique({
    where: { id: postId },
    select: {
      id: true,
      authorMemberId: true,
      authorName: true,
      content: true,
      bodyHtml: true,
      shareRequestedAt: true,
      shareAttempts: true,
      sharedAt: true,
      serverPostId: true,
      removedAt: true,
      images: {
        orderBy: { position: "asc" },
        select: { publicId: true, mimeType: true, storageKey: true },
      },
    },
  });

  if (!post || post.removedAt) return { status: "skipped", reason: "gone" };
  if (post.sharedAt || post.serverPostId) {
    return { status: "skipped", reason: "already-shared" };
  }
  if (!post.shareRequestedAt) {
    return { status: "skipped", reason: "not-requested" };
  }

  // Read in the SAME ORDER the body's image URLs will be rewritten against.
  // The server maps `image_ids[n]` onto the nth attached file, so a different
  // order here silently attaches every picture to the wrong place.
  const images: {
    publicId: string;
    mimeType: string;
    bytes: Uint8Array;
  }[] = [];
  for (const image of post.images) {
    const bytes = await readPostImage(image.storageKey);
    if (!bytes) {
      // A row whose file is missing. Skipped rather than failed: the post's
      // words are still worth sharing, and a permanently missing file would
      // otherwise block this post forever.
      logger.warn(
        { postId: post.id, publicId: image.publicId },
        "Club post image row has no file on disk; sharing without it",
      );
      continue;
    }
    images.push({
      publicId: image.publicId,
      mimeType: image.mimeType,
      bytes: new Uint8Array(bytes),
    });
  }

  try {
    const result = await shareClubPost({
      // The central server cannot verify author identity — it trusts this
      // club's API key — so these are club-attested. They come from the row,
      // which took them from the session at compose time.
      authorUserId: post.authorMemberId ?? `deleted:${post.id}`,
      authorName: post.authorName,
      content: post.content,
      bodyHtml: post.bodyHtml,
      images,
    });

    await prisma.clubPost.update({
      where: { id: post.id },
      data: {
        serverPostId: result.id,
        sharedAt: new Date(),
        shareError: null,
      },
    });

    return { status: "shared", serverPostId: result.id };
  } catch (error) {
    const attempts = post.shareAttempts + 1;
    // Retryable by ERROR KIND and still under the cap. A refusal that will
    // never succeed stops at once; a transient failure stops at the cap
    // (#3091 review 5) — either way the request is cleared and the reason is
    // on the row, so the member is told plainly rather than left watching a
    // post that never goes anywhere.
    const retryable = isRetryable(error) && attempts < MAX_SHARE_ATTEMPTS;
    const message =
      error instanceof Error ? error.message : "The central server refused it.";
    const recorded = (
      isRetryable(error) && !retryable
        ? `Gave up after ${MAX_SHARE_ATTEMPTS} attempts: ${message}`
        : message
    ).slice(0, 300);

    await prisma.clubPost.update({
      where: { id: post.id },
      data: {
        shareError: recorded,
        shareAttempts: attempts,
        ...(retryable ? {} : { shareRequestedAt: null }),
      },
    });

    logger.warn(
      { postId: post.id, retryable, attempts, err: error },
      "Sharing a club post to the central server failed",
    );
    return { status: "failed", error: message, retryable };
  }
}

export interface ShareSweepResult {
  attempted: number;
  shared: number;
  failed: number;
  /** The takedown half (#3091 review 1): withdrawals retried this pass. */
  withdrawalsAttempted: number;
  withdrawalsConfirmed: number;
  withdrawalsFailed: number;
}

/** Withdrawals retried per pass — bounded for the same reason the shares are. */
export const WITHDRAWAL_SWEEP_PAGE_SIZE = 8;

/**
 * Retry every takedown the central server has not yet confirmed (#3091
 * review 1). `removeClubPost` withdraws inline and stamps `withdrawnAt` on
 * success; when that inline call fails — server unreachable, mid-deploy, a
 * 5xx — the post is removed locally but its network copy is still on every
 * other club's board, and NOTHING else would ever try again. This sweep is
 * the retry: rows with `removedAt` set, a `serverPostId`, no origin club
 * (the withdrawal is own-club only) and no `withdrawnAt` are exactly the
 * removals whose network copy may still be live. `withdrawClubPost` treats a
 * 404 as success, so a copy the server already dropped confirms cleanly.
 */
export async function retryPendingWithdrawals(): Promise<{
  attempted: number;
  confirmed: number;
  failed: number;
}> {
  const pending = await prisma.clubPost.findMany({
    where: {
      removedAt: { not: null },
      serverPostId: { not: null },
      originClubCode: null,
      withdrawnAt: null,
    },
    orderBy: { removedAt: "asc" },
    take: WITHDRAWAL_SWEEP_PAGE_SIZE,
    select: { id: true, serverPostId: true },
  });

  const result = { attempted: pending.length, confirmed: 0, failed: 0 };
  for (const post of pending) {
    try {
      await withdrawClubPost(post.serverPostId as string);
      await prisma.clubPost.update({
        where: { id: post.id },
        data: { withdrawnAt: new Date() },
      });
      result.confirmed += 1;
    } catch (error) {
      result.failed += 1;
      logger.warn(
        { postId: post.id, serverPostId: post.serverPostId, err: error },
        "Retrying a club post withdrawal failed; the network copy may still be visible",
      );
    }
  }
  return result;
}

/**
 * Retry every post whose share is still outstanding.
 *
 * Bounded per pass so one unreachable server cannot turn the shared cron cycle
 * into a long series of timeouts — the rest of that cycle has work to do.
 */
export async function retryPendingShares(
  now: Date = new Date(),
): Promise<ShareSweepResult> {
  const pending = await prisma.clubPost.findMany({
    where: {
      shareRequestedAt: { not: null, lte: now },
      sharedAt: null,
      removedAt: null,
    },
    // Fewest attempts FIRST (#3091 review 5): a page of stuck posts selected
    // oldest-first would be re-selected every pass and starve every newer
    // share behind it. Ordering by attempts rotates the stuck ones to the
    // back until the cap retires them; age breaks ties.
    orderBy: [{ shareAttempts: "asc" }, { shareRequestedAt: "asc" }],
    take: SHARE_SWEEP_PAGE_SIZE,
    select: { id: true },
  });

  const result: ShareSweepResult = {
    attempted: pending.length,
    shared: 0,
    failed: 0,
    withdrawalsAttempted: 0,
    withdrawalsConfirmed: 0,
    withdrawalsFailed: 0,
  };

  for (const post of pending) {
    const outcome = await shareOnePost(post.id);
    if (outcome.status === "shared") result.shared += 1;
    else if (outcome.status === "failed") result.failed += 1;
  }

  // The takedown half rides the same cycle: a removal must come down
  // everywhere with the same persistence a share goes up with.
  const withdrawals = await retryPendingWithdrawals();
  result.withdrawalsAttempted = withdrawals.attempted;
  result.withdrawalsConfirmed = withdrawals.confirmed;
  result.withdrawalsFailed = withdrawals.failed;

  return result;
}
