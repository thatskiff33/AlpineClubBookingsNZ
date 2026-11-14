import { NextRequest, NextResponse } from "next/server";
import { isNotModified, opaqueEtag } from "@/lib/http-validators";
import { auth } from "@/lib/auth";
import { requireAdmin, requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import {
  detectImageContentType,
  extractImageDimensions,
  stripImageMetadata,
} from "@/lib/media-image";
import {
  MAX_MEMBER_PHOTO_BYTES,
  MAX_MEMBER_PHOTO_DIMENSION,
  MAX_MEMBER_PHOTO_REQUEST_BYTES,
  isAllowedMemberPhotoContentType,
} from "@/lib/member-photo";
import { readCappedMultipartFormData } from "@/lib/capped-multipart";

/**
 * Scoped member-photo serving + upload/remove endpoint (epic #171, MP2).
 *
 * Keyed by member id — never the public `/api/images/[id]` content path
 * (ADR-001, owner decision 3). Authorisation is enforced at the data layer:
 *
 * - GET is publicly (anonymously) servable **iff** the target member has a
 *   published, active `CommitteeAssignment` (their photo is committee-public)
 *   AND the club's `committeePhotoDisplay` setting is not `NONE`; otherwise only
 *   the owning member or a membership admin may fetch it — through the same
 *   shared session guards POST/DELETE use — and everyone else gets 404
 *   (preferred over 403 so the endpoint never confirms whether a private photo
 *   exists).
 * - POST/DELETE are gated to the owning member (self) or a membership-`edit`
 *   admin acting on their behalf. A plain member can only act on their own id
 *   (no IDOR).
 *
 * Resize is the client's job (MP3 crop UI). This route validates content-type
 * (JPEG/PNG/WebP only), enforces a byte cap and a dimension sanity backstop,
 * and strips EXIF/XMP/comment metadata (no re-encode — there is no server-side
 * image library) before storing so a straight-from-phone upload can't carry
 * GPS coordinates onto a publicly-served committee photo.
 */

// A member's photo is anonymously servable exactly when the member holds an
// active, published CommitteeAssignment to an active role (committee-membership)
// — per ADR-001, that assignment is what gates serving — AND the club has opted
// the public roster into photos (`committeePhotoDisplay != NONE`, checked in the
// handler below). Kept in lockstep with the /api/committee visibility predicate,
// which applies the same two conditions.
const PUBLIC_COMMITTEE_ASSIGNMENT_FILTER = {
  published: true,
  isActive: true,
  committeeRole: { isActive: true },
} as const;

function notFoundResponse() {
  // Prefer 404 over 403 so a private photo's existence is never confirmed.
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

function unauthorisedResponse() {
  return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
}

type MutationSession = Awaited<ReturnType<typeof auth>>;

/**
 * Resolve the acting session for a mutating request against member `targetId`.
 * The owning member acts on their own photo through the active-session guard;
 * anyone else must be a membership-`edit` admin acting on their behalf. The
 * caller passes the already-resolved `auth()` session so each HTTP method body
 * keeps its own visible session boundary (route-boundary test #812).
 */
async function resolveMutationActor(
  targetId: string,
  session: MutationSession,
): Promise<
  | { ok: true; actorId: string; onBehalf: boolean }
  | { ok: false; response: NextResponse }
> {
  const actorId = session?.user?.id;
  if (!actorId) {
    return { ok: false, response: unauthorisedResponse() };
  }

  if (actorId === targetId) {
    const inactive = await requireActiveSessionUser(actorId, {
      sessionUser: session?.user ?? null,
    });
    if (inactive) {
      return { ok: false, response: inactive };
    }
    return { ok: true, actorId, onBehalf: false };
  }

  // Acting on another member's photo requires membership-edit admin access.
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return { ok: false, response: guard.response };
  }
  return { ok: true, actorId: guard.session.user.id, onBehalf: true };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const member = await prisma.member.findUnique({
    where: { id },
    select: {
      active: true,
      photoImageId: true,
      photoUpdatedAt: true,
      committeeAssignments: {
        where: PUBLIC_COMMITTEE_ASSIGNMENT_FILTER,
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!member?.photoImageId) {
    return notFoundResponse();
  }

  // Lockstep with /api/committee: the member themselves must be active, not
  // merely holding a published assignment. A deactivated member with a stale
  // published assignment is absent from the committee page, so their photo
  // must not be publicly servable either.
  const isCommitteePublic =
    member.active && member.committeeAssignments.length > 0;

  // The club's roster-photo setting is the SECOND gate on anonymous serving.
  // `NONE` (the schema default) is presented to the operator as "Don't show
  // photos", so it has to stop the bytes being public — a takedown through that
  // control must be real, not cosmetic. Only read it when the assignment gate
  // already passed: a non-committee member never reaches the anonymous branch,
  // so the extra query stays off the private path.
  let servePublicly = isCommitteePublic;
  if (servePublicly) {
    const publicContentSettings = await prisma.publicContentSettings.findUnique({
      where: { id: "default" },
      select: { committeePhotoDisplay: true },
    });
    servePublicly =
      (publicContentSettings?.committeePhotoDisplay ?? "NONE") !== "NONE";
  }

  if (!servePublicly) {
    // Not anonymously servable: only the owning member or a membership
    // viewer/admin, resolved through the SAME shared session guards POST and
    // DELETE use (see `resolveMutationActor` above), so this GET can never skip
    // the forcePasswordChange and two-factor gates those guards enforce. A guard
    // refusal is mapped onto the route's 404 rather than surfaced as its own
    // 401/403 — the endpoint must never confirm whether a private photo exists
    // (that 404-not-403 choice is what defeats member enumeration).
    const session = await auth();
    const viewerId = session?.user?.id ?? null;
    let allowed = false;

    if (viewerId && viewerId === id) {
      const blocked = await requireActiveSessionUser(viewerId, {
        sessionUser: session?.user ?? null,
      });
      allowed = blocked === null;
    } else if (viewerId) {
      const guard = await requireAdmin({
        permission: { area: "membership", level: "view" },
      });
      allowed = guard.ok;
    }

    if (!allowed) {
      return notFoundResponse();
    }
  }

  const image = await prisma.mediaImage.findUnique({
    where: { id: member.photoImageId },
    select: { data: true, contentType: true, kind: true },
  });

  if (!image) {
    return notFoundResponse();
  }

  // Defence in depth: only ever serve a MEMBER_PHOTO blob through this
  // committee-cacheable path. If a future bug mispoints `photoImageId` at a
  // CONTENT image, fail closed (404) rather than leak arbitrary library content
  // via the member-photo endpoint.
  if (image.kind !== "MEMBER_PHOTO") {
    return notFoundResponse();
  }

  // Hardening headers mirror the public content route: member photos are
  // JPEG/PNG/WebP only (never SVG), but nosniff + a locked-down CSP keep a
  // response opened directly as a document from doing anything.
  const baseHeaders: Record<string, string> = {
    "Content-Type": image.contentType,
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  };

  if (servePublicly) {
    // Committee-public: safe to cache in shared/browser caches, but only
    // briefly — committee membership (and therefore public visibility) can be
    // revoked while the stored bytes stay the same, so a long-lived
    // `immutable` cache would leak the photo past un-publication. A short
    // max-age plus a content-derived ETag bounds that window and still allows
    // 304 revalidation. The ETag is an opaque digest — never the raw
    // `photoImageId` — so the internal MediaImage id is not disclosed to
    // anonymous clients (defence in depth alongside the /api/images kind gate).
    const etag = opaqueEtag(
      `${member.photoImageId}:${member.photoUpdatedAt?.toISOString() ?? ""}`,
    );
    const headers = {
      ...baseHeaders,
      "Cache-Control": "public, max-age=300, must-revalidate",
      ETag: etag,
    };
    if (isNotModified(request.headers, { etag })) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(image.data, { status: 200, headers });
  }

  // Not anonymously servable (a private photo, or a committee photo whose
  // roster display is off): never store in any cache, shared or private, so a
  // photo fetched by an authorised viewer can't be replayed to an unauthorised
  // one.
  return new Response(image.data, {
    status: 200,
    headers: {
      ...baseHeaders,
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const session = await auth();
  const actor = await resolveMutationActor(id, session);
  if (!actor.ok) return actor.response;

  // The target member must exist (and, for admins, be a real subject).
  const target = await prisma.member.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!target) {
    return notFoundResponse();
  }

  // Stream the multipart body through a capped reader: an oversize (chunked or
  // spoofed-Content-Length) body is cut off mid-stream instead of being fully
  // buffered by request.formData(). The reader folds in the honest
  // Content-Length fast-fail and enforces the per-file 2MB cap.
  const multipart = await readCappedMultipartFormData(request, {
    maxRequestBytes: MAX_MEMBER_PHOTO_REQUEST_BYTES,
    maxFileBytes: MAX_MEMBER_PHOTO_BYTES,
    maxFiles: 1,
  });
  if (!multipart.ok) {
    return multipart.reason === "too_large"
      ? NextResponse.json(
          { error: "Photo exceeds the 2MB upload limit" },
          { status: 413 },
        )
      : NextResponse.json(
          { error: "Invalid multipart/form-data body" },
          { status: 400 },
        );
  }
  const formData = multipart.formData;

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "A file field containing the photo is required" },
      { status: 400 },
    );
  }

  if (file.size > MAX_MEMBER_PHOTO_BYTES) {
    return NextResponse.json(
      { error: "Photo exceeds the 2MB upload limit" },
      { status: 413 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  if (bytes.length > MAX_MEMBER_PHOTO_BYTES) {
    return NextResponse.json(
      { error: "Photo exceeds the 2MB upload limit" },
      { status: 413 },
    );
  }

  // Trust the bytes, not the declared Content-Type or filename extension.
  const detected = detectImageContentType(bytes);
  if (!detected || !isAllowedMemberPhotoContentType(detected)) {
    return NextResponse.json(
      {
        error:
          "Unsupported or invalid image. Allowed photo types: JPEG, PNG, WebP.",
      },
      { status: 400 },
    );
  }

  // Dimension sanity is best effort (no image library by design): a null
  // reading is accepted and only a parsed dimension beyond the backstop is
  // rejected as absurd. JPEG/PNG/GIF/WebP dimensions are parsed from the header,
  // so an oversized-canvas WebP (a decode-bomb) is now caught here too.
  const dimensions = extractImageDimensions(bytes, detected);
  if (
    dimensions &&
    (dimensions.width > MAX_MEMBER_PHOTO_DIMENSION ||
      dimensions.height > MAX_MEMBER_PHOTO_DIMENSION ||
      dimensions.width <= 0 ||
      dimensions.height <= 0)
  ) {
    return NextResponse.json(
      { error: "Photo dimensions are outside the accepted range" },
      { status: 400 },
    );
  }

  // Strip EXIF/XMP/comment metadata (camera GPS coordinates live in JPEG APP1)
  // before storing: a committee member's photo is served to anonymous callers,
  // so location data in a straight-from-phone upload must not travel with it.
  // The crop UI already re-encodes via canvas (clean JPEG/PNG/WebP with a proper
  // EOI/IEND terminator), so legitimate uploads pass; this also covers the
  // direct-upload path. Fail-CLOSED for privacy: if the parser cannot positively
  // confirm a clean strip (malformed/nonstandard structure — e.g. a renderable
  // JPEG missing its trailing EOI that would otherwise sail past the byte
  // sniffer with EXIF/GPS intact), reject the upload BEFORE the transaction
  // rather than store bytes we could not prove were scrubbed.
  const stripped = stripImageMetadata(bytes, detected);
  if (!stripped.ok) {
    return NextResponse.json(
      {
        error:
          "Unsupported or invalid image. Allowed photo types: JPEG, PNG, WebP.",
      },
      { status: 400 },
    );
  }
  const storedBytes = stripped.bytes;

  const now = new Date();

  // Create the new blob, repoint the member, then delete the old blob — all in
  // one transaction so a replaced photo never leaks an orphaned MEMBER_PHOTO
  // row (consistent with MP1's cleanup ethos). No external calls inside the
  // transaction.
  const result = await prisma.$transaction(async (tx) => {
    // Lock the member row and read its CURRENT pointer under that lock, so two
    // concurrent replace/remove requests serialise instead of both deleting the
    // same stale blob and orphaning the other's new one. The pre-transaction
    // read is only used for the existence/authorisation gate above.
    //
    // Lock raw, read typed (#2289): the raw statement takes the lock and nothing
    // else — it selects a constant and its result is never inspected — and the
    // pointer comes back through the Prisma model, which owns the column
    // mapping. A `$queryRaw<{ photoImageId }>` here would be an unchecked cast,
    // and this one decides which image blob gets DELETED.
    await tx.$executeRaw`SELECT 1 FROM "Member" WHERE "id" = ${id} FOR UPDATE`;
    const locked = await tx.member.findUnique({
      where: { id },
      select: { photoImageId: true },
    });
    if (!locked) {
      // Member was deleted between the pre-check and the lock.
      return null;
    }
    const currentImageId = locked.photoImageId;

    const created = await tx.mediaImage.create({
      data: {
        filename: "member-photo",
        contentType: detected,
        byteSize: storedBytes.length,
        data: new Uint8Array(storedBytes),
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        uploadedByMemberId: actor.actorId,
        kind: "MEMBER_PHOTO",
      },
      select: { id: true, contentType: true, byteSize: true },
    });

    await tx.member.update({
      where: { id },
      data: {
        photoImageId: created.id,
        photoUpdatedAt: now,
        photoUpdatedByMemberId: actor.actorId,
      },
    });

    if (currentImageId && currentImageId !== created.id) {
      // Scope the delete to MEMBER_PHOTO so a mispointed FK can never take out
      // a CONTENT image.
      await tx.mediaImage.deleteMany({
        where: { id: currentImageId, kind: "MEMBER_PHOTO" },
      });
    }

    return { created, previousImageId: currentImageId };
  });

  if (!result) {
    return notFoundResponse();
  }
  const image = result.created;
  const previousImageId = result.previousImageId;

  logAudit({
    action: "member_photo.upload",
    actorMemberId: actor.actorId,
    subjectMemberId: id,
    memberId: actor.actorId,
    targetId: id,
    entityType: "Member",
    entityId: id,
    // `account` unconditionally (#2581). This used to be
    // `actor.onBehalf ? "admin" : "account"` - the same action on the same record
    // filed under two different categories depending on WHO acted, which is the
    // platform's clearest violation of the rule that category follows the
    // affected business DOMAIN. A member's own photo is account-domain work
    // whether the member changed it or an administrator did it for them.
    //
    // TWO consequences to name, both only for the on-behalf branch. An
    // administrator's photo change is no longer readable through the support-only
    // system correlation entry: it needs `membership:view` now, exactly as the
    // member's own change always did. And because `account` is member-visible
    // while `admin` is not, the member now sees an administrator's change to their
    // photo in their own profile timeline — which is the transparent answer, and
    // the same row they already saw when they made the change themselves. Admin >
    // Audit Log still shows both to anyone holding `support`.
    category: "account",
    outcome: "success",
    summary: actor.onBehalf
      ? "Uploaded a member photo on behalf of a member"
      : "Uploaded own member photo",
    metadata: {
      imageId: image.id,
      contentType: image.contentType,
      byteSize: image.byteSize,
      onBehalf: actor.onBehalf,
      replacedImageId: previousImageId ?? null,
    },
  });

  return NextResponse.json(
    { photoUrl: `/api/members/${id}/photo`, updatedAt: now.toISOString() },
    { status: 201 },
  );
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const session = await auth();
  const actor = await resolveMutationActor(id, session);
  if (!actor.ok) return actor.response;

  const target = await prisma.member.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!target) {
    return notFoundResponse();
  }

  const now = new Date();

  // Clear the pointer (with audit columns) and delete the blob in one
  // transaction. Idempotent: removing when there is no photo simply stamps the
  // audit columns and returns success.
  const removeResult = await prisma.$transaction(async (tx) => {
    // Lock the member row and read the current pointer under the lock so a
    // concurrent upload can't leave the blob we intended to delete orphaned
    // (or delete a blob a concurrent upload has just re-pointed to).
    // Lock raw, read typed (#2289) — see the POST handler above.
    await tx.$executeRaw`SELECT 1 FROM "Member" WHERE "id" = ${id} FOR UPDATE`;
    const locked = await tx.member.findUnique({
      where: { id },
      select: { photoImageId: true },
    });
    if (!locked) {
      return null;
    }
    const currentImageId = locked.photoImageId;

    await tx.member.update({
      where: { id },
      data: {
        photoImageId: null,
        photoUpdatedAt: now,
        photoUpdatedByMemberId: actor.actorId,
      },
    });

    if (currentImageId) {
      await tx.mediaImage.deleteMany({
        where: { id: currentImageId, kind: "MEMBER_PHOTO" },
      });
    }

    return { previousImageId: currentImageId };
  });

  if (!removeResult) {
    return notFoundResponse();
  }
  const previousImageId = removeResult.previousImageId;

  logAudit({
    action: "member_photo.remove",
    actorMemberId: actor.actorId,
    subjectMemberId: id,
    memberId: actor.actorId,
    targetId: id,
    entityType: "Member",
    entityId: id,
    // `account` unconditionally (#2581) - see the note on the upload writer
    // above; this site carried the same actor-based conditional.
    category: "account",
    outcome: "success",
    summary: actor.onBehalf
      ? "Removed a member photo on behalf of a member"
      : "Removed own member photo",
    metadata: {
      removedImageId: previousImageId ?? null,
      onBehalf: actor.onBehalf,
    },
  });

  return NextResponse.json({ success: true });
}
