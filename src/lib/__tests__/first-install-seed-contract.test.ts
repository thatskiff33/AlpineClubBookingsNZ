import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { firstInstallCommands } from "../../../scripts/ci/first-install-smoke.mjs";
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

  it("runs the same command as `pnpm run db:seed`", () => {
    const scripts = JSON.parse(readRepoFile("package.json")).scripts as Record<string, string>;
    expect(line(seed, "command")).toBe(`command: ./node_modules/.bin/${scripts["db:seed"]}`);
  });
});

describe("the docs that tell an operator how to seed (#4977, INV-OPS-019)", () => {
  it("gives DEPLOYMENT.md First Bootstrap the seed command, after migrate", () => {
    const commands = firstInstallCommands(readRepoFile("DEPLOYMENT.md"));
    expect(commands.seed).toBe(DOCKER_SEED_COMMAND);
    expect(commands.migrate).toBe("docker compose run --rm migrate");
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
