/**
 * The definitions read's cleanup (#4513): it rolls back to its savepoint even
 * when the read fails, and a cleanup that fails as well must not hide the
 * read's own error from the operator. Real-PostgreSQL behaviour is proven in
 * `member-money-journal.realdb.test.ts`; this pins the error precedence only.
 */
import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { readMemberMoneyDefinitions } from "@/lib/member-money/internal/verify";

/** A client whose definitions query and savepoint rollback can be made to fail. */
function client({ read, cleanup }: { read?: Error; cleanup?: Error }) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("pg_get_constraintdef") && read) throw read;
    if (sql.startsWith("ROLLBACK TO SAVEPOINT") && cleanup) throw cleanup;
    return { rows: [] };
  });
  return { client: { query } as unknown as Client, query };
}

describe("readMemberMoneyDefinitions cleanup (#4513)", () => {
  it("reports the read's own error when rolling back to the savepoint fails too", async () => {
    const read = new Error("the read failed");
    const { client: failing, query } = client({ read, cleanup: new Error("the cleanup failed") });
    await expect(readMemberMoneyDefinitions(failing)).rejects.toBe(read);
    expect(query.mock.calls.map(([sql]) => String(sql).split(" ").slice(0, 3).join(" ")))
      .toContain("ROLLBACK TO SAVEPOINT");
  });

  it("reports a failed cleanup when the read itself succeeded", async () => {
    const cleanup = new Error("the cleanup failed");
    await expect(readMemberMoneyDefinitions(client({ cleanup }).client)).rejects.toBe(cleanup);
  });

  it("rolls back to and releases its savepoint after a successful read", async () => {
    const { client: ok, query } = client({});
    await expect(readMemberMoneyDefinitions(ok)).resolves.toEqual([]);
    expect(query.mock.calls.slice(-2).map(([sql]) => sql)).toEqual([
      "ROLLBACK TO SAVEPOINT member_money_definitions",
      "RELEASE SAVEPOINT member_money_definitions",
    ]);
  });
});
