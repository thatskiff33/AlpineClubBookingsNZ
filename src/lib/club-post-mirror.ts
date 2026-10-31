import "server-only";
import type { Prisma } from "@prisma/client";

import { bodyShape, prepareMirrorBody } from "@/lib/club-post-mirror-images";
import logger from "@/lib/logger";
import { deletePostImage } from "@/lib/post-image-storage";
import { prisma } from "@/lib/prisma";
import {
  ServerNzVersionMismatchError,
  pullSharedPostSync,
  type SyncPost,
} from "@/lib/servernz-api";
import { SERVER_VERSION_MISMATCH_CODE } from "@/lib/servernz-api-version";
import { getServerNzSetupState } from "@/lib/servernz-config";
import { ensurePushRegistration } from "@/lib/servernz-push-registration";
import {
  advancedDownloadCursor,
  overlappedRequestCursor,
} from "@/lib/servernz-cursor-overlap";
import type { ServerNzAnswerTx } from "@/lib/servernz-settings";
import { checkServerVersion } from "@/lib/servernz-version-check";
import {
  ServerNzConnectionChangedError,
  serverNzAnswerWriter,
  type ServerNzAnswerWrite,
} from "@/lib/servernz-version-record";

/**
 * Mirroring shared posts from the central server (epic #2992).
 *
 * The mirror is a CACHE OF SOMEONE ELSE'S BOARD, and every decision below
 * follows from that. Content is upserted, never edited here; a tombstone
 * deletes the mirror row outright rather than soft-hiding it, because there is
 * nothing local worth keeping — the authoritative copy lives with the club
 * that wrote it. The one exception (#4588): a "hidden" tombstone for a mirror
 * this club's admin already removed leaves a scrubbed marker, because a hide
 * can be reversed and the marker is what keeps the removal standing; see
 * {@link applyRemoval}. Our OWN posts coming back around the loop are recognised by
 * `serverPostId` and skipped: this install is authoritative for those.
 *
 * DRIVEN TWO WAYS, ONE WRITER. The push webhook and the polling cron both end
 * up here, and the single-flight claim on `commsSyncStartedAt` is what stops a
 * push arriving mid-poll from running two ingest passes over the same cursor.
 *
 * THE FIRST REQUEST OF EVERY PASS LOOKS A LITTLE WAY BEHIND THE STORED
 * POSITION (#3449) — the same bounded overlap the Other Clubs pull applies, from
 * the same home, `@/lib/servernz-cursor-overlap`, which records why. Paging by
 * timestamp AND id protects a page boundary where rows share a timestamp; it
 * does nothing for a row that was not yet committed when the reader stepped
 * past its timestamp, and that row was skipped forever. The repeat is harmless
 * here because {@link upsertMirror} recognises an identical re-delivery and
 * writes nothing — evidence this sync owes on its own, and its tests carry it.
 */


/** A claim older than this belongs to a process that died mid-pass. */
export const STALE_SYNC_CLAIM_MS = 10 * 60 * 1000;

/** Pages per pass, so one pass cannot run unbounded against a huge backlog. */
const MAX_PAGES_PER_PASS = 10;

/** How the inert-overlap log line names this pull — see `overlappedRequestCursor`. */
const OVERLAP_SYNC_LABEL = "shared-post mirror";

export interface MirrorSyncResult {
  /**
   * `server-version-mismatch` (#49): the central server is on a different API
   * version, so nothing was pulled, no push target was registered and no image
   * was fetched. Decided BEFORE the claim, so a paused pass holds nothing.
   */
  skipped?: "not-configured" | "busy" | typeof SERVER_VERSION_MISMATCH_CODE;
  /** Visible changes that created or altered a mirror row. */
  upserted: number;
  /**
   * Visible changes whose post was already mirrored exactly as delivered —
   * the rows the cursor overlap deliberately re-asks for (#3449). Counted
   * apart so a repeat never reads as a change, and so an overlap that is
   * working is visible as such.
   */
  unchanged: number;
  removed: number;
  pages: number;
  /**
   * `connection-changed` (#4470): the server address or API key was replaced
   * while this pass ran, so it stopped at its first write for a page from the
   * replaced connection. That page wrote nothing: no post, failure count,
   * cursor or last-sync time; pages applied before the change stand.
   *
   * `claim-taken-over` (#4588): this pass ran past the stale window and a
   * second pass took the claim, so it stopped at its first write after that,
   * which wrote nothing. Changes applied before the takeover stand.
   */
  stopped?: "connection-changed" | "claim-taken-over";
}

/** A fenced write refused because another pass now holds the claim (#4588). */
class MirrorClaimTakenOverError extends Error {
  constructor() {
    super("The shared-post mirror claim was taken over by another pass");
    this.name = "MirrorClaimTakenOverError";
  }
}

/**
 * A page's fenced writer that also checks this pass STILL HOLDS its claim
 * (#4588): under the settings-row lock the fence has just taken, it re-reads
 * `commsSyncStartedAt` and refuses, writing nothing, unless it is still the
 * stamp this pass wrote. A pass that outlived the stale window and was taken
 * over cannot re-apply an older version, or re-create a post the newer pass
 * deleted, beside the pass that now holds the claim.
 */
function claimHeldWriter(write: ServerNzAnswerWrite, claimedAt: Date): ServerNzAnswerWrite {
  return (work) => write(async (tx) => {
    const row = await tx.serverNzSettings.findUnique({ where: { id: "default" }, select: { commsSyncStartedAt: true } });
    if (row?.commsSyncStartedAt?.getTime() !== claimedAt.getTime()) throw new MirrorClaimTakenOverError();
    return work(tx);
  });
}

/** What {@link upsertMirror} did with one visible change. */
type MirrorUpsertOutcome = "created" | "updated" | "unchanged" | "skipped";

/**
 * Upsert one mirrored post, images included (pictures and body:
 * `club-post-mirror-images.ts`).
 */
async function upsertMirror(
  post: SyncPost,
  write: ServerNzAnswerWrite,
): Promise<MirrorUpsertOutcome> {
  // Our own post coming back around the loop. This install is authoritative
  // for it; the server's copy is derived, so nothing here may overwrite it.
  // Read here only to skip the downloads: the decision is re-read under the
  // post's row lock, inside the fenced write below (#4586).
  // A mirror this club's admin REMOVED is skipped too (#4588): its words are
  // gone and stay gone, so nothing is downloaded for it either.
  const seen = await prisma.clubPost.findUnique({
    where: { serverPostId: post.id },
    select: { originClubCode: true, removedAt: true },
  });
  if (seen && (seen.originClubCode === null || seen.removedAt)) return "skipped";

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
    return "skipped";
  }

  // After the timestamp check, so a skipped post stores no file.
  const { storedImages, bodyHtml } = await prepareMirrorBody(post);

  // Every row write below is fenced on the connection this page came from
  // (#4470). A write that fails for any reason, a refusal included, rolled
  // back and committed no row naming the image files just stored, and no
  // sweep reclaims a file without a row, so they are removed here.
  const fresh = storedImages.map((image) => image.storageKey);
  let unused = fresh;
  let outcome: MirrorUpsertOutcome;
  try {
    outcome = await write(async (tx) => {
      // CREATE OR UPDATE IS DECIDED HERE, under the fence and the post's row
      // lock (#4586), from a re-read: the row cannot change between the read
      // and the write. The post is locked before any image row is touched.
      const existing = await lockMirroredPost(tx, post.id, {
        id: true, originClubCode: true, originClubName: true, content: true, bodyHtml: true, removedAt: true,
        // In position order: sameness is judged image-by-image against the
        // server's list, which is positional.
        images: { select: { storageKey: true, sha256: true }, orderBy: { position: "asc" } },
      });
      // Our own post, or a mirror this club's admin removed (#4588): a removal
      // blanked the words and deleted the pictures, and a re-delivery (an edit
      // at the origin, or the cursor overlap) must not write them back.
      if (existing && (existing.originClubCode === null || existing.removedAt)) return "skipped";
      if (existing) {
        // THE REPEAT THE CURSOR OVERLAP RE-DELIVERS (#3449). A post already
        // mirrored exactly as it arrives (same words, origin name and
        // pictures byte for byte) is written nowhere and not counted as a
        // change, so the overlap never churns the board; only the duplicate
        // files just stored are removed.
        const sameImages =
          storedImages.length === existing.images.length &&
          storedImages.every((image, index) => image.sha256 === existing.images[index]?.sha256);
        if (
          sameImages &&
          existing.content === content &&
          existing.originClubName === post.club.name &&
          bodyShape(existing.bodyHtml) === bodyShape(bodyHtml)
        ) {
          return "unchanged";
        }
        // Images replaced wholesale: the server's list is authoritative for a
        // mirror. Rows first, then files, so a failure leaves orphaned files
        // (invisible, swept later) rather than broken images.
        await tx.clubPostImage.deleteMany({ where: { postId: existing.id } });
        await tx.clubPost.update({
          where: { id: existing.id },
          data: { content, bodyHtml, originClubName: post.club.name, images: { create: storedImages } },
        });
        unused = existing.images.map((image) => image.storageKey);
        return "updated";
      }
      await tx.clubPost.create({
        data: {
          serverPostId: post.id,
          originClubCode: post.club.code,
          originClubName: post.club.name,
          // No local member wrote this, so there is nobody to link. The
          // display name is club-attested by the origin club.
          authorMemberId: null,
          authorName: post.authorName,
          content,
          bodyHtml,
          postedAt,
          images: { create: storedImages },
        },
      });
      unused = [];
      return "created";
    });
  } catch (error) {
    for (const key of fresh) await deletePostImage(key);
    throw error;
  }
  for (const key of unused) await deletePostImage(key);
  return outcome;
}

/**
 * Lock the row mirroring `serverPostId`, then re-read it (#4586). Every
 * message-board writer takes the `ClubPost` row before its `ClubPostImage`
 * rows; see docs/CONCURRENCY_AND_LOCKING.md -> "Message-board posts and their
 * images". `serverPostId` is a mutable key (a share stamps it), so a lock that
 * matched nothing is not found, never a row read unlocked; the unique column
 * refuses a create racing that stamp.
 */
async function lockMirroredPost<S extends Prisma.ClubPostSelect>(tx: ServerNzAnswerTx, serverPostId: string, select: S) {
  const locked = await tx.$executeRaw`SELECT 1 FROM "ClubPost" WHERE "serverPostId" = ${serverPostId} FOR UPDATE`;
  return locked === 0 ? null : tx.clubPost.findUnique({ where: { serverPostId }, select });
}

/** Apply one tombstone under the fence and the post's row lock (#4470, #4586, #4588). */
async function applyRemoval(
  serverPostId: string,
  reason: "hidden" | "removed",
  write: ServerNzAnswerWrite,
): Promise<boolean> {
  const outcome = await write(async (tx): Promise<{ files: string[]; removed: boolean } | null> => {
    const existing = await lockMirroredPost(tx, serverPostId, {
      id: true, originClubCode: true, hiddenAt: true, removedAt: true, images: { select: { storageKey: true } },
    });
    if (!existing) return null;
    const files = existing.images.map((image) => image.storageKey);
    if (existing.originClubCode !== null && existing.removedAt && reason === "hidden") {
      // A HIDE of a mirror this club's admin already removed (#4588). A hide
      // can be reversed at the server, and deleting the row would let that
      // restore re-create the post here, undoing the removal; so a MARKER
      // stays, scrubbed of everything but what recognises the id. Kept:
      // `serverPostId` (the recognition), `originClubCode` (non-null is what
      // marks a mirror; null would make it read as our own post), `removedAt`
      // (the decision), `postedAt` (so retention, where on, expires the marker
      // too) and `hiddenAt` (a timestamp). Blanked: the author, the origin
      // club's name, the words and the body; deleted: its reports (their
      // reporter names and details can quote the removed words) and any image
      // rows. A "removed" tombstone is final and deletes the row below.
      await tx.clubPostReport.deleteMany({ where: { postId: existing.id } });
      await tx.clubPostImage.deleteMany({ where: { postId: existing.id } });
      await tx.clubPost.update({
        where: { id: existing.id },
        data: { authorName: "", originClubName: null, content: "", bodyHtml: null, reportCount: 0 },
      });
      return { files, removed: false };
    }
    if (existing.originClubCode === null) {
      // OUR OWN post, taken down on the network side (a central-server admin
      // removed it, or reports hid it). The row stops claiming to be shared,
      // and the local copy is HIDDEN, not deleted: the words belong to this
      // club's own member, and takedown convergence is moderation, not
      // erasure. A club admin can unhide it as a local-only post.
      await tx.clubPost.update({
        where: { id: existing.id },
        data: { sharedAt: null, serverPostId: null, shareRequestedAt: null, hiddenAt: existing.hiddenAt ?? new Date() },
      });
      return { files: [], removed: true };
    }
    // A mirror is a cache: the authoritative copy lives with the club that
    // wrote it, so the row is deleted outright, its images and reports by
    // cascade. That includes one this club's admin removed, on a "removed"
    // tombstone: the takedown is final, so no marker is needed.
    await tx.clubPost.delete({ where: { id: existing.id } });
    return { files, removed: true };
  });
  if (outcome === null) return false;
  // Rows first, files second, as everywhere else.
  for (const key of outcome.files) await deletePostImage(key);
  return outcome.removed;
}

/** The mirror's stored position: its cursor pair and its failure count (#4470). */
type MirrorPosition = {
  commsCursorSince: string | null;
  commsCursorSinceId: string | null;
  commsPoisonChangeId: string | null;
  commsPoisonCount: number;
};
const POSITION_SELECT = {
  commsCursorSince: true, commsCursorSinceId: true, commsPoisonChangeId: true, commsPoisonCount: true,
} as const;
function positionOf(row: Partial<MirrorPosition> | null | undefined): MirrorPosition {
  return {
    commsCursorSince: row?.commsCursorSince ?? null,
    commsCursorSinceId: row?.commsCursorSinceId ?? null,
    commsPoisonChangeId: row?.commsPoisonChangeId ?? null,
    commsPoisonCount: row?.commsPoisonCount ?? 0,
  };
}

const PAUSED: MirrorSyncResult = {
  skipped: SERVER_VERSION_MISMATCH_CODE,
  upserted: 0,
  unchanged: 0,
  removed: 0,
  pages: 0,
};

/**
 * The cursor the FIRST page of a pass asks with: one overlap before the stored
 * position when that position is an instant, the stored pair untouched
 * otherwise, and nothing at all when there is no stored position — so an
 * initial full sync is unchanged.
 *
 * THE TIEBREAK ID IS DROPPED WHEN THE TIMESTAMP IS STEPPED. `sinceId` orders
 * rows that share the stored `since` exactly; paired with a different, earlier
 * instant it would exclude whichever rows at that instant sort at or before it
 * — a sliver, but a wrong one. Asking with the stepped instant alone asks for
 * everything from that instant on, which is the whole of the window.
 *
 * ONLY THE FIRST PAGE. Later pages in the same pass continue from the cursor
 * the server just returned, VERBATIM — a position inside this pass's own
 * read, not a watermark left by an earlier one. Stepping every page back
 * would re-fetch the tail of each page on the next, and a page whose two
 * hundred changes all fall inside one window would be re-served identically
 * until the page cap — a pass that never progresses. And the in-pass request
 * position is NOT the guarded durable one: when the window holds more than
 * one page, the server's next cursor sits INSIDE the window, earlier than the
 * stored position, and the never-backwards guard refuses to persist it.
 * Requesting from the guarded value instead would re-ask from the stored
 * position and step over the rest of the window — every pass, so permanently;
 * the defect this exists to close, re-created one page in.
 */
function overlappedMirrorCursor(
  since: string | null | undefined,
  sinceId: string | null | undefined,
): { since: string | null; sinceId: string | null } {
  const stored = since ?? null;
  const requested = overlappedRequestCursor(stored, OVERLAP_SYNC_LABEL);
  if (requested === stored) return { since: stored, sinceId: sinceId ?? null };
  return { since: requested, sinceId: null };
}

/**
 * Pull the mirror up to date. The one writer both the webhook and the cron use.
 */
export async function runMirrorSync(
  now: Date = new Date(),
): Promise<MirrorSyncResult> {
  const setup = await getServerNzSetupState();
  if (!setup.apiKeySet) {
    return {
      skipped: "not-configured",
      upserted: 0,
      unchanged: 0,
      removed: 0,
      pages: 0,
    };
  }

  // The version check, BEFORE the claim (#49, `INV-INT-027`): every call this
  // pass would make - registerPushTarget, pullSharedPostSync,
  // fetchSharedPostImage - goes through the gate in resolveConnection, so a
  // mismatch would refuse the first of them anyway; asking here is what keeps
  // a paused pass from taking `commsSyncStartedAt` and holding it until the
  // stale window reaps it. A check that could not reach the server keeps the
  // last answer and the pass continues (the pull will fail on its own terms).
  const version = await checkServerVersion();
  if (version.status === "mismatch") {
    logger.info(
      { expected: version.expected, serverVersion: version.serverVersion },
      "Shared-post mirror sync skipped: central server API version differs",
    );
    return { ...PAUSED };
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
  // The exact stamp this pass writes, kept so the release clears only it (#4586).
  const claimedAt = new Date(now.getTime());
  const claim = await prisma.serverNzSettings.updateMany({
    where: {
      id: "default",
      OR: [
        { commsSyncStartedAt: null },
        { commsSyncStartedAt: { lt: staleBefore } },
      ],
    },
    data: { commsSyncStartedAt: claimedAt },
  });
  if (claim.count === 0) {
    return { skipped: "busy", upserted: 0, unchanged: 0, removed: 0, pages: 0 };
  }

  const result: MirrorSyncResult = {
    upserted: 0,
    unchanged: 0,
    removed: 0,
    pages: 0,
  };
  try {
    await ensurePushRegistration();

    const cursor = await prisma.serverNzSettings.findUnique({
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
    // THE POSITION THIS PASS HOLDS (#4470): the stored cursor pair and failure
    // count as it read or last wrote them. Every position write re-reads them
    // under the page's fence and refuses, writing nothing, if any moved: a key
    // replaced at the same address resets them and leaves a page that passes
    // the fence (sent on the new key), so without this the pass would write
    // its old position, or step over a post on a stale failure count, onto
    // the new connection. A moved position stops the pass like a replaced one.
    let held = positionOf(cursor);
    const writePosition = async (pageWrite: ServerNzAnswerWrite, data: Partial<MirrorPosition>) => {
      await pageWrite(async (tx) => {
        const stored = positionOf(await tx.serverNzSettings.findUnique({ where: { id: "default" }, select: POSITION_SELECT }));
        if ((Object.keys(held) as (keyof MirrorPosition)[]).some((key) => stored[key] !== held[key])) {
          throw new ServerNzConnectionChangedError();
        }
        await tx.serverNzSettings.update({ where: { id: "default" }, data });
      });
      held = { ...held, ...data };
    };
    // TWO POSITIONS, kept apart on purpose (#3449). `durable` is what the row
    // holds and only ever moves forward. `request` is where the NEXT page asks
    // from: the overlapped position first, then whatever the server returned,
    // verbatim, even when that is earlier than `durable` — see
    // `overlappedMirrorCursor` for why conflating them re-creates the skip.
    let durable = {
      since: cursor?.commsCursorSince ?? null,
      sinceId: cursor?.commsCursorSinceId ?? null,
    };
    let request = overlappedMirrorCursor(durable.since, durable.sinceId);

    // EVERY WRITE FROM A PAGE IS FENCED on the connection that page was sent
    // on (#4470), the Other lodges download's protocol: posts, removals, the
    // failure count, the cursor and the last-sync time each commit in one
    // short `serverNzAnswerWriter` transaction that re-reads the stored
    // address and key version under the settings-row lock. A page from a
    // connection replaced while it was in flight writes nothing, so it cannot
    // put the old server's position back over the replacement's reset (which
    // would skip the new server's older posts for good, the cursor never
    // moving backwards); the pass stops at that write. Posts applied from
    // earlier pages stand: a move does not remove mirrored posts.
    let write: ServerNzAnswerWrite | null = null;
    for (let page = 0; page < MAX_PAGES_PER_PASS; page++) {
      const envelope = await pullSharedPostSync(request);
      const pageWrite = claimHeldWriter(serverNzAnswerWriter(envelope.sentOn), claimedAt);
      write = pageWrite;
      result.pages += 1;

      for (const change of envelope.changes) {
        const changeKey = change.state === "visible" ? change.post.id : change.id;
        try {
          if (change.state === "visible") {
            const outcome = await upsertMirror(change.post, pageWrite);
            if (outcome === "unchanged") result.unchanged += 1;
            else if (outcome !== "skipped") result.upserted += 1;
          } else {
            if (await applyRemoval(change.id, change.reason, pageWrite)) result.removed += 1;
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
          //
          // A version pause is not a poison change (#49): it is the server's
          // answer about the whole connection, so it neither counts against
          // this change nor steps over it - the pass reports paused below.
          // Nor is a replaced connection (#4470) or a claim taken over
          // (#4588): the pass stops below.
          if (error instanceof ServerNzVersionMismatchError) throw error;
          if (error instanceof ServerNzConnectionChangedError) throw error;
          if (error instanceof MirrorClaimTakenOverError) throw error;
          if (poisonId === changeKey && poisonCount >= 2) {
            // Said only once the count it rests on is still the stored one.
            await writePosition(pageWrite, { commsPoisonChangeId: null, commsPoisonCount: 0 });
            logger.error(
              { changeKey, failures: poisonCount + 1, err: error },
              "Skipping a poison mirror-sync change after repeated failures; the rest of the feed continues",
            );
            poisonId = null;
            poisonCount = 0;
            continue;
          }
          poisonCount = poisonId === changeKey ? poisonCount + 1 : 1;
          poisonId = changeKey;
          await writePosition(pageWrite, {
            commsPoisonChangeId: changeKey.slice(0, 64),
            commsPoisonCount: poisonCount,
          });
          throw error;
        }
        if (poisonId === changeKey) {
          // The previously failing change applied cleanly — a transient
          // cause after all. Forget it before it can be blamed again.
          poisonId = null;
          poisonCount = 0;
          await writePosition(pageWrite, { commsPoisonChangeId: null, commsPoisonCount: 0 });
        }
      }

      // Advance the cursor AFTER the page is applied, never before: a crash
      // mid-page replays the page, and every write above is an idempotent
      // upsert or delete, so replay converges instead of losing posts.
      //
      // AND NEVER BACKWARDS (#3449). The first request looked one overlap
      // behind the stored position, and a server that echoes `since` on an
      // empty page would hand that overlapped value straight back; storing it
      // would rewind the durable position a minute per quiet pass. The pair is
      // kept whole: the server's `sinceId` belongs with the server's `since`,
      // so a refused step keeps BOTH stored halves.
      //
      // AND ONLY OVER THE POSITION THIS PASS HOLDS (#4470): `writePosition`.
      if (envelope.cursor) {
        const since = advancedDownloadCursor(durable.since, envelope.cursor.since);
        if (since === envelope.cursor.since) durable = envelope.cursor;
        await writePosition(pageWrite, { commsCursorSince: durable.since, commsCursorSinceId: durable.sinceId });
        request = envelope.cursor;
      }

      if (!envelope.hasMore) break;
    }

    // The last page's connection: a pass whose connection was replaced after
    // its last write does not stamp the new connection as synced.
    await write?.((tx) => tx.serverNzSettings.update({
      where: { id: "default" },
      data: { commsLastSyncAt: now },
    }));
    return result;
  } catch (error) {
    // The server refused mid-pass for version (its 409, recorded by the API
    // client) or the gate did after a late self-heal: the pass is PAUSED, not
    // failed. The claim is released below; the cursor is wherever the last
    // applied page left it, so the next matching pass resumes from there.
    if (error instanceof ServerNzVersionMismatchError) {
      logger.info(
        { expected: error.expected, serverVersion: error.serverVersion, ...result },
        "Shared-post mirror sync paused mid-pass: central server API version differs",
      );
      return { ...PAUSED, ...result, skipped: SERVER_VERSION_MISMATCH_CODE };
    }
    // The connection was replaced mid-pass (#4470): stopped at the first write
    // for it, which wrote nothing. Released below; the next pass starts from
    // the replacement's (reset) position on the connection now stored.
    if (error instanceof ServerNzConnectionChangedError) {
      logger.warn(
        { ...result },
        "The Alpine Central Server connection changed while the shared-post mirror ran; nothing from it was written after the change",
      );
      return { ...result, stopped: "connection-changed" };
    }
    // Taken over (#4588): stopped at the first write after it, which wrote
    // nothing. The release below matches nothing; the claim is the new pass's.
    if (error instanceof MirrorClaimTakenOverError) {
      logger.warn({ ...result }, "A shared-post mirror pass outlived its claim and was taken over; it wrote nothing after the takeover");
      return { ...result, stopped: "claim-taken-over" };
    }
    throw error;
  } finally {
    // Released whatever happened, so a failed pass cannot wedge the next one,
    // and ONLY while the row still holds this pass's own stamp (#4586): a pass
    // whose claim went stale and was taken over must not clear the new
    // holder's, or a third pass could start beside it.
    await prisma.serverNzSettings
      .updateMany({ where: { id: "default", commsSyncStartedAt: claimedAt }, data: { commsSyncStartedAt: null } })
      .catch(() => undefined);
  }
}
