import { describe, expect, it } from "vitest";

import { isRerunnableOperation, rerunnableOperationWhere } from "@/lib/xero-active-operation-statuses";

/*
  #4494 (delta review r2-3, `INV-SSOT`): the in-memory "can run again" rule and the
  query that says it agree on every row - a change to one that misses the other fails here.
*/

type Row = { status: string; replayable: boolean; manuallyResolvedAt: Date | null };

/** Evaluates exactly the where clause's shape: a top-level null filter and an OR of status-in (with replayable) arms. */
function matchesWhere(row: Row): boolean {
  const where = rerunnableOperationWhere() as {
    manuallyResolvedAt: null;
    OR: Array<{ status: { in: string[] }; replayable?: boolean }>;
  };
  if (where.manuallyResolvedAt === null && row.manuallyResolvedAt !== null) return false;
  return where.OR.some((arm) => arm.status.in.includes(row.status) && (arm.replayable === undefined || arm.replayable === row.replayable));
}

const STATUSES = ["PENDING", "RUNNING", "WAITING_PAYMENT", "FAILED", "PARTIAL", "SUCCEEDED", "CANCELLED", "SKIPPED"];
const ROWS: Row[] = STATUSES.flatMap((status) =>
  [true, false].flatMap((replayable) =>
    [null, new Date("2026-06-30T00:00:00.000Z")].map((manuallyResolvedAt) => ({ status, replayable, manuallyResolvedAt })),
  ),
);

describe("isRerunnableOperation", () => {
  it.each(ROWS.map((row) => [`${row.status}, replayable ${row.replayable}, resolved ${row.manuallyResolvedAt !== null}`, row] as const))(
    "agrees with rerunnableOperationWhere for %s",
    (_name, row) => {
      expect(isRerunnableOperation(row)).toBe(matchesWhere(row));
    },
  );

  it("is yes for live rows and replayable FAILED or PARTIAL ones, never a resolved or ended one", () => {
    expect(isRerunnableOperation({ status: "PARTIAL", replayable: true, manuallyResolvedAt: null })).toBe(true);
    expect(isRerunnableOperation({ status: "FAILED", replayable: false, manuallyResolvedAt: null })).toBe(false);
    expect(isRerunnableOperation({ status: "PENDING", replayable: false, manuallyResolvedAt: null })).toBe(true);
    expect(isRerunnableOperation({ status: "PENDING", replayable: true, manuallyResolvedAt: new Date("2026-06-30T00:00:00.000Z") })).toBe(false);
    expect(isRerunnableOperation({ status: "SUCCEEDED", replayable: true, manuallyResolvedAt: null })).toBe(false);
  });
});
