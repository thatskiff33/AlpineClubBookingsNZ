import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { ClubPostValidationError } from "@/lib/club-posts";
import {
  ClubPostAlreadyRemovedError,
  ClubPostNotEditableError,
  ClubPostNotFoundError,
  editClubPostContent,
  removeClubPost,
  setClubPostHidden,
} from "@/lib/club-posts-admin";
import logger from "@/lib/logger";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { requireAdmin } from "@/lib/session-guards";

/**
 * PATCH /api/admin/club-posts/:id — hide, unhide, or rewrite a post.
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
  return null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guard();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "That change could not be read." },
      { status: 400 },
    );
  }

  const actorMemberId = gate.session.user.id;

  try {
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
