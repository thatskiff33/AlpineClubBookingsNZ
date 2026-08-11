/**
 * The RUNTIME half of `database.ts` (#2374, ADR-007), against a fake `pg` pool.
 *
 * `database.test.ts` covers the two pure functions — connection-string vetting and
 * the privilege verdict. Everything else in that module used to be exercised only
 * by the opt-in real-PostgreSQL proof, which `describe.skip`s itself without
 * `RUN_CONCURRENCY_RACE_TESTS=1`. That left the pool cache, the readiness mapping,
 * and the exact SQL the executor sends with no coverage in ordinary `npm test`.
 *
 * Two things here are deliberately asserted as EXACT STRINGS rather than
 * behaviourally, because they are the substrate's structural guarantees and a fake
 * database cannot demonstrate their effect:
 *
 *  - the `LIMIT` wrapper and its parameter numbering, which is the reason a tool
 *    cannot ship an unbounded scan by omission. Every shipped entry binds zero
 *    parameters today, so the non-empty-parameter path first runs in production when
 *    a tool pack (AID-6A/B/C) lands — hard-coding `$1` or prepending the limit
 *    instead of appending it would pass every other test in the tree.
 *  - the four `SET LOCAL` statements and `BEGIN READ ONLY`, in order.
 *
 * The real PostgreSQL suite then proves the database AGREES with all of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability-bridge", () => ({ reportAiError: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * The fake `pg` module, built inside `vi.hoisted` because `vi.mock` factories are
 * lifted above every top-level binding in the file.
 */
const pg = vi.hoisted(() => {
  interface Recorded {
    sql: string;
    values?: unknown[];
  }

  /** A least-privilege report, as the probe query would return it. */
  const SAFE_PRIVILEGE_ROW = {
    role_name: "ai_diagnostics_ro",
    is_superuser: false,
    can_create_db: false,
    can_create_role: false,
    can_replicate: false,
    bypasses_rls: false,
    can_create_temp_tables: false,
    can_create_in_database: false,
    can_create_in_public_schema: false,
    can_read_server_files: false,
    role_memberships: 0,
    forbidden_role_memberships: 0,
    forbidden_role_names: [] as string[],
    writable_relations: 0,
    undeclared_readable_relations: 0,
    table_wide_select_on_column_restricted_relations: 0,
    undeclared_readable_columns: 0,
    missing_readable_relations: 0,
    missing_readable_columns: 0,
    executable_security_definer_routines: 0,
  };

  /** Mutable fixture the fake pool reads. Reset in `beforeEach`. */
  const fixture: {
    privilegeRow: Record<string, unknown> | undefined;
    probeError: Error | null;
    /** Resolves after this many ticks, so concurrent callers really do overlap. */
    probeDelayTicks: number;
    /** When true the probe never settles at all — the black-holed-network case. */
    probeNeverSettles: boolean;
    clientError: (Error & { code?: string }) | null;
    readRows: Record<string, unknown>[];
  } = {
    privilegeRow: { ...SAFE_PRIVILEGE_ROW },
    probeError: null,
    probeDelayTicks: 0,
    probeNeverSettles: false,
    clientError: null,
    readRows: [],
  };

  class FakeClient {
    queries: Recorded[] = [];
    released = 0;

    async query(sql: string, values?: unknown[]) {
      this.queries.push({ sql, values });
      // Only the tool statement can fail; the transaction scaffolding does not.
      if (fixture.clientError && sql.includes("diagnostics_tool_result")) {
        throw fixture.clientError;
      }
      return { rows: fixture.readRows };
    }

    release() {
      this.released += 1;
    }
  }

  const pools: FakePool[] = [];

  class FakePool {
    options: Record<string, unknown>;
    clients: FakeClient[] = [];
    poolQueries: Recorded[] = [];
    errorHandlers: ((err: unknown) => void)[] = [];
    ended = 0;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      pools.push(this);
    }

    on(event: string, handler: (err: unknown) => void) {
      if (event === "error") this.errorHandlers.push(handler);
      return this;
    }

    async query(sql: string, values?: unknown[]) {
      this.poolQueries.push({ sql, values });
      for (let tick = 0; tick < fixture.probeDelayTicks; tick += 1) {
        await Promise.resolve();
      }
      if (fixture.probeNeverSettles) {
        // A socket that stays open and never answers. `pg`'s own `query_timeout`
        // would fire here in production; this stands in for the case where nothing
        // client-side bounds the round trip.
        await new Promise(() => {});
      }
      if (fixture.probeError) throw fixture.probeError;
      return { rows: fixture.privilegeRow ? [fixture.privilegeRow] : [] };
    }

    async connect() {
      const client = new FakeClient();
      this.clients.push(client);
      return client;
    }

    async end() {
      this.ended += 1;
    }
  }

  return { SAFE_PRIVILEGE_ROW, fixture, pools, FakePool };
});

const { SAFE_PRIVILEGE_ROW, fixture, pools } = pg;

vi.mock("pg", () => ({ Pool: pg.FakePool, Client: pg.FakePool }));

import {
  frozenTestNow,
  installFrozenTestClock,
} from "@/lib/__tests__/helpers/clock";
import logger from "@/lib/logger";
import { reportAiError } from "@/lib/observability-bridge";

import {
  AI_DIAGNOSTICS_DATABASE_URL_ENV,
  checkDiagnosticsDatabaseReadiness,
  closeDiagnosticsDatabase,
  DIAGNOSTICS_APPLICATION_NAME,
  FORBIDDEN_SERVER_FILE_FUNCTIONS,
  getDiagnosticsDatabase,
  runDiagnosticsReadOnlyQuery,
} from "../database";
import { FORBIDDEN_PREDEFINED_ROLES, SELECT_GRANTS } from "../provision-role";
import { DIAGNOSTICS_TOOL_BOUNDS } from "../types";

const DIAG_URL = "postgresql://ai_diagnostics_ro:secret@db:5432/tacbookings";
const APP_URL = "postgresql://tac:apppass@db:5432/tacbookings";

const reportAiErrorMock = vi.mocked(reportAiError);
const loggerMock = vi.mocked(logger);

/** The frozen test clock is a fake `Date`, so a TTL is advanced explicitly. */
function advanceClock(ms: number): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

beforeEach(async () => {
  await closeDiagnosticsDatabase();
  vi.clearAllMocks();
  pools.length = 0;
  fixture.privilegeRow = SAFE_PRIVILEGE_ROW;
  fixture.probeError = null;
  fixture.probeDelayTicks = 0;
  fixture.probeNeverSettles = false;
  fixture.clientError = null;
  fixture.readRows = [];
  process.env.DATABASE_URL = APP_URL;
  process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = DIAG_URL;
});

afterEach(() => {
  // `advanceClock` moves the frozen instant; hand the DEFAULT frozen instant back
  // (never the real clock) so a later test in this file or worker is unaffected.
  vi.setSystemTime(frozenTestNow());
});

describe("getDiagnosticsDatabase — the verified pool (#2374, ADR-007)", () => {
  it("opens ONE pool, bounded and named, and probes privileges once per pool", async () => {
    const first = await getDiagnosticsDatabase();
    const second = await getDiagnosticsDatabase();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) expect(first.roleName).toBe("ai_diagnostics_ro");

    expect(pools).toHaveLength(1);
    expect(pools[0].options).toMatchObject({
      connectionString: DIAG_URL,
      max: DIAGNOSTICS_TOOL_BOUNDS.maxPoolConnections,
      application_name: DIAGNOSTICS_APPLICATION_NAME,
      statement_timeout: DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs,
      // CLIENT-side deadline. `connectionTimeoutMillis` bounds only acquiring a
      // client, and `statement_timeout` is the server cancelling — which needs a
      // reply to travel back. Without `query_timeout` a black-holed connection left
      // the probe pending, and every readiness request joined that same promise.
      query_timeout: DIAGNOSTICS_TOOL_BOUNDS.queryTimeoutMs,
      keepAlive: true,
    });
    // The server's own cancellation must win the ordinary slow-query case, so the
    // client deadline sits ABOVE `statement_timeout` — otherwise a timed-out read
    // comes back as an opaque client abort instead of SQLSTATE 57014.
    expect(DIAGNOSTICS_TOOL_BOUNDS.queryTimeoutMs).toBeGreaterThan(
      DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs,
    );
    expect(DIAGNOSTICS_TOOL_BOUNDS.privilegeProbeTimeoutMs).toBeGreaterThan(
      DIAGNOSTICS_TOOL_BOUNDS.queryTimeoutMs,
    );
    // The verdict is cached per pool within the TTL: eight tool calls in one
    // session pay for one probe.
    expect(pools[0].poolQueries).toHaveLength(1);
    // A pool-level error listener is mandatory — an unhandled one kills the process.
    expect(pools[0].errorHandlers.length).toBeGreaterThan(0);
  });

  it("asks the server about memberships by MEMBER, the file functions and the allowlist", async () => {
    await getDiagnosticsDatabase();
    const probe = pools[0].poolQueries[0];
    // `USAGE` is FALSE for a NOINHERIT role that IS a member, so the old predicate
    // reported zero memberships for a role handed `pg_write_all_data` by hand.
    expect(probe.sql).toContain("pg_has_role(current_user, forbidden.oid, 'MEMBER')");
    expect(probe.sql).not.toContain("'USAGE'");
    // And it asks about EVERY role, not only the eight it can name. The subject is
    // `pg_roles` rather than `pg_auth_members` because `SET ROLE` reachability is
    // transitive — a role granted two hops away is still reachable — and the role's
    // own row is excluded, since every role is a member of itself.
    expect(probe.sql).toContain(
      "pg_has_role(current_user, other.oid, 'MEMBER')",
    );
    expect(probe.sql).toContain("other.oid <> r.oid");
    expect(probe.sql).not.toContain("pg_auth_members");
    // Every overload of every file-reading function, not one hard-coded signature.
    expect(probe.sql).not.toContain("pg_read_file(text)");
    expect(probe.values?.[0]).toEqual([...FORBIDDEN_PREDEFINED_ROLES]);
    expect(probe.values?.[1]).toEqual([...FORBIDDEN_SERVER_FILE_FUNCTIONS]);
    // The declared SELECT allowlist, in the three forms the probe compares against:
    // every declared relation (so a readable relation outside it refuses), every
    // declared COLUMN of a column-restricted relation, and the relations declared
    // for the WHOLE relation (whose columns are all legitimately readable and are
    // therefore skipped by the column count).
    expect(probe.values?.[2]).toEqual(
      SELECT_GRANTS.map((grant) => `${grant.schema}.${grant.relation}`),
    );
    expect(probe.values?.[3]).toEqual(
      SELECT_GRANTS.flatMap((grant) =>
        (grant.columns ?? []).map(
          (column) => `${grant.schema}.${grant.relation}.${column}`,
        ),
      ),
    );
    expect(probe.values?.[4]).toEqual(
      SELECT_GRANTS.filter((grant) => grant.columns === undefined).map(
        (grant) => `${grant.schema}.${grant.relation}`,
      ),
    );
    // Not a vacuous comparison: AID-6A declares at least one column-restricted
    // relation, so the column list is non-empty and the whole-relation list is not
    // the same thing as the relation list.
    expect((probe.values?.[3] as string[]).length).toBeGreaterThan(0);
  });

  it("asks the server for the COLUMNS the role can read, not only the relations", async () => {
    // The gate a column-restricted grant depends on (AID-6A, #2375). A hand-added
    // table-level grant on a relation the allowlist DOES declare leaves the
    // relation-level count at zero while the role gains every withheld column, so
    // the probe has to ask at column granularity or the allowlist is decorative.
    await getDiagnosticsDatabase();
    const probe = pools[0].poolQueries[0];
    expect(probe.sql).toContain("undeclared_readable_columns");
    expect(probe.sql).toContain(
      "table_wide_select_on_column_restricted_relations",
    );
    expect(probe.sql).toContain(
      "pg_catalog.has_column_privilege(current_user, c.oid, a.attnum, 'SELECT')",
    );
    expect(probe.sql).toContain("pg_catalog.pg_attribute");
    // Dropped columns keep their `pg_attribute` row; counting them would refuse a
    // deployment for a column that no longer exists.
    expect(probe.sql).toContain("NOT a.attisdropped");
    // A future whole-relation declaration has no entries in the expected-column
    // list. It is therefore satisfied only by table-level SELECT; one surviving
    // hand-granted column must still count the relation as missing.
    expect(probe.sql).toContain("expected.relation_key = ANY($5::text[])");
    expect(probe.sql).toMatch(
      /expected\.relation_key = ANY\(\$5::text\[\]\)\s+AND pg_catalog\.has_table_privilege\(current_user, c\.oid, 'SELECT'\)/,
    );
    expect(probe.sql).not.toMatch(
      /expected\.relation_key = ANY\(\$5::text\[\]\)\s+AND pg_catalog\.has_any_column_privilege/,
    );
  });

  it("refuses without connecting when the credential is not configured", async () => {
    delete process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV];
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(false);
    if (!handle.ok) {
      expect(handle.reason).toBe("database_not_configured");
      expect(handle.problem).toBe("not_set");
    }
    expect(pools).toHaveLength(0);
  });

  it("refuses without connecting when the credential reuses the application role", async () => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = APP_URL;
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(false);
    if (!handle.ok) expect(handle.problem).toBe("reuses_application_role");
    expect(pools).toHaveLength(0);
  });

  it("re-probes and ends the old pool when the connection string changes", async () => {
    await getDiagnosticsDatabase();
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
      "postgresql://ai_diagnostics_ro:rotated@db:5432/tacbookings";
    const handle = await getDiagnosticsDatabase();

    expect(handle.ok).toBe(true);
    expect(pools).toHaveLength(2);
    expect(pools[0].ended).toBe(1);
    expect(pools[1].poolQueries).toHaveLength(1);
  });

  it.each([
    ["is a superuser", { is_superuser: true }],
    ["can create databases", { can_create_db: true }],
    ["can create roles", { can_create_role: true }],
    ["can replicate", { can_replicate: true }],
    ["bypasses RLS", { bypasses_rls: true }],
    ["can create TEMP tables", { can_create_temp_tables: true }],
    ["can CREATE in the database", { can_create_in_database: true }],
    ["can CREATE in schema public", { can_create_in_public_schema: true }],
    ["can read server files", { can_read_server_files: true }],
    ["belongs to an escalating role", { forbidden_role_memberships: 1 }],
    // The named list is a subset. A membership in an ordinary application role is
    // invisible to every other column here (NOINHERIT), so the TOTAL is the gate.
    ["belongs to ANY other role", { role_memberships: 1 }],
    ["names an escalating role", { forbidden_role_names: ["pg_read_all_data"] }],
    ["can write to a relation", { writable_relations: 1 }],
    ["can read an undeclared relation", { undeclared_readable_relations: 1 }],
    [
      "has table-wide SELECT on a column-restricted relation",
      { table_wide_select_on_column_restricted_relations: 1 },
    ],
    [
      "may execute a SECURITY DEFINER routine",
      { executable_security_definer_routines: 1 },
    ],
    ["is not even the role we vetted", { role_name: "tac" }],
    ], )("refuses the role when the server says it %s", async (_label, drift) => {
    fixture.privilegeRow = { ...SAFE_PRIVILEGE_ROW, ...drift };
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(false);
    if (!handle.ok) {
      expect(handle.reason).toBe("database_role_unsafe");
      // The report travels so readiness can say "repair the role", not "check
      // connectivity" — two different operator actions.
      expect(handle.report).toBeDefined();
    }
  });

  it.each([
    ["a declared relation", { missing_readable_relations: 1 }],
    ["a declared column", { missing_readable_columns: 1 }],
  ] as const)("reports under-provisioning when the role lacks %s", async (_label, drift) => {
    fixture.privilegeRow = { ...SAFE_PRIVILEGE_ROW, ...drift };
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(false);
    if (!handle.ok) expect(handle.reason).toBe("database_grants_missing");
  });

  it("classifies mixed missing and excess privilege as over-privileged", async () => {
    fixture.privilegeRow = {
      ...SAFE_PRIVILEGE_ROW,
      missing_readable_columns: 1,
      undeclared_readable_columns: 1,
    };
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(false);
    if (!handle.ok) expect(handle.reason).toBe("database_role_unsafe");
  });

  it("carries the escalating role NAMES into the report, filtered to our own list", async () => {
    // Names make the alert actionable, so the report carries them — but only names
    // that are in this repository's own eight-name constant. The SQL already restricts
    // the rows, so the second filter cannot change a correct answer; it means a driver,
    // a mock or a future edit cannot put arbitrary server text into what gets logged.
    fixture.privilegeRow = {
      ...SAFE_PRIVILEGE_ROW,
      forbidden_role_memberships: 2,
      forbidden_role_names: ["pg_monitor", "tac_app", "pg_read_all_data"],
    };
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(false);
    if (!handle.ok) {
      expect(handle.report?.forbiddenRoleNames).toEqual([
        "pg_monitor",
        "pg_read_all_data",
      ]);
    }
  });

  it("does NOT cache an unsafe verdict — a repaired role is accepted next call", async () => {
    fixture.privilegeRow = { ...SAFE_PRIVILEGE_ROW, is_superuser: true };
    const refused = await getDiagnosticsDatabase();
    expect(refused.ok).toBe(false);

    // The operator re-runs `npm run diagnostics:provision-role`.
    fixture.privilegeRow = SAFE_PRIVILEGE_ROW;
    const repaired = await getDiagnosticsDatabase();
    expect(repaired.ok).toBe(true);
    // A cached refusal would have required a container restart to clear.
    expect(pools).toHaveLength(2);
    expect(pools[0].ended).toBe(1);
  });

  it("accepts the role however the connection string capitalises it", async () => {
    // PostgreSQL folds an unquoted identifier to lower case, so `AI_Diagnostics_RO`
    // in the URL and `ai_diagnostics_ro` on the server are the same role.
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
      "postgresql://AI_Diagnostics_RO:secret@db:5432/tacbookings";
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(true);
  });

  it("re-probes once the verdict has aged out, on the same pool", async () => {
    // The claim this fixes: the verdict used to be cached for the LIFE OF THE
    // PROCESS on the ok path, so a role escalated by hand kept reporting `verified`
    // until the container restarted — while the module docblock, the operator guide
    // and the release note all promised the drift was caught on the next tool call.
    const first = await getDiagnosticsDatabase();
    expect(first.ok).toBe(true);
    expect(pools[0].poolQueries).toHaveLength(1);

    // Well inside the TTL: still one probe.
    advanceClock(DIAGNOSTICS_TOOL_BOUNDS.rolePrivilegeTtlMs - 1);
    expect((await getDiagnosticsDatabase()).ok).toBe(true);
    expect(pools[0].poolQueries).toHaveLength(1);

    // Past it: the server is asked again, and the drifted answer now refuses.
    advanceClock(1);
    fixture.privilegeRow = { ...SAFE_PRIVILEGE_ROW, is_superuser: true };
    const refused = await getDiagnosticsDatabase();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("database_role_unsafe");
    // Same pool, second probe — not a new connection pool per probe.
    expect(pools).toHaveLength(1);
    expect(pools[0].poolQueries).toHaveLength(2);
  });

  it("re-probes for READINESS too, so the admin screen cannot lag behind", async () => {
    expect((await checkDiagnosticsDatabaseReadiness()).state).toBe("verified");
    advanceClock(DIAGNOSTICS_TOOL_BOUNDS.rolePrivilegeTtlMs);
    fixture.privilegeRow = { ...SAFE_PRIVILEGE_ROW, writable_relations: 4 };
    expect(await checkDiagnosticsDatabaseReadiness()).toEqual({
      state: "over_privileged",
      roleName: null,
    });
  });

  /**
   * Drive the probe deadline without waiting for it in real time. The frozen clock
   * fakes `Date` only, so `setTimeout` here is real; this borrows fake timers for
   * one call and hands the default frozen clock back afterwards.
   */
  async function withDeadlineElapsed<T>(start: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date"],
      now: frozenTestNow(),
    });
    try {
      const pending = start();
      await vi.advanceTimersByTimeAsync(
        DIAGNOSTICS_TOOL_BOUNDS.privilegeProbeTimeoutMs,
      );
      return await pending;
    } finally {
      vi.useRealTimers();
      installFrozenTestClock();
    }
  }

  it("REFUSES rather than hangs when the probe never answers", async () => {
    // A firewall change that black-holes packets, or a pooler that keeps the socket
    // open and never replies. Without a deadline the promise stayed pending — and
    // because it is cached, every later caller joined the same one, so
    // `GET /api/admin/ai-diagnostics/readiness` never returned even after
    // connectivity came back.
    fixture.probeNeverSettles = true;
    const handle = await withDeadlineElapsed(() => getDiagnosticsDatabase());
    expect(handle.ok).toBe(false);
    if (!handle.ok) {
      expect(handle.reason).toBe("database_role_unsafe");
      // No report: we could not ask, as opposed to being told no.
      expect(handle.report).toBeUndefined();
    }

    // And the next call is not stuck behind the abandoned probe.
    fixture.probeNeverSettles = false;
    expect((await getDiagnosticsDatabase()).ok).toBe(true);
  });

  it("reports unverified rather than hanging on the readiness surface", async () => {
    fixture.probeNeverSettles = true;
    const readiness = await withDeadlineElapsed(() =>
      checkDiagnosticsDatabaseReadiness(),
    );
    expect(readiness).toEqual({ state: "unverified", roleName: null });
  });

  it("refuses when the privilege probe cannot be run at all", async () => {
    fixture.probeError = new Error("connection refused");
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(false);
    if (!handle.ok) {
      expect(handle.reason).toBe("database_role_unsafe");
      // No report: we could not ask, as opposed to being told no.
      expect(handle.report).toBeUndefined();
    }
  });

  it("refuses when the probe returns no row for the current role", async () => {
    fixture.privilegeRow = undefined;
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(false);
    if (!handle.ok) expect(handle.reason).toBe("database_role_unsafe");
  });

  it("survives two CONCURRENT callers awaiting the same failing probe", async () => {
    // Both await the one cached probe promise. Each then discards the cache — so
    // the second must not dereference a cache the first already nulled, and must
    // not end a pool a later caller created. Before the entry was captured before
    // the await, this raised a TypeError that surfaced as `internal_error` and lost
    // the real reason from the audit row.
    fixture.probeError = new Error("connection refused");
    fixture.probeDelayTicks = 3;

    const [a, b] = await Promise.all([
      getDiagnosticsDatabase(),
      getDiagnosticsDatabase(),
    ]);

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe("database_role_unsafe");
    if (!b.ok) expect(b.reason).toBe("database_role_unsafe");
    // One pool, shared, and it is ended at most once per caller — never a pool a
    // third caller is still using.
    expect(pools).toHaveLength(1);
  });

  it("survives two CONCURRENT callers awaiting the same UNSAFE verdict", async () => {
    fixture.privilegeRow = { ...SAFE_PRIVILEGE_ROW, can_create_temp_tables: true };
    fixture.probeDelayTicks = 3;

    const [a, b] = await Promise.all([
      getDiagnosticsDatabase(),
      getDiagnosticsDatabase(),
    ]);

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(pools).toHaveLength(1);
  });
});

describe("checkDiagnosticsDatabaseReadiness — VERIFY, never trust (#2374)", () => {
  it("reports not_configured without contacting anything", async () => {
    delete process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV];
    expect(await checkDiagnosticsDatabaseReadiness()).toEqual({
      state: "not_configured",
      roleName: null,
    });
    expect(pools).toHaveLength(0);
  });

  it.each([
    ["not-a-url", "misconfigured"],
    ["mysql://user:pass@db/tacbookings", "misconfigured"],
    ["postgresql://:pass@db:5432/tacbookings", "misconfigured"],
    [APP_URL, "misconfigured"],
  ])("reports %s as %s", async (url, state) => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = url;
    const readiness = await checkDiagnosticsDatabaseReadiness();
    expect(readiness.state).toBe(state);
    expect(readiness.roleName).toBeNull();
  });

  it("reports over_privileged when the server says the role is not SELECT-only", async () => {
    fixture.privilegeRow = { ...SAFE_PRIVILEGE_ROW, is_superuser: true };
    expect(await checkDiagnosticsDatabaseReadiness()).toEqual({
      state: "over_privileged",
      roleName: null,
    });
  });

  it("reports under_provisioned when a declared grant is missing", async () => {
    fixture.privilegeRow = { ...SAFE_PRIVILEGE_ROW, missing_readable_columns: 1 };
    expect(await checkDiagnosticsDatabaseReadiness()).toEqual({
      state: "under_provisioned",
      roleName: null,
    });
  });

  it("reports unverified when the server could not be asked", async () => {
    fixture.probeError = new Error("connection refused");
    expect(await checkDiagnosticsDatabaseReadiness()).toEqual({
      state: "unverified",
      roleName: null,
    });
  });

  it("reports verified with the role name only when the server confirmed it", async () => {
    expect(await checkDiagnosticsDatabaseReadiness()).toEqual({
      state: "verified",
      roleName: "ai_diagnostics_ro",
    });
  });

  it("shares the cached probe with tool invocation rather than re-querying", async () => {
    // One implementation of the check, one probe. A readiness-shaped second copy is
    // how a readiness surface ends up green while the executor refuses.
    await getDiagnosticsDatabase();
    await checkDiagnosticsDatabaseReadiness();
    expect(pools).toHaveLength(1);
    expect(pools[0].poolQueries).toHaveLength(1);
  });
});

describe("runDiagnosticsReadOnlyQuery — the bounded read-only read (#2374)", () => {
  async function run(
    input: Parameters<typeof runDiagnosticsReadOnlyQuery>[0],
  ) {
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(true);
    if (!handle.ok) throw new Error("expected a verified pool");
    const result = await runDiagnosticsReadOnlyQuery(input, handle.pool);
    const client = pools[0].clients.at(-1);
    if (!client) throw new Error("no client was checked out");
    return { result, client };
  }

  it("opens BEGIN READ ONLY, sets every bound and pin, then commits and releases", async () => {
    fixture.readRows = [{ one: 1 }];
    const { result, client } = await run({
      sql: "SELECT 1 AS one",
      params: [],
      rowLimit: 5,
    });

    expect(result.ok).toBe(true);
    expect(client.queries.map((query) => query.sql)).toEqual([
      "BEGIN READ ONLY",
      `SET LOCAL statement_timeout = ${DIAGNOSTICS_TOOL_BOUNDS.statementTimeoutMs}`,
      `SET LOCAL lock_timeout = ${DIAGNOSTICS_TOOL_BOUNDS.lockTimeoutMs}`,
      `SET LOCAL idle_in_transaction_session_timeout = ${DIAGNOSTICS_TOOL_BOUNDS.idleInTransactionTimeoutMs}`,
      // `search_path` pinned so a role- or database-level setting cannot redirect
      // an unqualified relation name in a registry query.
      "SET LOCAL search_path TO public",
      // `TimeZone` pinned for the same reason, as a CORRECTNESS control (AID-6A,
      // #2375): every instant in this platform is a naive `timestamp` holding UTC, so
      // any expression that crosses to `timestamptz` — a comparison against `now()`,
      // or `to_char` after an `AT TIME ZONE` — resolves through the session setting. A
      // deployment set to `Pacific/Auckland` would otherwise shift a window by 12-13
      // hours and stamp a local time with a `Z`.
      "SET LOCAL TimeZone TO 'UTC'",
      "SELECT * FROM (SELECT 1 AS one) AS diagnostics_tool_result LIMIT ($1)::bigint",
      "COMMIT",
    ]);
    expect(client.released).toBe(1);
  });

  it("wraps the entry's SQL and appends the limit AFTER the entry's own parameters", async () => {
    // The numbering is the whole reason this is asserted as an exact string. A
    // registry entry's own `$1`/`$2` must still line up, so the limit has to be the
    // LAST parameter — `$3` here. Every shipped entry binds zero parameters today,
    // so a hard-coded `$1` would pass every other test in the tree and break the
    // first tool pack that takes an argument.
    fixture.readRows = [];
    const { client } = await run({
      sql: 'SELECT id FROM public."Booking" WHERE id = $1 AND status = $2',
      params: ["booking-1", "CONFIRMED"],
      rowLimit: 10,
    });

    const read = client.queries.at(-2);
    expect(read?.sql).toBe(
      'SELECT * FROM (SELECT id FROM public."Booking" WHERE id = $1 AND status = $2) AS diagnostics_tool_result LIMIT ($3)::bigint',
    );
    // rowLimit + 1, so truncation is knowable rather than guessed at.
    expect(read?.values).toEqual(["booking-1", "CONFIRMED", 11]);
  });

  it("asks for rowLimit + 1 rows, clamped to the substrate ceiling", async () => {
    const { client } = await run({
      sql: "SELECT 1",
      params: [],
      rowLimit: DIAGNOSTICS_TOOL_BOUNDS.maxRows * 100,
    });
    expect(client.queries.at(-2)?.values).toEqual([
      DIAGNOSTICS_TOOL_BOUNDS.maxRows + 1,
    ]);
  });

  it.each([0, -5, 0.4])(
    "floors a nonsensical row limit of %s at one row rather than zero",
    async (rowLimit) => {
      // A limit of 0 would return nothing and read as "no rows matched", which is a
      // different and misleading answer.
      const { client } = await run({ sql: "SELECT 1", params: [], rowLimit });
      expect(client.queries.at(-2)?.values).toEqual([2]);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "falls back to the substrate ceiling for a non-finite row limit of %s",
    async (rowLimit) => {
      // `Math.min`/`Math.max` both PROPAGATE NaN, so the clamp used to emit
      // `LIMIT (NaN)` — PostgreSQL rejects it and the read fails as `query_failed`.
      // A bound that turns into an error is not a bound, so a non-finite value
      // resolves to the substrate ceiling instead.
      const { client, result } = await run({
        sql: "SELECT 1",
        params: [],
        rowLimit,
      });
      expect(result.ok).toBe(true);
      expect(client.queries.at(-2)?.values).toEqual([
        DIAGNOSTICS_TOOL_BOUNDS.maxRows + 1,
      ]);
    },
  );

  it("ROLLS BACK and releases when the read fails, and never leaks the driver text", async () => {
    const failure = new Error(
      'syntax error near "SELECT id FROM Member WHERE email = \'member@example.org\'"',
    ) as Error & { code?: string };
    failure.code = "42601";
    fixture.clientError = failure;

    const { result, client } = await run({
      sql: "SELECT 1",
      params: [],
      rowLimit: 1,
      toolId: "diagnostics.substrate_probe",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(false);
      expect(JSON.stringify(result)).not.toContain("member@example.org");
    }
    expect(client.queries.map((query) => query.sql)).toContain("ROLLBACK");
    expect(client.queries.map((query) => query.sql)).not.toContain("COMMIT");
    expect(client.released).toBe(1);

    // The driver's own error object never reaches the bridge. `reportAiError`
    // forwards `err` to `Sentry.captureException` with NO redaction, and a
    // PostgreSQL message can quote a bound parameter verbatim — measured:
    // `invalid input syntax for type uuid: "SECRET@example.org"`. What travels is
    // the SQLSTATE and the server-owned registry key.
    const bridged = reportAiErrorMock.mock.calls
      .map(([call]) => call)
      .filter((call) => call.tag === "diagnostics-tool-query");
    expect(bridged).toHaveLength(1);
    expect(JSON.stringify(bridged[0])).not.toContain("member@example.org");
    expect(bridged[0].context).toEqual({
      toolId: "diagnostics.substrate_probe",
      sqlState: "42601",
    });
    expect(String((bridged[0].err as Error).message)).toContain("42601");
    expect(String((bridged[0].err as Error).message)).not.toContain("syntax error");
  });

  it("reports a statement-timeout cancellation as timedOut, WITHOUT a Sentry alert", async () => {
    const cancelled = new Error(
      "canceling statement due to statement timeout",
    ) as Error & { code?: string };
    cancelled.code = "57014";
    fixture.clientError = cancelled;

    const { result } = await run({ sql: "SELECT 1", params: [], rowLimit: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.timedOut).toBe(true);

    // A timeout is expected, operator-triggerable and self-limiting, and the
    // operator is already told (`query_failed`). Bridging it would raise an
    // error-level Sentry event per heavy question — the alert-fatigue trap #1150
    // rejected. It still reaches the server log.
    expect(
      reportAiErrorMock.mock.calls.filter(
        ([call]) => call.tag === "diagnostics-tool-query",
      ),
    ).toHaveLength(0);
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it("REFUSES a statement that references a placeholder its parameters do not supply", async () => {
    // The row cap is appended as the next `$n`, so an entry one parameter short does
    // not error — PostgreSQL lets the cap serve as that placeholder too. Verified on
    // postgres:16: `… WHERE g > $1 AND g < $2 … LIMIT ($2)` with `[0, 6]` returned
    // five rows and no error, so the tool's own predicate was silently evaluated
    // against the row cap and the result would have been audited as a clean success.
    const handle = await getDiagnosticsDatabase();
    expect(handle.ok).toBe(true);
    if (!handle.ok) return;

    const result = await runDiagnosticsReadOnlyQuery(
      {
        sql: 'SELECT id FROM public."Booking" WHERE "lodgeId" = $1 AND "startDate" >= $2',
        params: ["lodge-1"],
        rowLimit: 10,
        toolId: "diagnostics.example",
      },
      handle.pool,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.timedOut).toBe(false);
    // Refused BEFORE a connection is opened: no client, no transaction, no read.
    expect(pools[0].clients).toHaveLength(0);
    expect(reportAiErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          toolId: "diagnostics.example",
          boundParameters: 1,
          referencedPlaceholders: "1,2",
        },
      }),
    );
  });

  it.each([
    ["a gap in the numbering", "SELECT $1::text AS a, $3::text AS b", ["x", "y", "z"]],
    ["a parameter the SQL never uses", "SELECT $1::text AS a", ["x", "y"]],
    ["a zero-indexed placeholder", "SELECT $0::text AS a", ["x"]],
  ])("refuses %s", async (_label, sql, params) => {
    const handle = await getDiagnosticsDatabase();
    if (!handle.ok) throw new Error("expected a verified pool");
    const result = await runDiagnosticsReadOnlyQuery(
      { sql, params, rowLimit: 5 },
      handle.pool,
    );
    expect(result.ok).toBe(false);
    expect(pools[0].clients).toHaveLength(0);
  });

  it("accepts an entry whose SQL references each of its parameters, in any order", async () => {
    const handle = await getDiagnosticsDatabase();
    if (!handle.ok) throw new Error("expected a verified pool");
    const result = await runDiagnosticsReadOnlyQuery(
      { sql: "SELECT $2::text AS b, $1::text AS a, $1::text AS a_again", params: ["x", "y"], rowLimit: 5 },
      handle.pool,
    );
    expect(result.ok).toBe(true);
  });

  it("returns the driver's rows unchanged — bounding is the executor's job", async () => {
    fixture.readRows = [{ a: 1 }, { a: 2 }];
    const { result } = await run({ sql: "SELECT 1", params: [], rowLimit: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
