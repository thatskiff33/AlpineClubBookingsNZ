import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";

/**
 * The roster's custodians (#3818): the capacity count's own occupancies, with
 * names. The stored rows below are filtered through the WHERE the real
 * capacity loader sends, so a narrower question (bed only) or a wider one
 * (every assignment) fails here.
 */

const mocks = vi.hoisted(() => ({
  hutLeaderAssignmentFindMany: vi.fn(),
  memberFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    hutLeaderAssignment: { findMany: mocks.hutLeaderAssignmentFindMany },
    member: { findMany: mocks.memberFindMany },
  },
}));

import { findCustodianOccupants } from "@/lib/custodian-occupants";

type StoredRow = {
  id: string;
  bedId: string | null;
  isCustodian: boolean;
  ageTier: string;
};

function store(rows: StoredRow[]) {
  mocks.hutLeaderAssignmentFindMany.mockImplementation(
    async (args: { where: { OR?: Array<Record<string, unknown>> } }) =>
      rows
        .filter((row) =>
          (args.where.OR ?? []).some((clause) =>
            "bedId" in clause ? row.bedId !== null : row.isCustodian === clause.isCustodian,
          ),
        )
        .map((row) => ({
          id: row.id,
          memberId: `m-${row.id}`,
          bedId: row.bedId,
          startDate: parseDateOnly("2026-07-02"),
          endDate: parseDateOnly("2026-07-03"),
        })),
  );
  mocks.memberFindMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    rows
      .filter((row) => args.where.id.in.includes(`m-${row.id}`))
      .map((row) => ({
        id: `m-${row.id}`,
        firstName: row.id,
        lastName: "Ranger",
        ageTier: row.ageTier,
      })),
  );
}

const read = () =>
  findCustodianOccupants({
    lodgeId: "lodge-a",
    from: parseDateOnly("2026-07-01"),
    toExclusive: parseDateOnly("2026-07-10"),
  });

beforeEach(() => {
  mocks.hutLeaderAssignmentFindMany.mockReset();
  mocks.memberFindMany.mockReset();
});

describe("findCustodianOccupants (#3818: the roster's custodians)", () => {
  it("returns a ticked custodian with no bed, a bed holder, and a ticked bed holder once each", async () => {
    store([
      { id: "ticked", bedId: null, isCustodian: true, ageTier: "ADULT" },
      { id: "bed", bedId: "bed-1", isCustodian: false, ageTier: "ADULT" },
      { id: "both", bedId: "bed-2", isCustodian: true, ageTier: "ADULT" },
      { id: "role-only", bedId: null, isCustodian: false, ageTier: "ADULT" },
    ]);
    const found = await read();
    expect(found.map((o) => o.assignmentId)).toEqual(["ticked", "bed", "both"]);
    expect(found[0]).toEqual({
      assignmentId: "ticked",
      memberId: "m-ticked",
      bedId: null,
      startDate: "2026-07-02",
      endDate: "2026-07-03",
      memberFirstName: "ticked",
      memberLastName: "Ranger",
      memberIsMinor: false,
    });
  });

  it("marks a ticked minor custodian so the roster refuses to name them", async () => {
    store([{ id: "kid", bedId: null, isCustodian: true, ageTier: "YOUTH" }]);
    const [found] = await read();
    expect(found?.memberIsMinor).toBe(true);
  });

  it("fails closed: a custodian whose member row is not returned is treated as a minor", async () => {
    store([{ id: "ghost", bedId: null, isCustodian: true, ageTier: "ADULT" }]);
    mocks.memberFindMany.mockResolvedValue([]);
    const [found] = await read();
    expect(found?.memberIsMinor).toBe(true);
    expect(found?.memberFirstName).toBe("");
  });

  it("reads nothing for an empty window, and no names when there is no custodian", async () => {
    const found = await findCustodianOccupants({
      lodgeId: "lodge-a",
      from: parseDateOnly("2026-07-03"),
      toExclusive: parseDateOnly("2026-07-03"),
    });
    expect(found).toEqual([]);
    expect(mocks.hutLeaderAssignmentFindMany).not.toHaveBeenCalled();

    store([]);
    expect(await read()).toEqual([]);
    expect(mocks.memberFindMany).not.toHaveBeenCalled();
  });
});
