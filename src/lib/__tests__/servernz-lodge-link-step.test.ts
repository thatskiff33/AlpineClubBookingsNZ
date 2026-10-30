import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The setup page's lodge step after a key save (server onboarding, B2): pull
 * the server's lodges, then offer the choice with the one-to-one link
 * preselected. Nothing is linked until the administrator saves (#4262).
 */

const mocks = vi.hoisted(() => ({
  loadServerNzSettings: vi.fn(),
  assertStoredServerVersionMatches: vi.fn(),
  download: vi.fn(),
  claim: vi.fn(),
  lodgeFindMany: vi.fn(),
  saveLinks: vi.fn(),
  labelOwned: vi.fn(),
  feesSync: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/servernz-settings", () => ({ loadServerNzSettings: mocks.loadServerNzSettings }));
vi.mock("@/lib/servernz-api", () => ({ assertStoredServerVersionMatches: mocks.assertStoredServerVersionMatches }));
vi.mock("@/lib/servernz-other-lodges-sync", () => ({ downloadOtherClubsFromServer: mocks.download }));
vi.mock("@/lib/servernz-sync-claim", () => ({ withOtherLodgesSyncClaim: mocks.claim }));
vi.mock("@/lib/prisma", () => ({ prisma: { lodge: { findMany: mocks.lodgeFindMany } } }));
vi.mock("@/lib/other-lodge-fees-sync", () => ({ syncOwnOtherLodgesFromFees: mocks.feesSync }));
vi.mock("@/lib/servernz-sync-response", () => ({ auditDownload: mocks.audit }));
vi.mock("@/lib/central-lodge-link", async (importOriginal) => ({
  // The real suggestion rule; the writer and the labels are doubles.
  suggestedCentralLodgeId: ((await importOriginal()) as typeof import("@/lib/central-lodge-link")).suggestedCentralLodgeId,
  saveCentralLodgeLinks: mocks.saveLinks,
  labelOwnedLodges: mocks.labelOwned,
}));

import { runLodgeLinkStep, saveLodgeLinkChoices } from "@/lib/servernz-lodge-link-step";

const ACS_A = { id: "c_a", name: "Whakapapa Lodge" };
const ACS_B = { id: "c_b", name: "Turoa Lodge" };
const lodge = (id: string, centralLodgeId: string | null = null, active = true) => ({
  id,
  name: `Lodge ${id}`,
  active,
  centralLodgeId,
});

function settings(owned: Array<{ id: string; name: string }> | null, enabled = true) {
  mocks.loadServerNzSettings.mockResolvedValue({
    otherLodgesEnabled: enabled,
    baseUrl: "https://acs.example.nz",
    serverVersion: "2.4",
    otherLodgesOwnedLodges: owned,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claim.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  mocks.download.mockResolvedValue({ fetched: 2, created: 1, updated: 0, hiddenLodges: [], stopped: null });
  mocks.saveLinks.mockResolvedValue({ ok: true, before: [] });
  mocks.labelOwned.mockImplementation(async (owned: Array<{ id: string; name: string }>) =>
    owned.map((l) => ({ ...l, label: l.name })),
  );
  mocks.feesSync.mockResolvedValue([]);
});

describe("runLodgeLinkStep", () => {
  it("downloads first, under the sync claim, then offers one lodge its one owned lodge preselected, saving nothing (#4262)", async () => {
    settings([ACS_A]);
    mocks.lodgeFindMany.mockResolvedValue([lodge("l1")]);
    const result = await runLodgeLinkStep("admin-1");
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ fetched: 2 }), "admin-1", expect.any(String));
    expect(result).toEqual({
      download: "downloaded",
      step: {
        kind: "choose",
        lodges: [{ ...lodge("l1"), suggestedCentralLodgeId: "c_a" }],
        owned: [{ ...ACS_A, label: ACS_A.name }],
      },
    });
    expect(mocks.saveLinks).not.toHaveBeenCalled();
    expect(mocks.feesSync).not.toHaveBeenCalled();
  });

  it("reports an existing one-to-one link and writes nothing", async () => {
    settings([ACS_A]);
    mocks.lodgeFindMany.mockResolvedValue([lodge("l1", "c_a")]);
    expect((await runLodgeLinkStep("admin-1")).step).toEqual({ kind: "already-linked" });
    expect(mocks.saveLinks).not.toHaveBeenCalled();
  });

  it("asks rather than overwrite: one lodge linked to something else, or the owned lodge held by an inactive lodge", async () => {
    settings([ACS_A]);
    mocks.lodgeFindMany.mockResolvedValue([lodge("l1", "c_gone")]);
    expect((await runLodgeLinkStep("admin-1")).step.kind).toBe("choose");

    mocks.lodgeFindMany.mockResolvedValue([lodge("l1"), lodge("l0", "c_a", false)]);
    const { step } = await runLodgeLinkStep("admin-1");
    expect(step).toMatchObject({
      kind: "choose",
      lodges: [
        { id: "l1", centralLodgeId: null, suggestedCentralLodgeId: null },
        { id: "l0", active: false, centralLodgeId: "c_a" },
      ],
    });
    expect(mocks.saveLinks).not.toHaveBeenCalled();
  });

  it("offers the choice for two lodges or two owned lodges, preselecting nothing it cannot be sure of", async () => {
    settings([ACS_A, ACS_B]);
    mocks.lodgeFindMany.mockResolvedValue([lodge("l1", "c_b")]);
    expect((await runLodgeLinkStep("admin-1")).step).toEqual({
      kind: "choose",
      lodges: [{ ...lodge("l1", "c_b"), suggestedCentralLodgeId: null }],
      owned: [
        { ...ACS_A, label: ACS_A.name },
        { ...ACS_B, label: ACS_B.name },
      ],
    });

    settings([ACS_A]);
    mocks.lodgeFindMany.mockResolvedValue([lodge("l1"), lodge("l2")]);
    expect((await runLodgeLinkStep("admin-1")).step.kind).toBe("choose");
    expect(mocks.saveLinks).not.toHaveBeenCalled();
  });

  it("says when the server lists no lodge for the club, with no dialog", async () => {
    settings([]);
    expect((await runLodgeLinkStep("admin-1")).step).toEqual({ kind: "no-owned" });
    settings(null);
    expect((await runLodgeLinkStep("admin-1")).step).toEqual({ kind: "no-owned" });
    expect(mocks.lodgeFindMany).not.toHaveBeenCalled();
  });

  it("does nothing while Other Clubs sharing is off", async () => {
    settings([ACS_A], false);
    expect(await runLodgeLinkStep("admin-1")).toEqual({ step: { kind: "sharing-off" }, download: "skipped" });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("offers from the stored list when another pass holds the claim, and says so when there is none", async () => {
    settings([ACS_A]);
    mocks.claim.mockResolvedValue(null);
    mocks.lodgeFindMany.mockResolvedValue([lodge("l1")]);
    let result = await runLodgeLinkStep("admin-1");
    expect(result.download).toBe("running");
    expect(result.step.kind).toBe("choose");

    // The key save forgot the list: "none listed" would name the wrong cause.
    settings(null);
    result = await runLodgeLinkStep("admin-1");
    expect(result).toEqual({ download: "running", step: { kind: "download-running" } });
  });

  it("lets a version pause through, before the claim", async () => {
    settings([ACS_A]);
    mocks.assertStoredServerVersionMatches.mockImplementationOnce(() => {
      throw new Error("paused");
    });
    await expect(runLodgeLinkStep("admin-1")).rejects.toThrow("paused");
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});

describe("saveLodgeLinkChoices", () => {
  it("saves every row in one writer call, then fills the own lodge's rates", async () => {
    const links = [
      { lodgeId: "l1", centralLodgeId: "c_b", expectCurrent: "c_a" },
      { lodgeId: "l2", centralLodgeId: "c_a", expectCurrent: null },
    ];
    const audit = vi.fn();
    expect(await saveLodgeLinkChoices(links, "admin-1", audit)).toEqual({ ok: true, before: [] });
    expect(mocks.saveLinks).toHaveBeenCalledWith(links, audit);
    expect(mocks.feesSync).toHaveBeenCalledTimes(1);
  });

  it("fills nothing when the save is refused", async () => {
    mocks.saveLinks.mockResolvedValue({ ok: false, reason: "already-linked", holderName: "Iwikau" });
    await saveLodgeLinkChoices([{ lodgeId: "l1", centralLodgeId: "c_a", expectCurrent: null }], "admin-1", vi.fn());
    expect(mocks.feesSync).not.toHaveBeenCalled();
  });
});
