/**
 * #5265: the command's flags. Run with no flag it must be the census, the mode
 * that writes nothing; only `--apply` writes.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", () => ({ prisma: { $disconnect: vi.fn() } }));

import { parseAuditExpiryBackfillArgs } from "../audit-expiry-backfill";

describe("parseAuditExpiryBackfillArgs", () => {
  it("reads no flags as the census, with nothing confirmed", () => {
    expect(parseAuditExpiryBackfillArgs([])).toEqual({
      mode: "census",
      json: false,
      actor: null,
      confirmTotal: null,
      allowDelete: null,
      batchSize: undefined,
    });
  });

  it("stays a census when only read-only flags are given", () => {
    expect(parseAuditExpiryBackfillArgs(["--json"]).mode).toBe("census");
    expect(parseAuditExpiryBackfillArgs(["--census"]).mode).toBe("census");
    // The numbers alone never switch a run to apply.
    expect(parseAuditExpiryBackfillArgs(["--actor", "m1", "--confirm-total", "4", "--allow-delete", "1"]).mode).toBe(
      "census",
    );
  });

  it("reads each mode flag, and the apply gate's numbers", () => {
    expect(parseAuditExpiryBackfillArgs(["--dry-run"]).mode).toBe("dry-run");
    expect(
      parseAuditExpiryBackfillArgs([
        "--apply",
        "--actor",
        "member-1",
        "--confirm-total",
        "12",
        "--allow-delete",
        "3",
        "--batch-size",
        "250",
      ]),
    ).toEqual({
      mode: "apply",
      json: false,
      actor: "member-1",
      confirmTotal: 12,
      allowDelete: 3,
      batchSize: 250,
    });
  });

  it.each([
    [["--confirm-total"], /--confirm-total needs a whole number/],
    [["--confirm-total", "-1"], /--confirm-total needs a whole number/],
    [["--allow-delete", "1.5"], /--allow-delete needs a whole number/],
    [["--actor", "--apply"], /--actor needs a member id/],
    [["--undo"], /Unknown argument: --undo/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseAuditExpiryBackfillArgs(argv)).toThrow(message);
  });
});
