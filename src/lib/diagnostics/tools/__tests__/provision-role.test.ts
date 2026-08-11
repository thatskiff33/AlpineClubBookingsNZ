/**
 * The provisioning SQL is public code that decides what a database credential can
 * do, so these tests read like a specification of the role rather than a smoke
 * test of a string builder. Every assertion below corresponds to a clause of
 * ADR-007 §1; the real-PostgreSQL proof
 * (`src/lib/__tests__/ai-diagnostics-select-only-role.realdb.test.ts`) then shows
 * the server agrees.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { statementColumnReads } from "@/lib/__tests__/helpers/diagnostics-statement-reads";

import {
  buildAiDiagnosticsRoleSql,
  DEFAULT_AI_DIAGNOSTICS_ROLE_NAME,
  FORBIDDEN_PREDEFINED_ROLES,
  isSupportedProvisionIdentifier,
  quoteIdentifier,
  quoteLiteral,
  SELECT_GRANTS,
  SUPPORTED_IDENTIFIER_DESCRIPTION,
} from "../provision-role";
import { DIAGNOSTICS_TOOLS } from "../registry";

const base = {
  roleName: "ai_diagnostics_ro",
  password: "a-long-random-provisioning-password",
  databaseName: "tacbookings",
  preserveTempForRoles: ["tac"],
  statementTimeoutMs: 5_000,
  connectionLimit: 6,
};

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");

function documentedGrantCount(document: string, relation: string): number | null {
  const rows = document
    .split(/\r?\n/)
    .filter((candidate) => candidate.trimStart().startsWith("|"))
    .filter((candidate) => {
      const relationCell = candidate.split("|")[1]?.trim();
      return (
        relationCell === `\`${relation}\`` ||
        relationCell === `\`public."${relation}"\``
      );
    });
  if (rows.length !== 1) {
    throw new Error(
      `expected exactly one grant-table row for ${relation}, found ${rows.length}`,
    );
  }
  const grantedCell = rows[0]?.split("|")[2];
  const match = grantedCell?.match(/(\d+)\s+(?:explicitly named\s+)?columns?\b/i);
  return match ? Number(match[1]) : null;
}

function documentedExactGrantSets(document: string): Record<string, string[]> {
  const start = "<!-- ai-diagnostics-exact-grants:start -->";
  const end = "<!-- ai-diagnostics-exact-grants:end -->";
  const startIndex = document.indexOf(start);
  const endIndex = document.indexOf(end);
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error("deployment guide has no canonical exact-grant block");
  }

  const block = document.slice(startIndex + start.length, endIndex);
  const documented: Record<string, string[]> = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^public\."([A-Za-z]+)":\s+(.+)$/);
    if (!match) continue;
    const [, relation, columnText] = match;
    if (documented[relation]) {
      throw new Error(`deployment guide declares ${relation} more than once`);
    }
    const columns = columnText.split(",").map((column) => column.trim());
    if (columns.some((column) => column.length === 0)) {
      throw new Error(`deployment guide declares an empty ${relation} column`);
    }
    documented[relation] = [...columns].sort();
  }
  return documented;
}

function sql(overrides: Partial<typeof base> = {}): string {
  return buildAiDiagnosticsRoleSql({ ...base, ...overrides }).join("\n");
}

/**
 * The catch-all membership sweep, located by its own `DECLARE`. It has to be picked
 * out by something specific: the eight predefined-role revokes now query
 * `pg_auth_members` too, so a substring search for that table would match nine
 * statements and an assertion could pass against the wrong one.
 */
function findMembershipSweep(statements: string[]): string {
  const sweep = statements.find((candidate) =>
    candidate.includes("membership record"),
  );
  expect(sweep, "no catch-all membership sweep statement").toBeDefined();
  return sweep ?? "";
}

describe("AI Diagnostics SELECT-only role provisioning SQL (#2374, ADR-007)", () => {
  it("creates the role idempotently rather than failing on a re-run", () => {
    const statements = buildAiDiagnosticsRoleSql(base);
    expect(statements[0]).toContain("IF NOT EXISTS");
    expect(statements[0]).toContain("pg_catalog.pg_roles");
    expect(statements[0]).toContain("CREATE ROLE %I LOGIN");
  });

  it("pins every attribute that would make the role dangerous", () => {
    const text = sql();
    expect(text).toContain("NOSUPERUSER");
    expect(text).toContain("NOCREATEDB");
    expect(text).toContain("NOCREATEROLE");
    expect(text).toContain("NOREPLICATION");
    expect(text).toContain("NOBYPASSRLS");
    // NOINHERIT so an accidental future role grant does not take effect silently.
    expect(text).toContain("NOINHERIT");
    expect(text).toContain("CONNECTION LIMIT 6");
  });

  it("sets the role's own read-only default and timeouts", () => {
    const text = sql();
    expect(text).toContain("SET default_transaction_read_only = on");
    expect(text).toContain("SET statement_timeout = '5000ms'");
    expect(text).toContain("SET lock_timeout = '5000ms'");
    expect(text).toContain("SET idle_in_transaction_session_timeout = '10000ms'");
    expect(text).toContain("SET search_path = 'public'");
  });

  it("revokes TEMPORARY from PUBLIC and hands it back only to the named roles", () => {
    const text = sql({ preserveTempForRoles: ["tac", "migrator"] });
    // The only way to deny TEMP to one role, because it is a PUBLIC grant.
    expect(text).toContain(
      'REVOKE TEMPORARY ON DATABASE "tacbookings" FROM PUBLIC;',
    );
    expect(text).toContain('GRANT TEMPORARY ON DATABASE "tacbookings" TO "tac";');
    expect(text).toContain(
      'GRANT TEMPORARY ON DATABASE "tacbookings" TO "migrator";',
    );
    // The diagnostics role itself never gets it back.
    expect(text).not.toContain(
      'GRANT TEMPORARY ON DATABASE "tacbookings" TO "ai_diagnostics_ro";',
    );
  });

  it("grants the diagnostics role CONNECT and schema USAGE, and nothing else", () => {
    const text = sql();
    expect(text).toContain(
      'REVOKE ALL PRIVILEGES ON DATABASE "tacbookings" FROM "ai_diagnostics_ro";',
    );
    expect(text).toContain(
      'GRANT CONNECT ON DATABASE "tacbookings" TO "ai_diagnostics_ro";',
    );
    expect(text).toContain(
      'REVOKE ALL PRIVILEGES ON SCHEMA public FROM "ai_diagnostics_ro";',
    );
    expect(text).toContain('GRANT USAGE ON SCHEMA public TO "ai_diagnostics_ro";');
    // Never CREATE anywhere. The word boundaries are load-bearing: the AID-6A
    // allowlist grants the `"createdAt"` COLUMN of `AuditLog`, and a bare
    // substring match would read that grant as a CREATE privilege. The negative
    // control below proves the pattern still catches a real one.
    expect(text).not.toMatch(
      /GRANT[^;]*\bCREATE\b[^;]*TO "ai_diagnostics_ro"/i,
    );
    expect(
      /GRANT[^;]*\bCREATE\b[^;]*TO "ai_diagnostics_ro"/i.test(
        'GRANT CREATE ON SCHEMA public TO "ai_diagnostics_ro";',
      ),
    ).toBe(true);
  });

  it("strips every object privilege and default privilege before granting the allowlist", () => {
    const text = sql();
    expect(text).toContain(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "ai_diagnostics_ro";',
    );
    expect(text).toContain(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM "ai_diagnostics_ro";',
    );
    expect(text).toContain(
      'REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM "ai_diagnostics_ro";',
    );
    expect(text).toContain(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM "ai_diagnostics_ro";',
    );
  });

  it("revokes escalating predefined roles PER GRANTOR, not with a bare REVOKE", () => {
    const statements = buildAiDiagnosticsRoleSql(base);
    for (const predefined of FORBIDDEN_PREDEFINED_ROLES) {
      const statement = statements.find((candidate) =>
        candidate.includes(`'${predefined}'`),
      );
      expect(statement, `no revoke statement for ${predefined}`).toBeDefined();
      // A membership is recorded per grantor, and a REVOKE without GRANTED BY removes
      // only the CURRENT role's own grant — even for a superuser. Measured on
      // postgres:16.14: a `pg_monitor` grant made by a separate deployer role survived
      // a superuser's bare REVOKE, which returned success with only a WARNING.
      expect(statement).toContain("GRANTED BY %I");
      expect(statement).toContain("pg_catalog.pg_auth_members");
      expect(statement).toContain("grantor.oid = m.grantor");
      // The bare form must be gone, not merely accompanied.
      expect(statement).not.toMatch(/REVOKE %I FROM %I'/);
      // The old existence guard is unnecessary once the revoke is driven by recorded
      // rows: a role absent from this server (pg_maintain is PostgreSQL 17+)
      // contributes none.
      expect(statement).not.toContain("IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles");
    }
  });

  it("revokes EVERY remaining role membership, not only the named ones", () => {
    const statements = buildAiDiagnosticsRoleSql(base);
    const sweep = findMembershipSweep(buildAiDiagnosticsRoleSql(base));
    // The named list above is a subset. A membership in an ordinary application role
    // is one `SET ROLE` from that role's privileges and is invisible to every
    // ordinary privilege check, because the role is NOINHERIT — so provisioning
    // strips the lot rather than enumerating what an operator might have granted.
    expect(sweep).toContain("'ai_diagnostics_ro'");
    // Direct grants only, which is complete: a `SET ROLE` chain always starts with a
    // direct edge from this role, so removing every direct edge removes the closure.
    expect(sweep).toContain("WHERE member.rolname = 'ai_diagnostics_ro'");
    expect(statements.length).toBeGreaterThan(0);
  });

  it("carries the GRANTOR into every membership revoke", () => {
    // The defect this replaced: the loop selected `DISTINCT <role name>` and revoked
    // without `GRANTED BY`, which discarded the one column the REVOKE needs. Measured
    // on postgres:16.14 — a membership granted by a deployer role survived a
    // superuser's bare REVOKE, the statement reported success with a WARNING, the DO
    // block committed, and `pg_has_role(…, 'MEMBER')` stayed true.
    const sweep = findMembershipSweep(buildAiDiagnosticsRoleSql(base));
    expect(sweep).toContain("grantor.oid = m.grantor");
    expect(sweep).toContain("GRANTED BY %I");
    expect(sweep).toContain("membership.grantor");
    // The discarding form must be gone, not merely supplemented.
    expect(sweep).not.toContain("SELECT DISTINCT g.rolname");
    expect(sweep).not.toMatch(/REVOKE %I FROM %I'/);
  });

  it("RE-CHECKS after the sweep and raises, so silent survival cannot commit", () => {
    // A PostgreSQL WARNING is not a failure, and the whole point of running this list
    // in one transaction is that a partial run must not commit. The re-check is what
    // makes the operator guide's "rolls back" true.
    const sweep = findMembershipSweep(buildAiDiagnosticsRoleSql(base));
    expect(sweep).toContain("RAISE EXCEPTION");
    expect(sweep).toContain("still a member of");
    // Re-read from `pg_auth_members` and NOT `pg_has_role`: `pg_database_owner` is an
    // implicit membership with no recorded row and nothing to revoke, so a
    // `pg_has_role` re-check would make provisioning impossible for a role that owns
    // its database instead of merely refused at runtime.
    expect(sweep).not.toContain("pg_has_role");
    expect(sweep.indexOf("RAISE EXCEPTION")).toBeGreaterThan(
      sweep.indexOf("END LOOP"),
    );
  });

  it("grants exactly the declared SELECT allowlist, and never a blanket grant", () => {
    // AID-5 shipped an EMPTY allowlist; AID-6A (#2375) adds `AuditLog`, BY COLUMN,
    // for the five audit-correlation tools. The assertion is over the declared list
    // rather than a hard-coded expectation, so it keeps holding as later packs add
    // their own relations — what it pins is the SHAPE of what provisioning emits.
    expect(SELECT_GRANTS.length).toBeGreaterThan(0);
    const statements = sql();

    for (const grant of SELECT_GRANTS) {
      const target = `"${grant.schema}"."${grant.relation}"`;
      if (grant.columns === undefined) {
        expect(statements).toContain(`GRANT SELECT ON ${target} TO`);
        continue;
      }
      // A column list must name at least one column, and the emitted statement must
      // be the COLUMN form — the whole-relation form for a column-restricted entry
      // would be exactly the silent widening the allowlist exists to prevent.
      expect(grant.columns.length).toBeGreaterThan(0);
      const columns = grant.columns.map((column) => `"${column}"`).join(", ");
      expect(statements).toContain(`GRANT SELECT (${columns}) ON ${target} TO`);
      expect(statements).not.toContain(`GRANT SELECT ON ${target} TO`);
    }

    // Never a blanket grant, whatever the allowlist grows to.
    expect(statements).not.toMatch(/GRANT SELECT ON ALL TABLES/i);
    expect(statements).not.toMatch(/GRANT ALL/i);
  });

  it("REFUSES an allowlist entry whose column list is empty", () => {
    // `GRANT SELECT () ON …` is not valid SQL, and emitting the whole-relation form
    // instead would turn a mistake in the allowlist into a table-wide grant.
    expect(() =>
      buildAiDiagnosticsRoleSql({
        ...base,
        selectGrants: [{ schema: "public", relation: "AuditLog", columns: [] }],
      }),
    ).toThrow(/at least one column/i);
  });

  it("REFUSES a column name outside the supported identifier pattern", () => {
    // A column travels into an emitted identifier exactly as a relation name does,
    // so it goes through the same validation rather than being trusted.
    expect(() =>
      buildAiDiagnosticsRoleSql({
        ...base,
        selectGrants: [
          {
            schema: "public",
            relation: "AuditLog",
            columns: ['id" , "ipAddress'],
          },
        ],
      }),
    ).toThrow(/Refusing to build provisioning SQL/i);
  });

  // ------------------------------------------------------------------
  // ORDER. Every assertion above is `toContain` against a joined string, which
  // cannot tell a correct order from a reversed one. These pin the three ordered
  // pairs by INDEX, because each reversal is silently destructive: revoking after
  // granting strips the grant, and granting TEMP back before revoking it from
  // PUBLIC leaves the diagnostics role holding TEMP.
  // ------------------------------------------------------------------
  describe("statement ORDER is load-bearing", () => {
    function indexOfStatement(
      statements: string[],
      fragment: string,
    ): number {
      const index = statements.findIndex((statement) =>
        statement.includes(fragment),
      );
      expect(index, `no statement contains ${fragment}`).toBeGreaterThanOrEqual(0);
      return index;
    }

    it("creates or repairs the role BEFORE altering it", () => {
      const statements = buildAiDiagnosticsRoleSql(base);
      expect(indexOfStatement(statements, "CREATE ROLE %I LOGIN")).toBeLessThan(
        indexOfStatement(statements, "NOSUPERUSER"),
      );
    });

    it("pins NOINHERIT BEFORE sweeping memberships, and sweeps before any grant", () => {
      // Order matters in both directions here. The attribute pin must land first so
      // the role is NOINHERIT for the rest of the run, and the sweep must precede
      // every GRANT so it cannot strip a membership this run was meant to leave in
      // place (there is none today, and the ordering keeps that true by construction).
      const statements = buildAiDiagnosticsRoleSql(base);
      // `membership record` and not the table name: the predefined-role revokes read
      // `pg_auth_members` as well, and this must be the catch-all sweep.
      const sweep = indexOfStatement(statements, "membership record");
      expect(indexOfStatement(statements, "NOINHERIT")).toBeLessThan(sweep);
      expect(sweep).toBeLessThan(
        indexOfStatement(statements, "GRANT CONNECT ON DATABASE"),
      );
      expect(sweep).toBeLessThan(
        indexOfStatement(statements, "GRANT USAGE ON SCHEMA public"),
      );
    });

    it("revokes TEMPORARY from PUBLIC BEFORE granting it back", () => {
      const statements = buildAiDiagnosticsRoleSql({
        ...base,
        preserveTempForRoles: ["tac"],
      });
      expect(
        indexOfStatement(statements, "REVOKE TEMPORARY ON DATABASE"),
      ).toBeLessThan(indexOfStatement(statements, "GRANT TEMPORARY ON DATABASE"));
    });

    it("revokes all database privileges BEFORE granting CONNECT", () => {
      const statements = buildAiDiagnosticsRoleSql(base);
      expect(
        indexOfStatement(statements, "REVOKE ALL PRIVILEGES ON DATABASE"),
      ).toBeLessThan(indexOfStatement(statements, "GRANT CONNECT ON DATABASE"));
    });

    it("revokes all schema privileges BEFORE granting USAGE", () => {
      const statements = buildAiDiagnosticsRoleSql(base);
      expect(
        indexOfStatement(statements, "REVOKE ALL PRIVILEGES ON SCHEMA public"),
      ).toBeLessThan(indexOfStatement(statements, "GRANT USAGE ON SCHEMA public"));
    });

    it("revokes every object and default privilege BEFORE granting the allowlist", () => {
      // The shipped allowlist is empty, so this is the one property the empty list
      // makes untestable without the seam — and it is the one whose reversal would
      // silently strip the grant a future tool pack just added.
      const statements = buildAiDiagnosticsRoleSql({
        ...base,
        selectGrants: [{ schema: "public", relation: "Booking" }],
      });
      const grantIndex = indexOfStatement(
        statements,
        'GRANT SELECT ON "public"."Booking"',
      );
      for (const revoke of [
        "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public",
        "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public",
        "REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES",
      ]) {
        expect(
          indexOfStatement(statements, revoke),
          `${revoke} must run before the allowlist grant`,
        ).toBeLessThan(grantIndex);
      }
      // A grant is per-relation, never blanket, however the allowlist grows.
      expect(statements[grantIndex]).not.toMatch(/ALL TABLES/i);
    });
  });

  it("never mentions a secret-bearing relation", () => {
    const text = sql().toLowerCase();
    for (const relation of [
      "integrationcredential",
      "verificationtoken",
      "passwordreset",
      "twofactor",
      "usersession",
    ]) {
      expect(text).not.toContain(relation);
    }
  });

  it("does not touch PUBLIC's CREATE privilege on schema public", () => {
    // Deliberate: PostgreSQL 15+ already denies it, and revoking it could break a
    // fork whose app role is not a superuser. `database.ts` refuses at runtime if
    // the diagnostics role turns out to hold it.
    expect(sql()).not.toMatch(/REVOKE CREATE ON SCHEMA public FROM PUBLIC/i);
  });

  it("defaults to a role name that is not the application role", () => {
    expect(DEFAULT_AI_DIAGNOSTICS_ROLE_NAME).toBe("ai_diagnostics_ro");
    expect(DEFAULT_AI_DIAGNOSTICS_ROLE_NAME).not.toBe("tac");
  });
});

describe("provisioning SQL quoting refuses hostile input rather than escaping it", () => {
  it.each([
    'evil"; DROP DATABASE tacbookings; --',
    "role name with spaces",
    "1_leading_digit",
    "",
    "a".repeat(64),
    // `$` is legal in a PostgreSQL identifier but is refused here: the same name is
    // also emitted as a SQL LITERAL inside a dollar-quoted `DO $$ … $$` body, and a
    // name containing `$$` would terminate that body early. Quoting cannot save it,
    // so it is refused rather than escaped.
    "role$$name",
    "trailing$",
  ])("refuses identifier %s", (value) => {
    expect(() => quoteIdentifier(value)).toThrow();
  });

  it("keeps the DO-block bodies intact for every accepted role name", () => {
    // The structural reason `$` is barred: each guarded `DO $$ … $$` block must
    // contain exactly one opening and one closing dollar quote.
    for (const statement of buildAiDiagnosticsRoleSql(base)) {
      if (!statement.startsWith("DO $$")) continue;
      expect(statement.match(/\$\$/g)).toHaveLength(2);
      expect(statement.trimEnd().endsWith("$$;")).toBe(true);
    }
  });

  it("refuses a literal containing a DEL character", () => {
    expect(() => quoteLiteral(`del${String.fromCharCode(0x7f)}byte`)).toThrow();
  });

  it("accepts the PascalCase relation names this schema uses", () => {
    expect(quoteIdentifier("IntegrationCredential")).toBe(
      '"IntegrationCredential"',
    );
  });

  // The operator CLI asks this question BEFORE it builds any SQL, so a managed
  // provider's `tac-app` or `user@server` role name is refused with an actionable
  // line naming the variable that carried it, instead of a Node stack trace.
  it.each(["ai_diagnostics_ro", "IntegrationCredential", "_leading_underscore"])(
    "isSupportedProvisionIdentifier accepts %s",
    (value) => {
      expect(isSupportedProvisionIdentifier(value)).toBe(true);
    },
  );

  it.each(["tac-diag-ro", "tac.app", "user@server", "role$$name", ""])(
    "isSupportedProvisionIdentifier refuses %s",
    (value) => {
      expect(isSupportedProvisionIdentifier(value)).toBe(false);
      // …and it is the same answer the builder gives, so the CLI's pre-check can
      // never disagree with what would actually throw.
      expect(() => quoteIdentifier(value)).toThrow();
    },
  );

  it("names the accepted alphabet in a message an operator can act on", () => {
    expect(SUPPORTED_IDENTIFIER_DESCRIPTION).toContain("underscores");
    expect(() => quoteIdentifier("tac-diag-ro")).toThrow(
      /letters, digits and underscores only/,
    );
  });

  it("doubles single quotes in a literal", () => {
    expect(quoteLiteral("it's")).toBe("'it''s'");
    // Safe under standard_conforming_strings, which is PostgreSQL's default.
    expect(quoteLiteral("back\\slash")).toBe("'back\\slash'");
  });

  it("refuses a literal containing control characters", () => {
    expect(() => quoteLiteral("line\nbreak")).toThrow();
    expect(() => quoteLiteral("nul\u0000byte")).toThrow();
  });

  it.each([
    { roleName: 'x"; ALTER ROLE postgres SUPERUSER; --' },
    { databaseName: "db; DROP SCHEMA public" },
    { preserveTempForRoles: ["ok", "not ok"] },
    { statementTimeoutMs: 0 },
    { statementTimeoutMs: 1.5 },
    { connectionLimit: -1 },
  ])("refuses to build SQL for invalid input %o", (overrides) => {
    expect(() =>
      buildAiDiagnosticsRoleSql({ ...base, ...overrides }),
    ).toThrow();
  });

  it("keeps a quote-bearing password inside its literal", () => {
    const text = sql({ password: "pa'ss" });
    expect(text).toContain("PASSWORD 'pa''ss'");
  });
});

/**
 * THE GRANT ALLOWLIST AND THE STATEMENTS, RECONCILED IN BOTH DIRECTIONS.
 *
 * This is the control that makes the SELECT-only role's claim checkable, and it
 * lives here rather than in a pack's own suite because the role is ONE credential
 * shared by every pack: a column granted for AID-6C is readable by an AID-6B
 * statement and vice versa, so a per-pack census can only ever prove a per-pack
 * half of the property.
 *
 * WHY IT IS BEING WRITTEN NOW. AID-6C's `finance-pack.test.ts` docblock promised
 * exactly this — "in BOTH directions… a granted column no statement uses is reach
 * this pack did not argue for" — and the reverse direction was never implemented.
 * `finance-pack.test.ts` built a correctly-keyed `grantedColumns` set and then
 * never passed it to an `expect()`: an unused local that made the docblock look
 * implemented while nothing could fail. Seven granted-but-unread columns survived
 * two releases behind it, and #2376's own grant review is what found them.
 *
 * THE FORWARD DIRECTION IS ALSO STRICTER HERE than the one it replaces. The
 * surviving check in `finance-pack.test.ts` flattened every relation's columns
 * into one un-keyed set, so a column granted on `Payment` satisfied a read of the
 * same-named column on `MemberSubscription`; and its column pattern captured
 * `[A-Za-z]+`, so a column name carrying a digit or an underscore was invisible to
 * it. This resolves `alias -> relation` PER STATEMENT and compares
 * `Relation.column` pairs.
 */
describe("the SELECT-only grant allowlist matches what the statements read", () => {
  const sqlEntries = DIAGNOSTICS_TOOLS.filter(
    (entry): entry is Extract<typeof entry, { source: "select_only_sql" }> =>
      entry.source === "select_only_sql",
  );

  /**
   * The resolver is SHARED with the real-PostgreSQL proof
   * (`src/lib/__tests__/helpers/diagnostics-statement-reads.ts`) rather than
   * declared here, because that suite now asserts the same property from the
   * server's side — a column is readable by the provisioned role if and only if a
   * registered statement reads it. Two copies of this parser would let the
   * declaration-side and server-side halves of that property drift apart while
   * both stayed green.
   */
  const columnReads = statementColumnReads;

  /**
   * The ONLY references allowed to resolve to no base relation: output labels of a
   * derived table, which are not columns of anything and cannot need a grant.
   *
   * Declared rather than ignored. An alias this test cannot resolve is exactly what
   * an ungranted read would look like, so a new one has to be named here — and the
   * three below are named with the statement that produces them, because `n` is
   * ALSO a real alias for `PolicyExceptionReservationNight` in a different
   * statement and a global exemption would have hidden a genuine gap there.
   */
  const DERIVED_TABLE_LABELS: Record<string, readonly string[]> = {
    // `booking_party_state`'s CROSS JOIN LATERAL, which computes a guest's night
    // envelope; these three are its own output labels.
    "diagnostics.booking_party_state": [
      'n."night_count"',
      'n."first_night"',
      'n."last_night"',
    ],
    // `booking_bed_allocation_state`'s LATERAL aggregate identifies and counts
    // another occupant without exposing the aggregate as a base-relation grant.
    "diagnostics.booking_bed_allocation_state": [
      'co."other_guest_ref"',
      'co."other_occupant_count"',
    ],
  };

  const grantedPairs = new Set(
    SELECT_GRANTS.flatMap((grant) =>
      (grant.columns ?? []).map((column) => `${grant.relation}.${column}`),
    ),
  );

  it("resolves every column reference to a base relation or a declared label", () => {
    for (const entry of sqlEntries) {
      const { unattributed } = columnReads(entry.sql);
      expect(
        [...unattributed].sort(),
        `${entry.id} references aliases this test cannot attribute to a relation`,
      ).toEqual([...(DERIVED_TABLE_LABELS[entry.id] ?? [])].sort());
    }
  });

  it("grants every column some statement READS — the 42501 direction", () => {
    // An ungranted column is refused by PostgreSQL at runtime and passes every
    // mock, so this is the direction that decides whether the tool works at all.
    const missing: string[] = [];
    for (const entry of sqlEntries) {
      for (const pair of columnReads(entry.sql).reads) {
        if (!grantedPairs.has(pair)) missing.push(`${entry.id} reads ${pair}`);
      }
    }
    expect(missing.sort()).toEqual([]);
  });

  it("reads every column it GRANTS — the unreviewed-reach direction", () => {
    // The direction that was promised and never implemented. A granted column no
    // statement names is reach nobody argued for, and it does not stay harmless:
    // `PaymentRecoveryOperation."bookingId"` and `ManualRefundTask."bookingId"`
    // were opaque cuids while `Booking` was ungranted, and became a join onto a
    // booking's dates, prices and owner the moment AID-6B granted `Booking`.
    //
    // There is deliberately NO exemption map. A column that no statement reads has
    // no argument for being granted yet, and "yet" is what an exemption list turns
    // into a permanent widening.
    const read = new Set<string>();
    for (const entry of sqlEntries) {
      for (const pair of columnReads(entry.sql).reads) read.add(pair);
    }
    const unread = [...grantedPairs].filter((pair) => !read.has(pair)).sort();
    expect(unread).toEqual([]);
  });

  /**
   * NO STATEMENT MAY QUALIFY A SQL CONSTRUCT AS IF IT WERE A FUNCTION.
   *
   * Over EVERY registered statement, not just one pack's, because the mistake is a
   * property of the "qualify everything with `pg_catalog.`" rule rather than of any
   * pack that follows it.
   *
   * The rule is right and load-bearing — `database.ts` pins `search_path` so that
   * the statements deciding which records an operator can reach cannot depend on
   * schema-resolution order — but it is a rule about FUNCTIONS. The names below are
   * grammar: PostgreSQL's parser turns them into expression nodes and there is no
   * `pg_proc` row to qualify, so `pg_catalog.coalesce(a, b)` is a request for a
   * function that does not exist and fails to plan with SQLSTATE 42883.
   *
   * AID-6B shipped exactly that in the member search's mobile arm. It passed every
   * unit test in this repository, because a mock never plans anything; the opt-in
   * real-PostgreSQL suite caught it on the first run in which an AID-6B statement
   * was executed against a server. This assertion is the cheap version of that
   * proof, and it runs on every pull request rather than only where a database is
   * available.
   */
  const SQL_CONSTRUCTS_THAT_LOOK_LIKE_FUNCTIONS = [
    "coalesce",
    "nullif",
    "greatest",
    "least",
    "cast",
    "extract",
    "overlay",
    "position",
    "trim",
    "collation",
  ];

  it.each(SQL_CONSTRUCTS_THAT_LOOK_LIKE_FUNCTIONS)(
    "never writes pg_catalog.%s — it is grammar, not a catalogued function",
    (construct) => {
      for (const entry of sqlEntries) {
        expect(
          entry.sql.toLowerCase().includes(`pg_catalog.${construct}(`),
          `${entry.id} qualifies ${construct.toUpperCase()} as a function; PostgreSQL refuses that with 42883`,
        ).toBe(false);
      }
    },
  );

  /**
   * THE SIZE OF THE ALLOWLIST, PINNED.
   *
   * Not a ceiling and not a preference — a census, in the same spirit as
   * `AUDIT_CENSUS_TOTALS`. Two documents quote these figures as the reach of the
   * credential (`docs/ai-diagnostics/deployment.md` and
   * `docs/ai-diagnostics/tool-pack-booking-membership.md`), and both were stale by
   * four before #2376 re-measured them: an earlier revision of AID-6B trimmed four
   * granted-but-unread columns and the prose kept saying 248.
   *
   * A pull request that widens or narrows the grant has to change this number and
   * the two documents in the same commit, which is the only mechanism that has ever
   * kept them together.
   */
  it("grants exactly the census the deployment and pack documents quote", () => {
    expect(SELECT_GRANTS.length).toBe(26);
    expect(
      SELECT_GRANTS.reduce((total, grant) => total + (grant.columns?.length ?? 0), 0),
      "update docs/ai-diagnostics/deployment.md and tool-pack-booking-membership.md in the same commit",
    ).toBe(243);
  });

  it("pins the documented column census for every relation, not only the total", () => {
    const expected = {
      AuditLog: 9,
      Payment: 22,
      PaymentTransaction: 12,
      PaymentRefund: 10,
      PaymentRecoveryOperation: 10,
      ManualRefundTask: 6,
      RefundRequest: 7,
      ProcessedWebhookEvent: 6,
      WebhookLog: 7,
      XeroInboundEvent: 9,
      XeroObjectLink: 10,
      XeroSyncOperation: 17,
      Member: 23,
      Booking: 25,
      Lodge: 2,
      BookingGuest: 15,
      MemberPartnerLink: 3,
      BookingGuestNight: 2,
      BedAllocation: 8,
      LodgeRoom: 2,
      LodgeBed: 4,
      BookingChangeRequest: 16,
      PolicyExceptionReservationNight: 1,
      MemberSubscription: 11,
      FamilyGroupMember: 4,
      FamilyGroup: 2,
    } as const;
    expect(
      Object.fromEntries(
        SELECT_GRANTS.map((grant) => [grant.relation, grant.columns?.length ?? 0]),
      ),
      "update both grant tables in deployment.md and tool-pack-booking-membership.md",
    ).toEqual(expected);

    const packDoc = readFileSync(
      join(REPO_ROOT, "docs", "ai-diagnostics", "tool-pack-booking-membership.md"),
      "utf8",
    );
    const deploymentDoc = readFileSync(
      join(REPO_ROOT, "docs", "ai-diagnostics", "deployment.md"),
      "utf8",
    );
    for (const [relation, count] of Object.entries(expected)) {
      expect(documentedGrantCount(packDoc, relation), `${relation} pack count`).toBe(
        count,
      );
      expect(
        documentedGrantCount(deploymentDoc, relation),
        `${relation} deployment count`,
      ).toBe(count);
    }
  });

  it("names this release's readiness answer, and the columns that make it that answer", () => {
    // THE FINDING. Both documents state the precedence rule correctly — excess
    // privilege beats missing grants — but the operator troubleshooting table
    // promised `under_provisioned` after the AID-6B deploy, and that is wrong for
    // the path essentially every deployment is on.
    //
    // AID-6B does not only ADD. It REMOVES seven columns AID-6C granted, forced by
    // this branch's own no-exemption "reads every column it grants" test. So during
    // the documented window a role provisioned for AID-6C holds seven columns the new
    // declaration omits: `isDiagnosticsRolePrivilegeSafe` requires
    // `undeclaredReadableColumns === 0`, `onlyMissingGrants` re-tests safety with only
    // the two missing-grant counters zeroed — and the seven extras survive that
    // zeroing, which is that gate's whole design — so the reason is
    // `database_role_unsafe` and readiness maps it to `over_privileged`.
    //
    // The runtime is CORRECT in both states: each refuses every SQL-backed tool, fail
    // closed. The defect was remediation guidance — an operator whose tools had all
    // failed read `over_privileged` on screen, found no row for it, read the state as
    // documented ("holds a privilege ADR-007 forbids ... or is not even the role the
    // connection string names") and escalated a suspected credential-tampering
    // incident on a Critical security surface, instead of running the provisioner
    // sitting on the row they were told did not apply.
    const REMOVED_BY_THIS_RELEASE: ReadonlyArray<readonly [string, string]> = [
      ["PaymentTransaction", "xeroInvoiceId"],
      ["PaymentRefund", "paymentTransactionId"],
      ["PaymentRefund", "stripePaymentIntentId"],
      ["PaymentRecoveryOperation", "bookingId"],
      ["ManualRefundTask", "bookingId"],
      ["XeroInboundEvent", "source"],
      ["XeroSyncOperation", "entityType"],
    ];
    const packDoc = readFileSync(
      join(REPO_ROOT, "docs", "ai-diagnostics", "tool-pack-booking-membership.md"),
      "utf8",
    );
    const deploymentDoc = readFileSync(
      join(REPO_ROOT, "docs", "ai-diagnostics", "deployment.md"),
      "utf8",
    );

    // 1. The removals are REAL: each relation is still declared and no longer grants
    //    that column. If a future change grants one back, this release's answer stops
    //    being `over_privileged` and the guidance below stops being true.
    for (const [relation, column] of REMOVED_BY_THIS_RELEASE) {
      const grant = SELECT_GRANTS.find((entry) => entry.relation === relation);
      expect(grant, `${relation} is no longer declared at all`).toBeDefined();
      expect(
        grant?.columns ?? [],
        `${relation}."${column}" is granted again; the deploy-window readiness state is no longer over_privileged`,
      ).not.toContain(column);
    }

    // 2. Both documents name the answer AND the reason, so neither can be read as the
    //    smaller problem and neither drifts from the other.
    for (const [name, raw] of [
      ["tool-pack-booking-membership.md", packDoc],
      ["deployment.md", deploymentDoc],
    ] as const) {
      // Whitespace-collapsed, because prose wraps: the phrase below spans a line
      // break in one of the two documents and a raw substring match would pass on
      // one page and fail on the other for a reason that is not about the content.
      const document = raw.replace(/\s+/g, " ");
      expect(document, `${name} does not name over_privileged`).toContain(
        "`over_privileged`",
      );
      // AND THE EXPECTED-STATE MARKER IS ON THE RIGHT ROW. Merely naming
      // `over_privileged` somewhere is not enough — the previous wording named it in
      // the precedence paragraph while the operator table still promised
      // `under_provisioned`, which is the whole defect.
      expect(
        document,
        `${name} attributes the deploy-window state to under_provisioned`,
      ).not.toContain("`under_provisioned` | **THIS IS THE EXPECTED STATE");
      expect(
        document,
        `${name} does not say the removals are what make it that state`,
      ).toContain("REMOVES seven columns AID-6C granted");
      expect(
        document,
        `${name} does not tell the operator when to escalate instead`,
      ).toMatch(/still `over_privileged` after re-provisioning/i);
      // And each names every removed column, so the list cannot rot against the
      // allowlist assertion above.
      for (const [relation, column] of REMOVED_BY_THIS_RELEASE) {
        expect(
          document,
          `${name} does not name ${relation}."${column}"`,
        ).toContain(`${relation}."${column}"`);
      }
    }
  });

  it("publishes the exact grant sets bidirectionally, so a same-count swap fails", () => {
    const deploymentDoc = readFileSync(
      join(REPO_ROOT, "docs", "ai-diagnostics", "deployment.md"),
      "utf8",
    );
    const documented = documentedExactGrantSets(deploymentDoc);
    const declared = Object.fromEntries(
      SELECT_GRANTS.map((grant) => {
        if (!grant.columns) {
          throw new Error(
            `SELECT_GRANTS.${grant.relation} is table-wide; exact docs require columns`,
          );
        }
        return [grant.relation, [...grant.columns].sort()];
      }),
    );

    // Object equality is deliberately BOTH directions: a missing source column,
    // an undocumented grant, an extra documented relation, and a one-for-one
    // column substitution all fail with the relation named.
    expect(documented).toEqual(declared);
  });

  it("grants no relation that no statement reads, and reads none it does not grant", () => {
    const grantedRelations = new Set(SELECT_GRANTS.map((grant) => grant.relation));
    const readRelations = new Set(
      sqlEntries.flatMap((entry) =>
        [...entry.sql.matchAll(/public\."([A-Za-z]+)"/g)].map((match) => match[1]),
      ),
    );
    expect([...readRelations].filter((r) => !grantedRelations.has(r)).sort()).toEqual(
      [],
    );
    expect([...grantedRelations].filter((r) => !readRelations.has(r)).sort()).toEqual(
      [],
    );
  });
});
