import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { bashFixturePath, bashGateArgs } from "../src/lib/__tests__/helpers/bash-fixture-path";

const root = path.resolve(import.meta.dirname, "..");
const scratchDirs: string[] = [];

// Synthetic pg_dump-shaped SQL: no production dump or credentials are used.
// COPY data and routine bodies deliberately resemble privilege statements.
const schemaAndData = `CREATE TABLE public.example (value text);
COPY public.example (value) FROM stdin;
GRANT SELECT ON TABLE public.example TO tac_app;
\\.
CREATE FUNCTION public.example_fn() RETURNS text
    LANGUAGE sql
    AS $function$
SELECT 'OWNER TO tac_migrator';
$function$;
`;
const dump = `${schemaAndData}ALTER TABLE public.example OWNER TO tac;
ALTER FUNCTION public.example_fn() OWNER TO tac_migrator;
GRANT SELECT ON TABLE public.example TO tac_app;
GRANT DELETE ON TABLE public.example TO tac_audit_retention;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE tac_migrator IN SCHEMA public GRANT SELECT ON TABLES TO tac_app;
`;

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runDrill(
  format: "plain" | "gzip" | "custom" | "corrupt",
  { failRestore = false, failFilter = false } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "restore-drill-test-"));
  scratchDirs.push(dir);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const source = path.join(dir, "input.dump");
  const contents = format === "gzip"
    ? gzipSync(dump)
    : format === "custom"
      ? Buffer.from("PGDMPsynthetic archive")
      : format === "corrupt"
        ? Buffer.from([0x1f, 0x8b, 0x00])
        : dump;
  writeFileSync(source, contents);
  writeFileSync(path.join(dir, "expected.sql"), schemaAndData);
  // Run the actual drill, replacing only external tools. The simulated empty
  // cluster accepts exactly the schema/data payload, without deployment ACLs.
  writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" pg_restore "* ]]; then
  printf '%s\\n' "$*" > "$DRILL_TEST_DIR/archive-args"
  cat > "$DRILL_TEST_DIR/restored.sql"
  [[ "$DRILL_TEST_FAIL_RESTORE" != 1 ]]
elif [[ " $* " == *" psql "* && " $* " == *" -i "* ]]; then
  cat > "$DRILL_TEST_DIR/restored.sql"
  if [[ "$DRILL_TEST_FAIL_FILTER" != 1 ]]; then
    cmp "$DRILL_TEST_DIR/expected.sql" "$DRILL_TEST_DIR/restored.sql" || exit 1
  fi
  [[ "$DRILL_TEST_FAIL_RESTORE" != 1 ]]
elif [[ " $* " == *" psql -tAX "* ]]; then
  echo 0
fi
`, { mode: 0o755 });
  writeFileSync(path.join(bin, "pnpm"), `#!/usr/bin/env bash
touch "$DRILL_TEST_DIR/migrated"
`, { mode: 0o755 });
  if (failFilter) {
    // The ownership filter dies mid-stream: psql accepts the partial SQL it got,
    // so only the pipeline's own exit status can stop a false PASS.
    writeFileSync(path.join(bin, "node"), `#!/usr/bin/env bash
head -n 1
exit 1
`, { mode: 0o755 });
  }
  const driver = path.join(dir, "run.sh");
  writeFileSync(driver, `export PATH="$DRILL_TEST_DIR/bin:$PATH"
exec bash scripts/backup-restore-drill.sh "$@"
`);
  const result = spawnSync("bash", bashGateArgs(
    bashFixturePath(driver, root),
    ["--from-dump", bashFixturePath(source, root)],
    {
      TMPDIR: bashFixturePath(dir, root),
      DRILL_TEST_DIR: bashFixturePath(dir, root),
      DRILL_TEST_FAIL_RESTORE: failRestore ? "1" : "0",
      DRILL_TEST_FAIL_FILTER: failFilter ? "1" : "0",
    },
  ), {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
  });
  return { result, dir, source, contents };
}

describe("backup restore drill --from-dump", () => {
  for (const format of ["plain", "gzip"] as const) {
    it(`restores ${format} SQL without deployment roles and preserves row/routine data`, () => {
      const { result, dir, source, contents } = runDrill(format);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("RESULT: PASS");
      expect(readFileSync(path.join(dir, "restored.sql"), "utf8")).toBe(schemaAndData);
      expect(readFileSync(path.join(dir, "migrated"), "utf8")).toBe("");
      expect(readFileSync(source)).toEqual(Buffer.from(contents));
    }, 20_000);
  }

  it("restores custom archives without owners or ACLs and stops on errors", () => {
    const { result, dir, contents } = runDrill("custom");
    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(path.join(dir, "archive-args"), "utf8");
    expect(args).toContain("--no-owner");
    expect(args).toContain("--no-acl");
    expect(args).toContain("--exit-on-error");
    expect(readFileSync(path.join(dir, "restored.sql"))).toEqual(contents);
    expect(result.stdout).toContain("RESULT: PASS");
  }, 20_000);

  for (const format of ["plain", "gzip", "custom"] as const) {
    it(`does not report a pass after a ${format} restore failure`, () => {
      const { result } = runDrill(format, { failRestore: true });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("RESULT: PASS");
      expect(result.stdout).not.toContain("Running migrations forward");
    }, 20_000);
  }

  for (const format of ["plain", "gzip"] as const) {
    it(`does not report a pass when the ownership filter fails mid-stream on ${format} input`, () => {
      const { result, dir } = runDrill(format, { failFilter: true });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("RESULT: PASS");
      expect(result.stdout).not.toContain("Running migrations forward");
      // psql received the filter's partial output and accepted it.
      expect(readFileSync(path.join(dir, "restored.sql"), "utf8")).toBe(
        `${schemaAndData.split("\n")[0]}\n`,
      );
    }, 20_000);
  }

  it("rejects corrupt gzip input before reporting a successful drill", () => {
    const { result } = runDrill("corrupt");
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("RESULT: PASS");
  }, 20_000);
});
