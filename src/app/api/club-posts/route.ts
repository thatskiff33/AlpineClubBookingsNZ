import { NextRequest, NextResponse } from "next/server";

import { logAudit } from "@/lib/audit";
import {
  assertValidClubPostContent,
  CLUB_POST_PAGE_SIZE,
  ClubPostValidationError,
  createClubPost,
  listClubPostsForMember,
} from "@/lib/club-posts";
import logger from "@/lib/logger";
import { shareOnePost } from "@/lib/club-post-sharing";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { isServerNzConfigured } from "@/lib/servernz-config";
import { prisma } from "@/lib/prisma";
import { applyMemberScopedRateLimit, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * The club message board's member door (#2994, epic #2992).
 *
 * GET returns one page of the board. POST writes a post. Both are member-only
 * and both are club-local: nothing here contacts the central server, and a post
 * written through this route is not shared with anybody until a later child of
 * the epic adds that deliberately.
 *
 * THE MODULE GATE IS ENFORCED HERE AS WELL AS UPSTREAM. `src/config/feature-routes.ts`
 * lists this prefix so the feature-route rule 404s it when `commsPortal` is off,
 * but a module gate that lived only in middleware shipped bypassed once already
 * on a sibling route (#2780 security review), so both methods re-check the flag
 * directly. `loadEffectiveModuleFlags` fails closed on a read error.
 */

const MODULE_OFF = () =>
  NextResponse.json({ error: "Not found" }, { status: 404 });

async function boardEnabled(): Promise<boolean> {
  const modules = await loadEffectiveModuleFlags();
  return modules.commsPortal === true;
}

export async function GET(request: NextRequest) {
  if (!(await boardEnabled())) return MODULE_OFF();

  const gate = await requireActiveSession();
  if (!gate.ok) return gate.response;
  const memberId = gate.session.user.id;

  const url = new URL(request.url);
  const beforeRaw = url.searchParams.get("before");
  const beforeId = url.searchParams.get("beforeId") ?? undefined;

  let before: Date | undefined;
  if (beforeRaw) {
    const parsed = new Date(beforeRaw);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: "That page marker is not a date." },
        { status: 400 },
      );
    }
    before = parsed;
  }

  // Both halves of the composite cursor or neither. Half a cursor would page on
  // `postedAt` alone and silently skip posts sharing a millisecond.
  if ((before && !beforeId) || (!before && beforeId)) {
    return NextResponse.json(
      { error: "That page marker is incomplete." },
      { status: 400 },
    );
  }

  const page = await listClubPostsForMember(memberId, {
    before,
    beforeId,
    take: CLUB_POST_PAGE_SIZE,
  });

  return NextResponse.json(page);
}

export async function POST(request: NextRequest) {
  if (!(await boardEnabled())) return MODULE_OFF();

  const gate = await requireActiveSession();
  if (!gate.ok) return gate.response;
  const memberId = gate.session.user.id;

  const limited = await applyMemberScopedRateLimit(
    rateLimiters.clubPostCreate,
    request,
    memberId,
  );
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "That post could not be read." },
      { status: 400 },
    );
  }

  const content = (body as { content?: unknown })?.content;
  const rawHtml = (body as { bodyHtml?: unknown })?.bodyHtml;
  const bodyHtml = typeof rawHtml === "string" ? rawHtml : null;
  const wantsShare =
    (body as { shareToAllClubs?: unknown })?.shareToAllClubs === true;

  // AUTHOR IDENTITY COMES FROM THE SESSION, NEVER FROM THE BODY, even though
  // the body could carry a name and it would be less work to believe it. The
  // central server cannot verify these fields — it trusts this club's API key —
  // so a shared post is only as honest as this line. A body-supplied name is
  // ignored rather than rejected: there is no legitimate caller that sends one.
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { firstName: true, lastName: true },
  });
  if (!member) {
    // The session guard passed, so this is a member deleted mid-request.
    return NextResponse.json(
      { error: "That account is no longer active." },
      { status: 403 },
    );
  }

  const authorName = memberDisplayName(member);

  try {
    // With a rich body the writer derives the text from the SANITISED html, so
    // validating the request's own `content` here would check a value that is
    // then discarded. Let the writer do it and read back what it stored.
    const post = await createClubPost({
      authorMemberId: memberId,
      authorName,
      content: typeof content === "string" ? content : "",
      bodyHtml,
      // Only honoured when this club actually has a central-server connection.
      // A club without one that somehow asked would otherwise leave a post
      // pending forever against a server it can never reach.
      shareToAllClubs: wantsShare && (await isServerNzConfigured()),
    });
    const stored = post.content;

    // Attempted inline so an ordinary share lands immediately rather than
    // waiting for the next cron pass. Deliberately NOT awaited into the
    // response path's success: if the central server is slow or down the
    // member's post is already saved, and the retry pass will carry it.
    if (wantsShare) {
      void shareOnePost(post.id).catch(() => {
        // Already recorded on the row and logged by the sharer; swallowed here
        // so a failed share cannot turn a successful post into a 500.
      });
    }

    // `communication`, because the affected business domain is club messaging.
    // Note that category IS in MEMBER_VISIBLE_AUDIT_CATEGORIES, so this row
    // appears on the author's own timeline — which is right for "you posted",
    // and is why `details` carries a length rather than the post itself: the
    // body is already stored once, it can be long, and a second copy inside an
    // audit row would outlive any later moderation of the first (INV-PRIV).
    logAudit({
      action: "club_post.create",
      category: "communication",
      memberId,
      entityType: "ClubPost",
      entityId: post.id,
      details: `Posted ${stored.length} characters to the club message board.`,
    });

    return NextResponse.json({ id: post.id }, { status: 201 });
  } catch (error) {
    if (error instanceof ClubPostValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logger.error({ err: error, memberId }, "failed to create club post");
    return NextResponse.json(
      { error: "That post could not be saved." },
      { status: 500 },
    );
  }
}

/**
 * The name shown on the board, snapshotted at write time.
 *
 * Falls back rather than failing: a member with no name still gets a post, and
 * "A club member" is better on screen than an empty byline or a 500.
 */
function memberDisplayName(member: {
  firstName: string;
  lastName: string;
}): string {
  const chosen = `${member.firstName} ${member.lastName}`.trim();
  // Both columns are non-null, so this only bites on whitespace-only names.
  // A byline is better than a 500 and better than an empty space on screen.
  return (chosen || "A club member").slice(0, 200);
}

