import "server-only";
import { RETENTION_CHOICES } from "@/lib/club-post-retention-choices";
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
 * report `busy`, so the admin screen's button cannot race the nightly cron.
 */
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
  if (!cutoff) return { skipped: "disabled", deleted: 0 };

  const staleBefore = new Date(now.getTime() - STALE_CLEANUP_CLAIM_MS);

  // The claim. `updateMany`'s matched-row count IS the claim: exactly one
  // caller can move the row from "free or stale" to "held", atomically.
  const claim = await prisma.clubPostSettings.updateMany({
    where: {
      id: CLUB_POST_SETTINGS_ID,
      OR: [{ cleanupStartedAt: null }, { cleanupStartedAt: { lt: staleBefore } }],
    },
    data: { cleanupStartedAt: now },
  });
  if (claim.count === 0) return { skipped: "busy", deleted: 0 };

  try {
    // Strictly older than the cutoff. A post exactly ON the boundary is KEPT:
    // where the rule could be read two ways, this deletes less.
    const { count } = await prisma.clubPost.deleteMany({
      where: { postedAt: { lt: cutoff } },
    });

    await prisma.clubPostSettings.update({
      where: { id: CLUB_POST_SETTINGS_ID },
      data: { lastCleanupAt: now, lastCleanupDeleted: count },
    });

    return { deleted: count };
  } finally {
    // Released whatever happened: a failed pass must not wedge the next one.
    await prisma.clubPostSettings
      .update({
        where: { id: CLUB_POST_SETTINGS_ID },
        data: { cleanupStartedAt: null },
      })
      .catch(() => {
        // Not fatal — the staleness reap above recovers it within the window.
      });
  }
}
