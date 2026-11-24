import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  bashFixtureEnv,
  bashFixturePath,
  bashToolArgs,
  PATH_VALUED_ENV_KEYS,
  translateWindowsAbsolutePathForBash,
} from "./bash-fixture-path";

describe("bash fixture path transport (#2886)", () => {
  it("keeps the supported gate path-variable inventory explicit", () => {
    expect([...PATH_VALUED_ENV_KEYS].sort()).toEqual([
      "DATA_MIGRATION_GRANDFATHER_FILE",
      "DATA_MIGRATION_VERIFICATION_DIR",
      "MIGRATIONS_DIR",
      "MIGRATION_SAFETY_LEDGER",
      "SQL_STATEMENT_SPLITTER",
      "VALIDATOR",
    ]);
  });

  it("quotes POSIX tool arguments without relying on bash positional semantics", () => {
    expect(bashToolArgs("awk", ["two words", "it's quoted"])).toEqual([
      "-c",
      `exec 'awk' 'two words' 'it'"'"'s quoted'`,
    ]);
  });

  it("converts every path-valued variable and leaves prose untouched", () => {
    const cwd = process.cwd();
    const fixture = path.join(cwd, "fixtures", "migration.sql");
    const converted = bashFixtureEnv(
      Object.fromEntries([
        ...[...PATH_VALUED_ENV_KEYS].map((key) => [key, fixture]),
        ["BLUE_GREEN_MIGRATION_OVERRIDE_REASON", "keep \\ exactly"],
      ]),
      cwd,
    );

    const expectedFixture =
      path.sep === "/" ? fixture : "fixtures/migration.sql";
    for (const key of PATH_VALUED_ENV_KEYS) {
      expect(converted[key]).toBe(expectedFixture);
    }
    expect(converted.BLUE_GREEN_MIGRATION_OVERRIDE_REASON).toBe(
      "keep \\ exactly",
    );
  });

  it("asks the selected bash to translate a cross-volume Windows path", () => {
    const runner = vi.fn<(command: string, cwd: string) => string>(
      () => "/mnt/c/Temp/fixture.sql\n",
    );

    expect(
      translateWindowsAbsolutePathForBash(
        "C:\\Temp\\fixture.sql",
        "D:\\repo",
        runner,
      ),
    ).toBe("/mnt/c/Temp/fixture.sql");
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining(`wslpath -u 'C:\\Temp\\fixture.sql'`),
      "D:\\repo",
    );
    expect(runner.mock.calls[0]?.[0]).not.toContain("$1");
  });

  it("fails clearly when bash cannot produce a POSIX path", () => {
    const runner = vi.fn<(command: string, cwd: string) => string>(
      () => "C:/Temp/fixture.sql\n",
    );

    expect(() =>
      translateWindowsAbsolutePathForBash(
        "C:\\Temp\\fixture.sql",
        "D:\\repo",
        runner,
      ),
    ).toThrow("Cannot translate cross-volume Windows fixture path");
  });

  it.skipIf(process.platform !== "win32")(
    "routes a real cross-drive relative calculation through the translator",
    () => {
      const runner = vi.fn<(command: string, cwd: string) => string>(
        () => "/mnt/c/Temp/fixture.sql\n",
      );

      expect(
        bashFixturePath("C:\\Temp\\fixture.sql", "D:\\repo", runner),
      ).toBe("/mnt/c/Temp/fixture.sql");
    },
  );

  describe("a cwd inside the temporary directory (#5407, mechanism 3)", () => {
    const TEMP = "C:\\Users\\u\\AppData\\Local\\Temp";
    const CASE_DIR = `${TEMP}\\first-bootstrap-role-a\\case-b`;
    const REPO = "C:\\Users\\u\\repo";
    const translating = () =>
      vi.fn<(command: string, cwd: string) => string>(() => "/c/Users/u/repo/scripts/gate.sh\n");

    it("is an identity on a POSIX host, whatever the directories", () => {
      if (path.sep !== "/") return;
      const runner = translating();
      expect(bashFixturePath("/repo/scripts/gate.sh", "/tmp/case", runner, "/tmp")).toBe("/repo/scripts/gate.sh");
      expect(runner).not.toHaveBeenCalled();
    });

    it.skipIf(process.platform !== "win32")(
      "translates a target outside it rather than climbing out of the temporary directory",
      () => {
        const runner = translating();
        expect(bashFixturePath(`${REPO}\\scripts\\gate.sh`, CASE_DIR, runner, TEMP)).toBe(
          "/c/Users/u/repo/scripts/gate.sh",
        );
        expect(runner).toHaveBeenCalledWith(expect.stringContaining("C:\\Users\\u\\repo\\scripts\\gate.sh"), CASE_DIR);
      },
    );

    it.skipIf(process.platform !== "win32")(
      "keeps the relative form for a target inside the temporary directory",
      () => {
        const runner = translating();
        expect(bashFixturePath(`${CASE_DIR}\\harness.sh`, CASE_DIR, runner, TEMP)).toBe("harness.sh");
        expect(bashFixturePath(`${TEMP}\\first-bootstrap-role-a\\x.sh`, CASE_DIR, runner, TEMP)).toBe("../x.sh");
        expect(runner).not.toHaveBeenCalled();
      },
    );

    it.skipIf(process.platform !== "win32")(
      "keeps the relative form, byte for byte, from the repository root into the temporary directory",
      () => {
        const runner = translating();
        expect(bashFixturePath(`${TEMP}\\x\\migration.sql`, REPO, runner, TEMP)).toBe(
          "../AppData/Local/Temp/x/migration.sql",
        );
        expect(runner).not.toHaveBeenCalled();
      },
    );

    it.skipIf(process.platform !== "win32")(
      "treats a sibling whose name only starts with the temporary directory's as outside it",
      () => {
        const runner = translating();
        expect(bashFixturePath(`${REPO}\\a.sh`, `${TEMP}2\\case`, runner, TEMP)).toBe("../../../../repo/a.sh");
        expect(runner).not.toHaveBeenCalled();
      },
    );
  });

  it.skipIf(process.platform !== "win32")(
    "produces a path the selected Windows bash can open",
    () => {
      const directory = mkdtempSync(
        path.join(tmpdir(), "acb-bash-fixture-path-"),
      );
      const fixture = path.join(directory, "fixture with spaces.sql");
      writeFileSync(fixture, "SELECT 1;\n");

      try {
        const translated = translateWindowsAbsolutePathForBash(
          fixture,
          process.cwd(),
        );
        expect(() =>
          execFileSync("bash", bashToolArgs("test", ["-f", translated]), {
            cwd: process.cwd(),
            stdio: "ignore",
          }),
        ).not.toThrow();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
