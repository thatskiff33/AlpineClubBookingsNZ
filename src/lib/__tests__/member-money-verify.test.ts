/**
 * The definitions read's cleanup (#4513): it rolls back to its savepoint even
 * when the read fails, and a cleanup that fails as well must not hide the
 * read's own error from the operator. Real-PostgreSQL behaviour is proven in
 * `member-money-journal.realdb.test.ts`; this pins the error precedence only.
 */
import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { readMemberMoneyDefinitions, verifyMemberMoneyJournal } from "@/lib/member-money/internal/verify";
import { MEMBER_MONEY_DATABASE_SHAPE } from "@/lib/member-money/internal/database-shape";
import type { ApplicationState } from "@/lib/member-money/internal/application-state";

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

describe("population-wide M4a verification", () => {
  it("reports conservation and reservation failures even when every batch and definition is valid", async () => {
    const state: ApplicationState = {
      sources: [{ id: "receipt", sourceKind: "PAYMENT", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 100,
        debtorKind: "MEMBER", memberId: "member", organisationId: null, currency: "NZD", bookingId: "booking", obligationId: null, capture: "capture", reversed: false }],
      obligations: [{ id: "refund", key: "refund-obligation|review|task", kind: "REFUND", faceCents: 100,
        debtorKind: "MEMBER", memberId: "member", organisationId: null, currency: "NZD" }],
      applications: [{ id: "fund", sourceLineId: "receipt", obligationId: "refund", amountCents: 101, reversesApplicationId: null }],
      reservations: [{ id: "reservation", attemptKey: "attempt", obligationId: "refund", capture: "unfunded-capture", amountCents: 1 }],
    };
    const definitions = (["constraints", "triggers", "uniqueIndexes"] as const).flatMap((kind) =>
      Object.entries(MEMBER_MONEY_DATABASE_SHAPE[kind]).flatMap(([relation, entries]) =>
        Object.entries(entries).map(([name, definition]) => ({ kind, relation, name, definition, usable: true }))));
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_get_constraintdef")) return { rows: definitions };
      if (sql.includes("member_money_application_state")) return { rows: [{ state }] };
      if (sql.includes("member_money_reservation_errors")) return { rows: [{ identity: "reservation", problem: "open_reservation_without_funding" }] };
      if (sql.includes("md5(p.prosrc)")) return { rows: Object.entries(MEMBER_MONEY_DATABASE_SHAPE.functions).map(([name, shape]) => ({ name, ...shape })) };
      if (sql.includes("AS exempt")) return { rows: [{ exempt: false }] };
      return { rows: [] };
    });
    expect(await verifyMemberMoneyJournal({ query } as unknown as Client, "app")).toEqual({ grantCheck: "checked", findings: [
      { identity: "receipt", problem: "C1_source_cap" },
      { identity: "refund-obligation|review|task", problem: "C3_refund_family_cap" },
      { identity: "refund-obligation|review|task:unfunded-capture", problem: "C4_capture_cap" },
      { identity: "reservation", problem: "open_reservation_without_funding" },
    ] });
    expect(query).toHaveBeenCalledWith("SELECT public.member_money_application_state(NULL) AS state");
    state.applications[0].amountCents = 100;
    state.reservations = [];
    expect((await verifyMemberMoneyJournal({ query } as unknown as Client, "app")).findings).toEqual([
      { identity: "reservation", problem: "open_reservation_without_funding" },
    ]);
  });
});
