import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2999 (epic #2992) — club message board retention.
 *
 * This pass permanently deletes member content, so the tests here are weighted
 * towards proving it deletes LESS than more: nothing at all when the window is
 * 0, nothing when another pass holds the claim, and nothing on the boundary
 * itself.
 *
 * Clock frozen at 2026-07-01T00:00:00.000Z, so `NOW` below is that instant and
 * every cutoff is relative to it rather than to a real date.
 */

const mocks = vi.hoisted(() => ({
  settingsFindUnique: vi.fn(),
  settingsUpdateMany: vi.fn(),
  settingsUpdate: vi.fn(),
  settingsUpsert: vi.fn(),
  postDeleteMany: vi.fn(),
  postCount: vi.fn(),
  imageFindMany: vi.fn(),
  imageDeleteMany: vi.fn(),
  deletePostImage: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubPostSettings: {
      findUnique: mocks.settingsFindUnique,
      updateMany: mocks.settingsUpdateMany,
      update: mocks.settingsUpdate,
      upsert: mocks.settingsUpsert,
    },
    clubPost: {
      deleteMany: mocks.postDeleteMany,
      count: mocks.postCount,
    },
    clubPostImage: {
      findMany: mocks.imageFindMany,
      deleteMany: mocks.imageDeleteMany,
    },
  },
}));

// The filesystem side of the pass. Mocked so the tests stay about WHAT is
// deleted and in what order, not about a real mount being present.
vi.mock("@/lib/post-image-storage", () => ({
  deletePostImage: mocks.deletePostImage,
}));

import {
  assertValidRetentionDays,
  ClubPostSettingsValidationError,
  countPostsBeyondRetention,
  loadClubPostSettings,
  retentionCutoff,
  runClubPostCleanup,
  STALE_CLEANUP_CLAIM_MS,
} from "@/lib/club-post-retention";

const NOW = new Date("2026-07-01T00:00:00.000Z");

function settings(retentionDays: number) {
  return {
    retentionDays,
    lastCleanupAt: null,
    lastCleanupDeleted: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingsFindUnique.mockResolvedValue(settings(365));
  mocks.settingsUpdateMany.mockResolvedValue({ count: 1 });
  // Default: nothing on disk to reclaim, so the existing tests keep asserting
  // only what they were written to assert.
  mocks.imageFindMany.mockResolvedValue([]);
  mocks.imageDeleteMany.mockResolvedValue({ count: 0 });
  mocks.deletePostImage.mockResolvedValue(undefined);
  mocks.settingsUpdate.mockResolvedValue({});
  mocks.postDeleteMany.mockResolvedValue({ count: 3 });
  mocks.postCount.mockResolvedValue(0);
});

describe("the retention window", () => {
  it("defaults to keep-everything when no row exists", async () => {
    mocks.settingsFindUnique.mockResolvedValue(null);
    // An install that has never opened the screen must behave as though
    // retention is off, never as though some window applies.
    expect((await loadClubPostSettings()).retentionDays).toBe(0);
  });

  it("has no cutoff at all when the window is 0", () => {
    expect(retentionCutoff(0, NOW)).toBeNull();
    expect(retentionCutoff(-5, NOW)).toBeNull();
  });

  it("computes the cutoff from the frozen clock", () => {
    const cutoff = retentionCutoff(365, NOW);
    expect(cutoff?.toISOString()).toBe("2025-07-01T00:00:00.000Z");
  });

  it("accepts only the offered choices", () => {
    for (const days of [0, 90, 183, 365, 730]) {
      expect(assertValidRetentionDays(days)).toBe(days);
    }
    // A hand-crafted PUT must not be able to set a one-day window and empty
    // the board.
    for (const bad of [1, 7, -1, 4000, 1.5, "365", null, undefined]) {
      expect(() => assertValidRetentionDays(bad)).toThrow(
        ClubPostSettingsValidationError,
      );
    }
  });

  it("counts nothing as beyond retention when keeping everything", async () => {
    expect(await countPostsBeyondRetention(0, NOW)).toBe(0);
    expect(mocks.postCount).not.toHaveBeenCalled();
  });
});

describe("the cleanup pass", () => {
  it("deletes nothing and claims nothing when the window is 0", async () => {
    mocks.settingsFindUnique.mockResolvedValue(settings(0));

    const outcome = await runClubPostCleanup(NOW);

    expect(outcome).toEqual({ skipped: "disabled", deleted: 0 });
    expect(mocks.postDeleteMany).not.toHaveBeenCalled();
    // Not even briefly held: a disabled window making a concurrent caller
    // report `busy` would be a lie about why nothing happened.
    expect(mocks.settingsUpdateMany).not.toHaveBeenCalled();
  });

  it("sweeps abandoned uploads even when retention is off (#3091 review 4)", async () => {
    // "How long do we keep posts" and "clean up uploads nobody ever used"
    // are independent policies. Gating the orphan sweep behind a non-zero
    // window — 0 is the shipped default — made it unreachable on every
    // install that never chose one, which is exactly the accumulate-forever
    // outcome its own comment says it prevents.
    mocks.settingsFindUnique.mockResolvedValue(settings(0));
    mocks.imageFindMany.mockResolvedValue([
      { id: "img-9", storageKey: "posts/2025/01/abandoned.webp" },
    ]);

    const outcome = await runClubPostCleanup(NOW);

    expect(outcome.skipped).toBe("disabled");
    expect(mocks.imageDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["img-9"] } },
    });
    expect(mocks.deletePostImage).toHaveBeenCalledWith(
      "posts/2025/01/abandoned.webp",
    );
    // Member posts stay untouched — this is mount hygiene, not retention.
    expect(mocks.postDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes strictly older than the cutoff, so the boundary is KEPT", async () => {
    await runClubPostCleanup(NOW);

    const where = mocks.postDeleteMany.mock.calls[0][0].where;
    expect(where.postedAt.lt).toEqual(new Date("2025-07-01T00:00:00.000Z"));
    // `lt`, never `lte`. A post exactly on the boundary survives — where the
    // rule could be read two ways, this deletes less.
    expect(where.postedAt.lte).toBeUndefined();
  });

  it("does nothing when another pass holds the claim", async () => {
    mocks.settingsUpdateMany.mockResolvedValue({ count: 0 });

    const outcome = await runClubPostCleanup(NOW);

    expect(outcome).toEqual({ skipped: "busy", deleted: 0 });
    expect(mocks.postDeleteMany).not.toHaveBeenCalled();
    // Nothing was claimed, so nothing may be released — releasing here would
    // free the claim the OTHER pass is holding.
    expect(mocks.settingsUpdate).not.toHaveBeenCalled();
  });

  it("claims a free or stale row, reaping one a killed process left behind", async () => {
    await runClubPostCleanup(NOW);

    const where = mocks.settingsUpdateMany.mock.calls[0][0].where;
    expect(where.OR[0]).toEqual({ cleanupStartedAt: null });
    expect(where.OR[1].cleanupStartedAt.lt).toEqual(
      new Date(NOW.getTime() - STALE_CLEANUP_CLAIM_MS),
    );
  });

  it("releases the claim after a pass that throws", async () => {
    mocks.postDeleteMany.mockRejectedValue(new Error("database went away"));

    await expect(runClubPostCleanup(NOW)).rejects.toThrow("database went away");

    // A failed pass must not wedge the next one.
    const release = mocks.settingsUpdate.mock.calls.at(-1)?.[0];
    expect(release.data).toEqual({ cleanupStartedAt: null });
  });

  it("records what it deleted, then releases", async () => {
    mocks.postDeleteMany.mockResolvedValue({ count: 7 });

    const outcome = await runClubPostCleanup(NOW);

    expect(outcome).toEqual({ deleted: 7 });
    expect(mocks.settingsUpdate.mock.calls[0][0].data).toMatchObject({
      lastCleanupAt: NOW,
      lastCleanupDeleted: 7,
    });
    expect(mocks.settingsUpdate.mock.calls[1][0].data).toEqual({
      cleanupStartedAt: null,
    });
  });

  it("cannot report busy forever on an install with no settings row", async () => {
    // The claim is an `updateMany`, which matches nothing when the row is
    // absent — that would look like a permanently-held claim. The disabled
    // check above it is what makes that unreachable: a non-zero window can only
    // come from the upserting save, so a cutoff implies a row.
    mocks.settingsFindUnique.mockResolvedValue(null);

    const outcome = await runClubPostCleanup(NOW);

    expect(outcome.skipped).toBe("disabled");
    expect(outcome.skipped).not.toBe("busy");
    expect(mocks.settingsUpdateMany).not.toHaveBeenCalled();
  });

  it("reports zero honestly rather than as a skip", async () => {
    // "Ran and deleted nothing" and "did not run" are different answers, and
    // the screen says different things about them.
    mocks.postDeleteMany.mockResolvedValue({ count: 0 });
    expect(await runClubPostCleanup(NOW)).toEqual({ deleted: 0 });
  });
});

describe("image cleanup", () => {
  it("deletes the FILES of expired posts, not just their rows", async () => {
    mocks.imageFindMany.mockImplementation(async (args: { where: unknown }) => {
      // The doomed-images query, not the orphan query.
      const where = args.where as { postId?: null };
      if (where.postId === null) return [];
      return [{ storageKey: "posts/2025/01/a.webp" }];
    });
    mocks.postDeleteMany.mockResolvedValue({ count: 1 });

    await runClubPostCleanup(NOW);

    // Without this the rows would go and the photographs would stay on the
    // mount forever, which is the opposite of what a retention window promises.
    expect(mocks.deletePostImage).toHaveBeenCalledWith("posts/2025/01/a.webp");
  });

  it("collects the doomed files BEFORE deleting the rows that name them", async () => {
    const order: string[] = [];
    mocks.imageFindMany.mockImplementation(async () => {
      order.push("find-images");
      return [];
    });
    mocks.postDeleteMany.mockImplementation(async () => {
      order.push("delete-posts");
      return { count: 0 };
    });

    await runClubPostCleanup(NOW);

    // The cascade removes the image rows with the posts, so a query made after
    // the delete returns nothing and every file leaks. Order is the behaviour.
    expect(order.indexOf("find-images")).toBeLessThan(
      order.indexOf("delete-posts"),
    );
  });

  it("sweeps uploads that were never attached to a post", async () => {
    mocks.imageFindMany.mockImplementation(async (args: { where: unknown }) => {
      const where = args.where as { postId?: null };
      if (where.postId === null) {
        return [{ id: "img-1", storageKey: "posts/2025/01/orphan.webp" }];
      }
      return [];
    });
    mocks.postDeleteMany.mockResolvedValue({ count: 0 });

    await runClubPostCleanup(NOW);

    expect(mocks.imageDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["img-1"] } },
    });
    expect(mocks.deletePostImage).toHaveBeenCalledWith(
      "posts/2025/01/orphan.webp",
    );
  });

  it("gives a fresh upload an hour before treating it as abandoned", async () => {
    mocks.imageFindMany.mockResolvedValue([]);
    mocks.postDeleteMany.mockResolvedValue({ count: 0 });

    await runClubPostCleanup(NOW);

    const orphanQuery = mocks.imageFindMany.mock.calls
      .map(([args]) => args as { where: { postId?: null; createdAt?: { lt: Date } } })
      .find((args) => args.where.postId === null);

    // A member who is still composing must not have their picture swept out
    // from under them.
    expect(orphanQuery?.where.createdAt?.lt).toEqual(
      new Date(NOW.getTime() - 60 * 60 * 1000),
    );
  });
});
