import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  createAuditLog: vi.fn(),
  failDelete: false,
  failPushDelete: false,
  failReset: false,
  locked: false,
  stored: { baseUrl: "https://old.example.invalid", otherLodgesEnabled: true, apiKey: "old-key", pushSecret: "old-push-secret", serverVersion: "2.1", otherLodgesOwnedNames: ["Old lodge"] } as Record<string, unknown>,
  transaction: vi.fn(),
  invalidateProviderCredentialCache: vi.fn(),
  removedBy: undefined as unknown,
  pushSecretRemovedBy: undefined as unknown,
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/integration-credentials", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/integration-credentials")),
  deleteIntegrationCredentialInTransaction: async ({ tx, actor, provider, key }: {
    tx: { removeKey: () => void; removePushSecret: () => void }; actor: unknown; provider: string; key: string;
  }) => {
    if (provider !== "servernz") throw new Error(`unexpected provider ${provider}`);
    if (key === "api_key") {
      mocks.removedBy = actor;
      tx.removeKey();
    } else if (key === "push_secret") {
      mocks.pushSecretRemovedBy = actor;
      tx.removePushSecret();
    } else {
      throw new Error(`unexpected key ${key}`);
    }
  },
}));

import { POST } from "@/app/api/admin/alpine-server/settings/route";

function request(body: unknown) {
  return new Request("https://club.example.invalid/api/admin/alpine-server/settings", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "admin-4436", role: "ADMIN", accessRoles: ["ADMIN"] } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.failDelete = false;
  mocks.failPushDelete = false;
  mocks.failReset = false;
  mocks.locked = false;
  mocks.removedBy = undefined;
  mocks.pushSecretRemovedBy = undefined;
  mocks.stored = { baseUrl: "https://old.example.invalid", otherLodgesEnabled: true, apiKey: "old-key", pushSecret: "old-push-secret", serverVersion: "2.1", otherLodgesOwnedNames: ["Old lodge"] };
  mocks.transaction.mockImplementation(async (work) => {
    const staged = structuredClone(mocks.stored);
    const tx = {
      $executeRaw: async () => { mocks.locked = true; },
      serverNzSettings: {
        createMany: vi.fn(),
        findUnique: async () => {
          // A read before taking the lock can race another admin's move.
          if (!mocks.locked) throw new Error("unfenced settings read");
          return staged;
        },
        upsert: async ({ update }: { update: Record<string, unknown> }) => {
          if (mocks.failReset && "serverVersion" in update) throw new Error("reset failed");
          Object.assign(staged, update);
        },
      },
      removeKey: () => {
        if (mocks.failDelete) throw new Error("delete failed");
        staged.apiKey = null;
      },
      removePushSecret: () => {
        if (mocks.failPushDelete) throw new Error("push secret delete failed");
        staged.pushSecret = null;
      },
    };
    const result = await work(tx);
    mocks.stored = staged;
    return result;
  });
});

describe("central-server settings replacement (#4436)", () => {
  it("commits the new address, key removal and both answer resets together", async () => {
    const response = await POST(request({ baseUrl: "https://new.example.invalid/" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ baseUrl: "https://new.example.invalid", otherLodgesEnabled: true, apiKeyCleared: true });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.stored).toMatchObject({ baseUrl: "https://new.example.invalid", apiKey: null, serverVersion: null, otherLodgesOwnedNamesAt: null, serverVersionCheckedAt: null });
    expect(mocks.stored.otherLodgesOwnedNames).not.toEqual(["Old lodge"]);
    // The route names the acting admin once; the helper forwards that actor to
    // the key removal and records its member as the row's editor (#2723).
    expect(mocks.removedBy).toEqual({ kind: "admin", memberId: "admin-4436" });
    expect(mocks.stored.updatedByMemberId).toBe("admin-4436");
  });

  it("removes the old server's push secret in the same transaction, so the next sync registers with the new one (#4470)", async () => {
    expect((await POST(request({ baseUrl: "https://new.example.invalid" }))).status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.stored.pushSecret).toBeNull();
    // Every sync position goes with it (the shared-feed and Other lodges cursors).
    expect(mocks.stored).toMatchObject({
      otherLodgesCursor: null, otherLodgesLastUploadAt: null, otherLodgesLastDownloadAt: null,
      commsCursorSince: null, commsCursorSinceId: null, commsLastSyncAt: null,
    });
    expect(mocks.pushSecretRemovedBy).toEqual({ kind: "admin", memberId: "admin-4436" });
  });

  it.each(["failDelete", "failPushDelete", "failReset"] as const)("rolls the address and key back when %s", async (failure) => {
    const before = structuredClone(mocks.stored);
    mocks[failure] = true;
    await expect(POST(request({ baseUrl: "https://new.example.invalid" }))).rejects.toThrow(/failed/);
    expect(mocks.stored).toEqual(before);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it.each([{ baseUrl: "https://old.example.invalid/" }, { otherLodgesEnabled: false }])("retains the key and answers when the address stays the same: %j", async (body) => {
    expect((await POST(request(body))).status).toBe(200);
    expect(mocks.stored.apiKey).toBe("old-key");
    expect(mocks.stored.pushSecret).toBe("old-push-secret");
    expect(mocks.stored.serverVersion).toBe("2.1");
    expect(mocks.stored.otherLodgesOwnedNames).toEqual(["Old lodge"]);
  });

  it("clears the key on removing the address", async () => {
    const response = await POST(request({ baseUrl: "" }));
    expect(response.status).toBe(200);
    expect(mocks.stored).toMatchObject({ baseUrl: null, apiKey: null, pushSecret: null, serverVersion: null });
  });

  it("refuses a finance admin's address move before any write", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "finance-4436", role: "USER", accessRoles: ["FINANCE_ADMIN"] } });
    expect((await POST(request({ baseUrl: "https://new.example.invalid" }))).status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects an unsafe address before opening the transaction", async () => {
    expect((await POST(request({ baseUrl: "http://localhost" }))).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
