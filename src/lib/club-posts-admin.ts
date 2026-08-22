import { Prisma } from "@prisma/client";

import { assertValidClubPostContent } from "@/lib/club-posts";
import { prisma } from "@/lib/prisma";

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

export class ClubPostNotFoundError extends Error {
  constructor() {
    super("That post no longer exists.");
    this.name = "ClubPostNotFoundError";
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
    select: { id: true, content: true, hiddenAt: true, removedAt: true },
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
  const after = assertValidClubPostContent(rawContent);

  await prisma.clubPost.update({
    where: { id: postId },
    data: { content: after },
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
    select: { id: true, removedAt: true },
  });
  if (!post) throw new ClubPostNotFoundError();
  // Idempotent: removing an already-removed post is a no-op rather than an
  // error, so a double-click or a retry does not report a failure.
  if (post.removedAt) return;

  await prisma.clubPost.update({
    where: { id: postId },
    data: { content: "", removedAt: new Date() },
  });
}
