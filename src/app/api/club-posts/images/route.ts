import { NextRequest, NextResponse } from "next/server";

import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  ensurePostImageDirectory,
  MAX_POST_IMAGE_BYTES,
  MAX_POST_IMAGES,
  PostImageRejectedError,
  writePostImage,
} from "@/lib/post-image-storage";
import { prisma } from "@/lib/prisma";
import { applyMemberScopedRateLimit, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * Upload one image for a message board post (epic #2992).
 *
 * Returns the `publicId` the composer embeds in the post body. The row is
 * written with `postId` null — the image exists before the post does, because
 * the member picks it while still typing — and is claimed by the post when they
 * submit. An image nobody claims is swept by the retention job.
 *
 * NOTHING HERE TRUSTS THE CLIENT ABOUT THE FILE. The name, the declared
 * content type and the declared size are all chosen by whoever is calling, so
 * the size is measured from the bytes actually read and the type is sniffed
 * from those bytes; `writePostImage` then re-encodes, which is what strips the
 * GPS coordinates out of a phone photograph.
 */

export const runtime = "nodejs";

const MODULE_OFF = () =>
  NextResponse.json({ error: "Not found" }, { status: 404 });

export async function POST(request: NextRequest) {
  // Re-checked here as well as in middleware, for the reason the sibling route
  // records: a module gate that lived only in middleware shipped bypassed once.
  const modules = await loadEffectiveModuleFlags();
  if (modules.commsPortal !== true) return MODULE_OFF();

  const gate = await requireActiveSession();
  if (!gate.ok) return gate.response;
  const memberId = gate.session.user.id;

  const limited = await applyMemberScopedRateLimit(
    rateLimiters.clubPostImageUpload,
    request,
    memberId,
  );
  if (limited) return limited;

  let file: File | null = null;
  try {
    const form = await request.formData();
    const candidate = form.get("file");
    if (candidate instanceof File) file = candidate;
  } catch {
    return NextResponse.json(
      { error: "That upload could not be read." },
      { status: 400 },
    );
  }
  if (!file) {
    return NextResponse.json({ error: "Choose an image." }, { status: 400 });
  }

  // Checked against the DECLARED size first, so an oversized upload is refused
  // before its bytes are pulled into memory. The real check is below, on what
  // was actually read: `File.size` is as client-controlled as anything else.
  if (file.size > MAX_POST_IMAGE_BYTES) {
    return NextResponse.json(
      {
        error: `Images must be ${Math.floor(
          MAX_POST_IMAGE_BYTES / (1024 * 1024),
        )} MB or smaller.`,
      },
      { status: 413 },
    );
  }

  // ENFORCED here, not just advertised (#3091 review 3): the response's
  // `maxImagesPerPost` was advisory data the client could ignore, and the
  // create path used to truncate the claim list silently — leaving images 7+
  // unclaimed, served after moderation removed the post, and swept out from
  // under a live one. A member's UNCLAIMED uploads are the pool a new post
  // can draw on, so the cap applies there; claimed images belong to posts
  // already validated, and abandoned uploads age out via the orphan sweep.
  const unclaimed = await prisma.clubPostImage.count({
    where: { uploadedByMemberId: memberId, postId: null },
  });
  if (unclaimed >= MAX_POST_IMAGES) {
    return NextResponse.json(
      {
        error: `A post can carry at most ${MAX_POST_IMAGES} images — that many are already waiting. Post them, or remove some from the draft, before adding more.`,
      },
      { status: 400 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    // Probes the mount with a real write before doing any work. A bind-mounted
    // host directory owned by root passes every permission-bit check and still
    // fails the write, and the raw EACCES that produces names nothing an
    // operator can act on — this turns it into an error that names the mount.
    await ensurePostImageDirectory();

    const stored = await writePostImage(bytes);

    const image = await prisma.clubPostImage.create({
      data: {
        postId: null,
        storageKey: stored.storageKey,
        publicId: stored.publicId,
        mimeType: stored.mimeType,
        sha256: stored.sha256,
        width: stored.width,
        height: stored.height,
        bytes: stored.bytes,
        uploadedByMemberId: memberId,
      },
      select: { publicId: true, width: true, height: true },
    });

    logAudit({
      action: "club_post_image.upload",
      category: "communication",
      memberId,
      entityType: "ClubPostImage",
      entityId: image.publicId,
      // Size only. An audit row is not a place to restate what a member
      // photographed.
      details: `Uploaded a ${stored.bytes}-byte image for the club message board.`,
    });

    return NextResponse.json(
      {
        publicId: image.publicId,
        url: `/api/club-posts/images/${image.publicId}`,
        width: image.width,
        height: image.height,
        maxImagesPerPost: MAX_POST_IMAGES,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof PostImageRejectedError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logger.error({ err: error, memberId }, "Club post image upload failed");
    return NextResponse.json(
      { error: "That image could not be stored." },
      { status: 500 },
    );
  }
}
