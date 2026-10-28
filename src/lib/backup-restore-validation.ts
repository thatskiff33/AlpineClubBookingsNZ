/**
 * The nightly backup's restore-validation helpers (#4453 review, S-F2 / O-F11,
 * N2, N5): the live-database guard, and the owner/grant filter in a pure and a
 * streaming form. Kept free of `server-only` and of the environment so the unit
 * and real-PostgreSQL suites run them as shipped.
 */
import { createReadStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import { streamDatabaseTool } from "./backup-db-tool.ts";

/**
 * The database a connection string names, as libpq resolves it: a `dbname`
 * parameter wins over the path, and with neither, libpq uses the user name
 * (`user` parameter, then the URL's user). `null` when it cannot be read.
 */
function resolvedDatabaseName(connectionString: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    return null;
  }
  // A malformed escape (`%E0%A4`) is unreadable, so it reads as "the same
  // database" upstream: refuse rather than throw (#4453 review R5).
  try {
    const fromPath = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    const name =
      parsed.searchParams.get("dbname") ||
      fromPath ||
      parsed.searchParams.get("user") ||
      decodeURIComponent(parsed.username);
    return name || null;
  } catch {
    return null;
  }
}

/**
 * True when two connection strings may reach the same database. They do when
 * they NAME the same database, whatever the host, port, user, password or other
 * parameters (#4453 review N5).
 *
 * The restore-validation step starts with `DROP SCHEMA public CASCADE`, so it must
 * never be handed the live database (or the audit archive). Comparing hosts
 * cannot be made reliable — a container name and its IP, `postgres.` with a
 * trailing dot, `port=05432` — so the rule is the database NAME, which the
 * deployment guide already requires to differ. An unreadable string counts as
 * the same database: refusing is the safe answer.
 */
export function isSameDatabaseTarget(first: string, second: string): boolean {
  const a = resolvedDatabaseName(first);
  const b = resolvedDatabaseName(second);
  if (!a || !b) return true;
  return a === b;
}

/** A top-level statement that sets an owner or a privilege, as `pg_dump` writes it. */
const OWNERSHIP_OR_PRIVILEGE_STATEMENT =
  /^(ALTER [A-Z ]+ .* OWNER TO .*;|GRANT .*;|REVOKE .*;|ALTER DEFAULT PRIVILEGES .*;)$/;
const COPY_FROM_STDIN = /^COPY .* FROM stdin;$/;
const COPY_END = "\\.";
const DOLLAR_QUOTE = /\$[A-Za-z_0-9]*\$/g;

/**
 * The one line-by-line state machine both forms below run (`INV-SSOT`): it says
 * whether each line of a plain `pg_dump` is kept.
 *
 * `pg_dump` writes each owner and privilege statement on one line at column 0.
 * Lines inside a `COPY … FROM stdin` block are row data and lines inside a
 * dollar-quoted body are routine source, so neither is ever dropped. A `$tag$`
 * inside a single-quoted literal can desynchronise the dollar tracker; it then
 * KEEPS later owner lines, so the non-superuser restore fails closed rather than
 * dropping anything it should not.
 */
class OwnershipAndPrivilegeLineFilter {
  private inCopy = false;
  private openDollarTag: string | null = null;

  keep(line: string): boolean {
    if (this.inCopy) {
      if (line === COPY_END) this.inCopy = false;
      return true;
    }
    if (this.openDollarTag === null) {
      if (COPY_FROM_STDIN.test(line)) {
        this.inCopy = true;
        return true;
      }
      if (OWNERSHIP_OR_PRIVILEGE_STATEMENT.test(line)) return false;
    }
    for (const tag of line.match(DOLLAR_QUOTE) ?? []) {
      if (this.openDollarTag === null) this.openDollarTag = tag;
      else if (tag === this.openDollarTag) this.openDollarTag = null;
    }
    return true;
  }
}

/**
 * The backup SQL with every ownership and privilege statement removed, for the
 * restore-validation run only. This is what `pg_restore --no-owner --no-acl`
 * does for an archive; a plain-SQL dump has no such switch.
 *
 * Why: since #4453 a dump carries `OWNER TO <migration role>` and the role
 * grants, which only a superuser (or a member of those roles) may replay. The
 * validation proves the DATA restores, so it can run as a dedicated
 * non-superuser that owns only the shadow database, and the app never needs a
 * superuser credential. The real backup file is not changed: a disaster-recovery
 * restore, run by the operator, keeps the owners and grants.
 *
 * The whole-string form, for tests and small inputs; the validation itself runs
 * the streaming form below, so a large dump is never held in memory.
 */
export function stripOwnershipAndPrivilegeStatements(sql: string): string {
  const filter = new OwnershipAndPrivilegeLineFilter();
  return sql
    .split("\n")
    .filter((line) => filter.keep(line))
    .join("\n");
}

/**
 * The same filter as a stream (#4453 review N2): bytes in, bytes out, one line
 * held at a time. Its output is byte-identical to
 * `stripOwnershipAndPrivilegeStatements` over the whole input, in every case:
 * kept lines are joined by a newline written BEFORE each kept line but the
 * first, exactly as `Array.join` does, so a dropped last line leaves no newline
 * behind (#4453 review R3).
 *
 * Each chunk is searched for newlines on its own, and a line that spans chunks
 * is kept as a list of parts joined once, so a multi-megabyte line costs linear
 * time rather than a re-split of everything seen so far (#4453 review R2).
 */
export function createOwnershipAndPrivilegeStripStream(): Transform {
  const filter = new OwnershipAndPrivilegeLineFilter();
  const decoder = new StringDecoder("utf8");
  let parts: string[] = [];
  let first = true;
  const emit = (line: string): string => {
    if (!filter.keep(line)) return "";
    const out = first ? line : `\n${line}`;
    first = false;
    return out;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const text = decoder.write(chunk);
      let out = "";
      let start = 0;
      for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
        parts.push(text.slice(start, end));
        out += emit(parts.join(""));
        parts = [];
        start = end + 1;
      }
      if (start < text.length) parts.push(text.slice(start));
      callback(null, out.length > 0 ? out : undefined);
    },
    flush(callback) {
      parts.push(decoder.end());
      const out = emit(parts.join(""));
      callback(null, out.length > 0 ? out : undefined);
    },
  });
}

/**
 * Restore a gzipped plain dump into the validation database with owners and
 * grants left out, streamed end to end: file → gunzip → filter → `psql` stdin.
 * Throws with psql's own message (its first 64 KiB) when the restore fails.
 */
export async function restoreDumpWithoutOwnershipOrPrivileges(input: {
  sourcePath: string;
  argvUrl: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<void> {
  await streamDatabaseTool({
    command: "psql",
    args: [input.argvUrl, "-q", "-v", "ON_ERROR_STOP=1"],
    env: input.env,
    timeoutMs: input.timeoutMs,
    direction: "stdin",
    stream: (sink, signal) => pipeline(
      createReadStream(input.sourcePath),
      createGunzip(),
      createOwnershipAndPrivilegeStripStream(),
      sink,
      { signal },
    ),
    exitError: (code, _signal, stderr) => new Error(
      `Restore-validation psql exited ${code ?? "on a signal"}: ${stderr}`,
    ),
    spawnError: (error) => new Error(
      `Could not start psql for the restore validation: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    ),
  });
}
