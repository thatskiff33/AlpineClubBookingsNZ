import { beforeEach, describe, expect, it, vi } from "vitest";

// Which local lodge a central lodge id means (#62, D5): an explicit link, else
// the one-lodge default, else nothing — and only ever for a lodge the central
// server says this club owns.

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), findMany: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { lodge: { findUnique: mocks.findUnique, findMany: mocks.findMany } },
}));

import { defaultCentralLodgeId, resolveLocalLodgeForCentralId } from "@/lib/central-lodge-link";

const A = { id: "ol_a", name: "Aorangi Ski Club" };
const B = { id: "ol_b", name: "Boomerang Ski Club" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(null);
  mocks.findMany.mockResolvedValue([{ id: "lodge_1", centralLodgeId: null }]);
});

describe("defaultCentralLodgeId (the one-lodge default)", () => {
  it("applies with exactly one owned lodge and exactly one active local lodge", () => {
    expect(defaultCentralLodgeId([A], [{ centralLodgeId: null }])).toBe("ol_a");
    expect(defaultCentralLodgeId([A], [{ centralLodgeId: "ol_a" }])).toBe("ol_a");
  });

  it("does not apply with two of either, none, an unknown owned list, or a lodge linked elsewhere", () => {
    expect(defaultCentralLodgeId([A, B], [{ centralLodgeId: null }])).toBeNull();
    expect(defaultCentralLodgeId([A], [{ centralLodgeId: null }, { centralLodgeId: null }])).toBeNull();
    expect(defaultCentralLodgeId([], [{ centralLodgeId: null }])).toBeNull();
    expect(defaultCentralLodgeId(null, [{ centralLodgeId: null }])).toBeNull();
    expect(defaultCentralLodgeId([A], [{ centralLodgeId: "ol_gone" }])).toBeNull();
  });
});

describe("resolveLocalLodgeForCentralId", () => {
  it("answers nothing for a lodge the club does not own, or while the owned list is unknown, without a query", async () => {
    expect(await resolveLocalLodgeForCentralId("ol_x", [A])).toBeNull();
    expect(await resolveLocalLodgeForCentralId("ol_a", null)).toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("uses an explicit link first, and only while that lodge is active", async () => {
    mocks.findUnique.mockResolvedValue({ id: "lodge_2", active: true });
    expect(await resolveLocalLodgeForCentralId("ol_a", [A, B])).toBe("lodge_2");
    mocks.findUnique.mockResolvedValue({ id: "lodge_2", active: false });
    expect(await resolveLocalLodgeForCentralId("ol_a", [A, B])).toBeNull();
  });

  it("falls back to the one-lodge default when nothing is linked", async () => {
    expect(await resolveLocalLodgeForCentralId("ol_a", [A])).toBe("lodge_1");
  });

  it("gives no default when the club has two active lodges or owns two central ones", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "lodge_1", centralLodgeId: null },
      { id: "lodge_2", centralLodgeId: null },
    ]);
    expect(await resolveLocalLodgeForCentralId("ol_a", [A])).toBeNull();
    mocks.findMany.mockResolvedValue([{ id: "lodge_1", centralLodgeId: null }]);
    expect(await resolveLocalLodgeForCentralId("ol_a", [A, B])).toBeNull();
  });
});
