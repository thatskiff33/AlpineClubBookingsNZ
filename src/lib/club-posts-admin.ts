import "server-only";
import { Prisma } from "@prisma/client";

import { assertValidClubPostContent } from "@/lib/club-posts";
import logger from "@/lib/logger";
import { deletePostImage } from "@/lib/post-image-storage";
import { prisma } from "@/lib/prisma";
import { withdrawClubPost } from "@/lib/servernz-api";

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
}

function serialize(row: {
  id: string;
  authorName: string;
  authorMemberId: string | null;
  content: string;
  postedAt: Date;
  hiddenAt: Date | null;
  removedAt: Date | null;
  originClubName: string | null;
}): AdminClubPost {
  return {
    id: row.id,
    authorName: row.authorName,
    authorMemberId: row.authorMemberId,
    content: row.content,
    postedAt: row.postedAt.toISOString(),
    hiddenAt: row.hiddenAt?.toISOString() ?? null,
    removedAt: row.removedAt?.toISOString() ?? null,
    originClubName: row.originClubName,
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
          { content: { contains: options.q, mode: "insensitive" } },
          { authorName: { contains: options.q, mode: "insensitive" } },
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
    select: {
      id: true,
      authorName: true,
      authorMemberId: true,
      content: true,
      postedAt: true,
      hiddenAt: true,
      removedAt: true,
      originClubName: true,
    },
  });

  return rows.map(serialize);
}

/**
 * Removed posts whose network copy the central server has not yet confirmed
 * taken down (#3091 review 1). The moderation screen names this count: the
 * admin was told "removed", and until this is zero that is only true locally.
 */
export function countPendingWithdrawals(): Promise<number> {
  return prisma.clubPost.count({
    where: {
      removedAt: { not: null },
      serverPostId: { not: null },
      originClubCode: null,
      withdrawnAt: null,
    },
  });
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
  const post = await prisma.clubPost.findUnique({
    where: { id: postId },
    select: {
      id: true,
      removedAt: true,
      serverPostId: true,
      originClubCode: true,
    },
  });
  if (!post) throw new ClubPostNotFoundError();
  // Idempotent: removing an already-removed post is a no-op rather than an
  // error, so a double-click or a retry does not report a failure.
  if (post.removedAt) return;

  // The IMAGES go with the words. The serving route already refuses images on
  // a removed post, but refusing to serve a file is not the same as the file
  // being gone -- a removal that left the photographs on the mount until
  // retention happened to sweep the row would keep exactly the content the
  // admin asked to be rid of. Rows first, files second: the crash order that
  // leaves invisible orphans for the sweep, never broken references.
  const images = await prisma.clubPostImage.findMany({
    where: { postId },
    select: { storageKey: true },
  });
  await prisma.$transaction([
    prisma.clubPostImage.deleteMany({ where: { postId } }),
    prisma.clubPost.update({
      where: { id: postId },
      data: {
        content: "",
        bodyHtml: null,
        removedAt: new Date(),
        // Stops the retry pass from carrying a post the admin has just taken
        // down. Without this, removing a post whose share had not yet
        // succeeded would publish it minutes later.
        shareRequestedAt: null,
      },
    }),
  ]);
  for (const image of images) {
    await deletePostImage(image.storageKey);
  }

  // A SHARED POST MUST COME DOWN EVERYWHERE, not just here. Removing it
  // locally while it stays on every other club's board is the worst of both:
  // the admin believes it is gone and the members who can see it are the ones
  // it was taken down for.
  //
  // Deliberately AFTER the local write and deliberately not fatal: the local
  // removal is the part the admin asked for and must not be undone because the
  // central server is unreachable. `serverPostId` is kept so the withdrawal can
  // be retried; the tombstone row is what a later sweep would use.
  // Origin check as well as id check: a MIRROR row also carries a
  // serverPostId, but the network copy belongs to the club that wrote it, and
  // the server would refuse the withdrawal anyway (own-club only). Removing a
  // mirror is a local act.
  if (post.serverPostId && post.originClubCode === null) {
    try {
      await withdrawClubPost(post.serverPostId);
      // CONFIRMED down everywhere (#3091 review 1). Without this stamp the
      // row reads as withdrawal-pending forever and the sweep re-withdraws a
      // copy that is already gone (harmless — the server 404s — but noisy).
      await prisma.clubPost.update({
        where: { id: postId },
        data: { withdrawnAt: new Date() },
      });
    } catch (error) {
      // NOT fatal, and NOT forgotten (#3091 review 1): the local removal
      // stands, `withdrawnAt` stays null, and that combination is exactly
      // what `retryPendingWithdrawals` sweeps every general-cron cycle and
      // what the moderation screen names until the server confirms.
      logger.error(
        { postId, serverPostId: post.serverPostId, err: error },
        "Removed a shared club post locally but could not withdraw it from the central server; the withdrawal sweep will retry",
      );
    }
  }
}
