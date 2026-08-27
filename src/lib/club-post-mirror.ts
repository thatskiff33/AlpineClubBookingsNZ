import "server-only";

import { sanitiseClubPostHtml } from "@/lib/club-post-html";
import logger from "@/lib/logger";
import { deletePostImage, writePostImage } from "@/lib/post-image-storage";
import { prisma } from "@/lib/prisma";
import {
  fetchSharedPostImage,
  pullSharedPostSync,
  registerPushTarget,
  type SyncPost,
} from "@/lib/servernz-api";
import { getServerNzSetupState } from "@/lib/servernz-config";
import {
  getIntegrationCredentialValue,
  setIntegrationCredential,
} from "@/lib/integration-credentials";

/**
 * Mirroring shared posts from the central server (epic #2992).
 *
 * The mirror is a CACHE OF SOMEONE ELSE'S BOARD, and every decision below
 * follows from that. Content is upserted, never edited here; a tombstone
 * deletes the mirror row outright rather than soft-hiding it, because there is
 * nothing local worth keeping — the authoritative copy lives with the club
 * that wrote it. Our OWN posts coming back around the loop are recognised by
 * `serverPostId` and skipped: this install is authoritative for those.
 *
 * DRIVEN TWO WAYS, ONE WRITER. The push webhook and the polling cron both end
 * up here, and the single-flight claim on `commsSyncStartedAt` is what stops a
 * push arriving mid-poll from running two ingest passes over the same cursor.
 */

/** Provider key the push-verification secret is stored under, beside the API key. */
export const SERVERNZ_PUSH_SECRET_KEY = "push_secret";
const SERVERNZ_PROVIDER = "servernz";

/** A claim older than this belongs to a process that died mid-pass. */
export const STALE_SYNC_CLAIM_MS = 10 * 60 * 1000;

/** Pages per pass, so one pass cannot run unbounded against a huge backlog. */
const MAX_PAGES_PER_PASS = 10;

/** Images fetched per mirrored post. Matches the local per-post cap. */
const MAX_MIRROR_IMAGES = 6;

export interface MirrorSyncResult {
  skipped?: "not-configured" | "busy";
  upserted: number;
  removed: number;
  pages: number;
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
  return match ? match[1] : null;
}

/**
 * Upsert one mirrored post, images included.
 *
 * Images are DOWNLOADED AND STORED LOCALLY rather than hotlinked, for three
 * reasons that all matter: the central server's image URLs are capability URLs
 * that should not be broadcast into every member's browser history; a reader
 * of this club's board should not have their IP disclosed to the central
 * server on every render; and the board must keep working when the central
 * server is down — which is the whole reason mirrors exist.
 */
async function upsertMirror(post: SyncPost): Promise<void> {
  const existing = await prisma.clubPost.findUnique({
    where: { serverPostId: post.id },
    select: {
      id: true,
      originClubCode: true,
      images: { select: { publicId: true, storageKey: true, sha256: true } },
    },
  });

  // Our own post coming back around the loop. This install is authoritative
  // for it; the server's copy is derived, so nothing here may overwrite it.
  if (existing && existing.originClubCode === null) return;

  // Download this post's images and build the URL mapping. Bounded, and a
  // failed image never fails the post — the words still arrive.
  const mapping = new Map<string, string>();
  const storedImages: {
    publicId: string;
    storageKey: string;
    mimeType: string;
    sha256: string;
    width: number | null;
    height: number | null;
    bytes: number;
    position: number;
  }[] = [];

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

  const content = post.content.slice(0, 4000);
  const postedAt = new Date(post.createdAt);
  // The wire schema only requires a non-empty string (#3091 review 2b), and
  // Prisma throws on an Invalid Date — which would be a poison change. A post
  // with an unreadable timestamp is not worth wedging the sync over: skip it,
  // loudly. It re-arrives whenever the server fixes its serialisation.
  if (!Number.isFinite(postedAt.getTime())) {
    logger.error(
      { serverPostId: post.id, createdAt: post.createdAt },
      "Mirrored post carries an unreadable createdAt; skipping it",
    );
    return;
  }

  if (existing) {
    // Replace images wholesale: the server's list is authoritative for a
    // mirror, and diffing it against local rows buys nothing but edge cases.
    // Rows first, then files — the failure order that leaves orphaned files
    // (invisible, swept later) rather than broken images (visible forever).
    await prisma.$transaction([
      prisma.clubPostImage.deleteMany({ where: { postId: existing.id } }),
      prisma.clubPost.update({
        where: { id: existing.id },
        data: {
          content,
          bodyHtml,
          originClubName: post.club.name,
          images: { create: storedImages },
        },
      }),
    ]);
    for (const old of existing.images) {
      await deletePostImage(old.storageKey);
    }
    return;
  }

  await prisma.clubPost.create({
    data: {
      serverPostId: post.id,
      originClubCode: post.club.code,
      originClubName: post.club.name,
      // No local member wrote this, so there is nobody to link. The display
      // name is club-attested by the origin club, exactly as the server holds
      // it.
      authorMemberId: null,
      authorName: post.authorName,
      content,
      bodyHtml,
      postedAt,
      images: { create: storedImages },
    },
  });
}

/** Apply one tombstone. */
async function applyRemoval(serverPostId: string): Promise<boolean> {
  const existing = await prisma.clubPost.findUnique({
    where: { serverPostId },
    select: {
      id: true,
      originClubCode: true,
      hiddenAt: true,
      images: { select: { storageKey: true } },
    },
  });
  if (!existing) return false;

  if (existing.originClubCode === null) {
    // OUR OWN post, taken down on the network side — a central-server admin
    // removed it, or enough reports hid it. The network copy is gone either
    // way, so this install's row stops claiming to be shared; and the local
    // copy is HIDDEN, not deleted, because the words belong to this club's own
    // member and takedown convergence is a moderation action, not an erasure.
    // A club admin can unhide it, at which point it is a local-only post.
    await prisma.clubPost.update({
      where: { id: existing.id },
      data: {
        sharedAt: null,
        serverPostId: null,
        shareRequestedAt: null,
        hiddenAt: existing.hiddenAt ?? new Date(),
      },
    });
    return true;
  }

  // A mirror is a cache: the authoritative copy lives with the club that wrote
  // it, so there is nothing worth keeping and the row is deleted outright.
  // Rows first, files second, as everywhere else.
  await prisma.clubPost.delete({ where: { id: existing.id } });
  for (const image of existing.images) {
    await deletePostImage(image.storageKey);
  }
  return true;
}

/**
 * Make sure the central server knows where to push for this install.
 *
 * Idempotent and cheap to call from the sync pass: it does nothing when a
 * secret is already stored. The callback URL is derived from NEXTAUTH_URL —
 * the address this install already knows itself by — so there is no second
 * base-URL setting to drift.
 */
export async function ensurePushRegistration(): Promise<void> {
  const existing = await getIntegrationCredentialValue(
    SERVERNZ_PROVIDER,
    SERVERNZ_PUSH_SECRET_KEY,
  );
  if (existing) return;

  const base = process.env.NEXTAUTH_URL?.trim();
  // Push needs a URL the central server can reach over https; a localhost dev
  // install simply stays poll-only, which loses nothing but latency.
  if (!base || !base.startsWith("https://")) return;

  const callback = new URL("/api/webhooks/servernz-posts", base).toString();
  try {
    const result = await registerPushTarget(callback);
    await setIntegrationCredential({
      provider: SERVERNZ_PROVIDER,
      key: SERVERNZ_PUSH_SECRET_KEY,
      value: result.secret,
    });
    logger.info(
      { callback, secretVersion: result.secretVersion },
      "Registered this install for shared-post pushes",
    );
  } catch (error) {
    // Poll-only is a working state, so registration failing must not fail the
    // sync pass that attempted it.
    logger.warn({ err: error }, "Could not register the shared-post push target");
  }
}

/**
 * Pull the mirror up to date. The one writer both the webhook and the cron use.
 */
export async function runMirrorSync(
  now: Date = new Date(),
): Promise<MirrorSyncResult> {
  const setup = await getServerNzSetupState();
  if (!setup.apiKeySet) {
    return { skipped: "not-configured", upserted: 0, removed: 0, pages: 0 };
  }

  // The single-flight claim, same pattern as every other sync in this repo: a
  // conditional updateMany whose matched-row count IS the claim. An upsert
  // first so the row exists on an install that has never saved settings.
  await prisma.serverNzSettings.upsert({
    where: { id: "default" },
    create: { id: "default" },
    update: {},
  });
  const staleBefore = new Date(now.getTime() - STALE_SYNC_CLAIM_MS);
  const claim = await prisma.serverNzSettings.updateMany({
    where: {
      id: "default",
      OR: [
        { commsSyncStartedAt: null },
        { commsSyncStartedAt: { lt: staleBefore } },
      ],
    },
    data: { commsSyncStartedAt: now },
  });
  if (claim.count === 0) {
    return { skipped: "busy", upserted: 0, removed: 0, pages: 0 };
  }

  const result: MirrorSyncResult = { upserted: 0, removed: 0, pages: 0 };
  try {
    await ensurePushRegistration();

    let cursor = await prisma.serverNzSettings.findUnique({
      where: { id: "default" },
      select: {
        commsCursorSince: true,
        commsCursorSinceId: true,
        commsPoisonChangeId: true,
        commsPoisonCount: true,
      },
    });
    let poisonId = cursor?.commsPoisonChangeId ?? null;
    let poisonCount = cursor?.commsPoisonCount ?? 0;

    for (let page = 0; page < MAX_PAGES_PER_PASS; page++) {
      const envelope = await pullSharedPostSync({
        since: cursor?.commsCursorSince,
        sinceId: cursor?.commsCursorSinceId,
      });
      result.pages += 1;

      for (const change of envelope.changes) {
        const changeKey = change.state === "visible" ? change.post.id : change.id;
        try {
          if (change.state === "visible") {
            await upsertMirror(change.post);
            result.upserted += 1;
          } else {
            if (await applyRemoval(change.id)) result.removed += 1;
          }
        } catch (error) {
          // PER-CHANGE ISOLATION (#3091 review 2). A throw here used to
          // escape the page loop before the cursor advanced, so the next
          // pass pulled the same page, hit the same change, and threw again
          // — not "converges on replay" but permanently stuck, and quietly,
          // because the cron runner records the failure and carries on.
          //
          // Consecutive failures of the SAME change are counted on the
          // cursor row. Twice it aborts the pass so a transient cause (a
          // deploy, a database blip) gets its retries; the third pass steps
          // OVER it so one bad row cannot wedge every later change forever.
          if (poisonId === changeKey && poisonCount >= 2) {
            logger.error(
              { changeKey, failures: poisonCount + 1, err: error },
              "Skipping a poison mirror-sync change after repeated failures; the rest of the feed continues",
            );
            poisonId = null;
            poisonCount = 0;
            await prisma.serverNzSettings.update({
              where: { id: "default" },
              data: { commsPoisonChangeId: null, commsPoisonCount: 0 },
            });
            continue;
          }
          poisonCount = poisonId === changeKey ? poisonCount + 1 : 1;
          poisonId = changeKey;
          await prisma.serverNzSettings.update({
            where: { id: "default" },
            data: {
              commsPoisonChangeId: changeKey.slice(0, 64),
              commsPoisonCount: poisonCount,
            },
          });
          throw error;
        }
        if (poisonId === changeKey) {
          // The previously failing change applied cleanly — a transient
          // cause after all. Forget it before it can be blamed again.
          poisonId = null;
          poisonCount = 0;
          await prisma.serverNzSettings.update({
            where: { id: "default" },
            data: { commsPoisonChangeId: null, commsPoisonCount: 0 },
          });
        }
      }

      // Advance the cursor AFTER the page is applied, never before: a crash
      // mid-page replays the page, and every write above is an idempotent
      // upsert or delete, so replay converges instead of losing posts.
      if (envelope.cursor) {
        await prisma.serverNzSettings.update({
          where: { id: "default" },
          data: {
            commsCursorSince: envelope.cursor.since,
            commsCursorSinceId: envelope.cursor.sinceId,
          },
        });
        cursor = {
          commsCursorSince: envelope.cursor.since,
          commsCursorSinceId: envelope.cursor.sinceId,
          commsPoisonChangeId: poisonId,
          commsPoisonCount: poisonCount,
        };
      }

      if (!envelope.hasMore) break;
    }

    await prisma.serverNzSettings.update({
      where: { id: "default" },
      data: { commsLastSyncAt: now },
    });
    return result;
  } finally {
    // Released whatever happened: a failed pass must not wedge the next one.
    await prisma.serverNzSettings
      .update({ where: { id: "default" }, data: { commsSyncStartedAt: null } })
      .catch(() => undefined);
  }
}
