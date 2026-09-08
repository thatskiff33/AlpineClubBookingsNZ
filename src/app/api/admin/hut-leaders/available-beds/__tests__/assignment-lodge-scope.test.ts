import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #2678 surface 2 — a named assignment fixes the lodge, and the server owns it.
 *
 * The hut-leader bed picker took `assignmentId` and `lodgeId` as unrelated
 * parameters and never reconciled them, so a request naming assignment A at
 * lodge B was answerable and returned lodge B's beds. The row-edit caller passes
 * the right thing today, so nothing was exploitable — but the reason it was safe
 * was a guard somewhere else (`custodian-assignment.ts`'s `BED_WRONG_LODGE`
 * refusal on the write), not the read being correct. That is the #2664 shape,
 * and the walkthrough decision on #2678 is to derive the lodge from the
 * assignment and ignore a contradicting `lodgeId`.
 *
 * The create form has no `assignmentId` and keeps using the chosen lodge — the
 * fourth test below is what stops this fix breaking it.
 */
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  isEffectiveModuleEnabled: vi.fn(),
  listCustodianBedOptions: vi.fn(),
  assignmentFindUnique: vi.fn(),
  lodgeFindUnique: vi.fn(),
  getDefaultLodgeId: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mocks.requireAdmin(...args),
}));
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: (...args: unknown[]) =>
    mocks.isEffectiveModuleEnabled(...args),
}));
vi.mock("@/lib/custodian-assignment", () => ({
  listCustodianBedOptions: (...args: unknown[]) =>
    mocks.listCustodianBedOptions(...args),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    hutLeaderAssignment: {
      findUnique: (...args: unknown[]) => mocks.assignmentFindUnique(...args),
    },
    lodge: { findUnique: (...args: unknown[]) => mocks.lodgeFindUnique(...args) },
  },
}));
// `resolveOptionalActiveLodgeId` is left REAL so the active-lodge validation it
// performs is exercised rather than assumed; only its two reads are doubled.
vi.mock("@/lib/lodges", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/lodges");
  return {
    ...actual,
    getDefaultLodgeId: (...args: unknown[]) => mocks.getDefaultLodgeId(...args),
  };
});

import { GET } from "@/app/api/admin/hut-leaders/available-beds/route";

function call(query: string) {
  return GET(
    new NextRequest(
      `http://localhost/api/admin/hut-leaders/available-beds?${query}`,
    ),
  );
}

const DATES = "startDate=2027-07-01&endDate=2027-07-03";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true });
  mocks.isEffectiveModuleEnabled.mockResolvedValue(true);
  mocks.listCustodianBedOptions.mockResolvedValue([]);
  // Every lodge in these fixtures is active unless a test says otherwise.
  mocks.lodgeFindUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      active: true,
    }),
  );
});

describe("GET /api/admin/hut-leaders/available-beds — assignment fixes the lodge (#2678)", () => {
  it("derives the lodge from the assignment and IGNORES a contradicting lodgeId", async () => {
    mocks.assignmentFindUnique.mockResolvedValue({ lodgeId: "lodge-a" });

    const res = await call(`${DATES}&assignmentId=asg-1&lodgeId=lodge-b`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ lodgeId: "lodge-a" });
    expect(mocks.listCustodianBedOptions).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-a", assignmentId: "asg-1" }),
    );
  });

  it("derives it when no lodgeId is sent at all", async () => {
    // Without this the request would fall through to the club's DEFAULT lodge,
    // which is a different lodge's beds offered against a real assignment.
    mocks.assignmentFindUnique.mockResolvedValue({ lodgeId: "lodge-a" });
    mocks.getDefaultLodgeId.mockResolvedValue("lodge-default");

    const res = await call(`${DATES}&assignmentId=asg-1`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ lodgeId: "lodge-a" });
    expect(mocks.getDefaultLodgeId).not.toHaveBeenCalled();
  });

  it("still validates the derived lodge is active", async () => {
    // The honest caller already sent this lodge and already got a 400 for it, so
    // deriving it changes nothing here — but a derived lodge must not skip the
    // check the caller-supplied one gets.
    mocks.assignmentFindUnique.mockResolvedValue({ lodgeId: "lodge-archived" });
    mocks.lodgeFindUnique.mockResolvedValue({
      id: "lodge-archived",
      active: false,
    });

    const res = await call(`${DATES}&assignmentId=asg-1&lodgeId=lodge-b`);

    expect(res.status).toBe(400);
    expect(mocks.listCustodianBedOptions).not.toHaveBeenCalled();
  });

  it("leaves the CREATE form alone: no assignmentId means the chosen lodge wins", async () => {
    const res = await call(`${DATES}&lodgeId=lodge-b`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ lodgeId: "lodge-b" });
    expect(mocks.assignmentFindUnique).not.toHaveBeenCalled();
    expect(mocks.listCustodianBedOptions).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-b", assignmentId: undefined }),
    );
  });

  it("falls back to the caller's lodge when the assignmentId resolves to nothing", async () => {
    // A stale id is not an authorisation event: the caller's own scope still
    // applies, and the id is only an exclusion hint downstream.
    mocks.assignmentFindUnique.mockResolvedValue(null);

    const res = await call(`${DATES}&assignmentId=gone&lodgeId=lodge-b`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ lodgeId: "lodge-b" });
    expect(mocks.listCustodianBedOptions).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-b", assignmentId: "gone" }),
    );
  });
});
