/**
 * #4453 review (S-F2): the restore-validation guard compares WHERE a connection
 * string points, not who connects; and the validation restore drops only the
 * ownership and privilege statements, never row data or routine source.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

import {
  createOwnershipAndPrivilegeStripStream,
  isSameDatabaseTarget,
  restoreDumpWithoutOwnershipOrPrivileges,
  stripOwnershipAndPrivilegeStatements,
} from "@/lib/backup-restore-validation";

const LIVE = "postgresql://tac_app:app-pw@postgres:5432/tacbookings?connection_limit=10&pool_timeout=10";

describe("isSameDatabaseTarget", () => {
  it.each([
    ["another role and password", "postgresql://tac:op-pw@postgres:5432/tacbookings"],
    ["no port (the default)", "postgresql://tac_restore_check:pw@postgres/tacbookings"],
    ["other parameters", "postgresql://u:p@postgres:5432/tacbookings?sslmode=disable&options=-c%20x%3D1"],
    ["a host spelled in capitals", "postgresql://u:p@POSTGRES:5432/tacbookings"],
    ["a libpq dbname override", "postgresql://u:p@postgres:5432/scratch?dbname=tacbookings"],
    ["a trailing-dot host (N5)", "postgresql://u:p@postgres.:5432/tacbookings"],
    ["a port spelled port=05432 (N5)", "postgresql://u:p@postgres/tacbookings?port=05432"],
    ["another host or IP for the same name (N5)", "postgresql://u:p@10.0.0.5:5432/tacbookings"],
    ["no database path, so libpq uses the user name (N5)", "postgresql://tacbookings:p@postgres:5432"],
    ["no path and a user parameter (N5)", "postgresql://postgres:5432?user=tacbookings"],
  ])("treats %s as the live database", (_label, url) => {
    expect(isSameDatabaseTarget(url, LIVE)).toBe(true);
  });

  it("treats any loopback spelling as one database name", () => {
    expect(
      isSameDatabaseTarget("postgresql://a@localhost/tacbookings", "postgresql://b@127.0.0.1:5432/tacbookings"),
    ).toBe(true);
  });

  it.each([
    ["another database name", "postgresql://tac_app:app-pw@postgres:5432/tacbookings_restore_check"],
    ["another name on another host", "postgresql://tac_app:app-pw@shadow:5432/restore_check"],
    ["a user-named default that differs", "postgresql://restore_check:p@postgres:5432"],
  ])("allows %s", (_label, url) => {
    expect(isSameDatabaseTarget(url, LIVE)).toBe(false);
  });

  it("fails closed on a string it cannot parse", () => {
    expect(isSameDatabaseTarget("host=postgres dbname=other", LIVE)).toBe(true);
  });

  it.each([
    ["a database path", "postgresql://u:p@shadow:5432/restore_check%E0%A4%A"],
    ["a user name with no path", "postgresql://u%E0%A4%A:p@shadow:5432"],
  ])("fails closed, without throwing, on a malformed escape in %s (#4453 review R5)", (_label, url) => {
    expect(() => isSameDatabaseTarget(url, LIVE)).not.toThrow();
    expect(isSameDatabaseTarget(url, LIVE)).toBe(true);
  });
});

describe("stripOwnershipAndPrivilegeStatements", () => {
  const dump = [
    "CREATE TABLE public.\"BookingLedgerLine\" (",
    "    id text NOT NULL",
    ");",
    "ALTER TABLE public.\"BookingLedgerLine\" OWNER TO tac_migrator;",
    "ALTER SCHEMA public OWNER TO pg_database_owner;",
    "ALTER SEQUENCE public.\"PaymentTransaction_insertionSeq_seq\" OWNED BY public.\"PaymentTransaction\".\"insertionSeq\";",
    "CREATE FUNCTION public.f() RETURNS trigger",
    "    LANGUAGE plpgsql",
    "    AS $$",
    "GRANT ALL ON TABLE x TO y;",
    "BEGIN RETURN NEW; END;",
    "$$;",
    "ALTER FUNCTION public.f() OWNER TO tac_migrator;",
    "COPY public.\"AuditLog\" (id, action) FROM stdin;",
    "GRANT ALL ON TABLE public.\"x\" TO tac_app;\tlooks like a grant, is a row",
    "\\.",
    "GRANT SELECT,INSERT ON TABLE public.\"BookingLedgerLine\" TO tac_app;",
    "REVOKE ALL ON SCHEMA public FROM PUBLIC;",
    "ALTER DEFAULT PRIVILEGES FOR ROLE tac_migrator IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO tac_app;",
    "",
  ].join("\n");
  const stripped = stripOwnershipAndPrivilegeStatements(dump);

  it("removes every owner, grant, revoke and default-privilege statement", () => {
    expect(stripped).not.toContain("OWNER TO");
    expect(stripped).not.toMatch(/^GRANT SELECT/m);
    expect(stripped).not.toMatch(/^REVOKE/m);
    expect(stripped).not.toContain("ALTER DEFAULT PRIVILEGES");
  });

  it("keeps row data, routine bodies, OWNED BY and the schema itself", () => {
    expect(stripped).toContain("GRANT ALL ON TABLE public.\"x\" TO tac_app;\tlooks like a grant, is a row");
    expect(stripped).toContain("GRANT ALL ON TABLE x TO y;");
    expect(stripped).toContain("OWNED BY public.\"PaymentTransaction\"");
    expect(stripped).toContain("CREATE TABLE public.\"BookingLedgerLine\" (");
    expect(stripped.split("\n")).toHaveLength(dump.split("\n").length - 6);
  });
});

describe("the streamed strip (#4453 review N2)", () => {
  // A dump with a multi-byte character (a macron) and no trailing newline, so a
  // chunk boundary can split a character, a line, or the last line.
  const dump = [
    "CREATE TABLE public.\"Member\" (\"lastName\" text);",
    "ALTER TABLE public.\"Member\" OWNER TO tac_migrator;",
    "COPY public.\"Member\" (\"lastName\") FROM stdin;",
    "Māori-Tūhoe",
    "GRANT ALL ON TABLE x TO y;",
    "\\.",
    "CREATE FUNCTION public.f() RETURNS int AS $_$",
    "REVOKE ALL ON TABLE x FROM y;",
    "$_$;",
    "GRANT SELECT ON TABLE public.\"Member\" TO tac_app;",
    "SELECT 'last line, no newline';",
  ].join("\n");
  const bytes = Buffer.from(dump, "utf8");

  async function streamed(chunkSize: number, input: Buffer = bytes): Promise<string> {
    const chunks: Buffer[] = [];
    for (let start = 0; start < input.length; start += chunkSize) chunks.push(input.subarray(start, start + chunkSize));
    const out: Buffer[] = [];
    await pipeline(
      Readable.from(chunks),
      createOwnershipAndPrivilegeStripStream(),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          out.push(Buffer.from(chunk));
          callback();
        },
      }),
    );
    return Buffer.concat(out).toString("utf8");
  }

  it.each([1, 2, 3, 7, 64, 65_536])("matches the pure function byte for byte, in %i-byte chunks", async (size) => {
    expect(await streamed(size)).toBe(stripOwnershipAndPrivilegeStatements(dump));
  });

  it("matches with a trailing newline too", async () => {
    const withNewline = `${dump}\n`;
    const out: string[] = [];
    await pipeline(
      Readable.from([Buffer.from(withNewline)]),
      createOwnershipAndPrivilegeStripStream(),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          out.push(chunk.toString("utf8"));
          callback();
        },
      }),
    );
    expect(out.join("")).toBe(stripOwnershipAndPrivilegeStatements(withNewline));
  });

  it.each([1, 5, 65_536])(
    "matches when the dropped line is the last, with no trailing newline, in %i-byte chunks (#4453 review R3)",
    async (size) => {
      const droppedLast = `${dump}\nGRANT SELECT ON TABLE public."Member" TO tac_app;`;
      const pure = stripOwnershipAndPrivilegeStatements(droppedLast);
      expect(pure.endsWith("'last line, no newline';")).toBe(true);
      expect(await streamed(size, Buffer.from(droppedLast, "utf8"))).toBe(pure);
    },
  );

  it("matches when every line is dropped", async () => {
    const allDropped = "GRANT ALL ON TABLE x TO y;\nREVOKE ALL ON TABLE x FROM y;";
    expect(await streamed(4, Buffer.from(allDropped))).toBe(stripOwnershipAndPrivilegeStatements(allDropped));
  });

  it("streams a multi-megabyte single line in linear time (#4453 review R2)", async () => {
    // 8 MiB with no newline, in 1 KiB chunks: re-splitting everything held on
    // every chunk scans ~32 GiB; one pass over each chunk scans 8 MiB.
    const line = `COPY x FROM stdin;\n${"a".repeat(8 * 1024 * 1024)}`;
    const start = process.hrtime.bigint();
    const out = await streamed(1024, Buffer.from(line));
    expect(realElapsedMs(start)).toBeLessThan(5_000);
    expect(out).toBe(line);
  });

  describe("restoreDumpWithoutOwnershipOrPrivileges", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "restore-validation-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const gz = path.join(dir, "backup.sql.gz");
    writeFileSync(gz, gzipSync(bytes));
    // A stand-in `psql` on PATH: records its stdin and arguments, exits as told.
    const bin = path.join(dir, "bin");
    const psql = path.join(bin, "psql");
    const makePsql = (body: string) => {
      rmSync(bin, { recursive: true, force: true });
      mkdirSync(bin);
      writeFileSync(psql, `#!/bin/sh\n${body}\n`);
      chmodSync(psql, 0o755);
    };
    const env = (): NodeJS.ProcessEnv => ({ NODE_ENV: "test", PATH: `${bin}:${process.env.PATH ?? ""}`, CAPTURE: path.join(dir, "stdin.sql") });

    it("streams the gunzipped, stripped dump into psql's stdin", async () => {
      makePsql('printf "%s\\n" "$@" > "$CAPTURE.args"; cat > "$CAPTURE"');
      await restoreDumpWithoutOwnershipOrPrivileges({
        sourcePath: gz,
        argvUrl: "postgresql://check@shadow/tacbookings_restore_check",
        env: env(),
        timeoutMs: 30_000,
      });
      expect(readFileSync(path.join(dir, "stdin.sql"), "utf8")).toBe(stripOwnershipAndPrivilegeStatements(dump));
      expect(readFileSync(path.join(dir, "stdin.sql.args"), "utf8")).toContain("ON_ERROR_STOP=1");
    });

    it("reports psql's own reason when it stops early", async () => {
      makePsql('head -c 10 >/dev/null; echo "ERROR:  must be owner of table Member" >&2; exit 3');
      await expect(
        restoreDumpWithoutOwnershipOrPrivileges({
          sourcePath: gz,
          argvUrl: "postgresql://check@shadow/tacbookings_restore_check",
          env: env(),
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow(/psql exited 3: ERROR: {2}must be owner of table Member/);
    });

    it("rejects with the cause, and no unhandled rejection, when psql is not on PATH (#4453 review R1)", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const empty = path.join(dir, "empty-bin");
        mkdirSync(empty, { recursive: true });
        await expect(
          restoreDumpWithoutOwnershipOrPrivileges({
            sourcePath: gz,
            argvUrl: "postgresql://check@shadow/tacbookings_restore_check",
            env: { NODE_ENV: "test", PATH: empty },
            timeoutMs: 30_000,
          }),
        ).rejects.toThrow(/Could not start psql for the restore validation: .*ENOENT/);
        // Let any stray rejection surface before checking.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });
});
