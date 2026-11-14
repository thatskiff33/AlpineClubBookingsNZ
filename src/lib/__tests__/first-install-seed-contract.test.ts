import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  changedTables,
  FINGERPRINT_SQL,
  REFRESHED_BY_DESIGN,
  fillPlaceholders,
  firstBootstrapBlocks,
  firstInstallSteps,
} from "../../../scripts/ci/first-install-smoke.mjs";
import {
  appEnvironmentAnchor,
  BASE_COMPOSE,
  composeServices,
  readRepoFile,
} from "./helpers/compose";
import { DOCKER_SEED_COMMAND, SEED_COMPOSE_SERVICE } from "@/lib/seed-commands";

/**
 * A Docker-only install can create its first admin, and every doc tells it how
 * (#4977, INV-OPS-019).
 *
 * The seed cannot run in the app container: the runner image holds no source.
 * "First Bootstrap" had lost its seed step and three docs gave an `exec app`
 * command that fails there, while CI seeded from the host and stayed green.
 * This census holds the compose service and the docs to the one working
 * command; `scripts/ci/first-install-smoke.mjs` runs it in CI.
 *
 * It reads repository files from disk, so `pnpm run test:related` cannot select
 * it (`docs/TESTING.md`): run it with `pnpm run test:named`.
 */

/**
 * Every `SEED_` variable the seed reads, taken from the seed itself so a new
 * one cannot be missed by the service. `SEED_PASSWORD_SCREEN_POLICY` is a
 * constant the seed imports, not an environment variable.
 */
const SEED_ENVIRONMENT = [
  ...new Set(readRepoFile("prisma/seed.ts").match(/\bSEED_[A-Z_]+\b/g) ?? []),
].filter((name) => name !== "SEED_PASSWORD_SCREEN_POLICY");

/** The docs that walk an operator through seeding a Compose stack. */
const OPERATOR_SEED_DOCS = [
  "README.md",
  "docs/IMPLEMENTATION_GUIDE.md",
  "docs/STAGING_ACCESSIBILITY.md",
];

/** One shell command per line: a trailing backslash continues the line. */
function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n\s*/g, " ");
}

function service(name: string): string {
  const body = composeServices(BASE_COMPOSE).get(name);
  if (body === undefined) throw new Error(`${BASE_COMPOSE} has no ${name} service`);
  return body;
}

/** The service's `build:` block, up to the next key at the service's own indent. */
function buildBlock(body: string): string {
  const match = /^(\s+)build:\n((?:\1\s+.*\n?)+)/m.exec(`${body}\n`);
  if (!match) throw new Error("service has no build block");
  return match[2];
}

function line(body: string, key: string): string | undefined {
  return body.split("\n").find((l) => l.trim().startsWith(`${key}:`))?.trim();
}

describe("the first-install seed service (#4977, INV-OPS-019)", () => {
  const seed = service(SEED_COMPOSE_SERVICE);
  const migrate = service("migrate");

  it("runs on the migrate service's image and build, the builder stage", () => {
    expect(line(seed, "image")).toBeDefined();
    expect(line(seed, "image")).toBe(line(migrate, "image"));
    expect(buildBlock(seed)).toBe(buildBlock(migrate));
    expect(buildBlock(seed)).toMatch(/^\s+target: builder$/m);
  });

  it("sits behind its own profile, so `up` never starts it", () => {
    expect(line(seed, "profiles")).toBe(`profiles: ["${SEED_COMPOSE_SERVICE}"]`);
  });

  it("receives every SEED_ variable from .env through environment:", () => {
    expect(SEED_ENVIRONMENT).toEqual(
      expect.arrayContaining(["SEED_ADMIN_EMAIL", "SEED_ADMIN_PASSWORD", "SEED_LODGE_PASSWORD"]),
    );
    for (const name of SEED_ENVIRONMENT) {
      expect(seed, name).toContain(`${name}: \${${name}:-}`);
    }
    expect(seed).toContain("APP_ENVIRONMENT_ROLE: ${APP_ENVIRONMENT_ROLE}");
  });

  it("takes the club's domain from NEXTAUTH_URL, as the app does", () => {
    // The kiosk and committee addresses are `<name>@` that host; without it
    // the seed falls back to example.org.
    const anchor = appEnvironmentAnchor(readRepoFile(BASE_COMPOSE)) ?? "";
    expect(line(seed, "NEXTAUTH_URL")).toBeDefined();
    expect(line(seed, "NEXTAUTH_URL")).toBe(line(anchor, "NEXTAUTH_URL"));
  });

  it("never takes a seed secret as a build argument or on its command line", () => {
    for (const [name, body] of composeServices(BASE_COMPOSE)) {
      if (!/^\s+build:/m.test(body)) continue;
      expect(buildBlock(body), name).not.toMatch(/SEED_/);
    }
    expect(readRepoFile("Dockerfile")).not.toMatch(/^\s*ARG\s+SEED_/m);
    expect(line(seed, "command")).not.toMatch(/SEED_/);
  });

  it("connects as the app role with a bounded pool", () => {
    const url = line(seed, "DATABASE_URL");
    expect(url).toMatch(/postgresql:\/\/\$\{APP_DB_USER:-tac\}:/);
    expect(url).toMatch(/connection_limit=2&pool_timeout=10$/);
  });

  it("declares its role literally in the staging overlay, never from the live .env", () => {
    // `run --rm seed` against docker-compose.staging.yml would otherwise read
    // ${APP_ENVIRONMENT_ROLE} from the file of the deployment it must not touch
    // (ENV-SAFETY 1). The generic override census only checks a service the
    // overlay names, so deleting this block would pass it.
    const staged = composeServices("docker-compose.staging.yml").get(SEED_COMPOSE_SERVICE);
    expect(staged, "docker-compose.staging.yml overrides the seed service").toBeDefined();
    expect(staged).toMatch(/^\s+APP_ENVIRONMENT_ROLE: non-production$/m);
  });

  it("runs the same command as `pnpm run db:seed`", () => {
    const scripts = JSON.parse(readRepoFile("package.json")).scripts as Record<string, string>;
    expect(line(seed, "command")).toBe(`command: ./node_modules/.bin/${scripts["db:seed"]}`);
  });
});

describe("the docs that tell an operator how to seed (#4977, INV-OPS-019)", () => {
  it("gives DEPLOYMENT.md First Bootstrap the seed command, once the roles are on and before the app starts", () => {
    // firstInstallSteps itself throws if a step is missing or out of order, so
    // reading the doc is the order check: migrate, provision, switch the roles
    // on in .env, seed, start.
    const steps = firstInstallSteps(readRepoFile("DEPLOYMENT.md"));
    expect(steps.seed.line).toBe(DOCKER_SEED_COMMAND);
    expect(steps.migrate.line).toBe(
      "docker compose --profile migrate run --rm -e DATABASE_URL migrate",
    );
  });

  it("holds the smoke to the doc's order: a seed after the app starts, or none, is refused", () => {
    // Mutation probe on the doc's own blocks, so it cannot pass vacuously.
    const steps = firstInstallSteps(readRepoFile("DEPLOYMENT.md"));
    const document = (names: string[]) =>
      `\n## First Bootstrap\n\n${names.map((n) => `\`\`\`bash\n${steps[n].text}\n\`\`\``).join("\n\n")}\n\n## Next\n`;
    const inOrder = ["copy", "postgres", "migrate", "provision", "switch", "seed", "start"];
    expect(() => firstInstallSteps(document(inOrder))).not.toThrow();
    const swapped = [...inOrder.slice(0, 5), "start", "seed"];
    expect(() => firstInstallSteps(document(swapped))).toThrow(/out of order/);
    expect(() => firstInstallSteps(document(inOrder.filter((n) => n !== "seed")))).toThrow(
      /no seed step/,
    );
  });

  it("fills every placeholder the doc's run steps use, and refuses one it does not know", () => {
    const steps = firstInstallSteps(readRepoFile("DEPLOYMENT.md"));
    const values = {
      DB_PASSWORD: "operator-pw",
      APP_DB_PASSWORD: "app-pw",
      MIGRATION_DB_PASSWORD: "migration-pw",
      AUDIT_RETENTION_DB_PASSWORD: "retention-pw",
    };
    for (const name of ["migrate", "provision", "switch"]) {
      expect(() => fillPlaceholders(steps[name].text, values), name).not.toThrow();
    }
    expect(() => fillPlaceholders("export X=<your-unknown-password>", values)).toThrow(
      /cannot fill/,
    );
    expect(firstBootstrapBlocks(readRepoFile("DEPLOYMENT.md")).length).toBeGreaterThanOrEqual(7);
  });

  it("holds the smoke's \"changes nothing\" check to row content, not only row counts", () => {
    // Mutation probe on the readings themselves: a re-run that rewrote a row in
    // place leaves every count as it was, so only a changed hash can name it.
    expect(FINGERPRINT_SQL).toMatch(/md5\(/);
    expect(FINGERPRINT_SQL).toMatch(/string_agg\(\(to_jsonb\(t\)/);
    const before = "Lodge=1:aaa\nMember=2:bbb\nSetting=3:ccc";
    expect(changedTables(before, before)).toEqual([]);
    expect(changedTables(before, "Lodge=1:aaa\nMember=2:bbb\nSetting=3:ddd")).toEqual(["Setting"]);
    expect(changedTables(before, "Lodge=1:aaa\nMember=3:eee\nSetting=3:ccc")).toEqual(["Member"]);
    expect(changedTables(before, "Lodge=1:aaa\nMember=2:bbb")).toEqual(["Setting"]);
  });

  it("lets a second seed run move only what the seed rewrites by design", () => {
    // The built-in lobby-display rows are refreshed from code on every run (#111,
    // owner decision A), which moves their `updatedAt` and nothing else. Growing
    // this list would let a real in-place rewrite through, so it is pinned to
    // the code that justifies each entry.
    expect(REFRESHED_BY_DESIGN).toEqual({
      DisplayLayout: ["updatedAt"],
      DisplayTemplate: ["updatedAt"],
    });
    expect(readRepoFile("src/lib/lodge-display/built-in-seeds.ts")).toMatch(
      /REFRESHES its definition from code on every re-seed/,
    );
    const schema = readRepoFile("prisma/schema.prisma");
    for (const model of Object.keys(REFRESHED_BY_DESIGN)) {
      const body = new RegExp(`^model ${model} \\{[\\s\\S]*?^\\}`, "m").exec(schema)?.[0] ?? "";
      expect(body, model).toMatch(/^\s+updatedAt\s+DateTime\s+@updatedAt/m);
    }
  });

  it(".env.example gives Compose no empty value followed by a comment", () => {
    // `cp .env.example .env` is the doc's first step. Compose reads `KEY=   # note`
    // as the value `# note`, so an unedited line made `docker compose up` fail
    // on an undefined volume and set a role name to the comment's text. A
    // comment sits on its own line instead.
    const offenders = readRepoFile(".env.example")
      .split("\n")
      .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=[ \t]+#/.test(l));
    expect(offenders).toEqual([]);
  });

  it.each(OPERATOR_SEED_DOCS)("%s seeds with `run --rm seed`", (doc) => {
    const text = joinContinuations(readRepoFile(doc));
    expect(text).toMatch(/docker compose .*\brun --rm seed\b/);
  });

  it("no tracked doc seeds in the app container, which cannot run it", () => {
    const docs = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(docs.length).toBeGreaterThan(OPERATOR_SEED_DOCS.length);
    const offenders = docs.flatMap((doc) =>
      joinContinuations(readRepoFile(doc))
        .split("\n")
        .filter((l) => /\bexec\s+app\b.*seed\.ts/.test(l))
        .map((l) => `${doc}: ${l.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
