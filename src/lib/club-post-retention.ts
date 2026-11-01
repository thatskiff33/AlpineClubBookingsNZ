import "server-only";
import { Prisma } from "@prisma/client";
import { RETENTION_CHOICES } from "@/lib/club-post-retention-choices";
import { deletePostImage } from "@/lib/post-image-storage";
import { prisma } from "@/lib/prisma";

/**
 * Retention and cleanup for the club message board (#2999, epic #2992).
 *
 * This module PERMANENTLY DELETES member content. Everywhere a rule could be
 * read two ways it is written to delete less rather than more: a window of 0
 * deletes nothing at all, the boundary is exclusive, and a pass that cannot
 * take the claim does nothing rather than racing.
 */

export const CLUB_POST_SETTINGS_ID = "default";

/**
 * Generous relative to a real pass. Reaping early is merely wasteful — two
 * overlapping passes, and the deletes are idempotent — whereas reaping late
 * leaves a wedged job, and a wedged job is silent.
 */
export const STALE_CLEANUP_CLAIM_MS = 30 * 60 * 1000;

export interface ClubPostSettingsValues {
  retentionDays: number;
  lastCleanupAt: string | null;
  lastCleanupDeleted: number;
}

export class ClubPostSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClubPostSettingsValidationError";
  }
}

/** Reject anything not on the offered list, so a hand-crafted PUT cannot set 1. */
export function assertValidRetentionDays(raw: unknown): number {
  const days = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isInteger(days)) {
    throw new ClubPostSettingsValidationError(
      "Choose one of the retention periods offered.",
    );
  }
  if (!RETENTION_CHOICES.some((choice) => choice.days === days)) {
    throw new ClubPostSettingsValidationError(
      "Choose one of the retention periods offered.",
    );
  }
  return days;
}

/**
 * Read the settings, creating nothing.
 *
 * A missing row reads as the shipped defaults — keep everything — so an install
 * that has never opened the screen behaves as though retention is off rather
 * than failing or, worse, defaulting to a window that deletes.
 */
export async function loadClubPostSettings(): Promise<ClubPostSettingsValues> {
  const row = await prisma.clubPostSettings.findUnique({
    where: { id: CLUB_POST_SETTINGS_ID },
    select: {
      retentionDays: true,
      lastCleanupAt: true,
      lastCleanupDeleted: true,
    },
  });

  return {
    retentionDays: row?.retentionDays ?? 0,
    lastCleanupAt: row?.lastCleanupAt?.toISOString() ?? null,
    lastCleanupDeleted: row?.lastCleanupDeleted ?? 0,
  };
}

export async function saveClubPostRetention(
  rawDays: unknown,
  actorMemberId: string,
): Promise<ClubPostSettingsValues> {
  const retentionDays = assertValidRetentionDays(rawDays);

  await prisma.clubPostSettings.upsert({
    where: { id: CLUB_POST_SETTINGS_ID },
    create: {
      id: CLUB_POST_SETTINGS_ID,
      retentionDays,
      updatedByMemberId: actorMemberId,
    },
    update: { retentionDays, updatedByMemberId: actorMemberId },
  });

  return loadClubPostSettings();
}

/**
 * The cutoff a window implies. Exposed so the admin screen can say how many
 * posts a window would delete BEFORE it is saved, using exactly the arithmetic
 * the pass will use rather than an approximation of it.
 */
export function retentionCutoff(retentionDays: number, now: Date): Date | null {
  if (retentionDays <= 0) return null;
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/** How many posts a window would delete right now. */
export async function countPostsBeyondRetention(
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = retentionCutoff(retentionDays, now);
  if (!cutoff) return 0;
  return prisma.clubPost.count({ where: { postedAt: { lt: cutoff } } });
}

export interface CleanupOutcome {
  /** "disabled" when the window is 0; "busy" when another pass holds the claim. */
  skipped?: "disabled" | "busy";
  deleted: number;
}

/**
 * Delete every post older than the retention window.
 *
 * Safe to call concurrently: exactly one caller does the work and the rest
 * report `busy`, so the admin screen's button cannot race the scheduled cron.
 */
/**
 * Delete uploads nobody ever attached to a post (#3091 review 4). A member
 * who picks an image and then abandons the composer leaves one behind, and
 * without this they accumulate on the mount forever. An hour's grace so an
 * upload that is still being composed is never swept out from under its
 * author.
 *
 * Runs UNCONDITIONALLY, claim or no claim: "how long do we keep posts" and
 * "clean up uploads nobody ever used" are independent policies, and gating
 * this behind a non-zero retention window — the shipped default is 0 —
 * made it unreachable on every install that never chose one. Safe without
 * the single-flight claim because every step is idempotent: each row is
 * deleted by id and `deletePostImage` never throws on a file already gone,
 * so two overlapping passes merely waste a query.
 *
 * ONE ROW AT A TIME, AND ONLY WHILE IT IS STILL UNATTACHED (#4588). A member
 * can post with an upload older than the grace hour, and `createClubPost`
 * claims it between the read above and the delete: the guarded delete then
 * matches nothing, and the file a live post names stays. A file is deleted
 * only for a row this pass actually deleted. Single-row statements also hold
 * one image row at a time, so the sweep cannot deadlock against a claim that
 * takes several (the claim locks by `publicId`, this read ran by `id`).
 */
async function sweepOrphanImages(now: Date): Promise<void> {
  const abandonedBefore = new Date(now.getTime() - 60 * 60 * 1000);
  const orphans = await prisma.clubPostImage.findMany({
    where: { postId: null, createdAt: { lt: abandonedBefore } },
    select: { id: true, storageKey: true },
  });
  for (const orphan of orphans) {
    const { count } = await prisma.clubPostImage.deleteMany({
      where: { id: orphan.id, postId: null },
    });
    if (count === 1) await deletePostImage(orphan.storageKey);
  }
}

/** Expired posts deleted per transaction, so one pass never holds thousands of row locks. */
const RETENTION_BATCH_SIZE = 200;

/**
 * Delete every post older than `cutoff`, in batches, and THEN their files
 * (#4588).
 *
 * Each batch is one transaction: it locks the doomed `ClubPost` rows (id
 * order), reads their images UNDER those locks, deletes the posts (their image
 * rows go by cascade) and hands back the storage keys; the files go after the
 * commit. Reading the images first and outside a transaction let a mirror
 * update add image rows to a doomed post in between: the cascade took them and
 * their files stayed on the mount with no row, where the row-driven orphan
 * sweep can never find them. Every writer that adds image rows to a post holds
 * that post's row lock (docs/CONCURRENCY_AND_LOCKING.md -> "Message-board
 * posts and their images"), so under these locks the image set is final.
 */
async function deleteExpiredPosts(cutoff: Date): Promise<number> {
  let deleted = 0;
  for (;;) {
    // Strictly older than the cutoff. A post exactly ON the boundary is KEPT:
    // where the rule could be read two ways, this deletes less.
    const batch = await prisma.clubPost.findMany({
      where: { postedAt: { lt: cutoff } },
      orderBy: { id: "asc" },
      take: RETENTION_BATCH_SIZE,
      select: { id: true },
    });
    if (batch.length === 0) return deleted;
    const ids = batch.map((post) => post.id);
    const { count, storageKeys } = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "ClubPost" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
      // Re-read under the locks: a post deleted or re-dated meanwhile drops out.
      const doomed = await tx.clubPost.findMany({
        where: { id: { in: ids }, postedAt: { lt: cutoff } },
        select: { id: true, images: { select: { storageKey: true } } },
      });
      const removed = await tx.clubPost.deleteMany({ where: { id: { in: doomed.map((post) => post.id) } } });
      return { count: removed.count, storageKeys: doomed.flatMap((post) => post.images.map((image) => image.storageKey)) };
      // Bounded like the other short row-lock writers: a batch can queue
      // behind a mirror page or an admin removal holding one of its posts.
    }, { maxWait: 10_000, timeout: 30_000 });
    deleted += count;
    // Rows first, files second: a crash in between leaves invisible files,
    // never a live post naming a missing one. Never throws on a file already
    // gone, so a retried pass cannot fail on its own previous success.
    for (const key of storageKeys) await deletePostImage(key);
  }
}

export async function runClubPostCleanup(
  now: Date = new Date(),
): Promise<CleanupOutcome> {
  const settings = await loadClubPostSettings();
  const cutoff = retentionCutoff(settings.retentionDays, now);

  // Checked BEFORE the claim: a disabled window should not even briefly hold a
  // claim that would make a concurrent caller report `busy` for no reason.
  //
  // It also guards the claim below, which is an `updateMany` and therefore
  // matches NOTHING when the settings row does not exist — that would report
  // `busy` forever on an install that had never saved a setting. It cannot
  // happen: a non-zero window can only come from `saveClubPostRetention`, which
  // upserts, so a cutoff existing implies the row does too.
  if (!cutoff) {
    // Retention off is NOT cleanup off (#3091 review 4): the orphan sweep
    // guards the mount, not member content, and it runs either way.
    await sweepOrphanImages(now);
    return { skipped: "disabled", deleted: 0 };
  }

  const staleBefore = new Date(now.getTime() - STALE_CLEANUP_CLAIM_MS);
  // The exact stamp this pass writes, kept so the release clears only it (#4590).
  const claimedAt = new Date(now.getTime());

  // The claim. `updateMany`'s matched-row count IS the claim: exactly one
  // caller can move the row from "free or stale" to "held", atomically.
  const claim = await prisma.clubPostSettings.updateMany({
    where: {
      id: CLUB_POST_SETTINGS_ID,
      OR: [{ cleanupStartedAt: null }, { cleanupStartedAt: { lt: staleBefore } }],
    },
    data: { cleanupStartedAt: claimedAt },
  });
  if (claim.count === 0) return { skipped: "busy", deleted: 0 };

  try {
    const count = await deleteExpiredPosts(cutoff);

    await sweepOrphanImages(now);

    await prisma.clubPostSettings.update({
      where: { id: CLUB_POST_SETTINGS_ID },
      data: { lastCleanupAt: now, lastCleanupDeleted: count },
    });

    return { deleted: count };
  } finally {
    // Released whatever happened, so a failed pass cannot wedge the next one,
    // and ONLY while the row still holds this pass's own stamp (#4590, as the
    // mirror's since #4586): a pass that outlived the stale window and was
    // taken over must not clear the new holder's claim.
    await prisma.clubPostSettings
      .updateMany({
        where: { id: CLUB_POST_SETTINGS_ID, cleanupStartedAt: claimedAt },
        data: { cleanupStartedAt: null },
      })
      .catch(() => {
        // Not fatal — the staleness reap above recovers it within the window.
      });
  }
}
