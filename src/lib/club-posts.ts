import { prisma } from "@/lib/prisma";

/**
 * The club message board (#2994, epic #2992).
 *
 * Members write here and read what other members have written. Everything on
 * this board is CLUB-LOCAL: nothing is uploaded anywhere and nothing arrives
 * from anywhere. Sharing a post with other clubs, and mirroring theirs back,
 * are later children of the epic — the composer already renders a disabled
 * share control so the screen does not change shape when they land.
 *
 * The board is club-wide rather than lodge-scoped (D-C1, recorded in
 * docs/multi-lodge/lodge-scoping-contract.md).
 */

/** Matches the `ClubPost.content` column, so a body that fits here fits there. */
export const MAX_CLUB_POST_LENGTH = 4000;

/** How many posts one page of the board holds. */
export const CLUB_POST_PAGE_SIZE = 20;

export class ClubPostValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClubPostValidationError";
  }
}

/**
 * Normalise a submitted body.
 *
 * Content is stored and rendered as PLAIN TEXT. There is deliberately no
 * sanitiser here and `sanitizePageContentHtml` is deliberately NOT reused: that
 * belongs to authored HTML, and reaching for it would imply this field holds
 * markup. React escapes the string at render, so a member who types `<script>`
 * sees `<script>` — their words are preserved rather than silently rewritten.
 *
 * Line endings are normalised first so the control-character strip below can
 * safely remove everything except tab and newline.
 */
export function normalizeClubPostContent(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, "\n")
      // Everything in C0/C1 except tab (\u0009) and newline (\u000A).
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Validate a body and return what should be stored.
 *
 * Normalisation runs BEFORE the length check, so a body padded with control
 * characters cannot pass a limit it only meets before stripping.
 */
export function assertValidClubPostContent(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ClubPostValidationError("A post needs some text.");
  }

  const content = normalizeClubPostContent(raw);

  if (content.length === 0) {
    throw new ClubPostValidationError("A post needs some text.");
  }
  if (content.length > MAX_CLUB_POST_LENGTH) {
    throw new ClubPostValidationError(
      `A post can be at most ${MAX_CLUB_POST_LENGTH} characters; that one is ${content.length}.`,
    );
  }

  return content;
}

export interface MemberClubPost {
  id: string;
  authorName: string;
  /** Null once the author's member record is gone; the post survives them. */
  authorMemberId: string | null;
  content: string;
  postedAt: string;
  /** True when the signed-in member wrote it. */
  mine: boolean;
  /**
   * Which club wrote it. Null means this club. Populated only once mirrored
   * posts arrive in a later child; the reader carries it now so the card does
   * not have to change shape then.
   */
  originClubName: string | null;
}

export function serializeClubPostForMember(
  post: {
    id: string;
    authorName: string;
    authorMemberId: string | null;
    content: string;
    postedAt: Date;
    originClubName: string | null;
  },
  viewerMemberId: string,
): MemberClubPost {
  return {
    id: post.id,
    authorName: post.authorName,
    authorMemberId: post.authorMemberId,
    content: post.content,
    postedAt: post.postedAt.toISOString(),
    mine: post.authorMemberId === viewerMemberId,
    originClubName: post.originClubName,
  };
}

export interface ClubPostPage {
  posts: MemberClubPost[];
  /** Pass back as `before`/`beforeId` for the next page. Null on the last. */
  cursor: { before: string; beforeId: string } | null;
}

/**
 * One page of the board, newest first.
 *
 * Hidden and removed posts are excluded HERE, in the reader, even though
 * nothing sets either column until child 3 adds moderation. Shipping the filter
 * with the reader means the moderation child cannot forget to add it — the
 * failure mode being that hiding a post appears to work in the admin screen and
 * does nothing on the board.
 *
 * Keyset on the composite `(postedAt, id)` rather than an offset: two posts
 * written in the same millisecond straddling a page boundary would otherwise be
 * skipped, and an offset additionally re-numbers every page whenever somebody
 * posts while a member is reading.
 */
export async function listClubPostsForMember(
  viewerMemberId: string,
  options: { before?: Date; beforeId?: string; take?: number } = {},
): Promise<ClubPostPage> {
  const take = options.take ?? CLUB_POST_PAGE_SIZE;
  const cursorFilter =
    options.before && options.beforeId
      ? {
          OR: [
            { postedAt: { lt: options.before } },
            { postedAt: options.before, id: { lt: options.beforeId } },
          ],
        }
      : {};

  const rows = await prisma.clubPost.findMany({
    where: {
      hiddenAt: null,
      removedAt: null,
      ...cursorFilter,
    },
    orderBy: [{ postedAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      authorName: true,
      authorMemberId: true,
      content: true,
      postedAt: true,
      originClubName: true,
    },
  });

  const last = rows.at(-1);
  return {
    posts: rows.map((row) => serializeClubPostForMember(row, viewerMemberId)),
    cursor:
      rows.length === take && last
        ? { before: last.postedAt.toISOString(), beforeId: last.id }
        : null,
  };
}

/**
 * Write a post.
 *
 * `authorName` is captured as a snapshot rather than joined at read time so the
 * board still reads correctly after a member is renamed or removed — and so a
 * later child can share the post to other clubs, which have no way to resolve a
 * member id of ours.
 *
 * The caller passes the identity it took from the session. Nothing here reads a
 * request body: on the central server the author fields are unverifiable and
 * trusted only because this application takes them from a real session, so that
 * has to be true at the one point it can be.
 */
export async function createClubPost(input: {
  authorMemberId: string;
  authorName: string;
  content: string;
}): Promise<{ id: string }> {
  const content = assertValidClubPostContent(input.content);

  const post = await prisma.clubPost.create({
    data: {
      authorMemberId: input.authorMemberId,
      authorName: input.authorName,
      content,
      // originClubCode/originClubName stay null: this club wrote it.
      // sharedAt/serverPostId stay null: sharing arrives in a later child.
    },
    select: { id: true },
  });

  return post;
}

/** How many posts are visible, for the dashboard card's empty check. */
export function countVisibleClubPosts(): Promise<number> {
  return prisma.clubPost.count({
    where: { hiddenAt: null, removedAt: null },
  });
}
