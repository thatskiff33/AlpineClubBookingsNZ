import { beforeEach, describe, expect, it, vi } from "vitest";

// Cursor persistence route for the reusable wizard shell (#2080): finance view
// to read, finance edit to write, only allowlisted wizard ids.

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getProgress: vi.fn(),
  saveProgress: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/integration-wizard-progress", () => ({
  getIntegrationWizardProgress: mocks.getProgress,
  saveIntegrationWizardProgress: mocks.saveProgress,
}));

import { GET, POST } from "@/app/api/admin/integrations/wizard-progress/route";

function okGuard() {
  return { ok: true as const, session: { user: { id: "admin-1" } } };
}

function get(url: string) {
  return GET(new Request(url));
}
function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/admin/integrations/wizard-progress", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue(okGuard());
});

describe("GET wizard-progress", () => {
  it("returns the persisted cursor for an allowed wizard", async () => {
    mocks.getProgress.mockResolvedValue({
      wizardId: "xero",
      currentStepId: "credentials",
      completedStepIds: [],
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    const res = await get(
      "http://localhost/api/admin/integrations/wizard-progress?wizardId=xero",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.progress.currentStepId).toBe("credentials");
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "view" },
    });
  });

  it("400s an unknown wizard id", async () => {
    const res = await get(
      "http://localhost/api/admin/integrations/wizard-progress?wizardId=evil",
    );
    expect(res.status).toBe(400);
    expect(mocks.getProgress).not.toHaveBeenCalled();
  });

  // #2249: the Lodge Display wizard persists under the SAME finance gate as the
  // provider wizards — the owner decided not to widen the area for it — so the
  // only change the display wizard needed here was its id on the allowlist.
  it("allows the display wizard id, still under the finance gate", async () => {
    mocks.getProgress.mockResolvedValue({
      wizardId: "display",
      currentStepId: "boards",
      completedStepIds: [],
      updatedAt: "2026-07-29T00:00:00.000Z",
    });
    const res = await get(
      "http://localhost/api/admin/integrations/wizard-progress?wizardId=display",
    );
    expect(res.status).toBe(200);
    expect((await res.json()).progress.currentStepId).toBe("boards");
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "view" },
    });
  });
});

describe("POST wizard-progress", () => {
  it("persists a valid cursor under finance edit", async () => {
    mocks.saveProgress.mockResolvedValue({
      wizardId: "xero",
      currentStepId: "connect",
      completedStepIds: [],
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    const res = await post({
      wizardId: "xero",
      currentStepId: "connect",
      completedStepIds: [],
    });
    expect(res.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "edit" },
    });
    expect(mocks.saveProgress).toHaveBeenCalledWith(
      expect.objectContaining({ wizardId: "xero", currentStepId: "connect" }),
    );
  });

  it("400s an unknown wizard id without writing", async () => {
    const res = await post({
      wizardId: "evil",
      currentStepId: "x",
      completedStepIds: [],
    });
    expect(res.status).toBe(400);
    expect(mocks.saveProgress).not.toHaveBeenCalled();
  });

  it("persists the display wizard cursor under finance edit", async () => {
    mocks.saveProgress.mockResolvedValue({
      wizardId: "display",
      currentStepId: "pair",
      completedStepIds: ["config"],
      updatedAt: "2026-07-29T00:00:00.000Z",
    });
    const res = await post({
      wizardId: "display",
      currentStepId: "pair",
      completedStepIds: ["config"],
    });
    expect(res.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "edit" },
    });
    expect(mocks.saveProgress).toHaveBeenCalledWith(
      expect.objectContaining({ wizardId: "display", currentStepId: "pair" }),
    );
  });

  it("403s when the guard rejects", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response("forbidden", { status: 403 }),
    });
    const res = await post({
      wizardId: "xero",
      currentStepId: "connect",
      completedStepIds: [],
    });
    expect(res.status).toBe(403);
    expect(mocks.saveProgress).not.toHaveBeenCalled();
  });
});
