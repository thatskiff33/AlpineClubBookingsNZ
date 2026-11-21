import { exactContains } from "@/lib/prisma-exact-prefix";
import "server-only";
import { Prisma } from "@prisma/client";

import { assertValidClubPostContent } from "@/lib/club-posts";
import { OUTSTANDING_COPY_SELECT, withdrawOutstandingCopies } from "@/lib/club-post-sharing";
import {
  SHARE_OUTCOME_GRACE_MS,
  SHARE_PROBLEM_SELECT,
  STRAY_COPY_KINDS,
  type ShareProblem,
  classifyShareProblem,
  recordedShareAwaitsWithdrawal,
  strayCopyId,
  strayCopyWhere,
} from "@/lib/club-post-share-problem";
import logger from "@/lib/logger";
import { deletePostImage } from "@/lib/post-image-storage";
import { prisma } from "@/lib/prisma";
import { ServerNzVersionMismatchError } from "@/lib/servernz-api";

/**
 * Moderation for the club message board (#2998, epic #2992).
 *
 * Everything here is club-local. Mirrored posts from other clubs, and the rules
 * that differ for them, arrive in a later child; so does reporting, which is why
 * there is no flagged view — `reportCount` exists on the row but nothing writes
 * to it yet, and a queue that can only ever be empty reads as "no problems"
 * rather than "not built".
 */

export type AdminPostTab = "all" | "hidden";

export function parseAdminPostTab(raw: string | null | undefined): AdminPostTab {
  return raw === "hidden" ? "hidden" : "all";
}

export const ADMIN_POST_PAGE_SIZE = 50;

export interface AdminClubPost {
  id: string;
  authorName: string;
  authorMemberId: string | null;
  content: string;
  postedAt: string;
  hiddenAt: string | null;
  /** Non-null once removed. The row survives; its content does not. */
  removedAt: string | null;
  originClubName: string | null;
  /** A share or withdrawal that ended in an error (#5246); admin-only. */
  shareProblem: ShareProblem | null;
}

const ADMIN_POST_SELECT = {
  id: true,
  authorName: true,
  authorMemberId: true,
  content: true,
  postedAt: true,
  hiddenAt: true,
  originClubName: true,
  // removedAt comes with the share-problem fields.
  ...SHARE_PROBLEM_SELECT,
} satisfies Prisma.ClubPostSelect;

function serialize(
  row: Prisma.ClubPostGetPayload<{ select: typeof ADMIN_POST_SELECT }>,
  now: Date,
): AdminClubPost {
  return {
    id: row.id,
    authorName: row.authorName,
    authorMemberId: row.authorMemberId,
    content: row.content,
    postedAt: row.postedAt.toISOString(),
    hiddenAt: row.hiddenAt?.toISOString() ?? null,
    removedAt: row.removedAt?.toISOString() ?? null,
    originClubName: row.originClubName,
    shareProblem: classifyShareProblem(row, now),
  };
}

/**
 * The moderation list.
 *
 * Removed posts are excluded from BOTH tabs. Their content is already blanked,
 * so a row would show an empty card with no action left on it — the audit trail
 * is where a removal is answered for, not this screen.
 */
export async function listClubPostsForAdmin(options: {
  tab: AdminPostTab;
  q?: string;
}): Promise<AdminClubPost[]> {
  const search: Prisma.ClubPostWhereInput = options.q
    ? {
        OR: [
          { content: exactContains(options.q, "insensitive") },
          { authorName: exactContains(options.q, "insensitive") },
        ],
      }
    : {};

  const rows = await prisma.clubPost.findMany({
    where: {
      removedAt: null,
      ...(options.tab === "hidden" ? { hiddenAt: { not: null } } : {}),
      ...search,
    },
    orderBy: [{ postedAt: "desc" }, { id: "desc" }],
    take: ADMIN_POST_PAGE_SIZE,
    select: ADMIN_POST_SELECT,
  });

  const now = new Date();
  return rows.map((row) => serialize(row, now));
}

/** Most posts the "Sharing problems" panel lists; each is a rare failure. */
export const SHARE_PROBLEM_LIST_LIMIT = 50;

export type AdminShareProblemPost = AdminClubPost & { shareProblem: ShareProblem };

/**
 * This club's posts that may be on other clubs' boards in a way this site did
 * not record (#3091 review 1, #5246): an accepted copy with no recorded share,
 * a removal the server has not confirmed taking down, or a send whose result
 * was never recorded. Removed posts INCLUDED, unlike the moderation list: a
 * removed post's copy elsewhere is exactly what the admin needs to see.
 */
export async function listClubPostShareProblems(): Promise<AdminShareProblemPost[]> {
  const now = new Date();
  const rows = await prisma.clubPost.findMany({
    where: strayCopyWhere(now),
    orderBy: [{ postedAt: "desc" }, { id: "desc" }],
    take: SHARE_PROBLEM_LIST_LIMIT,
    select: ADMIN_POST_SELECT,
  });
  return rows
    .map((row) => serialize(row, now))
    .filter((post): post is AdminShareProblemPost =>
      post.shareProblem !== null && STRAY_COPY_KINDS.includes(post.shareProblem.kind),
    );
}

export class ClubPostNotFoundError extends Error {
  constructor() {
    super("That post no longer exists.");
    this.name = "ClubPostNotFoundError";
  }
}

export class ClubPostNotEditableError extends Error {
  constructor() {
    super(
      "That post was written by another club's member, so its words cannot be edited here. It can be hidden or removed.",
    );
    this.name = "ClubPostNotEditableError";
  }
}

export class ClubPostNoShareProblemError extends Error {
  constructor() {
    super("That post has no shared copy left to deal with.");
    this.name = "ClubPostNoShareProblemError";
  }
}

const ASK_THE_ADMINISTRATOR =
  "If it keeps failing, send the central server id to the central server's administrator and ask them to take the copy down.";

/**
 * What a failed admin withdrawal still did (#5246 review): a post can hold two
 * copies, and the first may come down before the second fails. The route
 * audits both lists, so a half-successful attempt is never unrecorded.
 */
interface WithdrawalAttempt {
  /** Ids the central server confirmed down before the failure. */
  withdrawnServerPostIds: string[];
  /** Ids still outstanding after it. */
  outstandingServerPostIds: string[];
}

function partSentence({ withdrawnServerPostIds }: WithdrawalAttempt): string {
  return withdrawnServerPostIds.length > 0
    ? ` The copy ${withdrawnServerPostIds.join(", ")} was withdrawn; the rest was not.`
    : "";
}

/** The server is on a different API version (#49): the rest was not withdrawn. */
export class ClubPostWithdrawalPausedError extends Error {
  readonly attempt: WithdrawalAttempt;
  constructor(attempt: WithdrawalAttempt = { withdrawnServerPostIds: [], outstandingServerPostIds: [] }) {
    super(
      `Sharing with other clubs is paused because the central server is on a different version, so the copy was not withdrawn.${partSentence(attempt)} ${ASK_THE_ADMINISTRATOR}`,
    );
    this.name = "ClubPostWithdrawalPausedError";
    this.attempt = attempt;
  }
}

/** The server did not confirm the withdrawal; the id is kept for another try. */
export class ClubPostWithdrawalFailedError extends Error {
  readonly attempt: WithdrawalAttempt;
  constructor(reason: string, attempt: WithdrawalAttempt = { withdrawnServerPostIds: [], outstandingServerPostIds: [] }) {
    super(
      `The central server did not confirm the withdrawal (${reason.slice(0, 200)}).${partSentence(attempt)} ${ASK_THE_ADMINISTRATOR}`,
    );
    this.name = "ClubPostWithdrawalFailedError";
    this.attempt = attempt;
  }
}

export class ClubPostAlreadyRemovedError extends Error {
  constructor() {
    super("That post has been removed and can no longer be changed.");
    this.name = "ClubPostAlreadyRemovedError";
  }
}

async function loadEditable(postId: string) {
  const post = await prisma.clubPost.findUnique({
    where: { id: postId },
    select: {
      id: true,
      content: true,
      hiddenAt: true,
      removedAt: true,
      originClubCode: true,
    },
  });
  if (!post) throw new ClubPostNotFoundError();
  // A removed post has no content left to hide, restore or rewrite. Refusing
  // is honest; silently succeeding would tell an admin they had done something.
  if (post.removedAt) throw new ClubPostAlreadyRemovedError();
  return post;
}

/** Hide a post from the member board, reversibly. Content is untouched. */
export async function setClubPostHidden(
  postId: string,
  hidden: boolean,
): Promise<void> {
  await loadEditable(postId);
  await prisma.clubPost.update({
    where: { id: postId },
    data: { hiddenAt: hidden ? new Date() : null },
  });
}

/**
 * Replace a post's text.
 *
 * Returns what it replaced so the caller can put the original into the audit
 * row: an admin rewriting a member's words must leave the original recoverable,
 * and this is the only place it still exists.
 */
export async function editClubPostContent(
  postId: string,
  rawContent: unknown,
): Promise<{ before: string; after: string }> {
  const post = await loadEditable(postId);
  // D-C4, now ENFORCED rather than merely promised by the schema comment: a
  // mirror still shows the origin club's name and badge, so rewriting its
  // words here would misrepresent that club to this one's members. Hiding and
  // removing the local copy stay available — they say what they actually do.
  if (post.originClubCode !== null) throw new ClubPostNotEditableError();

  const after = assertValidClubPostContent(rawContent);

  await prisma.clubPost.update({
    where: { id: postId },
    // bodyHtml is CLEARED, not kept: the board renders the rich body in
    // preference to the text, so an edit that only rewrote `content` would be
    // invisible — the admin saves, the audit records a change, and every
    // member keeps reading the unedited words. The edited post renders as
    // plain text; the member can repost with formatting if it matters.
    data: { content: after, bodyHtml: null },
  });

  return { before: post.content, after };
}

/**
 * Remove a post permanently.
 *
 * The CONTENT is blanked rather than the row merely flagged, so the words are
 * actually gone from the database instead of sitting behind a filter that a
 * future query might forget. The row itself stays: it is what a later child
 * uses to tell other clubs the post is gone, and what the audit trail points
 * at. `authorMemberId` and `authorName` stay too — a removal has to remain
 * answerable for.
 */
export async function removeClubPost(postId: string): Promise<void> {
  // THE POST ROW FIRST, then its images (#4586), the order every message-board
  // writer takes them in (docs/CONCURRENCY_AND_LOCKING.md -> "Message-board
  // posts and their images"): taking the images first deadlocked against a
  // mirror tombstone or the retention sweep deleting the same post. The
  // status-guarded claim below takes the post's row lock; the images, and the
  // share state the withdrawal needs, are read under it.
  //
  // The IMAGES go with the words. The serving route already refuses images on
  // a removed post, but refusing to serve a file is not the same as the file
  // being gone -- a removal that left the photographs on the mount until
  // retention happened to sweep the row would keep exactly the content the
  // admin asked to be rid of. Rows first, files second: the crash order that
  // leaves invisible orphans for the sweep, never broken references.
  const post = await prisma.$transaction(async (tx) => {
    const claim = await tx.clubPost.updateMany({
      where: { id: postId, removedAt: null },
      data: {
        content: "",
        bodyHtml: null,
        removedAt: new Date(),
        // Stops the retry pass from carrying a post the admin has just taken
        // down. Without this, removing a post whose share had not yet
        // succeeded would publish it minutes later.
        shareRequestedAt: null,
      },
    });
    if (claim.count === 0) return null;
    const removed = await tx.clubPost.findUniqueOrThrow({
      where: { id: postId },
      select: { ...OUTSTANDING_COPY_SELECT, images: { select: { storageKey: true } } },
    });
    await tx.clubPostImage.deleteMany({ where: { postId } });
    return removed;
    // Bounded like the repository's other short row-lock writers (#4586
    // review): the post-row claim can queue behind a retention batch holding
    // the same row, and Prisma's 5 s default would refuse a removal that only
    // had to wait.
  }, { maxWait: 10_000, timeout: 30_000 });
  if (!post) {
    // The claim matched nothing. Idempotent: removing an already-removed post
    // is a no-op rather than an error, so a double-click or a retry does not
    // report a failure; a post that is gone (a mirror tombstone or retention
    // deleted it) is not found.
    const exists = await prisma.clubPost.findUnique({ where: { id: postId }, select: { id: true } });
    if (!exists) throw new ClubPostNotFoundError();
    return;
  }
  for (const image of post.images) {
    await deletePostImage(image.storageKey);
  }

  // A SHARED POST MUST COME DOWN EVERYWHERE, not just here. Removing it
  // locally while it stays on every other club's board is the worst of both:
  // the admin believes it is gone and the members who can see it are the ones
  // it was taken down for.
  //
  // Deliberately AFTER the local write and deliberately not fatal: the local
  // removal is the part the admin asked for and must not be undone because the
  // central server is unreachable. The ids are kept so the withdrawal can be
  // retried. `withdrawOutstandingCopies` withdraws the recorded share and any
  // unrecorded copy (#5246), own-club posts only: a MIRROR row also carries a
  // serverPostId, but its network copy belongs to the club that wrote it.
  const { error } = await withdrawOutstandingCopies(post);
  if (error !== null) {
    // NOT fatal, and NOT forgotten (#3091 review 1): the local removal
    // stands, the ids stay, and that is exactly what
    // `retryPendingWithdrawals` sweeps every general-cron cycle and what the
    // moderation screen lists under "Sharing problems" until the server
    // confirms.
    //
    // A version pause (#49) is the same outcome for the row and a different
    // one for the log: it is expected, not a fault, so it is recorded at
    // info with the two numbers rather than as an error with a stack.
    const ids = { serverPostId: post.serverPostId, unrecordedServerPostId: post.unrecordedServerPostId };
    if (error instanceof ServerNzVersionMismatchError) {
      logger.info(
        { postId, ...ids, expected: error.expected, serverVersion: error.serverVersion },
        "Removed a shared club post locally; its withdrawal waits until the central server API version matches",
      );
      return;
    }
    logger.error(
      { postId, ...ids, err: error },
      "Removed a shared club post locally but could not withdraw it from the central server; the withdrawal sweep will retry",
    );
  }
}

/**
 * Withdraw a post's stray copy from the central server, on the admin's
 * request (#5246): the unrecorded copy whenever one is held, and a removed
 * post's unconfirmed share. A live post's own recorded share is never taken
 * down here, and the share request is never touched, so this can only ever
 * remove a copy, never send one. Returns the ids withdrawn, for the audit row;
 * a failure carries the ids it did withdraw and the ones still outstanding.
 */
export async function withdrawSharedCopy(postId: string): Promise<{ serverPostIds: string[] }> {
  const post = await prisma.clubPost.findUnique({ where: { id: postId }, select: OUTSTANDING_COPY_SELECT });
  if (!post) throw new ClubPostNotFoundError();
  const stray = strayCopyId(post);
  const serverPostIds = [
    ...(stray ? [stray] : []),
    ...(recordedShareAwaitsWithdrawal(post) ? [post.serverPostId] : []),
  ];
  if (post.originClubCode !== null || serverPostIds.length === 0) throw new ClubPostNoShareProblemError();
  const { confirmedServerPostIds, error } = await withdrawOutstandingCopies(post);
  if (error === null) return { serverPostIds: confirmedServerPostIds };
  const attempt: WithdrawalAttempt = {
    withdrawnServerPostIds: confirmedServerPostIds,
    outstandingServerPostIds: serverPostIds.filter((id) => !confirmedServerPostIds.includes(id)),
  };
  logger.warn({ postId, ...attempt, err: error }, "An admin's withdrawal of a shared club post's copy failed");
  if (error instanceof ServerNzVersionMismatchError) throw new ClubPostWithdrawalPausedError(attempt);
  throw new ClubPostWithdrawalFailedError(error instanceof Error ? error.message : "no reason given", attempt);
}

/**
 * Mark a send whose result was never recorded as dealt with (#5246): the
 * admin has had any copy taken down, or found there was none. Clears only the
 * marker, and only while the post still holds no server id.
 */
export async function dismissShareOutcome(postId: string, now: Date = new Date()): Promise<void> {
  const { count } = await prisma.clubPost.updateMany({
    // Only once the grace has passed (#5246 review): inside it the send may
    // still be recording its own result, and the screen does not offer this.
    where: {
      id: postId,
      shareSentAt: { not: null, lt: new Date(now.getTime() - SHARE_OUTCOME_GRACE_MS) },
      sharedAt: null,
      serverPostId: null,
    },
    data: { shareSentAt: null },
  });
  if (count === 1) return;
  const exists = await prisma.clubPost.findUnique({ where: { id: postId }, select: { id: true } });
  if (!exists) throw new ClubPostNotFoundError();
  throw new ClubPostNoShareProblemError();
}
