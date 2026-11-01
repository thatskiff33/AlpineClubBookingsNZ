import { beforeEach, describe, expect, it, vi } from "vitest";

// Which local lodge a central lodge id means (#62, D5): the active lodge an
// administrator explicitly linked to it, else nothing — and only ever for a
// lodge the central server says this club owns. Every club links explicitly,
// a one-lodge club included (owner decision, 24 Oct 2026, #4262): there is no
// automatic one-lodge fallback, only a suggestion the card preselects.

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), findMany: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { lodge: { findUnique: mocks.findUnique, findMany: mocks.findMany } },
}));

import {
  centralLinkStatus,
  resolveLocalLodgeForCentralId,
  suggestedCentralLodgeId,
} from "@/lib/central-lodge-link";

const A = { id: "ol_a", name: "Aorangi Ski Club" };
const B = { id: "ol_b", name: "Boomerang Ski Club" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(null);
  mocks.findMany.mockResolvedValue([{ id: "lodge_1", centralLodgeId: null }]);
});

describe("suggestedCentralLodgeId (what the card preselects, never an answer)", () => {
  it("suggests the one owned lodge to a club with exactly one active, unlinked lodge", () => {
    expect(suggestedCentralLodgeId([A], [{ centralLodgeId: null }])).toBe("ol_a");
  });

  it("suggests nothing with two of either, none, an unknown owned list, or a lodge already linked", () => {
    expect(suggestedCentralLodgeId([A, B], [{ centralLodgeId: null }])).toBeNull();
    expect(suggestedCentralLodgeId([A], [{ centralLodgeId: null }, { centralLodgeId: null }])).toBeNull();
    expect(suggestedCentralLodgeId([], [{ centralLodgeId: null }])).toBeNull();
    expect(suggestedCentralLodgeId(null, [{ centralLodgeId: null }])).toBeNull();
    expect(suggestedCentralLodgeId([A], [{ centralLodgeId: "ol_a" }])).toBeNull();
    expect(suggestedCentralLodgeId([A], [{ centralLodgeId: "ol_gone" }])).toBeNull();
  });
});

describe("resolveLocalLodgeForCentralId", () => {
  it("answers nothing for a lodge the club does not own, or while the owned list is unknown, without a query", async () => {
    expect(await resolveLocalLodgeForCentralId("ol_x", [A])).toBeNull();
    expect(await resolveLocalLodgeForCentralId("ol_a", null)).toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("uses the explicit link, and only while that lodge is active", async () => {
    mocks.findUnique.mockResolvedValue({ id: "lodge_2", active: true });
    expect(await resolveLocalLodgeForCentralId("ol_a", [A, B])).toBe("lodge_2");
    mocks.findUnique.mockResolvedValue({ id: "lodge_2", active: false });
    expect(await resolveLocalLodgeForCentralId("ol_a", [A, B])).toBeNull();
  });

  it("answers NOTHING for a one-lodge club that owns one central lodge until the link is saved (#4262)", async () => {
    expect(await resolveLocalLodgeForCentralId("ol_a", [A])).toBeNull();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

describe("centralLinkStatus (what the admin page shows, by the endpoint's own resolver)", () => {
  it("reports a one-lodge club's unsaved suggestion, never as what the lodge answers for", async () => {
    expect(await centralLinkStatus("lodge_1", [A])).toEqual({
      answersFor: null,
      heldBy: null,
      suggested: "ol_a",
    });
  });

  it("suggests nothing to a lodge that is not the club's only active lodge", async () => {
    mocks.findMany.mockResolvedValue([{ id: "lodge_2", centralLodgeId: null }]);
    expect(await centralLinkStatus("lodge_1", [A])).toEqual({ answersFor: null, heldBy: null, suggested: null });
  });

  it("names the holder, and suggests nothing, while another (inactive) lodge holds the link", async () => {
    mocks.findUnique.mockImplementation(async ({ where }: { where: { centralLodgeId: string } }) =>
      where.centralLodgeId === "ol_a" ? { id: "lodge_old", name: "Old Hut", active: false } : null,
    );
    expect(await resolveLocalLodgeForCentralId("ol_a", [A])).toBeNull();
    expect(await centralLinkStatus("lodge_1", [A])).toEqual({ answersFor: null, heldBy: "Old Hut", suggested: null });
  });

  it("reports an explicit link the lodge answers for", async () => {
    mocks.findUnique.mockImplementation(async ({ where }: { where: { centralLodgeId: string } }) =>
      where.centralLodgeId === "ol_b" ? { id: "lodge_1", name: "Whakapapa", active: true } : null,
    );
    expect(await centralLinkStatus("lodge_1", [A, B])).toEqual({ answersFor: "ol_b", heldBy: null, suggested: null });
  });

  it("reports nothing while the owned list is unknown", async () => {
    expect(await centralLinkStatus("lodge_1", null)).toEqual({ answersFor: null, heldBy: null, suggested: null });
  });
});
