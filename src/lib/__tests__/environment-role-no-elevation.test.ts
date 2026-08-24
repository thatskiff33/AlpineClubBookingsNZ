import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

/**
 * The safer-only rule is STRUCTURAL, not merely enforced in code
 * (ENV-SAFETY 1, #3034; epic #2986; INV-CONFIG-003).
 *
 * `environment-role-precedence.test.ts` proves that the resolver's twelve
 * branches never elevate. That is a behavioural proof, and a behavioural proof
 * only covers the branches somebody wrote. This file proves the stronger thing:
 * there is no PLACE for a production claim to live. The database has no column
 * that could hold one, and the API has no field that could carry one, so an
 * elevating branch could not be written without also changing something here.
 *
 * That matters most for the case epic #2986 exists for — a copy restored from
 * the club's live database. Whatever that dump contains, it cannot contain "I am
 * production", because the schema has nowhere to put it.
 *
 * READS THE GENERATED DMMF, not the schema text, for the model half. The text is
 * what a developer writes; the DMMF is what Prisma actually built, so a field
 * added through any route — a merge resolved by keeping both sides, a generator
 * change — is visible here. The schema text is asserted too, but only for the
 * things the DMMF cannot show: the `@default` on the boolean and the comment that
 * tells the next reader why.
 *
 * `test:related` cannot select this file: it reads `prisma/schema.prisma` and a
 * route's source from disk, so it has no import edge to either
 * (`docs/TESTING.md`).
 */

const MODEL = "EnvironmentSafetySettings";

/** Everything the model is allowed to hold, and nothing else. */
const ALLOWED_FIELDS = [
  "id",
  "forceNonProduction",
  "updatedByMemberId",
  "createdAt",
  "updatedAt",
] as const;

/**
 * Names a future field must not take. Each is a plausible spelling of the claim
 * this model must be unable to make.
 *
 * `forceNonProduction` is the one allowed name containing "production", and it is
 * matched exactly rather than excluded by a pattern, so `forceNonProductionMode`
 * or a second `forceNonProduction2` would still be caught by the allowlist above.
 */
const FORBIDDEN_FIELD_PATTERNS = [
  /^role$/i,
  /^environment/i,
  /production/i,
  /^isProd/i,
  /^live$/i,
  /^mode$/i,
  /^stage$/i,
  /^staging$/i,
];

function readRepoFile(relativePath: string) {
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

const schemaText = readRepoFile("prisma/schema.prisma");
const routeText = readRepoFile("src/app/api/admin/environment-safety/route.ts");
const writeText = readRepoFile(
  "src/lib/environment-safety-override-write.ts",
);

/**
 * Comments removed, so a rule ABOUT a forbidden thing cannot be mistaken for the
 * forbidden thing itself.
 *
 * Both files below explain at length what they refuse to do, naming `INSERT`,
 * `forceProduction` and `any-admin` in prose — and the first draft of this suite
 * then failed on its own documentation. `docs/ARCHITECTURE.md` records the same
 * class of mistake in the view-only census, where a `describeReason={false}`
 * inside a comment counted as a call site twice.
 *
 * Deliberately simple: neither file contains a string literal or regex holding
 * `*` followed by `/`, or a `//` inside a string, so a full lexer would buy
 * nothing here. If one ever does, this becomes wrong quietly — which is why the
 * assertions below are each written so that a broken strip makes them FAIL rather
 * than pass (they assert a real call site is FOUND, not merely that a bad one is
 * absent).
 */
function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ 	]*\/\/.*$/gm, "");
}

function stripSqlComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const routeCode = stripTsComments(routeText);
const writeCode = stripTsComments(writeText);

function modelFromDmmf() {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === MODEL);
  if (!model) throw new Error(`${MODEL} is missing from the Prisma DMMF`);
  return model;
}

describe("the database cannot express a production claim", () => {
  it("finds the model in the generated client, so nothing below is vacuous", () => {
    expect(modelFromDmmf().name).toBe(MODEL);
  });

  it("holds exactly the five fields it is allowed to hold", () => {
    const names = modelFromDmmf()
      .fields.map((field) => field.name)
      .sort();
    expect(names).toEqual([...ALLOWED_FIELDS].sort());
  });

  it("has no field that could assert production", () => {
    const offenders = modelFromDmmf()
      .fields.map((field) => field.name)
      .filter(
        (name) =>
          name !== "forceNonProduction" &&
          FORBIDDEN_FIELD_PATTERNS.some((pattern) => pattern.test(name)),
      );

    expect(
      offenders,
      `${MODEL} may hold no field capable of asserting that this installation ` +
        `is production (INV-CONFIG-003). The only lever is forceNonProduction, ` +
        `which moves the resolved role towards the SAFER state and in no other ` +
        `direction — that is what stops a restored production dump carrying a ` +
        `production claim into a copy. Production is declared by the deployment ` +
        `(APP_ENVIRONMENT_ROLE) and by nothing in this database.`,
    ).toEqual([]);
  });

  it("keeps the one lever a plain boolean", () => {
    const lever = modelFromDmmf().fields.find(
      (field) => field.name === "forceNonProduction",
    );
    expect(lever?.kind).toBe("scalar");
    expect(lever?.type).toBe("Boolean");
  });

  it("defaults that boolean to off, in the schema and in the migration", () => {
    /*
      Asserted from the TEXT rather than the DMMF: the Prisma 7 client's runtime
      DMMF carries only each field's name, kind and type, so `@default(false)` is
      not visible there at all. Reading it from both the schema and the migration
      is what makes an absent row and a `false` row the same answer — which is in
      turn why no read path ever has to create one.
    */
    const model = schemaText.slice(
      schemaText.indexOf(`model ${MODEL} {`),
    );
    const block = model.slice(0, model.indexOf("\n}"));
    expect(block).toMatch(/forceNonProduction\s+Boolean\s+@default\(false\)/);

    const migration = stripSqlComments(
      readRepoFile(
        "prisma/migrations/20260826010000_add_environment_safety_settings/migration.sql",
      ),
    );
    expect(migration).toMatch(
      /"forceNonProduction"\s+BOOLEAN\s+NOT NULL\s+DEFAULT false/,
    );
  });

  it("carries no enum, so no future value can be added beside the boolean", () => {
    // A three-state enum (`PRODUCTION` / `NON_PRODUCTION` / `UNSET`) is the
    // obvious "improvement" somebody will propose. It would put the production
    // claim back in the database, which is the whole thing this model refuses.
    for (const field of modelFromDmmf().fields) {
      expect(field.kind).not.toBe("enum");
    }
  });

  it("says WHY in the schema, where the next reader of the model will be", () => {
    const start = schemaText.indexOf(`model ${MODEL} {`);
    expect(start).toBeGreaterThan(0);
    const preamble = schemaText.slice(Math.max(0, start - 1600), start);
    expect(preamble).toContain("INV-CONFIG-003");
    expect(preamble).toContain("APP_ENVIRONMENT_ROLE");
    // The doc has to name the failure mode, not merely assert the rule.
    expect(preamble.toLowerCase()).toContain("forceproduction");
  });

  it("seeds no row in the migration, because absent already means 'no override'", () => {
    const migration = stripSqlComments(
      readRepoFile(
        "prisma/migrations/20260826010000_add_environment_safety_settings/migration.sql",
      ),
    );
    // The strip has to leave the real statements behind, or the DML check below
    // would pass on an empty string.
    expect(migration).toContain(`CREATE TABLE "${MODEL}"`);
    expect(migration).toContain("CREATE INDEX");
    // No DML of any kind: nothing to backfill, and nothing that could write a
    // row asserting a state nobody has chosen.
    for (const statement of ["INSERT", "UPDATE ", "DELETE", "DO $$"]) {
      expect(migration.toUpperCase()).not.toContain(statement);
    }
  });
});

describe("the API cannot carry a production claim either", () => {
  it("accepts exactly two body fields", () => {
    /*
      Asserted from the source because the schema is a value the route does not
      export, and exporting it purely to be tested would widen the route's
      surface for the test's benefit. The behavioural half — every plausible
      elevating body answered 400 — is in the route's own suite; this is the
      structural half, and it fails on a field that is ADDED rather than only on
      one that is exercised.
    */
    const start = routeCode.indexOf("const changeSchema");
    expect(start).toBeGreaterThan(0);
    const end = routeCode.indexOf(".strict();", start);
    expect(end).toBeGreaterThan(start);
    const schema = routeCode.slice(start, end);

    const fields = [...schema.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
    expect(fields.sort()).toEqual(["confirmed", "forceNonProduction"]);
  });

  it("is strict, so an unknown key is refused rather than ignored", () => {
    // Without `.strict()`, `{ forceNonProduction: false, forceProduction: true }`
    // would be a 200 and the caller would reasonably believe it had been
    // honoured.
    expect(routeCode).toContain(".strict();");
  });

  it("only ever writes the one boolean and the actor", () => {
    const upsert = writeCode.slice(
      writeCode.indexOf("environmentSafetySettings.upsert"),
    );
    const body = upsert.slice(0, upsert.indexOf("});"));
    expect(body).toContain("forceNonProduction,");
    expect(body).toContain("updatedByMemberId: actingMemberId");
    // Nothing about the environment reaches the row. The declaration is read
    // live by the resolver; a copy of it here would be a second, stale
    // authority for the very question this epic settles.
    expect(body).not.toContain("APP_ENVIRONMENT_ROLE");
    expect(body).not.toContain("declaration");
  });

  it("enforces Full Admin on both verbs, not an inferred area level", () => {
    const guards = [...routeCode.matchAll(/requireAdmin\(([^)]*)\)/g)].map(
      (m) => m[1],
    );
    // One per verb, and both the explicit "Full Admin only" shape. An omitted
    // `permission` would infer `support` from the path and admit a support
    // editor; `"any-admin"` would admit every admitted administrator.
    expect(guards).toEqual(["{ permission: false }", "{ permission: false }"]);
  });
});
