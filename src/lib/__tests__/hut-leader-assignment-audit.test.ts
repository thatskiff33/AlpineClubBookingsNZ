import { beforeEach, describe, expect, it, vi } from "vitest";

const createAuditLog = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit", () => ({ createAuditLog }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { recordHutLeaderAssignmentAudit } from "@/lib/hut-leader-assignment-audit";

/**
 * The hut-leader assignment row has to say WHICH WAY capacity moved (#2698
 * review A-1), because that is the only thing an operator reconstructing a
 * night from the trail can use it for.
 *
 * Before this, `updated` was one fixed sentence claiming "a bed that was
 * released is bookable again" on every edit — including the edit that does the
 * opposite. The inline bed picker on a role-only assignment TAKES a bed out of
 * the bookable pool, and it is the write the `INV-CAP-035` amendment accept
 * runs through, so the PR's most consequential new capacity event was recorded
 * as its own opposite. `created` and `deleted` already branched; only `updated`
 * took the argument and ignored it.
 *
 * These assert the DIRECTION, not the wording: each case pins the phrase that
 * distinguishes it from its opposite, so restoring the single fixed sentence
 * fails three of the five rather than none.
 */
describe("hut-leader assignment audit detail (#2698)", () => {
  const BASE = {
    actorMemberId: "officer-1",
    subjectMemberId: "member-1",
    assignmentId: "a1",
    lodgeId: "lodge-1",
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    endDate: new Date("2026-07-05T00:00:00.000Z"),
  };
  const PREVIOUS = {
    lodgeId: "lodge-1",
    startDate: BASE.startDate,
    endDate: BASE.endDate,
  };

  beforeEach(() => {
    createAuditLog.mockReset();
    createAuditLog.mockResolvedValue(undefined);
  });

  async function detailsFor(
    input: Parameters<typeof recordHutLeaderAssignmentAudit>[1],
  ): Promise<string> {
    await recordHutLeaderAssignmentAudit({} as never, input);
    return createAuditLog.mock.calls[0][0].details as string;
  }

  it("says a bed was TAKEN when an edit adds one to a role-only assignment", async () => {
    const details = await detailsFor({
      ...BASE,
      event: "updated",
      bedId: "bed-1",
      previous: { ...PREVIOUS, bedId: null },
    });
    expect(details).toContain("out of the bookable pool");
    expect(details).not.toContain("bookable again");
  });

  it("says a bed was RELEASED when an edit clears one", async () => {
    const details = await detailsFor({
      ...BASE,
      event: "updated",
      bedId: null,
      previous: { ...PREVIOUS, bedId: "bed-1" },
    });
    expect(details).toContain("released the bed it was holding");
    expect(details).toContain("bookable again");
  });

  it("says both when an edit MOVES the hold to a different bed", async () => {
    const details = await detailsFor({
      ...BASE,
      event: "updated",
      bedId: "bed-2",
      previous: { ...PREVIOUS, bedId: "bed-1" },
    });
    expect(details).toContain("bookable again");
    expect(details).toContain("out of the bookable pool");
  });

  it("claims no bed movement when an edit keeps the same bed", async () => {
    const details = await detailsFor({
      ...BASE,
      event: "updated",
      bedId: "bed-1",
      previous: { ...PREVIOUS, bedId: "bed-1" },
    });
    expect(details).toContain("went on holding the same bed");
  });

  it("claims no capacity effect at all for a bedless edit", async () => {
    const details = await detailsFor({
      ...BASE,
      event: "updated",
      bedId: null,
      previous: { ...PREVIOUS, bedId: null },
    });
    expect(details).toContain("nothing moved into or out of the bookable pool");
    // And a roster note is not an `important` capacity event.
    expect(createAuditLog.mock.calls[0][0].severity).toBe("info");
  });

  it("still reads the bed off the row for a delete, which carries no previous", async () => {
    const details = await detailsFor({
      ...BASE,
      event: "deleted",
      bedId: "bed-1",
    });
    expect(details).toContain("was holding a bed");
    expect(createAuditLog.mock.calls[0][0].severity).toBe("important");
  });
});
