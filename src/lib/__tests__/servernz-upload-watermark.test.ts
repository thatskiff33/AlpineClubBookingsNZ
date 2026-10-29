import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the real sync, settings writers and connection fence; only the
// database and provider boundary are fakes. All dates use the frozen clock.
const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  credentialVersion: "old-key",
  beforeCapture: async () => {},
  duringUpload: async () => {},
  queries: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/prisma", () => {
  const db = {
    serverNzSettings: {
      findUnique: async () => state.row,
      upsert: async ({ update }: { update: Record<string, unknown> }) => {
        Object.assign(state.row, update);
        return state.row;
      },
    },
    otherLodge: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        state.queries.push(where);
        const updatedAt = new Date("2026-06-01T00:00:00.000Z");
        const since = (where.updatedAt as { gt: Date } | undefined)?.gt;
        return since && updatedAt <= since ? [] : [{
          id: "local-lodge", centralId: "central-lodge", name: "Club lodge",
          updatedAt, amenities: [],
        }];
      },
    },
    $executeRaw: vi.fn(async () => 1),
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
  };
  return { prisma: db };
});
vi.mock("@/lib/servernz-config", () => ({
  SERVERNZ_PROVIDER: "servernz",
  readServerNzCredentialVersion: async () => state.credentialVersion,
}));
vi.mock("@/lib/integration-credentials", () => ({ invalidateProviderCredentialCache: vi.fn() }));
vi.mock("@/lib/other-lodge-fees-sync", () => ({ syncOwnOtherLodgesFromFees: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/servernz-api", () => ({
  prepareOtherLodgesUpload: async () => {
    await state.beforeCapture();
    // Capture settings and identity together, like the real API wrapper.
    const { loadServerNzSettings } = await import("@/lib/servernz-settings");
    const settings = await loadServerNzSettings();
    const sentOn = { baseUrl: state.row.baseUrl, credentialVersion: state.credentialVersion };
    return { settings, upload: async (items: Array<{ id: string; name: string }>) => {
      await state.duringUpload();
      return {
        sentOn, created: 0, updated: items.length, unchanged: 0, skipped: 0,
        results: items.map((item) => ({ ...item, status: "updated" })),
      };
    } };
  },
}));

import { prisma } from "@/lib/prisma";
import { uploadOtherClubsToServer } from "@/lib/servernz-other-lodges-sync";
import { forgetServerConnectionAnswers, type ServerNzConnectionTx } from "@/lib/servernz-settings";
import { ServerNzConnectionChangedError } from "@/lib/servernz-version-record";

const owned = [{ id: "central-lodge", name: "Club lodge" }];
const previousWatermark = new Date("2026-06-15T00:00:00.000Z");

beforeEach(() => {
  state.row = {
    id: "default", baseUrl: "https://old.example.invalid", otherLodgesEnabled: true,
    otherLodgesOwnedLodges: owned,
    otherLodgesLastUploadAt: null,
    otherLodgesLastDownloadAt: previousWatermark,
    otherLodgesCursor: "old-server-cursor",
    commsCursorSince: "old-feed-position", commsCursorSinceId: "old-feed-id",
    commsLastSyncAt: previousWatermark,
    commsPoisonChangeId: "old-feed-change", commsPoisonCount: 2,
    otherLodgesKeyedAt: previousWatermark,
  };
  state.credentialVersion = "old-key";
  state.beforeCapture = async () => {};
  state.duringUpload = async () => {};
  state.queries = [];
});

async function replaceConnection(change: "address" | "key") {
  if (change === "address") state.row.baseUrl = "https://new.example.invalid";
  else state.credentialVersion = "new-key";
  // Production connection writers call this within their settings-row fence.
  await forgetServerConnectionAnswers(prisma as unknown as ServerNzConnectionTx);
}

describe("Other lodges upload watermark belongs to its connection (#4485)", () => {
  it.each(["address", "key"] as const)("clears the cursors after a %s change and sends older rows on the next upload", async (change) => {
    state.row.otherLodgesLastUploadAt = previousWatermark;
    // The older lodge would be excluded by the old watermark.
    expect((await uploadOtherClubsToServer()).sent).toBe(0);

    await replaceConnection(change);
    expect(state.row).toMatchObject({
      otherLodgesLastUploadAt: null, otherLodgesLastDownloadAt: null,
      otherLodgesCursor: null, otherLodgesKeyedAt: null,
      commsCursorSince: null, commsCursorSinceId: null, commsLastSyncAt: null,
      commsPoisonChangeId: null, commsPoisonCount: 0,
    });
    // A download must first record this connection's owned list again.
    state.row.otherLodgesOwnedLodges = owned;
    expect((await uploadOtherClubsToServer()).sent).toBe(1);
    expect(state.queries.at(-1)).toEqual({ hiddenAt: null });
    expect(state.row.otherLodgesLastUploadAt).toEqual(new Date("2026-06-01T00:00:00.000Z"));
  });

  it.each(["address", "key"] as const)("records nothing when the %s changes during an upload", async (change) => {
    state.duringUpload = () => replaceConnection(change);
    await expect(uploadOtherClubsToServer()).rejects.toBeInstanceOf(ServerNzConnectionChangedError);
    expect(state.row.otherLodgesLastUploadAt).toBeNull();
  });

  it.each(["address", "key"] as const)("uses the new connection's whole selection when the %s changes before request capture", async (change) => {
    state.row.otherLodgesLastUploadAt = previousWatermark;
    state.beforeCapture = async () => {
      await replaceConnection(change);
      state.row.otherLodgesOwnedLodges = owned;
    };
    expect((await uploadOtherClubsToServer()).sent).toBe(1);
    expect(state.queries.at(-1)).toEqual({ hiddenAt: null });
  });

  it("advances the watermark when the connection stands", async () => {
    expect((await uploadOtherClubsToServer()).sent).toBe(1);
    expect(state.row.otherLodgesLastUploadAt).toEqual(new Date("2026-06-01T00:00:00.000Z"));
  });
});
