import "server-only";

import { sanitiseClubPostHtml } from "@/lib/club-post-html";
import logger from "@/lib/logger";
import { writePostImage } from "@/lib/post-image-storage";
import { fetchSharedPostImage, type SyncPost } from "@/lib/servernz-api";

/**
 * The mirror's pictures and body (epic #2992), split out of
 * `club-post-mirror.ts` (#4588) so that module keeps to the row decisions and
 * their locks. Nothing here touches the database: it downloads and stores a
 * post's images and builds the body that names them, before any transaction.
 */

/** Images fetched per mirrored post. Matches the local per-post cap. */
const MAX_MIRROR_IMAGES = 6;

/** One stored image, as the mirror's nested create writes it. */
export interface MirrorStoredImage {
  publicId: string;
  storageKey: string;
  mimeType: string;
  sha256: string;
  width: number | null;
  height: number | null;
  bytes: number;
  position: number;
}

/**
 * A mirrored body with its local image ids blanked, so two renderings of the
 * same server post — whose images were stored under different local ids on
 * different passes — compare equal when, and only when, the words and the
 * pictures are the same. The pictures themselves are compared by SHA-256.
 */
export function bodyShape(bodyHtml: string | null): string | null {
  return (
    bodyHtml?.replace(
      /\/api\/club-posts\/images\/[0-9a-f]{32}/g,
      "/api/club-posts/images/#",
    ) ?? null
  );
}

/**
 * Rewrite a mirrored body's image URLs onto the LOCAL copies just stored.
 *
 * The body arrives naming the central server's own image routes. After this,
 * every surviving image points at this install's session-checked serving
 * route; anything unmapped is left as-is for the sanitiser to drop, because a
 * missing picture beats one that leaks each reader to a remote host.
 */
function rewriteMirrorImageSources(
  html: string,
  mapping: Map<string, string>,
): string {
  return html.replace(
    /\/api\/images\/posts\/([0-9a-f]{32})(?:\.webp)?/g,
    (whole, serverId: string) => {
      const localId = mapping.get(serverId);
      return localId ? `/api/club-posts/images/${localId}` : whole;
    },
  );
}

/** The server-side image id inside one of its image URLs, or null. */
function serverImageId(url: string): string | null {
  const match = url.match(/\/api\/images\/posts\/([0-9a-f]{32})(?:\.webp)?/);
  // The capture group has no `?` quantifier, so a match always carries it.
  return match?.[1] ?? null;
}

/**
 * Download and store a post's images, then build its local body.
 *
 * Images are DOWNLOADED AND STORED LOCALLY rather than hotlinked, for three
 * reasons that all matter: the central server's image URLs are capability URLs
 * that should not be broadcast into every member's browser history; a reader
 * of this club's board should not have their IP disclosed to the central
 * server on every render; and the board must keep working when the central
 * server is down — which is the whole reason mirrors exist. The caller owns
 * the stored files from here: a write that never names them deletes them.
 */
export async function prepareMirrorBody(
  post: SyncPost,
): Promise<{ storedImages: MirrorStoredImage[]; bodyHtml: string | null }> {
  // Download this post's images and build the URL mapping. Bounded, and a
  // failed image never fails the post — the words still arrive.
  const mapping = new Map<string, string>();
  const storedImages: MirrorStoredImage[] = [];

  for (const [index, image] of post.images.slice(0, MAX_MIRROR_IMAGES).entries()) {
    const remoteId = serverImageId(image.url);
    if (!remoteId) continue;
    const bytes = await fetchSharedPostImage(image.url);
    if (!bytes) {
      logger.warn(
        { serverPostId: post.id, image: remoteId },
        "Mirrored post image could not be fetched; mirroring without it",
      );
      continue;
    }
    try {
      // Through the SAME pipeline as a member upload — sniffed, re-encoded,
      // EXIF-stripped — because a mirrored image is still remote input, however
      // trusted the server is.
      const stored = await writePostImage(bytes);
      mapping.set(remoteId, stored.publicId);
      storedImages.push({ ...stored, position: index });
    } catch (error) {
      logger.warn(
        { serverPostId: post.id, image: remoteId, err: error },
        "Mirrored post image could not be stored; mirroring without it",
      );
    }
  }

  // Sanitised AGAIN on this side of the wire, after the rewrite so surviving
  // images point locally. The server sanitises too, but this install renders
  // the result to its own members and does not outsource that decision.
  let bodyHtml = post.bodyHtml
    ? sanitiseClubPostHtml(rewriteMirrorImageSources(post.bodyHtml, mapping)) ||
      null
    : null;

  // A post can arrive with pictures but no rich body -- the server's own seed
  // data, or a client that attached images to a plain post. The board renders
  // pictures only through the body, so such a post gets a minimal one;
  // without it the images are downloaded, stored, counted and never seen.
  // Sanitised like any other body, so the write-side invariant holds.
  if (!bodyHtml && storedImages.length > 0) {
    bodyHtml =
      sanitiseClubPostHtml(
        storedImages
          .map(
            (image) =>
              '<img src="/api/club-posts/images/' + image.publicId + '" alt="" />',
          )
          .join(""),
      ) || null;
  }

  // The SANITISED length is what the column stores, and sanitisation GROWS a
  // body (every anchor gains target/rel attributes), so a wire body inside
  // the 20,000 cap can come out over it — and an over-long value fails the
  // insert AFTER rows are written and BEFORE the cursor advances (#3091
  // review 2a; the serverPostId schema comment records the identical trap).
  // Formatting is decoration; the words are the post. Degrade to plain text
  // rather than wedge the sync.
  if (bodyHtml && bodyHtml.length > 20_000) {
    logger.warn(
      { serverPostId: post.id, length: bodyHtml.length },
      "Mirrored post body exceeds the column cap after sanitising; mirroring as plain text",
    );
    bodyHtml = null;
  }

  return { storedImages, bodyHtml };
}
