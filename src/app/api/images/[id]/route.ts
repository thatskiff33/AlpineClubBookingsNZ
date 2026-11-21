import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * Public image serving route for the database-backed image library (#731).
 *
 * SVG hardening: SVGs are allowed (not excluded), so this route serves all
 * images with `Content-Disposition: inline`, a strict
 * `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`,
 * and `X-Content-Type-Options: nosniff`. This neutralises script execution
 * and MIME-confusion if an SVG response is opened directly as a document:
 * `default-src 'none'` blocks scripts and every outside fetch, and `sandbox`
 * gives the document a unique opaque origin, so even markup that slipped past
 * the upload-time SVG rebuild (`@/lib/image-metadata-svg`, #5244) can neither
 * run nor reach this site's cookies or storage.
 *
 * The image id is immutable content (uploads create a new id; nothing
 * mutates an existing row's bytes), so a strong ETag derived from the id
 * plus a long-lived immutable Cache-Control is safe.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const image = await prisma.mediaImage.findUnique({
    where: { id },
    select: { data: true, contentType: true, kind: true },
  });

  // Only CONTENT and LOGO images are addressable through this public,
  // unauthenticated, immutably-cached path. Both are public branding/content by
  // definition (#2322: the club logo renders on every public page). MEMBER_PHOTO
  // blobs live in the same table but are a private data class served exclusively
  // through the scoped, authorised `/api/members/[id]/photo` endpoint (ADR-001
  // decision 3). Returning the same 404 as a missing row keeps a member photo's
  // existence non-disclosable here.
  if (!image || (image.kind !== "CONTENT" && image.kind !== "LOGO")) {
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }

  const etag = `"${id}"`;
  const headers = {
    "Content-Type": image.contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(image.data, { status: 200, headers });
}
