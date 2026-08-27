import { NextRequest, NextResponse } from "next/server";

import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { readPostImage } from "@/lib/post-image-storage";
import { prisma } from "@/lib/prisma";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * Serve one message board image (epic #2992).
 *
 * THIS ROUTE IS THE ONLY WAY TO REACH THESE FILES, which is why they are stored
 * outside the application directory rather than under `public/`. Everything
 * under `public/` is served by the web server with no session check; the board
 * is members-only, so its images have to be too.
 *
 * Addressed by `publicId` — 128 bits of randomness independent of the row id —
 * so holding one image's URL never lets anyone derive another's.
 */

export const runtime = "nodejs";

const NOT_FOUND = () =>
  NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ publicId: string }> },
) {
  const modules = await loadEffectiveModuleFlags();
  if (modules.commsPortal !== true) return NOT_FOUND();

  const gate = await requireActiveSession();
  if (!gate.ok) return gate.response;

  const { publicId } = await params;
  if (!publicId || !/^[0-9a-f]{32}$/.test(publicId)) return NOT_FOUND();

  const image = await prisma.clubPostImage.findUnique({
    where: { publicId },
    select: {
      storageKey: true,
      mimeType: true,
      post: { select: { hiddenAt: true, removedAt: true } },
    },
  });
  if (!image) return NOT_FOUND();

  // An image on a hidden or removed post stops being served with it. Without
  // this, moderation would take the words down and leave the photograph
  // reachable by anyone who had already loaded the page — which for the kind
  // of post that gets removed is usually the part that mattered.
  //
  // A null `post` is an upload not yet claimed by a post; its own uploader may
  // still be composing, so it is served rather than withheld.
  if (image.post && (image.post.hiddenAt || image.post.removedAt)) {
    return NOT_FOUND();
  }

  const bytes = await readPostImage(image.storageKey);
  if (!bytes) return NOT_FOUND();

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": image.mimeType,
      "Content-Length": String(bytes.byteLength),
      // PRIVATE, not public: a shared cache must never hold a members-only
      // image where the next request could be served it without a session.
      // Immutable is safe because the address is content-bound — an edited
      // image is a new upload with a new publicId, never the same one changed.
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": "inline",
      // Belt and braces on top of the WebP re-encode: even if something ever
      // stored a file whose bytes disagreed with its recorded type, the
      // browser must not sniff its way to executing it.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
