/**
 * A hut leader on their OWN account is scoped to the lodge whose assignment
 * covers the REQUESTED day (#3029 S1, `INV-PRIV-022`).
 *
 * `getKioskAccessTier` grants `hut-leader` when any assignment at any lodge
 * covers the requested day. The lodge used to come from the assignment covering
 * TODAY (or the default lodge), so a leader of lodge B opening a date inside
 * their B assignment could be served lodge A's guest list — and, since #3029,
 * lodge A's dietary/allergy notes. This drives `resolveKioskLodgeId` over two
 * lodges, and the kiosk grant's own re-check behind it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Assignment = { memberId: string; lodgeId: string; startDate: Date; endDate: Date };
const state = vi.hoisted(() => ({ assignments: [] as Assignment[] }));

/** The subset of Prisma's where the two queries use, over the in-memory rows. */
function matching(where: {
  memberId: string;
  lodgeId?: string;
  startDate: { lte: Date };
  endDate: { gte: Date };
}) {
  return state.assignments.filter(
    (row) =>
      row.memberId === where.memberId &&
      (where.lodgeId === undefined || row.lodgeId === where.lodgeId) &&
      row.startDate <= where.startDate.lte &&
      row.endDate >= where.endDate.gte,
  );
}

const db = {
  hutLeaderAssignment: {
    findMany: vi.fn(async (args: { where: Parameters<typeof matching>[0] }) =>
      matching(args.where).map(({ lodgeId, startDate }) => ({ lodgeId, startDate })),
    ),
    count: vi.fn(async (args: { where: Parameters<typeof matching>[0] }) =>
      matching(args.where).length,
    ),
    findUnique: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: { memberFieldsSettings: { findUnique: async () => ({ showDietaryRequirements: true }) } },
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/lodge-pin-session", () => ({ getActiveLodgePinSessionForRequest: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { resolveKioskLodgeId } from "@/lib/lodge-auth";
import { AmbiguousKioskLodgeError, KioskLodgeUnresolvedError } from "@/lib/lodge-access";
import { grantKioskDietaryAccess } from "@/lib/member-dietary";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const leader = (date: string) =>
  ({ tier: "hut-leader" as const, member: { id: "leader-1" }, date: day(date) });

beforeEach(() => {
  vi.clearAllMocks();
  state.assignments = [
    // Lodge A covers "today" under the frozen clock (1 Jul 2026)...
    { memberId: "leader-1", lodgeId: "lodge-a", startDate: day("2026-06-28"), endDate: day("2026-07-03") },
    // ...lodge B covers a later week.
    { memberId: "leader-1", lodgeId: "lodge-b", startDate: day("2026-08-10"), endDate: day("2026-08-15") },
  ];
});

describe("own-account hut leader lodge scope (#3029 S1)", () => {
  it("a lodge-B leader opening a lodge-B date is scoped to lodge B, not today's lodge A", async () => {
    await expect(resolveKioskLodgeId(leader("2026-08-12"), db as never)).resolves.toBe("lodge-b");
    await expect(resolveKioskLodgeId(leader("2026-07-01"), db as never)).resolves.toBe("lodge-a");
  });

  it("a day no assignment covers is refused, never served the default lodge", async () => {
    await expect(resolveKioskLodgeId(leader("2026-09-01"), db as never)).rejects.toBeInstanceOf(
      KioskLodgeUnresolvedError,
    );
  });

  it("a changeover day belongs to the assignment whose own dates cover it (N4)", async () => {
    state.assignments = [
      { memberId: "leader-1", lodgeId: "lodge-a", startDate: day("2026-08-05"), endDate: day("2026-08-10") },
      { memberId: "leader-1", lodgeId: "lodge-b", startDate: day("2026-08-11"), endDate: day("2026-08-15") },
    ];
    // The 10th is inside A and inside B's day-before window: A's own dates win.
    await expect(resolveKioskLodgeId(leader("2026-08-10"), db as never)).resolves.toBe("lodge-a");
    await expect(resolveKioskLodgeId(leader("2026-08-11"), db as never)).resolves.toBe("lodge-b");
    // The day before B starts, with nothing else covering it, still reaches B.
    state.assignments = [state.assignments[1]!];
    await expect(resolveKioskLodgeId(leader("2026-08-10"), db as never)).resolves.toBe("lodge-b");
  });

  it("assignments at two lodges on the same day are refused as ambiguous", async () => {
    state.assignments.push({
      memberId: "leader-1",
      lodgeId: "lodge-c",
      startDate: day("2026-08-11"),
      endDate: day("2026-08-13"),
    });
    await expect(resolveKioskLodgeId(leader("2026-08-12"), db as never)).rejects.toBeInstanceOf(
      AmbiguousKioskLodgeError,
    );
  });
});

describe("the kiosk dietary grant re-checks the leader's lodge and day (#3029 S1)", () => {
  const access = (lodgeId: string, date: string, pinSession?: unknown) => ({
    tier: "hut-leader" as const,
    actorMemberId: "leader-1",
    lodgeId,
    date: day(date),
    presentGuestIds: ["g1"],
    ...(pinSession ? { pinSession } : {}),
  });

  it("grants only for an assignment at THIS lodge covering THIS day", async () => {
    const options = { enabled: true, db: db as never };
    expect(await grantKioskDietaryAccess(access("lodge-b", "2026-08-12"), options)).not.toBeNull();
    // Lodge A on a lodge-B day: the route's resolution should never produce
    // this, and the grant refuses it anyway.
    expect(await grantKioskDietaryAccess(access("lodge-a", "2026-08-12"), options)).toBeNull();
  });

  it("a PIN session is judged by its own assignment and skips the re-read", async () => {
    const grant = await grantKioskDietaryAccess(
      access("lodge-a", "2026-08-12", { assignmentId: "x", memberId: "leader-1" }),
      { enabled: true, db: db as never },
    );
    expect(grant).not.toBeNull();
    expect(db.hutLeaderAssignment.count).not.toHaveBeenCalled();
  });
});
