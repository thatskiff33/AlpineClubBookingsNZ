import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * #4940: the values `scripts/load-smoke.sh` reads from the running load stack
 * rather than keeping its own copy (the app's port, the password the seeders
 * hashed, the seeded member count). A copy in the smoke script drifts from the
 * stack the moment someone sets a different value in the stack's env file, and
 * the failure is every login refused. These run the real `load-stack.sh`
 * subcommands against a fixture stack directory: no Docker and no database.
 * `volume-members` counts rows through `docker compose exec`, so it is checked
 * against real PostgreSQL by `load-volume-seed.realdb.test.ts`.
 */
const repo = path.resolve(__dirname, "..", "..", "..");

let root = "";

function stackEnv(lines: string[]) {
  writeFileSync(path.join(root, ".artifacts", "load-stub", "load.env"), lines.join("\n") + "\n");
}

function run(subcommand: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["scripts/load-stack.sh", subcommand], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      // The fixture's `pnpm` shim first, then the repo's tsx; nothing else of
      // the caller's environment, so a DEMO_SEED_PASSWORD in the developer's
      // shell cannot leak into a case that expects it to be absent.
      PATH: `${path.join(root, "bin")}:${path.join(repo, "node_modules", ".bin")}:${process.env.PATH}`,
      NODE_ENV: "test",
      ...env,
    },
  });
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "load-stack-readouts-"));
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  mkdirSync(path.join(root, ".artifacts", "load-stub", "tls"), { recursive: true });
  mkdirSync(path.join(root, "bin"));
  copyFileSync(path.join(repo, "scripts", "load-stack.sh"), path.join(root, "scripts", "load-stack.sh"));
  copyFileSync(
    path.join(repo, "scripts", "lib", "compose-env-file.sh"),
    path.join(root, "scripts", "lib", "compose-env-file.sh"),
  );
  writeFileSync(path.join(root, ".artifacts", "load-stub", "tls", "ca.pem"), "");
  // The seeders' own modules, through the repo's own tsx, from the fixture root.
  for (const entry of ["prisma", "src", "load", "node_modules", "package.json", "tsconfig.json"]) {
    symlinkSync(path.join(repo, entry), path.join(root, entry));
  }
  // `pnpm exec <bin> ...` is `<bin> ...` here, so the test needs no pnpm on PATH.
  // FAKE_PNPM_FAIL makes it fail, for the case where the address pattern cannot be built.
  writeFileSync(
    path.join(root, "bin", "pnpm"),
    '#!/usr/bin/env bash\n[ -n "${FAKE_PNPM_FAIL:-}" ] && exit 1\n[ "$1" = exec ] && shift\nexec "$@"\n',
  );
  chmodSync(path.join(root, "bin", "pnpm"), 0o755);
  // Plays `docker compose ... exec -T postgres psql`: records the arguments it was
  // given and answers with a count, or fails (or answers rubbish) when told to.
  writeFileSync(
    path.join(root, "bin", "docker"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"\n[ -n "${FAKE_DOCKER_FAIL:-}" ] && exit 1\necho "${FAKE_DOCKER_ANSWER:-42}"\n',
  );
  chmodSync(path.join(root, "bin", "docker"), 0o755);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("load-stack.sh read-outs", () => {
  it("base-url is the port the stack's env file published, else the E2E default", () => {
    stackEnv(["DB_PASSWORD=x", "STAGING_HTTP_PORT=3999"]);
    expect(run("base-url").stdout).toBe("http://localhost:3999");
    stackEnv(["DB_PASSWORD=x"]);
    expect(run("base-url").stdout).toBe("http://localhost:3001");
  });

  it("demo-password is the one the seeders hash: the env file beats the shell, then the default", () => {
    stackEnv(["DB_PASSWORD=x", "DEMO_SEED_PASSWORD=from-the-stack-file"]);
    const fromFile = run("demo-password", { DEMO_SEED_PASSWORD: "from-the-shell" });
    expect(fromFile.status, fromFile.stderr).toBe(0);
    expect(fromFile.stdout).toBe("from-the-stack-file");

    stackEnv(["DB_PASSWORD=x"]);
    // Nothing in the file: the seeders inherit the caller's value, so this does too.
    expect(run("demo-password", { DEMO_SEED_PASSWORD: "from-the-shell" }).stdout).toBe("from-the-shell");
    // Nothing anywhere: the seeders' published default, read from the seeders' module.
    expect(run("demo-password").stdout).toBe("demo1234");
  }, 120_000);

  it("volume-members counts the seeded accounts in the stack's own database", () => {
    stackEnv(["DB_PASSWORD=x"]);
    const log = path.join(root, "docker.log");
    rmSync(log, { force: true });
    const result = run("volume-members", { FAKE_DOCKER_LOG: log });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("42");
    const call = readFileSync(log, "utf8");
    // The load project's own Postgres, and the prefix and domain the seeder and k6 share.
    expect(call).toMatch(/-p load-issue4940 /);
    expect(call).toContain("exec -T postgres psql -U tac -d tacbookings");
    expect(call).toContain(`LIKE 'load-%@demo.alpineclub.test'`);
  }, 120_000);

  it("volume-members fails rather than reporting a count it could not take", () => {
    stackEnv(["DB_PASSWORD=x"]);
    const log = path.join(root, "docker.log");
    // Postgres unreachable: a non-zero exit, not an empty or zero count.
    const down = run("volume-members", { FAKE_DOCKER_LOG: log, FAKE_DOCKER_FAIL: "1" });
    expect(down.status).not.toBe(0);
    expect(down.stdout).toBe("");
    // An answer that is not a number is refused.
    const rubbish = run("volume-members", { FAKE_DOCKER_LOG: log, FAKE_DOCKER_ANSWER: "ERROR" });
    expect(rubbish.status).not.toBe(0);
    expect(rubbish.stderr).toMatch(/Expected a member count/);
    // The address pattern cannot be built: no query runs against an empty pattern.
    rmSync(log, { force: true });
    const noPattern = run("volume-members", { FAKE_DOCKER_LOG: log, FAKE_PNPM_FAIL: "1" });
    expect(noPattern.status).not.toBe(0);
    expect(noPattern.stdout).toBe("");
    expect(existsSync(log)).toBe(false);
  }, 120_000);

  it("refuses every read-out when no load stack has been prepared", () => {
    rmSync(path.join(root, ".artifacts", "load-stub", "load.env"), { force: true });
    for (const subcommand of ["base-url", "demo-password", "volume-members"]) {
      const result = run(subcommand);
      expect(result.status, subcommand).toBe(1);
      expect(result.stderr, subcommand).toMatch(/No load stack here/);
    }
  }, 120_000);
});

describe("scripts/load-smoke.sh keeps no second copy of the stack's values", () => {
  // Policing, because a bash script cannot import a constant. The structural
  // fix is the read-outs above; this fails if a literal creeps back in.
  const smoke = readFileSync(path.join(repo, "scripts", "load-smoke.sh"), "utf8");
  const stack = readFileSync(path.join(repo, "scripts", "load-stack.sh"), "utf8");
  const code = (text: string) =>
    text
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

  it("takes the password, port and member count from load-stack.sh", () => {
    expect(code(smoke)).not.toMatch(/demo1234/);
    expect(code(smoke)).not.toMatch(/localhost:3001/);
    expect(code(smoke)).not.toMatch(/\b2000\b|\b3000\b/);
    expect(code(smoke)).toMatch(/load-stack\.sh demo-password/);
    expect(code(smoke)).toMatch(/load-stack\.sh base-url/);
    expect(code(smoke)).toMatch(/load-stack\.sh volume-members/);
  });

  it("records the member count it measures, not the one it was told", () => {
    expect(code(stack)).not.toMatch(/LOAD_VOLUME_USERS:-\d+|LOAD_VOLUME_USERS \|\| \d+/);
    expect(code(stack)).toMatch(/volume_members="\$\(volume_member_count\)"/);
    // The count's pattern is built from the two constants the seeder and k6 share.
    expect(code(stack)).toContain('LOAD_VOLUME_EMAIL_PREFIX + "%@" + DEMO_SEED_DOMAIN');
  });
});
