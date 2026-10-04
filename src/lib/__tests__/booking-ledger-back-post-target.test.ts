/**
 * The back-post's wrong-database fence (#3583 review, L2): `--apply` refuses
 * unless the operator names the database `DATABASE_URL` points at.
 */
import { describe, expect, it } from "vitest";

import { describeBackPostTarget } from "@/lib/booking-ledger-back-post-report";

const URL_ = "postgresql://app:secret@db.internal:5432/tacbookings";

describe("the back-post names its target and fences --apply on it", () => {
  it("prints the host and database, never the password, and a dry run needs no confirmation", () => {
    const target = describeBackPostTarget(URL_, { apply: false, confirmDatabase: null });
    expect(target).toBe("Target: host db.internal:5432, database tacbookings");
    expect(target).not.toContain("secret");
  });

  it("--apply runs only with the matching --confirm-database", () => {
    expect(describeBackPostTarget(URL_, { apply: true, confirmDatabase: "tacbookings" })).toContain("database tacbookings");
    expect(() => describeBackPostTarget(URL_, { apply: true, confirmDatabase: null })).toThrow("--apply needs --confirm-database tacbookings");
    expect(() => describeBackPostTarget(URL_, { apply: true, confirmDatabase: "tacbookings_copy" })).toThrow("does not name it");
  });

  it("refuses a value that is not a database URL", () => {
    expect(() => describeBackPostTarget("", { apply: false, confirmDatabase: null })).toThrow("not a database URL");
  });
});
