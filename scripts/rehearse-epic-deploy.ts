#!/usr/bin/env -S npx tsx
/**
 * Epic deploy rehearsal (#3002, mitigation 9).
 *
 *   npm run db:rehearse-epic -- --database-url postgres://user:pw@127.0.0.1:55440/postgres
 *   npm run db:rehearse-epic -- --database-url ... --base <ref> --seed-sql <file>
 *   npm run db:rehearse-epic -- --help
 *
 * ## What this is for
 *
 * Since #3002 an epic's children merge into an integration branch and the epic
 * reaches `main` as ONE merge, so **every migration in an epic lands in a single
 * deploy**. The colour draining at cutover is running the code from BEFORE the
 * epic, so that is the client every migration in the epic has to stay readable
 * by — not merely the client of the child before it.
 *
 * This script rehearses that. It applies the base ref's migrations to a
 * throwaway PostgreSQL, applies the migrations this branch ADDS on top, then
 * generates a Prisma client from the BASE REF's own `prisma/schema.prisma` and
 * reads every model with it. A read that fails is the draining colour failing.
 *
 * That is not an invention: it is the technique both `windowed` rows in
 * `docs/BLUE_GREEN_MIGRATION_POLICY.md` were verified with rather than asserted
 * (`20260803010000`, `20260803030000`), where a client generated from the
 * previous schema failed with `The column MembershipLockoutSettings.enabled does
 * not exist in the current database`. With a whole epic's migrations arriving at
 * once it is the only way to prove the compatibility claim.
 *
 * ## WHAT THIS DOES NOT PROVE
 *
 * Read this before quoting a green run as evidence.
 *
 * - **Writes.** The draining colour also INSERTs and UPDATEs. A generic harness
 *   cannot construct a valid payload for 180 models, so this reads only. A
 *   dropped NOT NULL column with no default, or a new constraint the old code
 *   cannot satisfy, will pass here and fail in production.
 * - **The application's real query shapes.** It runs one `findMany({ take: 1 })`
 *   per model, which names every scalar column the old schema knows — that is
 *   what catches a removed or renamed column. It does not run the app's
 *   `include`/`select` trees, its filters, or its raw SQL, so a hand-written
 *   query naming a dropped column is out of scope.
 * - **The exact previously-released client.** It generates from the base ref's
 *   SCHEMA using the Prisma version installed in THIS checkout. If the epic also
 *   changes the Prisma version, that difference is not modelled.
 * - **Value decoding, unless rows exist.** The base migration chain plants a real
 *   install's starter rows (the default lodge, page content, settings), and this
 *   script reports the row count it found per model. A model that is empty is
 *   proven only at the column-list level: a column TYPE change with rows present
 *   is a class this run cannot see for that model. `--seed-sql` adds rows.
 * - **Migrations the branch MODIFIED rather than added.** Editing a committed
 *   migration is already forbidden (checksums), so only additions are rehearsed.
 * - **`rollback.sql`, and the operational sequence.** Removing traffic, stopping
 *   the old app and every worker, backups, cutover: none of that is here.
 *   `docs/PRODUCTION_UPGRADE_RUNBOOK.md` owns it.
 *
 * ## Safety
 *
 * It refuses to run against anything that is not obviously disposable, and it
 * fails closed on every one of these rather than asking:
 *
 * - The URL must be given explicitly (`--database-url`, or
 *   `EPIC_REHEARSAL_DATABASE_URL`). It NEVER falls back to `DATABASE_URL`,
 *   because on an operator's host that is the live database.
 * - Loopback hosts only.
 * - **No query string at all.** node-postgres reads the connection out of the
 *   query as well as out of the URL: measured, `?host=/var/run/postgresql`
 *   redirects to the local socket and `?port=5432` overrides the port, each
 *   walking past a guard below while the URL still reads as loopback:5433. Any
 *   parameter is refused rather than an allowlist of the ones one version of one
 *   library happens to honour.
 * - **Port 5432 is refused outright**, rather than inspected. It is PostgreSQL's
 *   default, so on any machine that also runs a real instance — an operator's
 *   server, a fork owner's box — loopback:5432 IS that instance, and "it is only
 *   my local one" is exactly the assumption that ends a club's data. Run the
 *   throwaway container on another port and point this at that.
 * - **The server must hold no databases but its own maintenance one.** An empty
 *   maintenance database proves nothing on its own: a production cluster's
 *   `postgres` database is empty as well, so on an operator's box that test and
 *   the two above were all that stood between this script and `CREATE DATABASE`
 *   on the live server. `pg_database` names the club's database out loud.
 * - The database it connects to must hold **no tables at all**. A non-empty
 *   public schema is treated as somebody's real data.
 * - It then does its work inside a scratch database it CREATES and DROPS itself,
 *   never in the one it was pointed at. That is the same shape
 *   `src/lib/__tests__/data-migration-verification.realdb.test.ts` uses.
 *
 * Reads git, the working tree and the throwaway database. No provider calls, no
 * network, no production credentials.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "pg";

import { splitSqlStatements } from "../prisma/migration-verification/split-statements";
import { resolveBaseRef } from "./lib/file-size-base";

/** The ref a rehearsal compares against when none is named. */
export const DEFAULT_BASE_REF = "origin/main";

/** The one port this script will not talk to, whatever else is true. */
export const REFUSED_PORT = 5432;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type RehearsalOptions = {
  baseRef: string;
  databaseUrl: string | null;
  seedSqlPath: string | null;
  keepScratch: boolean;
  help: boolean;
};

/**
 * `--base <ref>` / `--base=<ref>`, matching `scripts/ci/check-file-size-budget.ts`
 * and `scripts/check-migration-safety-coverage.sh`. An unrecognised argument is
 * refused rather than ignored, so a typo cannot read as "run with the defaults".
 */
export function parseArgs(argv: readonly string[]): RehearsalOptions {
  const options: RehearsalOptions = {
    baseRef: DEFAULT_BASE_REF,
    databaseUrl: process.env.EPIC_REHEARSAL_DATABASE_URL?.trim() || null,
    seedSqlPath: null,
    keepScratch: false,
    help: false,
  };

  const valueOf = (arg: string, flag: string, index: number): string => {
    if (arg.startsWith(`${flag}=`)) {
      const inline = arg.slice(flag.length + 1);
      if (!inline) throw new Error(`${flag}= needs a value`);
      return inline;
    }
    const next = argv[index + 1];
    if (!next) throw new Error(`${flag} needs a value`);
    return next;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--keep-scratch") {
      options.keepScratch = true;
      continue;
    }
    if (arg === "--base" || arg.startsWith("--base=")) {
      options.baseRef = valueOf(arg, "--base", index);
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (arg === "--database-url" || arg.startsWith("--database-url=")) {
      options.databaseUrl = valueOf(arg, "--database-url", index);
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (arg === "--seed-sql" || arg.startsWith("--seed-sql=")) {
      options.seedSqlPath = valueOf(arg, "--seed-sql", index);
      if (!arg.includes("=")) index += 1;
      continue;
    }
    throw new Error(`unrecognised argument ${arg}`);
  }

  return options;
}

/**
 * Why this URL is not obviously disposable, or null when it is.
 *
 * Every branch here fails closed on purpose. A rehearsal is worth nothing next
 * to the cost of pointing one at a real database by accident, and the operator
 * who would be pointing it there is the one under time pressure.
 */
export function describeDisposabilityRefusal(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "no database URL was given.";

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "the database URL does not parse as a URL.";
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return `the URL scheme is ${parsed.protocol} — this rehearsal only speaks PostgreSQL.`;
  }

  // EVERY QUERY PARAMETER IS REFUSED, and this is not tidiness. The two guards
  // below read `URL.hostname` and `URL.port`, but node-postgres does not: it
  // hands the string to `pg-connection-string`, which lets the QUERY STRING
  // override both. Measured against the copy in this checkout:
  //
  //   ?host=/var/run/postgresql  -> host becomes the local socket, so a URL
  //                                 spelling 127.0.0.1 connects somewhere else
  //                                 entirely and the loopback guard sees nothing
  //   ?port=5432                 -> port becomes 5432, walking straight through
  //                                 the one port this script refuses outright
  //
  // `hostaddr`, `dbname`, `options` and an upper-case `HOST` are ignored by that
  // parser today — which is exactly why an allowlist of "the dangerous ones"
  // would be wrong: it would encode a measurement of one version of one library
  // and rot silently. A rehearsal URL is loopback, non-5432 and throwaway; it
  // has no legitimate need of a parameter, so any parameter is refused and the
  // remedy is to delete it.
  if (parsed.search !== "") {
    const names = [...new Set([...parsed.searchParams.keys()])].join(", ");
    return (
      `the URL carries query parameter(s) (${names}), and this rehearsal refuses all of\n` +
      `  them. node-postgres reads the connection out of the query string as well as out\n` +
      `  of the URL: ?host= redirects to another server and ?port= overrides the port,\n` +
      `  both past the checks below. Delete the query string and point the URL itself at\n` +
      `  the throwaway server.`
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    return (
      `the host is ${host || "(empty)"}, which is not loopback. A rehearsal writes a\n` +
      `  whole migration history and then drops a database; it runs only against a\n` +
      `  throwaway PostgreSQL on this machine. Start one (a container on a spare\n` +
      `  port) rather than reaching across the network.`
    );
  }

  // No port means 5432, and 5432 is refused whatever spelling gets it there.
  const port = parsed.port === "" ? REFUSED_PORT : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return `the port ${parsed.port} is not a port number.`;
  }
  if (port === REFUSED_PORT) {
    return (
      `the port is ${REFUSED_PORT}${parsed.port === "" ? " (implied: the URL names no port)" : ""}.\n` +
      `  ${REFUSED_PORT} is PostgreSQL's default, so on a machine that also runs a real\n` +
      `  instance — an operator's server, a fork owner's box — loopback:${REFUSED_PORT} IS that\n` +
      `  instance. It is refused outright rather than inspected. Run the throwaway\n` +
      `  container on another port and point this at that.`
    );
  }

  const database = parsed.pathname.replace(/^\//, "");
  if (!database) {
    return "the URL names no database to connect to.";
  }

  return null;
}

/** A scratch database this script created, named from 8 crypto bytes. */
const SCRATCH_DATABASE_PATTERN = /^epic_rehearsal_[0-9a-f]{16}$/;

/**
 * Why this CLUSTER is not obviously disposable, or null when it is.
 *
 * The emptiness test this script has always run inspects the MAINTENANCE
 * database it connects to — and on a production cluster that database is
 * `postgres`, which is empty there too. So on an operator's box the only thing
 * between this script and `CREATE DATABASE` on the live server was the loopback
 * and non-5432 pair, and a server administered from the machine it runs on
 * satisfies both. `SELECT datname FROM pg_database` is the honest question: a
 * throwaway container holds `postgres` and nothing else, while a real cluster
 * names the club's database out loud.
 *
 * Templates are excluded by the query. `postgres` is allowed because every
 * cluster has it, the maintenance database is allowed because that is the one
 * already inspected for tables, and a leftover `epic_rehearsal_<hex>` is allowed
 * because `--keep-scratch` is a documented option and its own droppings must not
 * lock the next run out.
 */
export function describeClusterNotDisposable(
  databaseNames: readonly string[],
  maintenanceDatabase: string,
): string | null {
  const foreign = databaseNames.filter(
    (name) =>
      name !== maintenanceDatabase &&
      name !== "postgres" &&
      !SCRATCH_DATABASE_PATTERN.test(name),
  );
  if (foreign.length === 0) return null;

  const listed = foreign.slice(0, 5).join(", ");
  return (
    `the PostgreSQL server it was pointed at holds ${foreign.length} database(s) that are\n` +
    `  not this rehearsal's own: ${listed}${foreign.length > 5 ? ", …" : ""}.\n` +
    "  That is somebody's cluster until proven otherwise, and an empty maintenance\n" +
    "  database proves nothing about it — a production server's `postgres` database is\n" +
    "  empty too. This script CREATES and DROPS databases on the server it connects to,\n" +
    "  so it runs only against a server that holds nothing else. Start a throwaway\n" +
    "  container on a spare port and point it at that."
  );
}

/** Fail closed rather than measure against a history git cannot fully see. */
function assertNotShallow(root: string): void {
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]).trim();
  if (shallow !== "false") {
    throw new Error(
      `This is a shallow clone (git rev-parse --is-shallow-repository = ${shallow}).\n` +
        `  A truncated history narrows the base-ref diff SILENTLY rather than erroring,\n` +
        `  so the rehearsal would apply an incomplete set of migrations and pass.\n` +
        `  Fix with:  git fetch --unshallow`,
    );
  }
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Every migration whose own `migration.sql` this branch ADDS since the base.
 *
 * The counterpart of check 4 in `scripts/check-migration-safety-coverage.sh`,
 * and deliberately the same rule: keyed on `migration.sql` (a pre-existing
 * migration that merely gains a `rollback.sql` here is not new), `--no-renames`
 * so a folder renamed into existence reads as an addition, and untracked files
 * included so a rehearsal can be run before the commit.
 */
export function addedMigrationsSinceBase(root: string, baseSha: string): string[] {
  const tracked = git(root, [
    "diff",
    "--name-only",
    "--diff-filter=A",
    "--no-renames",
    baseSha,
    "--",
    "prisma/migrations",
  ]);
  const untracked = git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "prisma/migrations",
  ]);

  const names = new Set<string>();
  for (const line of `${tracked}\n${untracked}`.split("\n")) {
    const match = /^prisma\/migrations\/([^/]+)\/migration\.sql$/.exec(line.trim());
    if (match) names.add(match[1] as string);
  }
  return [...names].sort();
}

/** Every migration present at the base ref, in the order PostgreSQL will see them. */
function baseMigrations(root: string, baseSha: string): string[] {
  const listing = git(root, [
    "ls-tree",
    "-r",
    "--name-only",
    baseSha,
    "--",
    "prisma/migrations",
  ]);
  const names = new Set<string>();
  for (const line of listing.split("\n")) {
    const match = /^prisma\/migrations\/([^/]+)\/migration\.sql$/.exec(line.trim());
    if (match) names.add(match[1] as string);
  }
  return [...names].sort();
}

/** Table names an added migration mentions, for the report only. */
export function tablesMentioned(sql: string): string[] {
  const tables = new Set<string>();
  const patterns = [
    /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi,
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi,
    /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi,
    /\bON\s+"([^"]+)"/gi,
    /\bINSERT\s+INTO\s+"([^"]+)"/gi,
    /\bUPDATE\s+"([^"]+)"/gi,
    /\bDELETE\s+FROM\s+"([^"]+)"/gi,
  ];
  for (const pattern of patterns) {
    for (const match of sql.matchAll(pattern)) tables.add(match[1] as string);
  }
  return [...tables].sort();
}

async function applyMigrationSql(
  client: Client,
  migration: string,
  sql: string,
): Promise<void> {
  const statements = splitSqlStatements(sql);
  for (const statement of statements) {
    try {
      // Rehearsal harness: replays this repository's own committed migration SQL
      // against a scratch database it created. No user input reaches here.
      // nosemgrep: javascript.express.db.pg-express.pg-express
      await client.query(statement);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${migration} failed to apply: ${detail}\n  statement: ${statement.slice(0, 300)}`,
      );
    }
  }
}

type ModelReading = {
  model: string;
  table: string;
  rows: number | null;
  error: string | null;
};

/**
 * A schema reduced to what it MEANS, so two spellings of the same schema compare
 * equal and two different schemas never do.
 *
 * Prisma rewrites the schema it emits beside a generated client: it re-aligns
 * every field declaration, and — measured on this repository's own schema — it
 * REORDERS the `@@index`/`@@unique` block attributes within a model. So byte
 * equality is not the question; the question is whether the same declarations are
 * present. Trimming, collapsing internal whitespace, dropping blank lines and
 * sorting answers exactly that: a permutation compares equal, and a schema
 * differing by one field does not (both verified against the real 6,853-line
 * schema before this was relied on).
 *
 * Note this deliberately does NOT run `prisma format` on anything — AGENTS.md
 * forbids that, and the reformatting here is Prisma's own, inside a throwaway
 * copy under `node_modules/.cache/`.
 */
export function normaliseSchemaForComparison(schema: string): string {
  return schema
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0)
    .sort()
    .join("\n");
}

/**
 * Generate a Prisma client from the BASE REF's schema, into a scratch directory.
 *
 * Two things here are load-bearing and both were measured rather than assumed:
 *
 * 1. The scratch directory lives under `node_modules/.cache/`. Prisma resolves
 *    `@prisma/client` relative to the SCHEMA, so a schema in `os.tmpdir()` fails
 *    with `Could not resolve @prisma/client`; `node_modules/.cache/**` resolves,
 *    and it is outside `tsconfig.json`'s globs and already git-ignored, so the
 *    generated client is invisible to typecheck, knip and the file-size ratchet.
 * 2. The generated client writes its own `schema.prisma` beside itself, and this
 *    function CHECKS that copy against the base schema it asked for. `--schema`
 *    overriding `prisma.config.ts` is what makes this work at all; if a future
 *    Prisma reversed that precedence the client would silently be the CURRENT
 *    schema's, every read would pass, and the rehearsal would certify nothing.
 */
function generateBaseClient(
  root: string,
  baseSha: string,
  scratchDir: string,
  scratchUrl: string,
): string {
  const baseSchema = git(root, ["show", `${baseSha}:prisma/schema.prisma`]);
  if (!/generator\s+client\s*\{/.test(baseSchema)) {
    throw new Error(
      `prisma/schema.prisma at ${baseSha.slice(0, 12)} has no generator client block.`,
    );
  }
  const withOutput = baseSchema.replace(
    /generator\s+client\s*\{/,
    (matched) => `${matched}\n  output = "./client"`,
  );

  mkdirSync(scratchDir, { recursive: true });
  const schemaPath = path.join(scratchDir, "schema.prisma");
  writeFileSync(schemaPath, withOutput, "utf8");

  // The CLI's own entry script under `node`, not `node_modules/.bin/prisma`.
  // Measured on Windows: spawning the `.cmd` shim without a shell fails with
  // `spawnSync node_modules\.bin\prisma.cmd EINVAL` (Node's .cmd/.bat spawn
  // restriction), and `shell: true` would then need the path quoting to be right
  // on both platforms. Resolving the package's declared bin avoids both.
  const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
  execFileSync(
    process.execPath,
    [prismaCli, "generate", "--schema", schemaPath, "--no-hints"],
    {
      cwd: root,
      // The scratch URL, not the ambient DATABASE_URL: generation does not
      // connect, but nothing in this script should ever hand a real URL to a
      // child process.
      env: { ...process.env, DATABASE_URL: scratchUrl },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    },
  );

  const clientDir = path.join(scratchDir, "client");
  // Test fixture path: a directory this function just created.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const emitted = readFileSync(path.join(clientDir, "schema.prisma"), "utf8");
  if (normaliseSchemaForComparison(emitted) !== normaliseSchemaForComparison(withOutput)) {
    throw new Error(
      "The generated client is NOT the base ref's client: the schema Prisma emitted\n" +
        "  beside it differs from the schema this script asked for. `--schema` must be\n" +
        "  overriding prisma.config.ts for this rehearsal to mean anything, and it is\n" +
        "  not. Refusing to report a pass that would certify nothing.",
    );
  }
  return clientDir;
}

/**
 * A Prisma read failure reduced to one printable line.
 *
 * Not `message.split("\n")[0]`: a Prisma client error opens with a BLANK line
 * and puts the sentence that matters ("The column Member.phoneNumber does not
 * exist in the current database") several lines down, so taking the first line
 * printed an empty finding — measured, on the mutation probe this function was
 * written for. Every non-empty line is joined instead, and truncated, so the
 * reason is always in the report.
 */
export function summariseReadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const joined = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Drop Prisma's code frame: it quotes THIS script's own source around the
    // call site, which is several lines of noise ahead of the sentence a reader
    // needs and would otherwise push it past the truncation below.
    .filter((line) => !/^(?:→\s*)?\d+\s/.test(line))
    .filter((line) => !line.startsWith("Invalid `"))
    .filter((line) => !/\.[cm]?tsx?:\d+:\d+$/.test(line))
    .join(" | ");
  if (joined.length === 0) return "read failed with an empty error message";
  return joined.length > 400 ? `${joined.slice(0, 400)}…` : joined;
}

/** Read every model the BASE schema knows, with the base ref's own client. */
async function readEveryModelWithBaseClient(
  clientDir: string,
  scratchUrl: string,
): Promise<ModelReading[]> {
  const require = createRequire(import.meta.url);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const generated = require(clientDir) as any;
  const { PrismaPg } = require("@prisma/adapter-pg") as any;
  const models: { name: string; dbName: string | null }[] =
    generated.Prisma?.dmmf?.datamodel?.models ?? [];
  if (models.length === 0) {
    throw new Error("The generated base client exposes no models to read.");
  }

  const client = new generated.PrismaClient({
    adapter: new PrismaPg({ connectionString: scratchUrl }),
  });
  const readings: ModelReading[] = [];
  try {
    for (const model of models) {
      const property = model.name.charAt(0).toLowerCase() + model.name.slice(1);
      const delegate = (client as any)[property];
      const table = model.dbName ?? model.name;
      if (!delegate || typeof delegate.findMany !== "function") {
        readings.push({
          model: model.name,
          table,
          rows: null,
          error: "the base client exposes no readable delegate for this model",
        });
        continue;
      }
      try {
        // The proof: Prisma emits an explicit column list, so a column the epic
        // removed or renamed makes this throw exactly as the draining colour would.
        await delegate.findMany({ take: 1 });
        const rows = await delegate.count();
        readings.push({ model: model.name, table, rows, error: null });
      } catch (error) {
        readings.push({
          model: model.name,
          table,
          rows: null,
          error: summariseReadError(error),
        });
      }
    }
  } finally {
    await client.$disconnect().catch(() => {});
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return readings;
}

const HELP = `Epic deploy rehearsal (#3002)

  npm run db:rehearse-epic -- --database-url <throwaway postgres URL> [options]

Applies the base ref's migrations to a throwaway PostgreSQL, applies the
migrations THIS BRANCH adds on top, then generates a Prisma client from the BASE
REF's schema and reads every model with it. A read that fails is the colour
draining at cutover failing.

Options
  --database-url <url>  REQUIRED. A throwaway PostgreSQL. Loopback only, never
                        port ${REFUSED_PORT}, and no query string (node-postgres reads
                        ?host= and ?port= out of it, past both of those). The
                        server must hold no databases beyond the one named here
                        and \`postgres\`. Also accepted as
                        EPIC_REHEARSAL_DATABASE_URL. DATABASE_URL is never used.
  --base <ref>          Base ref to rehearse against (default ${DEFAULT_BASE_REF}).
                        Pass the pre-push SHA on a push event.
  --seed-sql <file>     Extra SQL run after the base migrations, to put rows in
                        tables the epic touches. Optional: the base migration
                        chain already plants a real install's starter rows.
  --keep-scratch        Leave the scratch database and generated client behind.
  --help                This text.

WHAT A GREEN RUN DOES NOT PROVE
  - Writes. It reads only; a dropped NOT NULL column with no default passes here.
  - The application's own query shapes, includes, filters or raw SQL.
  - The exact previously-released client: it uses the base ref's SCHEMA with the
    Prisma version installed in this checkout.
  - Value decoding for a model with no rows: that read proves the column list.
  - rollback.sql, and the operational deploy sequence.
  The module docblock in scripts/rehearse-epic-deploy.ts carries the full list.
`;

export async function run(root: string, argv: readonly string[]): Promise<number> {
  let options: RehearsalOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`rehearse-epic-deploy: ${error instanceof Error ? error.message : error}`);
    console.error(HELP);
    return 1;
  }

  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const refusal = describeDisposabilityRefusal(options.databaseUrl ?? "");
  if (refusal) {
    console.error("REFUSED — this rehearsal will not run here.");
    console.error(`  ${refusal}`);
    console.error(
      "\n  Pass --database-url (or EPIC_REHEARSAL_DATABASE_URL). It is never read from\n" +
        "  DATABASE_URL, because on an operator's host that is the live database.",
    );
    return 1;
  }
  const adminUrl = (options.databaseUrl as string).trim();

  try {
    assertNotShallow(root);
  } catch (error) {
    console.error(`REFUSED — ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  const base = resolveBaseRef(root, options.baseRef);
  if (!base.ok) {
    console.error(`REFUSED — the base ref could not be resolved.\n  ${base.error}`);
    return 1;
  }
  const baseSha = base.sha;

  const added = addedMigrationsSinceBase(root, baseSha);
  const chain = baseMigrations(root, baseSha);
  console.log(`Base ref     : ${options.baseRef} (merge base ${baseSha.slice(0, 12)})`);
  console.log(`Base chain   : ${chain.length} migration(s)`);
  console.log(`This branch  : ${added.length} migration(s) added`);
  for (const migration of added) {
    const sql = readMigrationSql(root, migration);
    const tables = tablesMentioned(sql);
    console.log(`  + ${migration}${tables.length > 0 ? `  [${tables.join(", ")}]` : ""}`);
  }
  if (added.length === 0) {
    console.log(
      "\nNothing to rehearse: this branch adds no migration. That is a real answer, not\n" +
        "a pass — there is no epic deploy here to prove anything about.",
    );
    return 0;
  }

  const scratchDatabase = `epic_rehearsal_${randomBytes(8).toString("hex")}`;
  const scratchUrlObject = new URL(adminUrl);
  scratchUrlObject.pathname = `/${scratchDatabase}`;
  const scratchUrl = scratchUrlObject.toString();
  const scratchDir = path.join(
    root,
    "node_modules",
    ".cache",
    "epic-deploy-rehearsal",
    scratchDatabase,
  );

  const admin = new Client({ connectionString: adminUrl });
  let scratch: Client | null = null;
  let failures = 0;

  try {
    await admin.connect();

    // The cluster test comes first because it is the broader one: it asks what
    // this SERVER is, where the query below asks only what one database holds.
    const clusterDatabases = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
    );
    const clusterRefusal = describeClusterNotDisposable(
      clusterDatabases.rows.map((row) => row.datname),
      new URL(adminUrl).pathname.replace(/^\//, ""),
    );
    if (clusterRefusal) {
      console.error("REFUSED — this rehearsal will not run here.");
      console.error(`  ${clusterRefusal}`);
      return 1;
    }

    const existing = await admin.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    if (existing.rows.length > 0) {
      const sample = existing.rows.slice(0, 5).map((row) => row.table_name).join(", ");
      console.error("REFUSED — this rehearsal will not run here.");
      console.error(
        `  The database it was pointed at already holds ${existing.rows.length} table(s) in its\n` +
          `  public schema (${sample}${existing.rows.length > 5 ? ", …" : ""}). That is somebody's data\n` +
          "  until proven otherwise. Point this at an EMPTY database — it creates and\n" +
          "  drops a scratch database of its own and never touches the one it connects to.",
      );
      return 1;
    }

    // Rehearsal harness: a name this script generated from crypto bytes.
    // nosemgrep: javascript.express.db.pg-express.pg-express
    await admin.query(`CREATE DATABASE "${scratchDatabase}"`);
    console.log(`\nScratch      : ${scratchDatabase} (created; dropped on exit)`);

    scratch = new Client({ connectionString: scratchUrl });
    await scratch.connect();

    console.log(`\n[1/4] Applying the base ref's ${chain.length} migration(s)…`);
    for (const migration of chain) {
      await applyMigrationSql(scratch, migration, gitShowMigration(root, baseSha, migration));
    }
    console.log("      base chain applied.");

    if (options.seedSqlPath) {
      const seedPath = path.resolve(root, options.seedSqlPath);
      console.log(`\n[2/4] Seeding extra pre-epic rows from ${options.seedSqlPath}…`);
      await applyMigrationSql(scratch, `--seed-sql ${options.seedSqlPath}`, readFileSync(seedPath, "utf8"));
      console.log("      seed applied.");
    } else {
      console.log(
        "\n[2/4] No --seed-sql given. The pre-epic state is what the base migration chain\n" +
          "      itself plants, which is what a real install holds on that release. Row\n" +
          "      counts per model are reported below so this is visible rather than assumed.",
      );
    }

    console.log(`\n[3/4] Applying this branch's ${added.length} migration(s) on top…`);
    for (const migration of added) {
      await applyMigrationSql(scratch, migration, readMigrationSql(root, migration));
      console.log(`      applied ${migration}`);
    }

    console.log(
      `\n[4/4] Reading every model with a client generated from ${options.baseRef}'s schema…`,
    );
    const clientDir = generateBaseClient(root, baseSha, scratchDir, scratchUrl);
    const readings = await readEveryModelWithBaseClient(clientDir, scratchUrl);

    const broken = readings.filter((reading) => reading.error !== null);
    const totalRows = readings.reduce((sum, reading) => sum + (reading.rows ?? 0), 0);
    const populated = readings.filter((reading) => (reading.rows ?? 0) > 0);

    console.log(
      `      read ${readings.length} model(s); ${populated.length} held rows (${totalRows} row(s) total).`,
    );

    if (broken.length > 0) {
      failures = 1;
      console.error(`\nREHEARSAL FAILED — ${broken.length} model(s) the pre-epic release reads are broken`);
      console.error(
        "by this epic's migrations. In a real deploy that is the draining colour erroring\n" +
          "between migrate and cutover, on live traffic.\n",
      );
      for (const reading of broken) {
        console.error(`  ${reading.model} (table "${reading.table}")`);
        console.error(`    ${reading.error}`);
      }
      console.error(
        "\nWhat to do: make each migration old-code compatible against the PRE-EPIC\n" +
          "release, or declare the incompatibility honestly — old_code_compatible=windowed\n" +
          "with the window written into lock_impact_plan and a rollback.sql beside the\n" +
          "migration. docs/BLUE_GREEN_MIGRATION_POLICY.md owns both routes.",
      );
    } else {
      console.log(
        `\nREHEARSAL PASSED — every one of the ${readings.length} model(s) in ${options.baseRef}'s schema\n` +
          "still reads after this branch's migrations are applied.",
      );
      const empty = readings.length - populated.length;
      if (empty > 0) {
        console.log(
          `Stated limit: ${empty} model(s) held no rows, so for those this proves the column\n` +
            "list and not value decoding. Pass --seed-sql to put rows in the tables this\n" +
            "epic touches if a column TYPE changed.",
        );
      }
      console.log(
        "Stated limit: reads only. See the module docblock for the full list of what a\n" +
          "green run here does NOT prove — writes and the app's own query shapes included.",
      );
    }
  } catch (error) {
    failures = 1;
    console.error(`\nREHEARSAL FAILED — ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await scratch?.end().catch(() => {});
    if (options.keepScratch) {
      console.log(`\nKept scratch database ${scratchDatabase} and ${path.relative(root, scratchDir)}.`);
    } else {
      try {
        // Rehearsal harness: drops the database this script created above.
        // nosemgrep: javascript.express.db.pg-express.pg-express
        await admin.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
      } catch {
        console.error(`Could not drop scratch database ${scratchDatabase}; drop it by hand.`);
      }
      rmSync(scratchDir, { force: true, recursive: true });
    }
    await admin.end().catch(() => {});
  }

  return failures;
}

function readMigrationSql(root: string, migration: string): string {
  // Rehearsal harness: joins this repository's own migrations directory with a
  // folder name git reported from that same directory.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.join(root, "prisma", "migrations", migration, "migration.sql"), "utf8");
}

function gitShowMigration(root: string, baseSha: string, migration: string): string {
  return git(root, ["show", `${baseSha}:prisma/migrations/${migration}/migration.sql`]);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  run(process.cwd(), process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`rehearse-epic-deploy: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    });
}
