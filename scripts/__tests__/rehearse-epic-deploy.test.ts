import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BASE_REF,
  REFUSED_PORT,
  addedMigrationsSinceBase,
  describeClusterNotDisposable,
  describeDisposabilityRefusal,
  normaliseSchemaForComparison,
  parseArgs,
  summariseReadError,
  tablesMentioned,
} from "../rehearse-epic-deploy";

/**
 * `scripts/rehearse-epic-deploy.ts` (#3002, mitigation 9).
 *
 * WHAT IS AND IS NOT COVERED HERE, stated rather than implied. The parts tested
 * below are the ones that decide whether the rehearsal is SAFE and whether it is
 * measuring what it claims: the refusals, the base-ref diff, and the two string
 * reductions a green or red verdict is read out of. The parts that need a live
 * PostgreSQL — applying 300+ migrations, generating a client from the base ref's
 * schema, reading every model with it — are exercised by RUNNING the script
 * against a throwaway container, and the evidence for that lives in the pull
 * request rather than here. Standing up a database in the unit suite would make
 * every developer's `npm test` depend on Docker, which this repository
 * deliberately does not do (`data-migration-verification.realdb.test.ts` gates
 * its real-database half on an explicit environment variable for the same
 * reason).
 *
 * The refusals get the most attention on purpose. A rehearsal is worth nothing
 * measured against the cost of pointing one at a real club's database, and the
 * operator who would do that is the one under time pressure.
 */

const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS) rmSync(root, { force: true, recursive: true });
  ROOTS.length = 0;
  delete process.env.EPIC_REHEARSAL_DATABASE_URL;
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function newRepo(): {
  root: string;
  addMigration: (name: string, file?: string) => void;
  commit: (message: string) => string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "acb-rehearsal-"));
  ROOTS.push(root);
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");

  const addMigration = (name: string, file = "migration.sql") => {
    // Test fixture: joins the fixture repo's own migrations directory with a
    // test-controlled name; no user input.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const dir = path.join(root, "prisma", "migrations", name);
    mkdirSync(dir, { recursive: true });
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    writeFileSync(path.join(dir, file), "SELECT 1;\n", "utf8");
  };

  const commit = (message: string) => {
    git(root, "add", "-A");
    // --allow-empty so a case can start from a repository with no files at all,
    // which is the shape that proves an untracked migration is still counted.
    git(root, "commit", "--quiet", "--allow-empty", "-m", message);
    return git(root, "rev-parse", "HEAD").trim();
  };

  return { root, addMigration, commit };
}

describe("parseArgs", () => {
  it("defaults the base ref and requires the database URL to be given", () => {
    const options = parseArgs([]);
    expect(options.baseRef).toBe(DEFAULT_BASE_REF);
    expect(options.databaseUrl).toBeNull();
    expect(options.seedSqlPath).toBeNull();
    expect(options.keepScratch).toBe(false);
  });

  it("NEVER falls back to DATABASE_URL", () => {
    // The single most important line in this file. On an operator's host
    // DATABASE_URL is the live club database, and this script drops databases.
    process.env.DATABASE_URL = "postgres://real:real@db.internal:5432/club_production";
    try {
      expect(parseArgs([]).databaseUrl).toBeNull();
    } finally {
      delete process.env.DATABASE_URL;
    }
  });

  it("accepts the URL from EPIC_REHEARSAL_DATABASE_URL", () => {
    process.env.EPIC_REHEARSAL_DATABASE_URL = "postgres://p:p@127.0.0.1:55302/postgres";
    expect(parseArgs([]).databaseUrl).toBe("postgres://p:p@127.0.0.1:55302/postgres");
  });

  it("reads --base, --base=, --database-url, --seed-sql and --keep-scratch", () => {
    const options = parseArgs([
      "--base",
      "abc123",
      "--database-url=postgres://p:p@127.0.0.1:55302/postgres",
      "--seed-sql",
      "fixtures/seed.sql",
      "--keep-scratch",
    ]);
    expect(options.baseRef).toBe("abc123");
    expect(options.databaseUrl).toBe("postgres://p:p@127.0.0.1:55302/postgres");
    expect(options.seedSqlPath).toBe("fixtures/seed.sql");
    expect(options.keepScratch).toBe(true);
  });

  it("refuses an unrecognised argument instead of running with the defaults", () => {
    expect(() => parseArgs(["--databse-url", "x"])).toThrow(/unrecognised argument/);
  });

  it("refuses a flag whose value is missing", () => {
    expect(() => parseArgs(["--base"])).toThrow(/--base needs a value/);
    expect(() => parseArgs(["--database-url="])).toThrow(/--database-url= needs a value/);
  });
});

describe("describeDisposabilityRefusal", () => {
  it("accepts a loopback URL on a non-production port", () => {
    expect(describeDisposabilityRefusal("postgres://postgres:postgres@127.0.0.1:55302/postgres")).toBeNull();
    expect(describeDisposabilityRefusal("postgresql://p:p@localhost:6543/scratch")).toBeNull();
  });

  it(`REFUSES port ${REFUSED_PORT} outright, even on loopback`, () => {
    // Not a heuristic and not negotiable: 5432 is PostgreSQL's default, so on a
    // machine that also runs a real instance loopback:5432 IS that instance, and
    // "it is only my local one" is the assumption that ends a club's data.
    const refusal = describeDisposabilityRefusal("postgres://p:p@127.0.0.1:5432/postgres");
    expect(refusal).toContain(`the port is ${REFUSED_PORT}`);
    expect(refusal).toContain("refused outright rather than inspected");
  });

  it(`REFUSES a URL with no port, because that means ${REFUSED_PORT}`, () => {
    const refusal = describeDisposabilityRefusal("postgres://p:p@localhost/scratch");
    expect(refusal).toContain("implied: the URL names no port");
  });

  it("REFUSES a host that is not loopback", () => {
    const refusal = describeDisposabilityRefusal("postgres://p:p@db.example.com:6543/scratch");
    expect(refusal).toContain("not loopback");
  });

  it("REFUSES an empty URL, an unparseable one, and a non-PostgreSQL scheme", () => {
    expect(describeDisposabilityRefusal("")).toContain("no database URL");
    expect(describeDisposabilityRefusal("not a url")).toContain("does not parse");
    expect(describeDisposabilityRefusal("mysql://p:p@127.0.0.1:3306/x")).toContain(
      "only speaks PostgreSQL",
    );
  });

  it("REFUSES a URL that names no database", () => {
    expect(describeDisposabilityRefusal("postgres://p:p@127.0.0.1:55302")).toContain(
      "names no database",
    );
  });

  it("REFUSES a query string, because node-postgres reads the connection out of it", () => {
    // Both of these read as loopback:5433 to `new URL`, and both connect
    // somewhere else. Measured against the `pg-connection-string` in this
    // checkout: `?host=` becomes the connection host, and `?port=` becomes the
    // port — walking through the loopback guard and through the one port this
    // script refuses outright, respectively. The guard is not an allowlist of
    // those two names: an allowlist would encode one measurement of one version
    // of one library and rot without saying so.
    expect(
      describeDisposabilityRefusal(
        "postgresql://u:pw@127.0.0.1:5433/postgres?host=/var/run/postgresql",
      ),
    ).toContain("query parameter(s) (host)");
    expect(
      describeDisposabilityRefusal("postgresql://u:pw@127.0.0.1:5433/postgres?port=5432"),
    ).toContain("query parameter(s) (port)");
    // Anything else too, including a parameter that is inert today.
    expect(
      describeDisposabilityRefusal("postgresql://u:pw@127.0.0.1:5433/postgres?sslmode=disable"),
    ).toContain("refuses all of");
  });
});

describe("describeClusterNotDisposable", () => {
  it("accepts a throwaway cluster, and one holding this script's own leftovers", () => {
    // `postgres` exists on every cluster; `--keep-scratch` is a documented
    // option, so the script's own droppings must not lock the next run out.
    expect(describeClusterNotDisposable(["postgres"], "postgres")).toBeNull();
    expect(
      describeClusterNotDisposable(
        ["epic_rehearsal_0123456789abcdef", "postgres"],
        "postgres",
      ),
    ).toBeNull();
    // The maintenance database need not be called `postgres`.
    expect(describeClusterNotDisposable(["postgres", "scratch"], "scratch")).toBeNull();
  });

  it("REFUSES a cluster holding databases that are not its own", () => {
    // The hole this closes: the emptiness test the script has always run
    // inspects the MAINTENANCE database, and a production cluster's `postgres`
    // database is empty too. On an operator's box — loopback, and a server
    // administered from the machine it runs on — that left only the port check
    // between this script and `CREATE DATABASE` on the live cluster.
    const refusal = describeClusterNotDisposable(
      ["postgres", "tacbookings", "tacbookings_backup"],
      "postgres",
    );

    expect(refusal).toContain("tacbookings");
    expect(refusal).toContain("tacbookings_backup");
    expect(refusal).toContain("an empty maintenance");
  });

  it("does not mistake a lookalike name for one of its own scratch databases", () => {
    // The pattern is anchored and hex-exact on purpose: a club database called
    // `epic_rehearsal_notes` is somebody's data, not a leftover.
    expect(
      describeClusterNotDisposable(["postgres", "epic_rehearsal_notes"], "postgres"),
    ).toContain("epic_rehearsal_notes");
    expect(
      describeClusterNotDisposable(["postgres", "epic_rehearsal_0123456789abcdefff"], "postgres"),
    ).toContain("epic_rehearsal_0123456789abcdefff");
  });
});

describe("addedMigrationsSinceBase", () => {
  it("returns only the migrations whose migration.sql the branch adds", () => {
    const repo = newRepo();
    repo.addMigration("20990101000000_already_shipped");
    const base = repo.commit("base");
    repo.addMigration("20990102000000_new_one");
    repo.commit("branch");

    expect(addedMigrationsSinceBase(repo.root, base)).toEqual(["20990102000000_new_one"]);
  });

  it("does not count a pre-existing migration that only gains a rollback.sql", () => {
    const repo = newRepo();
    repo.addMigration("20990101000000_already_shipped");
    const base = repo.commit("base");
    repo.addMigration("20990101000000_already_shipped", "rollback.sql");
    repo.commit("add a reverse script to the old migration");

    expect(addedMigrationsSinceBase(repo.root, base)).toEqual([]);
  });

  it("counts an UNCOMMITTED new migration, so a rehearsal can be run before the commit", () => {
    const repo = newRepo();
    const base = repo.commit("empty base");
    repo.addMigration("20990102000000_uncommitted");

    expect(addedMigrationsSinceBase(repo.root, base)).toEqual(["20990102000000_uncommitted"]);
  });

  it("returns migrations in the order PostgreSQL will apply them", () => {
    const repo = newRepo();
    const base = repo.commit("empty base");
    repo.addMigration("20990103000000_third");
    repo.addMigration("20990101000000_first");
    repo.addMigration("20990102000000_second");
    repo.commit("three at once, added out of order");

    expect(addedMigrationsSinceBase(repo.root, base)).toEqual([
      "20990101000000_first",
      "20990102000000_second",
      "20990103000000_third",
    ]);
  });
});

describe("normaliseSchemaForComparison", () => {
  // This is the rehearsal's non-vacuity guard. Prisma rewrites the schema it
  // emits beside a generated client — it re-aligns fields AND reorders `@@`
  // block attributes — so byte equality would fail on a correct run. What must
  // still hold is that a DIFFERENT schema never compares equal, because that is
  // the case where the client is silently the current schema's and every read
  // passes for the wrong reason.
  const schema = [
    "model Member {",
    "  id    String  @id",
    "  email String?",
    "  @@index([email])",
    "  @@unique([id])",
    "}",
  ].join("\n");

  it("is unchanged by Prisma's re-alignment and attribute reordering", () => {
    const reformatted = [
      "model Member {",
      "  id      String  @id",
      "",
      "  email        String?",
      "  @@unique([id])",
      "  @@index([email])",
      "}",
    ].join("\n");
    expect(normaliseSchemaForComparison(reformatted)).toBe(normaliseSchemaForComparison(schema));
  });

  it("still detects a one-field difference", () => {
    const changed = schema.replace("email String?", "emailAddress String?");
    expect(normaliseSchemaForComparison(changed)).not.toBe(normaliseSchemaForComparison(schema));
  });
});

describe("summariseReadError", () => {
  it("keeps the sentence that matters and drops Prisma's code frame", () => {
    // Measured shape. Taking message.split("\n")[0] printed an EMPTY finding,
    // because a Prisma client error opens with a blank line and buries the
    // reason several lines down under a quote of this script's own source.
    const error = new Error(
      [
        "",
        "Invalid `delegate.findMany()` invocation in",
        "C:\\repo\\scripts\\rehearse-epic-deploy.ts:492:24",
        "  490   // a comment",
        "→ 492   await delegate.findMany(",
        "The column `Member.phoneNumber` does not exist in the current database.",
      ].join("\n"),
    );

    const summary = summariseReadError(error);

    expect(summary).toBe(
      "The column `Member.phoneNumber` does not exist in the current database.",
    );
  });

  it("never reports an empty reason", () => {
    expect(summariseReadError(new Error("\n\n  \n"))).toBe(
      "read failed with an empty error message",
    );
  });

  it("truncates a very long message rather than flooding the report", () => {
    const summary = summariseReadError(new Error("x".repeat(1000)));
    expect(summary.length).toBeLessThanOrEqual(401);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("tablesMentioned", () => {
  it("names the tables an added migration touches, for the report", () => {
    const sql = [
      'ALTER TABLE "Member" ADD COLUMN "x" TEXT;',
      'CREATE INDEX "i" ON "Booking"("x");',
      'UPDATE "PageContent" SET "body" = \'y\';',
    ].join("\n");
    expect(tablesMentioned(sql)).toEqual(["Booking", "Member", "PageContent"]);
  });
});
