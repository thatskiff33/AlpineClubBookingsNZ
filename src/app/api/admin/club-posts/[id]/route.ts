import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { ClubPostValidationError } from "@/lib/club-posts";
import {
  ClubPostAlreadyRemovedError,
  ClubPostNoShareProblemError,
  ClubPostNotEditableError,
  ClubPostNotFoundError,
  ClubPostWithdrawalFailedError,
  ClubPostWithdrawalPausedError,
  dismissShareOutcome,
  editClubPostContent,
  removeClubPost,
  setClubPostHidden,
  withdrawSharedCopy,
} from "@/lib/club-posts-admin";
import logger from "@/lib/logger";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { requireAdmin } from "@/lib/session-guards";

/**
 * PATCH /api/admin/club-posts/:id — hide, unhide, or rewrite a post; withdraw
 * its stray copy from the central server, or mark a share whose result was
 * never recorded as dealt with (#5246).
 * DELETE /api/admin/club-posts/:id — remove it permanently.
 *
 * Both need `membership:edit`, matching `/admin/notices`: the people who curate
 * club news are the ones who should moderate what members write.
 *
 * The module is re-checked before the permission guard, so an off module cannot
 * be probed by the difference between a 403 and a 404.
 */

const patchSchema = z
  .object({
    hidden: z.boolean().optional(),
    content: z.string().optional(),
    withdrawSharedCopy: z.literal(true).optional(),
    dismissShareProblem: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "No change was supplied.",
  });

async function guard() {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.commsPortal) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }
  return requireAdmin({ permission: { area: "membership", level: "edit" } });
}

function errorResponse(error: unknown): NextResponse | null {
  if (error instanceof ClubPostNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof ClubPostAlreadyRemovedError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ClubPostNotEditableError) {
    // 403 rather than 400: the request is well-formed, the ACTION is what is
    // refused — the words belong to another club's member.
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof ClubPostValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof ClubPostNoShareProblemError || error instanceof ClubPostWithdrawalPausedError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ClubPostWithdrawalFailedError) {
    // The central server, not this site, refused or could not be reached.
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
  return null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guard();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const jsonBody = await parseJsonRequestBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "That change could not be read." },
      { status: 400 },
    );
  }

  const actorMemberId = gate.session.user.id;

  try {
    if (parsed.data.withdrawSharedCopy) {
      const { serverPostIds } = await withdrawSharedCopy(id);
      logAudit({
        action: "club_post.withdraw_shared_copy",
        category: "communication",
        memberId: actorMemberId,
        entityType: "ClubPost",
        entityId: id,
        // The server's ids, never the post's words: a copy is withdrawn for
        // the same reasons a post is removed.
        details: `Withdrew a club message board post's copy from the central server (${serverPostIds.join(", ")}).`,
      });
      return NextResponse.json({ status: "withdrawn" });
    }

    if (parsed.data.dismissShareProblem) {
      await dismissShareOutcome(id);
      logAudit({
        action: "club_post.share_problem.dismiss",
        category: "communication",
        memberId: actorMemberId,
        entityType: "ClubPost",
        entityId: id,
        details: "Marked a club message board post's unrecorded share as dealt with.",
      });
      return NextResponse.json({ status: "dismissed" });
    }

    if (parsed.data.content !== undefined) {
      const { before, after } = await editClubPostContent(
        id,
        parsed.data.content,
      );
      logAudit({
        action: "club_post.edit",
        category: "communication",
        memberId: actorMemberId,
        entityType: "ClubPost",
        entityId: id,
        // The ORIGINAL goes in, not the replacement. An admin rewriting a
        // member's words must leave what they said recoverable, and after this
        // write the audit row is the only place it still exists.
        details: `Edited a club message board post. Original text: ${before}`,
      });
      return NextResponse.json({ status: "edited", length: after.length });
    }

    if (parsed.data.hidden !== undefined) {
      await setClubPostHidden(id, parsed.data.hidden);
      logAudit({
        action: parsed.data.hidden ? "club_post.hide" : "club_post.unhide",
        category: "communication",
        memberId: actorMemberId,
        entityType: "ClubPost",
        entityId: id,
        details: parsed.data.hidden
          ? "Hid a club message board post from members."
          : "Restored a club message board post to members.",
      });
      return NextResponse.json({
        status: parsed.data.hidden ? "hidden" : "visible",
      });
    }

    return NextResponse.json(
      { error: "No change was supplied." },
      { status: 400 },
    );
  } catch (error) {
    if (
      parsed.data.withdrawSharedCopy &&
      (error instanceof ClubPostWithdrawalFailedError || error instanceof ClubPostWithdrawalPausedError)
    ) {
      // A failed or half-successful withdrawal is audited too (#5246 review):
      // a copy may already be down, and the attempt itself is a moderation act.
      const { withdrawnServerPostIds, outstandingServerPostIds } = error.attempt;
      logAudit({
        action: "club_post.withdraw_shared_copy.failed",
        category: "communication",
        memberId: actorMemberId,
        entityType: "ClubPost",
        entityId: id,
        details:
          `Tried to withdraw a club message board post's copy from the central server; ` +
          (error instanceof ClubPostWithdrawalPausedError ? "sharing is paused by a version difference. " : "the server did not confirm. ") +
          `Withdrawn: ${withdrawnServerPostIds.join(", ") || "none"}. Still outstanding: ${outstandingServerPostIds.join(", ") || "none"}.`,
      });
    }
    const known = errorResponse(error);
    if (known) return known;
    logger.error({ err: error, postId: id }, "failed to moderate club post");
    return NextResponse.json(
      { error: "That change could not be saved." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guard();
  if (!gate.ok) return gate.response;

  const { id } = await params;

  try {
    await removeClubPost(id);
    logAudit({
      action: "club_post.remove",
      category: "communication",
      memberId: gate.session.user.id,
      entityType: "ClubPost",
      entityId: id,
      // Deliberately NOT carrying the removed text. A removal is usually
      // because the words should not be around; copying them into a row that
      // outlives the post would defeat the removal.
      details: "Removed a club message board post.",
    });
    return NextResponse.json({ status: "removed" });
  } catch (error) {
    const known = errorResponse(error);
    if (known) return known;
    logger.error({ err: error, postId: id }, "failed to remove club post");
    return NextResponse.json(
      { error: "That post could not be removed." },
      { status: 500 },
    );
  }
}
