import { describe, expect, it } from "vitest";

import type { EnvironmentRoleDeclaration } from "@/lib/environment-role-declaration";
import {
  decideEnvironmentRole,
  type EnvironmentRole,
  type EnvironmentRoleDatabaseOverride,
  type EnvironmentRoleDecidedBy,
} from "@/lib/environment-role";

/**
 * Every precedence combination, exhaustively (ENV-SAFETY 1, #3034; epic #2986;
 * INV-CONFIG-003).
 *
 * The issue's first acceptance criterion is "every precedence combination
 * resolves deterministically to one of the three states", so the table below IS
 * that criterion rather than a sample of it: four declaration states times three
 * override states, twelve rows, each pinning both the role AND which source
 * decided it. `decideEnvironmentRole` is the pure half of the resolver precisely
 * so this can be asserted without a database in the loop — a fake database that
 * had to be persuaded into each of these twelve states would be twelve chances
 * to test the fake instead of the rule.
 *
 * Deliberately clock-free: nothing here formats or compares a date, so the
 * answer is the same at every instant (`docs/TESTING.md`).
 */

const DECLARATIONS = {
  production: { kind: "production" } as EnvironmentRoleDeclaration,
  "non-production": { kind: "non-production" } as EnvironmentRoleDeclaration,
  absent: { kind: "absent" } as EnvironmentRoleDeclaration,
  invalid: { kind: "invalid", raw: "staging" } as EnvironmentRoleDeclaration,
} as const;

/** `updatedAt` sits in the past relative to the frozen 2026-07-01 clock. */
const OVERRIDE_SET_AT = new Date("2026-06-15T09:30:00.000Z");

const OVERRIDES = {
  on: {
    kind: "force-non-production",
    updatedAt: OVERRIDE_SET_AT,
    updatedByMemberId: "member-full-admin",
  } as EnvironmentRoleDatabaseOverride,
  off: { kind: "none" } as EnvironmentRoleDatabaseOverride,
  unreadable: { kind: "unreadable" } as EnvironmentRoleDatabaseOverride,
} as const;

type DeclarationKey = keyof typeof DECLARATIONS;
type OverrideKey = keyof typeof OVERRIDES;

/**
 * THE TABLE. Read it as the specification; the implementation is what has to
 * agree with it, not the other way round.
 *
 * The two shapes worth reading twice:
 *
 *   - `production` + `unreadable` is UNKNOWN, not PRODUCTION. That is the
 *     deliberate fail-closed leg: an unreadable override cannot rule out that an
 *     operator has already forced this instance safer, and the case where that
 *     matters is a copy of production about to email real members.
 *   - `non-production` + `unreadable` stays NON_PRODUCTION. There is nowhere
 *     safer for the override to have pushed it, so a failed read costs nothing.
 */
const TABLE: Array<{
  declaration: DeclarationKey;
  override: OverrideKey;
  role: EnvironmentRole;
  decidedBy: EnvironmentRoleDecidedBy;
}> = [
  { declaration: "production", override: "on", role: "NON_PRODUCTION", decidedBy: "database-safer-override" },
  { declaration: "production", override: "off", role: "PRODUCTION", decidedBy: "deployment-declaration" },
  { declaration: "production", override: "unreadable", role: "UNKNOWN", decidedBy: "unresolved" },

  { declaration: "non-production", override: "on", role: "NON_PRODUCTION", decidedBy: "deployment-declaration" },
  { declaration: "non-production", override: "off", role: "NON_PRODUCTION", decidedBy: "deployment-declaration" },
  { declaration: "non-production", override: "unreadable", role: "NON_PRODUCTION", decidedBy: "deployment-declaration" },

  { declaration: "absent", override: "on", role: "NON_PRODUCTION", decidedBy: "database-safer-override" },
  { declaration: "absent", override: "off", role: "UNKNOWN", decidedBy: "unresolved" },
  { declaration: "absent", override: "unreadable", role: "UNKNOWN", decidedBy: "unresolved" },

  { declaration: "invalid", override: "on", role: "NON_PRODUCTION", decidedBy: "database-safer-override" },
  { declaration: "invalid", override: "off", role: "UNKNOWN", decidedBy: "unresolved" },
  { declaration: "invalid", override: "unreadable", role: "UNKNOWN", decidedBy: "unresolved" },
];

const ALL_DECLARATIONS = Object.keys(DECLARATIONS) as DeclarationKey[];
const ALL_OVERRIDES = Object.keys(OVERRIDES) as OverrideKey[];

function decide(declaration: DeclarationKey, override: OverrideKey) {
  return decideEnvironmentRole(DECLARATIONS[declaration], OVERRIDES[override]);
}

describe("the precedence table is complete", () => {
  it("covers all twelve combinations exactly once", () => {
    expect(TABLE).toHaveLength(
      ALL_DECLARATIONS.length * ALL_OVERRIDES.length,
    );
    const keys = TABLE.map((row) => `${row.declaration}/${row.override}`);
    expect(keys).toEqual([...new Set(keys)]);
    for (const declaration of ALL_DECLARATIONS) {
      for (const override of ALL_OVERRIDES) {
        expect(keys).toContain(`${declaration}/${override}`);
      }
    }
  });
});

describe("every precedence combination resolves deterministically", () => {
  it.each(TABLE)(
    "declaration=$declaration + override=$override -> $role ($decidedBy)",
    ({ declaration, override, role, decidedBy }) => {
      const resolution = decide(declaration, override);
      expect(resolution.role).toBe(role);
      expect(resolution.decidedBy).toBe(decidedBy);
      // The sources travel unchanged, so an operator surface can report BOTH
      // rather than only the answer they produced.
      expect(resolution.declaration).toEqual(DECLARATIONS[declaration]);
      expect(resolution.databaseOverride).toEqual(OVERRIDES[override]);
    },
  );

  it("is a pure function — the same inputs give the same answer twice", () => {
    for (const row of TABLE) {
      expect(decide(row.declaration, row.override)).toEqual(
        decide(row.declaration, row.override),
      );
    }
  });
});

describe("missing or invalid declaration cannot become PRODUCTION", () => {
  it.each(ALL_OVERRIDES)(
    "an absent declaration with override=%s is never PRODUCTION",
    (override) => {
      expect(decide("absent", override).role).not.toBe("PRODUCTION");
    },
  );

  it.each(ALL_OVERRIDES)(
    "an invalid declaration with override=%s is never PRODUCTION",
    (override) => {
      expect(decide("invalid", override).role).not.toBe("PRODUCTION");
    },
  );

  it("keeps absent and invalid distinguishable in the resolution", () => {
    // The operator surface has to tell "you have not set it" from "you set it to
    // something I refuse to interpret" — those need different instructions.
    expect(decide("absent", "off").declaration.kind).toBe("absent");
    expect(decide("invalid", "off").declaration.kind).toBe("invalid");
  });
});

describe("the database can never elevate", () => {
  /*
    This is the structural promise INV-CONFIG-003 makes, checked behaviourally
    here and structurally in environment-role-no-elevation.test.ts, which reads
    the Prisma model and the API schema. Both matter: the schema is what makes it
    impossible, and this is what would notice if a future branch in
    decideEnvironmentRole made it possible anyway.
  */
  it("cannot turn a declared non-production into production, in any database state", () => {
    for (const override of ALL_OVERRIDES) {
      expect(decide("non-production", override).role).toBe("NON_PRODUCTION");
    }
  });

  it("cannot turn an undeclared installation into production, in any database state", () => {
    for (const override of ALL_OVERRIDES) {
      expect(decide("absent", override).role).not.toBe("PRODUCTION");
    }
  });

  it("only ever moves an answer towards NON_PRODUCTION", () => {
    /*
      ONE ASSERTION, NOT A BRANCH (#3034 review). This case used to be an
      `if`/`else` whose two arms both asserted `toBe("NON_PRODUCTION")`. It read
      as a monotonicity check and was not one: no input made the arms differ, so
      the branch could be deleted with no effect on what was proved, and a reader
      scanning for the monotonicity property found something that looked like it
      and was not.

      The property that IS true, and is worth stating unconditionally, is
      stronger than monotonicity: switching the override on yields the safest
      CONFIRMED state from every starting point. So there is no declaration from
      which the override can produce PRODUCTION, and none from which it can leave
      UNKNOWN standing — including `invalid`, which is the one that needed a
      decision and is recorded in the resolver's docblock.
    */
    for (const declaration of ALL_DECLARATIONS) {
      expect(
        decide(declaration, "on").role,
        `declaration ${declaration} with the override on`,
      ).toBe("NON_PRODUCTION");
    }
  });

  it("switching the override OFF is not an elevation", () => {
    // With the override off the DECLARATION decides. A declared non-production
    // stays non-production; an undeclared one goes back to UNKNOWN, never to
    // production. This is the property the admin route's PATCH relies on when it
    // tells an administrator that turning it off is safe to offer at all.
    expect(decide("non-production", "off").role).toBe("NON_PRODUCTION");
    expect(decide("absent", "off").role).toBe("UNKNOWN");
    expect(decide("invalid", "off").role).toBe("UNKNOWN");
    expect(decide("production", "off").role).toBe("PRODUCTION");
  });
});

describe("the notes explain the state without leaking anything", () => {
  it("always says something", () => {
    for (const row of TABLE) {
      const { notes } = decide(row.declaration, row.override);
      expect(notes.length).toBeGreaterThan(0);
      for (const note of notes) expect(note.length).toBeGreaterThan(20);
    }
  });

  it("names the variable in full wherever it asks the operator to set it", () => {
    // "Set the environment role" sends an operator to the wrong variable —
    // APP_RUNTIME_ROLE is right there beside it in the same Compose file.
    const unresolved = decide("absent", "off");
    expect(unresolved.notes.join(" ")).toContain("APP_ENVIRONMENT_ROLE");
    expect(unresolved.notes.join(" ")).toContain("APP_RUNTIME_ROLE");
  });

  it("quotes a refused value back so the operator can see the typo", () => {
    const invalid = decideEnvironmentRole(
      { kind: "invalid", raw: "prodction" },
      OVERRIDES.off,
    );
    expect(invalid.notes.join(" ")).toContain('"prodction"');
  });

  it("gives each UNKNOWN cause its own repair, because they are different faults", () => {
    /*
      #3034 review. UNKNOWN has three causes and only two are "the variable is
      not set". The third is a valid `production` declaration whose safer override
      could not be READ — the app started before `prisma migrate deploy` — and the
      boot log, the setup checklist and the admin panel all render these notes
      verbatim. A single fixed sentence naming APP_ENVIRONMENT_ROLE would send
      that operator to fix the one thing that is already correct, and never
      mention the repair that works. So the notes are asserted to DIFFER, not
      merely to exist.
    */
    const unreadable = decide("production", "unreadable").notes.join(" ");
    const absent = decide("absent", "off").notes.join(" ");

    // The unreadable case names the database repair and does NOT instruct
    // anybody to set the variable.
    expect(unreadable).toContain("prisma migrate deploy");
    expect(unreadable).not.toContain(
      "Set APP_ENVIRONMENT_ROLE to production or non-production",
    );

    // The undeclared case is the exact mirror.
    expect(absent).toContain(
      "Set APP_ENVIRONMENT_ROLE to production or non-production",
    );
    expect(absent).not.toContain("prisma migrate deploy");
  });

  it("states the valid declaration it DID find, when the override is what failed", () => {
    // Without this the operator cannot tell whether their declaration was read
    // at all, which is the first thing they will wonder.
    const unreadable = decide("production", "unreadable").notes.join(" ");
    expect(unreadable).toContain("APP_ENVIRONMENT_ROLE=production");
    expect(unreadable).toContain("could not be read");
  });

  it("carries no credential-shaped text", () => {
    for (const row of TABLE) {
      for (const note of decide(row.declaration, row.override).notes) {
        expect(note).not.toMatch(/postgres|password|secret|token|@|:\/\//i);
      }
    }
  });
});
