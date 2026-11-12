import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";
import { bashFixturePath } from "@/lib/__tests__/helpers/bash-fixture-path";
import { readRepoFile } from "@/lib/__tests__/helpers/compose";
import { DEPLOY_SCRIPT } from "@/lib/__tests__/helpers/deploy-script";

/**
 * First Bootstrap's live-site role gate (#4980; INV-CONFIG-003).
 *
 * `DEPLOYMENT.md` → "First Bootstrap" stands the club's live site up with plain
 * `docker compose up`, never through the blue/green deploy script, so before
 * #4980 nothing stopped a live site starting from `.env.example`'s
 * `APP_ENVIRONMENT_ROLE=non-production` — emailing no member and replacing the
 * addresses on the club's real Xero contacts. These cases pin the three things
 * that close it: the gate refuses for real, it is the deploy's own check rather
 * than a copy, and the documented First Bootstrap runs it before any container.
 */

const ROOT = process.cwd();
const BOOTSTRAP_GATE = "scripts/check-environment-role.sh";
const ROLE_CHECK_LIBRARY = "scripts/lib/environment-role-check.sh";

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "first-bootstrap-role-"));
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

/** Runs the gate from a throwaway directory holding `envFile` as `.env`. */
function runGate(envFile: string | null) {
  const dir = mkdtempSync(path.join(fixtureRoot, "case-"));
  if (envFile !== null) writeFileSync(path.join(dir, ".env"), envFile, "utf8");
  // The invoking shell must not carry the variable, or the gate's (correct)
  // shell-versus-file refusal would answer instead of the file check.
  const env = { ...process.env };
  delete env[ENVIRONMENT_ROLE_ENV_VAR];
  const result = spawnSync(
    "bash",
    [bashFixturePath(path.join(ROOT, BOOTSTRAP_GATE), dir)],
    { cwd: dir, encoding: "utf8", env },
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("First Bootstrap's role gate refuses a live site declared as a copy", () => {
  it("refuses the .env.example value unchanged, naming the variable", () => {
    const run = runGate(readRepoFile(".env.example"));
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`${ENVIRONMENT_ROLE_ENV_VAR} must be exactly production`);
    expect(run.stderr).toContain("The value says this installation is a COPY.");
  });

  it.each([
    ["missing", "DATABASE_URL=postgres://x\n", "Missing required .env entry"],
    ["empty", `${ENVIRONMENT_ROLE_ENV_VAR}=\n`, "present but empty"],
    ["a near miss", `${ENVIRONMENT_ROLE_ENV_VAR}=prod\n`, "must be exactly production"],
    [
      "duplicated",
      `${ENVIRONMENT_ROLE_ENV_VAR}=production\n${ENVIRONMENT_ROLE_ENV_VAR}=non-production\n`,
      "appears 2 times",
    ],
  ])("refuses a %s declaration", (_label, envFile, refusal) => {
    const run = runGate(envFile);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(refusal);
    expect(run.stderr).toContain(ENVIRONMENT_ROLE_ENV_VAR);
  });

  it("refuses when there is no .env at all, rather than passing vacuously", () => {
    const run = runGate(null);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`${ENVIRONMENT_ROLE_ENV_VAR}=production`);
  });

  it("passes exactly production, in a shape Compose reads", () => {
    const run = runGate(`export ${ENVIRONMENT_ROLE_ENV_VAR}="Production"\n`);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`${ENVIRONMENT_ROLE_ENV_VAR}=production`);
  });
});

describe("First Bootstrap and the deploy run one role check, not two", () => {
  function shellFiles(dir: string): string[] {
    return readdirSync(path.join(ROOT, dir)).flatMap((name) => {
      const relative = `${dir}/${name}`;
      if (statSync(path.join(ROOT, relative)).isDirectory()) return shellFiles(relative);
      return relative.endsWith(".sh") ? [relative] : [];
    });
  }

  it("defines require_environment_role_env_key once, in the shared library", () => {
    const definers = shellFiles("scripts").filter((file) =>
      /^require_environment_role_env_key\(\) \{$/m.test(readRepoFile(file)),
    );
    expect(definers).toEqual([ROLE_CHECK_LIBRARY]);
  });

  it.each([BOOTSTRAP_GATE, DEPLOY_SCRIPT])("%s sources the library and calls the check", (file) => {
    const code = readRepoFile(file)
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).toMatch(/^\. "\$[A-Z_]+\/environment-role-check\.sh"$/m);
    expect(code).toMatch(/^\s*require_environment_role_env_key\s*$/m);
  });

  it("starts nothing: the gate never runs docker", () => {
    expect(readRepoFile(BOOTSTRAP_GATE)).not.toMatch(/^\s*docker\b/m);
  });
});

describe("DEPLOYMENT.md's First Bootstrap sets the role and checks it first", () => {
  const deployment = readFileSync(path.join(ROOT, "DEPLOYMENT.md"), "utf8");
  const sectionStart = deployment.indexOf("\n## First Bootstrap\n");
  const section = deployment.slice(sectionStart, deployment.indexOf("\n## ", sectionStart + 1));
  const block = /```bash\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
  const lines = block.split("\n");
  const indexOf = (predicate: (line: string) => boolean) => lines.findIndex(predicate);

  it("has a First Bootstrap command block", () => {
    expect(sectionStart).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(3);
  });

  it("names APP_ENVIRONMENT_ROLE=production as an explicit step", () => {
    expect(block).toContain(`${ENVIRONMENT_ROLE_ENV_VAR}=production`);
  });

  it("runs the gate after copying the template and before the first docker compose", () => {
    const copy = indexOf((line) => line.startsWith("cp .env.example .env"));
    const gate = indexOf((line) => line.trim() === `bash ${BOOTSTRAP_GATE}`);
    const firstCompose = indexOf((line) => line.startsWith("docker compose"));
    expect(copy).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(copy);
    expect(firstCompose).toBeGreaterThan(gate);
  });
});
