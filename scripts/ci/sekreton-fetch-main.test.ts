import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashFixturePath } from "../../src/lib/__tests__/helpers/bash-fixture-path";

const root = process.cwd();
const script = path.join(root, "scripts/ci/sekreton-fetch-main.sh");
let fixture: string;
let checkout: string;
let upstream: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fetchMain() {
  return spawnSync("bash", [bashFixturePath(script, checkout)], { cwd: checkout, encoding: "utf8" });
}

describe("Sekreton main fetch", () => {
  beforeEach(() => {
    // Keep disposable repositories inside the checkout; no network or credentials.
    mkdirSync(path.join(root, "tmp"), { recursive: true });
    fixture = mkdtempSync(path.join(root, "tmp/sekreton-fetch-"));
    checkout = path.join(fixture, "checkout");
    upstream = path.join(fixture, "upstream");
    mkdirSync(checkout);
    mkdirSync(upstream);
    git(checkout, "init", "--initial-branch=task");
    git(upstream, "init", "--initial-branch=main");
    git(upstream, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Base");
  });

  afterEach(() => rmSync(fixture, { recursive: true, force: true }));

  it.each(["origin", "gh"])("refreshes origin/main from %s even with no default fetch refspec", (remote) => {
    git(checkout, "config", `remote.${remote}.url`, upstream);
    expect(fetchMain().status).toBe(0);
    expect(git(checkout, "rev-parse", "origin/main")).toBe(git(upstream, "rev-parse", "main"));
    git(upstream, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Advance main");
    expect(fetchMain().status).toBe(0);
    expect(git(checkout, "rev-parse", "origin/main")).toBe(git(upstream, "rev-parse", "main"));
  }, 15_000);

  it("prefers origin when gh is also configured", () => {
    git(checkout, "remote", "add", "origin", upstream);
    git(checkout, "remote", "add", "gh", path.join(fixture, "missing"));
    expect(fetchMain().status).toBe(0);
    expect(git(checkout, "rev-parse", "origin/main")).toBe(git(upstream, "rev-parse", "main"));
  }, 15_000);

  it("fails a broken origin even with a stale base and working gh", () => {
    git(checkout, "remote", "add", "gh", upstream);
    expect(fetchMain().status).toBe(0);
    git(checkout, "remote", "add", "origin", path.join(fixture, "missing"));
    expect(fetchMain().status).toBe(128);
  }, 15_000);

  it("uses the local main branch when no remote is configured, replacing a stale base", () => {
    git(checkout, "remote", "add", "gh", upstream);
    expect(fetchMain().status).toBe(0);
    git(checkout, "remote", "remove", "gh");
    git(checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Sandbox base");
    git(checkout, "branch", "main");
    expect(fetchMain().status).toBe(0);
    expect(git(checkout, "rev-parse", "origin/main")).toBe(git(checkout, "rev-parse", "main"));
  }, 15_000);

  it("fails with no remote and no local main rather than keeping a stale base", () => {
    git(checkout, "remote", "add", "gh", upstream);
    expect(fetchMain().status).toBe(0);
    git(checkout, "remote", "remove", "gh");
    const result = fetchMain();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no origin or gh remote and no local main branch");
  }, 15_000);
});
