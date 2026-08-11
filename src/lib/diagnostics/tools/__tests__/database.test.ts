/**
 * These tests cover the two decisions `database.ts` makes WITHOUT a database: is
 * this connection string acceptable, and is this privilege report acceptable.
 * Both are the fail-closed gates that stop a deployment pointing diagnostics at
 * its superuser, so they are tested exhaustively here and then proven against a
 * real PostgreSQL in
 * `src/lib/__tests__/ai-diagnostics-select-only-role.realdb.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AI_DIAGNOSTICS_DATABASE_URL_ENV,
  isDiagnosticsRolePrivilegeSafe,
  readSqlPlaceholderNumbers,
  REFUSED_DIAGNOSTICS_URL_PARAMETERS,
  resolveDiagnosticsDatabaseConfig,
  type DiagnosticsRolePrivilegeReport,
} from "../database";

const APP_URL = "postgresql://tac:apppw@postgres:5432/tacbookings";
const DIAG_URL =
  "postgresql://ai_diagnostics_ro:diagpw@postgres:5432/tacbookings?connection_limit=3";

let originalApp: string | undefined;
let originalDiag: string | undefined;

beforeEach(() => {
  originalApp = process.env.DATABASE_URL;
  originalDiag = process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV];
  process.env.DATABASE_URL = APP_URL;
});

afterEach(() => {
  if (originalApp === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalApp;
  if (originalDiag === undefined) {
    delete process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV];
  } else {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = originalDiag;
  }
});

describe("resolveDiagnosticsDatabaseConfig (#2374, ADR-007)", () => {
  it("accepts a dedicated role on the same server as the application", () => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = DIAG_URL;
    const result = resolveDiagnosticsDatabaseConfig();
    expect(result).toEqual({
      ok: true,
      url: DIAG_URL,
      roleName: "ai_diagnostics_ro",
    });
  });

  it("fails closed when the variable is absent — there is NO fallback to DATABASE_URL", () => {
    delete process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV];
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "not_set",
    });
  });

  it.each(["", "   "])("treats a blank value (%j) as not set", (value) => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = value;
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "not_set",
    });
  });

  it.each([
    "not-a-url",
    "mysql://user:pw@host:3306/db",
    "http://postgres:5432/tacbookings",
    "file:///tmp/db",
  ])("refuses a non-PostgreSQL or malformed URL: %s", (value) => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = value;
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "malformed_url",
    });
  });

  it("refuses a URL with no role, because the role is the whole control", () => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
      "postgresql://postgres:5432/tacbookings";
    // No `@`, so the "host" parses as the username-less form.
    const result = resolveDiagnosticsDatabaseConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toBe("missing_role");
  });

  it("refuses a byte-identical copy of DATABASE_URL", () => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = APP_URL;
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "reuses_application_role",
    });
  });

  it("refuses the application ROLE even with a different password, host or database", () => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
      "postgresql://tac:otherpw@replica:5432/other";
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "reuses_application_role",
    });
  });

  it("refuses the application role regardless of capitalisation", () => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
      "postgresql://TAC:apppw@postgres:5432/tacbookings";
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "reuses_application_role",
    });
  });

  it("still accepts a dedicated role when DATABASE_URL itself is unparseable", () => {
    process.env.DATABASE_URL = "totally-not-a-url";
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] = DIAG_URL;
    const result = resolveDiagnosticsDatabaseConfig();
    expect(result.ok).toBe(true);
  });

  it("compares percent-encoded roles after decoding", () => {
    process.env.DATABASE_URL = "postgresql://my%20app:pw@postgres:5432/db";
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
      "postgresql://my%20app:other@postgres:5432/db";
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "reuses_application_role",
    });
  });

  // `pg` reads a query parameter in preference to the URL's own userinfo
  // (`config.user = config.user || decodeURIComponent(result.username)`), and merges
  // the parsed connection string OVER the pool's explicit options. So a `?user=`
  // would let the driver connect as the application role while this gate vetted the
  // dedicated one, and `?statement_timeout=0` would strip the pool's own bound.
  it.each(REFUSED_DIAGNOSTICS_URL_PARAMETERS.map((name) => [name]))(
    "refuses a diagnostics URL carrying ?%s=",
    (parameter) => {
      process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
        `postgresql://ai_diagnostics_ro:diagpw@postgres:5432/tacbookings?${parameter}=tac`;
      expect(resolveDiagnosticsDatabaseConfig()).toEqual({
        ok: false,
        problem: "unsafe_url_parameters",
      });
    },
  );

  it("refuses the override however it is capitalised", () => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
      "postgresql://ai_diagnostics_ro:diagpw@postgres:5432/tacbookings?USER=tac";
    expect(resolveDiagnosticsDatabaseConfig()).toEqual({
      ok: false,
      problem: "unsafe_url_parameters",
    });
  });

  it("refuses the override BEFORE it reads the role, so the gate cannot be fooled", () => {
    // The refusal must not depend on the role name being wrong: this URL names the
    // dedicated role in its userinfo and the application role in its parameters,
    // which is exactly the shape that used to pass every check and then connect as
    // the application.
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
      "postgresql://ai_diagnostics_ro:diagpw@postgres:5432/tacbookings?user=tac&password=apppw";
    const result = resolveDiagnosticsDatabaseConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toBe("unsafe_url_parameters");
  });

  it.each([
    "connection_limit=3",
    "sslmode=require",
    "application_name=something-else",
  ])("still accepts the parameters operators legitimately write (%s)", (query) => {
    process.env[AI_DIAGNOSTICS_DATABASE_URL_ENV] =
      `postgresql://ai_diagnostics_ro:diagpw@postgres:5432/tacbookings?${query}`;
    expect(resolveDiagnosticsDatabaseConfig().ok).toBe(true);
  });
});

describe("readSqlPlaceholderNumbers (#2374)", () => {
  it("finds every $n a statement references", () => {
    expect(
      readSqlPlaceholderNumbers(
        'SELECT id FROM public."Booking" WHERE "lodgeId" = $1 AND "startDate" >= $2 AND id <> $1',
      ),
    ).toEqual([1, 2, 1]);
  });

  it("returns nothing for a statement with no parameters", () => {
    expect(readSqlPlaceholderNumbers("SELECT true AS probe_ok")).toEqual([]);
  });
});

const SAFE: DiagnosticsRolePrivilegeReport = {
  roleName: "ai_diagnostics_ro",
  matchesConfiguredRole: true,
  isSuperuser: false,
  canCreateDb: false,
  canCreateRole: false,
  canReplicate: false,
  bypassesRls: false,
  canCreateTempTables: false,
  canCreateInDatabase: false,
  canCreateInPublicSchema: false,
  canReadServerFiles: false,
  roleMemberships: 0,
  forbiddenRoleMemberships: 0,
  forbiddenRoleNames: [],
  writableRelations: 0,
  undeclaredReadableRelations: 0,
  tableWideSelectOnColumnRestrictedRelations: 0,
  undeclaredReadableColumns: 0,
  missingReadableRelations: 0,
  missingReadableColumns: 0,
  executableSecurityDefinerRoutines: 0,
};

describe("isDiagnosticsRolePrivilegeSafe (#2374, ADR-007)", () => {
  it("accepts a fully restricted role", () => {
    expect(isDiagnosticsRolePrivilegeSafe(SAFE)).toBe(true);
  });

  it.each([
    "isSuperuser",
    "canCreateDb",
    "canCreateRole",
    "canReplicate",
    "bypassesRls",
    "canCreateTempTables",
    "canCreateInDatabase",
    "canCreateInPublicSchema",
    "canReadServerFiles",
  ] as const)("refuses a role holding %s", (field) => {
    expect(isDiagnosticsRolePrivilegeSafe({ ...SAFE, [field]: true })).toBe(false);
  });

  it("refuses a role that can read an undeclared COLUMN of a declared relation", () => {
    // The column-level gate (AID-6A, #2375). `AuditLog` is granted eight columns
    // because the rest of the table is IP addresses, user agents, free text,
    // arbitrary JSON and member ids — so a hand-added table-level
    // `GRANT SELECT ON "AuditLog"` leaves `undeclaredReadableRelations` at ZERO (the
    // relation IS declared) while the role gains every one of them. This count is
    // the only one that notices, which is why it is its own gate rather than a
    // refinement of the relation count.
    expect(
      isDiagnosticsRolePrivilegeSafe({ ...SAFE, undeclaredReadableColumns: 1 }),
    ).toBe(false);
    expect(
      isDiagnosticsRolePrivilegeSafe({
        ...SAFE,
        undeclaredReadableRelations: 0,
        undeclaredReadableColumns: 14,
      }),
    ).toBe(false);
  });

  it("refuses table-wide SELECT even when a column declaration currently names every column", () => {
    expect(
      isDiagnosticsRolePrivilegeSafe({
        ...SAFE,
        undeclaredReadableColumns: 0,
        tableWideSelectOnColumnRestrictedRelations: 1,
      }),
    ).toBe(false);
  });

  it.each(["missingReadableRelations", "missingReadableColumns"] as const)(
    "refuses an otherwise safe role whose %s count is non-zero",
    (field) => {
      expect(isDiagnosticsRolePrivilegeSafe({ ...SAFE, [field]: 1 })).toBe(false);
    },
  );

  it("refuses a role that is a member of any escalating predefined role", () => {
    expect(
      isDiagnosticsRolePrivilegeSafe({ ...SAFE, forbiddenRoleMemberships: 1 }),
    ).toBe(false);
  });

  it("refuses on the predefined-role NAMES, so the alert can say which one", () => {
    // The guide promised a refusal that names the escalation role and nothing emitted
    // a name: readiness carries no privilege detail by design, and the log carried
    // counts alone, which left "granted pg_read_all_data" and "granted
    // pg_signal_backend" indistinguishable where an operator would look.
    expect(
      isDiagnosticsRolePrivilegeSafe({
        ...SAFE,
        forbiddenRoleNames: ["pg_write_all_data"],
      }),
    ).toBe(false);
  });

  it("refuses a role that is a member of ANY role, predefined or not", () => {
    // The named list is a subset, not the gate. A membership in an ordinary
    // application role — or in a superuser role — is invisible to every other field
    // in this report, because the role is NOINHERIT: `isSuperuser` reads the role's
    // own attribute, and the relation and function counts all use `current_user` ACL
    // functions, which respect `rolinherit`. So the report below is exactly what the
    // server returns for `GRANT tac_app TO ai_diagnostics_ro`, and it must refuse.
    expect(isDiagnosticsRolePrivilegeSafe({ ...SAFE, roleMemberships: 1 })).toBe(
      false,
    );
    // And the total is what decides it, even when the named subset says nothing.
    expect(
      isDiagnosticsRolePrivilegeSafe({
        ...SAFE,
        roleMemberships: 2,
        forbiddenRoleMemberships: 0,
      }),
    ).toBe(false);
  });

  it.each([
    "writableRelations",
    "undeclaredReadableRelations",
    "executableSecurityDefinerRoutines",
  ] as const)("refuses a role whose %s count is not zero", (field) => {
    // The privileges that make the name "SELECT-only" true. Nothing in the runtime
    // path used to ask about a single TABLE privilege, so a role carrying
    // INSERT/UPDATE/DELETE/TRUNCATE on every table in the schema — or a hand-added
    // `GRANT SELECT ON "IntegrationCredential"` — was reported `verified`.
    expect(isDiagnosticsRolePrivilegeSafe({ ...SAFE, [field]: 1 })).toBe(false);
  });

  it("refuses when the server connected us as a DIFFERENT role than we vetted", () => {
    // The config gate compares the URL's userinfo against `DATABASE_URL`; this is
    // the same question asked of the server, so a redirected login cannot leave the
    // vetted name standing in for the real one.
    expect(
      isDiagnosticsRolePrivilegeSafe({ ...SAFE, matchesConfiguredRole: false }),
    ).toBe(false);
  });

  it("checks EVERY field of the report, so a new one cannot be forgotten", () => {
    // Mutation guard for the predicate itself: flipping any single field away from
    // its safe value must refuse. Written over `Object.keys` so a field added to
    // `DiagnosticsRolePrivilegeReport` and left out of the predicate fails here.
    for (const [key, value] of Object.entries(SAFE)) {
      if (key === "roleName") continue; // The NAME is metadata, not a privilege.
      const unsafeValue = Array.isArray(value)
        ? ["pg_read_all_data"]
        : typeof value === "boolean"
          ? !value
          : 1;
      expect(
        isDiagnosticsRolePrivilegeSafe({ ...SAFE, [key]: unsafeValue }),
        `${key} is not part of the safety verdict`,
      ).toBe(false);
    }
  });
});
