import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Handing a fixture to one of this repository's real `bash` gate scripts
 * (#2886).
 *
 * Several suites prove a shell gate by running it for real against a throwaway
 * fixture built under `os.tmpdir()`, with the fixture's location and the gate's
 * knobs supplied as environment variables:
 *
 * - `review-findings-contracts.test.ts` → `validate-blue-green-migrations.sh`,
 *   `check-migration-safety-coverage.sh`
 * - `blue-green-ledger-lint.test.ts` → `validate-blue-green-migrations.sh`
 * - `data-migration-verification-gate.test.ts` →
 *   `check-data-migration-verification.sh`
 *
 * On Windows `bash` is whatever PATH resolves, and on a stock Windows 11
 * developer machine that is `C:\Windows\System32\bash.exe` — the **WSL**
 * launcher, not Git Bash. Two independent things then go wrong, and both were
 * measured on the Windows host in #2886.
 *
 * ## Mechanism 1 — a drive-letter path does not exist inside WSL
 *
 * WSL runs the script in a Linux filesystem namespace:
 *
 * ```
 * $ bash -c 'ls -d C:/Users'
 * ls: cannot access 'C:/Users': No such file or directory
 * ```
 *
 * so the gate reported `Migration SQL file not found: C:/Users/…/migration.sql`
 * and every assertion built on that run failed — 48 of them in
 * `review-findings-contracts.test.ts` alone, on a clean tree, identically when
 * the suite ran alone.
 *
 * Flipping the separators (`C:\Users\…` → `C:/Users/…`), which is what these
 * suites used to do, does not help. It fixes a *different*, real problem (Git
 * Bash drops the backslashes out of an argv element, so `C:\Users\x` arrives as
 * `C:Usersx`), but the result is still a drive-letter path and WSL cannot open
 * one whatever the slashes look like.
 *
 * What works is a path expressed **relative to the working directory the script
 * is spawned with**. Node spawns these with `cwd` at the repository root, and
 * every bash translates its own working directory — WSL reports
 * `/mnt/c/Users/…/repo`, Git Bash reports `/c/Users/…/repo` — so a relative
 * path resolves correctly under either, with no need to know which is
 * installed. When the repository and fixture are on different volumes, no
 * relative path exists; the selected shell translates the absolute path with
 * `wslpath` or `cygpath` instead. Measured, passing the same fixture to a real
 * script:
 *
 * | Form handed to bash                                   | Result  |
 * | ----------------------------------------------------- | ------- |
 * | `C:/Users/…/Temp/x/migration.sql` (what shipped)       | MISSING |
 * | `../../AppData/Local/Temp/x/migration.sql` (relative)  | FOUND   |
 *
 * ## Mechanism 2 — environment variables do not cross into WSL
 *
 * This one is worse, because it fails silently rather than loudly. Variables
 * put on `spawnSync`'s `env` option are Win32 environment variables, and the
 * WSL launcher does not forward them; the script sees them **unset** and falls
 * back to its production defaults. So a test that pointed the validator at a
 * throwaway ledger was in fact running it against the repository's real
 * `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` — a fixture substitution with no error
 * message at all. Measured, with the same script printing what it received:
 *
 * | How the variable was supplied                | Script saw            |
 * | -------------------------------------------- | --------------------- |
 * | `spawnSync({ env: { …, LEDGER: "x" } })`      | `UNSET`               |
 * | `bash -c "LEDGER='x' exec bash script args"`  | `x`                   |
 *
 * Inlining the assignments into the command string is portable rather than
 * WSL-specific, and it is already this repository's working idiom:
 * `adult-member-hosting-coverage-migration.test.ts` has always built its
 * validator invocation that way, and it is the one suite in this family that
 * never showed either failure.
 *
 * ## Mechanism 3 — the temporary directory is mounted somewhere else
 *
 * A relative path is sound only while every directory it climbs through is
 * where Windows says it is. Git Bash mounts the Windows temporary directory at
 * `/tmp`, so a shell started inside it does not sit under `AppData/Local`.
 * Measured on a Windows host (#5407): a Git Bash shell started in
 * `<temp>/diag-x` reports `/tmp/diag-x`; `cd ..` gives `/tmp`, and `cd ..`
 * again gives `/`, the Git install directory. A path relative to a fixture
 * directory that climbs out of the temporary directory to reach the repository
 * therefore resolves against the wrong tree, and the gate exits 127 with "No
 * such file or directory" (`first-bootstrap-environment-role.test.ts`, seven
 * cases, every run). So when `cwd` is inside the temporary directory and the
 * target is not, the absolute path is translated by the selected bash instead,
 * as for the cross-drive case. That is right under either bash: `cygpath -u`
 * names the repository by its drive mount (`/c/…`), and `wslpath -u` by
 * `/mnt/c/…`, each in its own namespace. A target inside the temporary
 * directory, or a `cwd` outside it (the repository root, which every other
 * suite spawns from), keeps the relative form exactly as before.
 *
 * ## Why this was recorded as something else
 *
 * Both mechanisms are platform-deterministic: they reproduce on a clean tree,
 * with the suite run alone, every time. They had been written down as
 * "load-sensitive timeouts — re-run it alone", which is why the cost kept
 * repeating: re-running cannot help, because load was never involved.
 *
 * ## Linux and CI
 *
 * {@link bashFixturePath} returns its input unchanged wherever `path.sep` is
 * already `/`, so CI hands the scripts byte-for-byte the strings it did before.
 * {@link bashGateArgs} does change the invocation shape everywhere — the same
 * script, the same argv, the same variables, reached through one `-c` string
 * instead of the `env` option — and that equivalence was checked on Linux by
 * running both shapes over the same fixtures inside `node:24-bookworm` and
 * comparing exit status, stdout and stderr.
 */

/**
 * Converts an absolute path produced by Node into one the spawned `bash` can
 * open. See the module comment for the measurements.
 *
 * @param value An absolute path (`path.join`, `mkdtempSync`).
 * @param cwd   The working directory the script will be spawned with. It must
 *              be the same `cwd` passed to `spawnSync`/`execFile`, because that
 *              is what the returned path is relative to.
 */
export function bashFixturePath(
  value: string,
  cwd: string = process.cwd(),
  runner: BashPathTranslatorRunner = runBashPathTranslator,
  temporaryRoot: string = tmpdir(),
): string {
  // POSIX hosts (Linux/CI, macOS): identity. Nothing below can improve a string
  // that is already exactly what bash reads.
  if (path.sep === "/") return value;

  const relative = path.relative(cwd, value);

  // `path.relative` cannot express a relative path across Windows drives — it
  // hands back the absolute target instead. Ask the selected bash to translate
  // that absolute path into its own namespace: WSL provides `wslpath`, while
  // Git Bash provides `cygpath`. Returning the drive-letter form would merely
  // postpone the same deterministic "file not found" failure this helper exists
  // to prevent.
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    /^[A-Za-z]:/.test(relative)
  ) {
    return translateWindowsAbsolutePathForBash(value, cwd, runner);
  }

  // Mechanism 3: a climb out of the temporary directory lands in the wrong tree
  // under Git Bash, which mounts that directory at `/tmp`.
  if (isWithin(cwd, temporaryRoot) && !isWithin(value, temporaryRoot)) {
    return translateWindowsAbsolutePathForBash(value, cwd, runner);
  }

  return relative.split(path.sep).join("/");
}

type BashPathTranslatorRunner = (command: string, cwd: string) => string;

/** Whether `child` is `parent` or below it (Windows comparison rules). */
function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  const climbs = relative === ".." || relative.startsWith(`..${path.sep}`);
  return relative === "" || (!climbs && !path.isAbsolute(relative));
}

function runBashPathTranslator(command: string, cwd: string): string {
  return execFileSync("bash", ["-c", command], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Translate a Windows absolute path into the namespace of the selected bash. */
export function translateWindowsAbsolutePathForBash(
  value: string,
  cwd: string = process.cwd(),
  runner: BashPathTranslatorRunner = runBashPathTranslator,
): string {
  const command = [
    "if command -v wslpath >/dev/null 2>&1; then",
    `  exec wslpath -u ${shellQuote(value)}`,
    "elif command -v cygpath >/dev/null 2>&1; then",
    `  exec cygpath -u ${shellQuote(value)}`,
    "else",
    '  echo "bash has neither wslpath nor cygpath" >&2',
    "  exit 127",
    "fi",
  ].join("\n");

  try {
    const translated = runner(command, cwd).trim();
    if (!translated.startsWith("/")) {
      throw new Error(`translator returned non-POSIX path ${translated}`);
    }
    return translated;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot translate cross-volume Windows fixture path ${value} for bash: ${detail}`,
    );
  }
}

/** POSIX single-quoting, so a value with spaces or quotes survives the shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Build a safely quoted `bash -c` invocation for a POSIX tool. */
export function bashToolArgs(tool: string, args: string[] = []): string[] {
  return [
    "-c",
    ["exec", shellQuote(tool), ...args.map(shellQuote)].join(" "),
  ];
}

/**
 * Builds the argument array for `spawnSync("bash", …)` / `execFile("bash", …)`
 * that runs a gate script with `env` actually set.
 *
 * The assignments are inlined into a single `-c` string because that is the
 * only form the WSL launcher carries across (see the module comment). `exec`
 * replaces the wrapper shell rather than leaving it waiting, so the exit status
 * the caller asserts on is still the script's own.
 *
 * The script is run as `bash <script>` rather than as a bare command, matching
 * what these suites did before and keeping the run independent of whether the
 * file carries an executable bit in the checkout.
 *
 * @param script Repository-relative path to the gate script.
 * @param args   Positional arguments, already passed through
 *               {@link bashFixturePath} if they are paths.
 * @param env    Gate variables to set for this run only.
 */
export function bashGateArgs(
  script: string,
  args: string[] = [],
  env: Record<string, string> = {},
): string[] {
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const command = [
    assignments,
    "exec bash",
    shellQuote(script),
    ...args.map(shellQuote),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return ["-c", command];
}

/**
 * The environment variables these gate scripts read as **paths**, listed
 * explicitly rather than sniffed.
 *
 * The previous idiom converted any env value containing a backslash, which is a
 * guess: `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` is free prose an operator
 * writes, and a backslash in it would have been silently rewritten. Naming the
 * keys means a value is converted because it *is* a path, not because it looked
 * like one.
 */
export const PATH_VALUED_ENV_KEYS = new Set([
  "MIGRATION_SAFETY_LEDGER",
  "MIGRATIONS_DIR",
  "DATA_MIGRATION_VERIFICATION_DIR",
  "DATA_MIGRATION_GRANDFATHER_FILE",
  "SQL_STATEMENT_SPLITTER",
  "VALIDATOR",
]);

/**
 * Converts the path-valued entries of a gate script's environment with
 * {@link bashFixturePath} and leaves every other value exactly as given.
 */
export function bashFixtureEnv(
  env: Record<string, string>,
  cwd: string = process.cwd(),
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      PATH_VALUED_ENV_KEYS.has(key) ? bashFixturePath(value, cwd) : value,
    ]),
  );
}
