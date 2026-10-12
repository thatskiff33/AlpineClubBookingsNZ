import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrBody } from "./pr-body.mjs";
import { REQUIRED_FIELDS } from "./check-pr-concurrency-declaration.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Real shell syntax remains inert body data, including quotes, backticks and Unicode.
const padding = "café 🏔️ 'quoted' \"double\" `echo unsafe` $(echo unsafe) ${HOME} \\ \r\n".repeat(3000);
const declaration = "## Concurrency And Lock Impact\n\n" +
  REQUIRED_FIELDS.map((field) => `- ${field}: reviewed #4053; None`).join("\n");
const largeBody = `${padding}\n${declaration}\n\nchangelog: none — fixture needs no release entry\n`;
let root;
let eventPath;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pr-event-body-"));
  eventPath = join(root, "event.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { body: largeBody } }));
  vi.stubEnv("GITHUB_EVENT_PATH", eventPath);
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("GH_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("shared PR body event-file transport", () => {
  it("round-trips more than 128 KB of Unicode and shell syntax without an environment body", async () => {
    expect(Buffer.byteLength(largeBody)).toBeGreaterThan(128 * 1024);
    expect(await loadPrBody("fixture")).toBe(largeBody);
  });

  it.each(["current body", "", null])("prefers the live body %j without reading a malformed fallback", async (body) => {
    writeFileSync(eventPath, "malformed JSON");
    vi.stubEnv("GITHUB_TOKEN", "fixture-token");
    vi.stubEnv("GITHUB_REPOSITORY", "fixture/repo");
    vi.stubEnv("PR_NUMBER", "1");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ body }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadPrBody("fixture")).toBe(body ?? "");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to the event file when the live fetch is unavailable", async () => {
    vi.stubEnv("GITHUB_TOKEN", "fixture-token");
    vi.stubEnv("GITHUB_REPOSITORY", "fixture/repo");
    vi.stubEnv("PR_NUMBER", "1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    expect(await loadPrBody("fixture")).toBe(largeBody);
  });

  it.each([{}, { pull_request: { body: null } }, { pull_request: { body: 42 } }, { pull_request: { body: "" } }])(
    "keeps missing, non-string and empty event bodies empty: %j", async (event) => {
      writeFileSync(eventPath, JSON.stringify(event));
      expect(await loadPrBody("fixture")).toBe("");
    },
  );

  it("keeps an absent event path empty", async () => {
    vi.stubEnv("GITHUB_EVENT_PATH", "");
    expect(await loadPrBody("fixture")).toBe("");
  });

  it("rejects unreadable and malformed fallback files", async () => {
    rmSync(eventPath);
    await expect(loadPrBody("fixture")).rejects.toThrow("ENOENT");
    writeFileSync(eventPath, "malformed JSON");
    await expect(loadPrBody("fixture")).rejects.toThrow();
  });

  it.each(["check-pr-concurrency-declaration.mjs", "check-pr-changelog-fragment.mjs"])(
    "runs %s over a real sensitive diff using only the event-file body", (script) => {
      const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
      git("init", "--quiet");
      git("config", "user.email", "gate-test@example.invalid");
      git("config", "user.name", "Gate Test");
      git("config", "commit.gpgsign", "false");
      writeFileSync(join(root, "seed.txt"), "seed\n");
      git("add", "seed.txt");
      git("commit", "--quiet", "-m", "seed");
      const base = git("rev-parse", "HEAD").trim();
      mkdirSync(join(root, "src/lib"), { recursive: true });
      writeFileSync(join(root, "src/lib/payment-fixture.ts"), "export const value = 1;\n");
      git("add", "src");
      git("commit", "--quiet", "-m", "source change");
      const run = () => spawnSync(process.execPath, [join(here, script)], {
        cwd: root,
        encoding: "utf8",
        // Allowlist the environment: no inherited credentials or PR_BODY.
        env: {
          PATH: process.env.PATH,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          GITHUB_EVENT_PATH: eventPath,
          PR_BASE_SHA: base,
          PR_HEAD_SHA: "HEAD",
        },
      });
      const passed = run();
      expect(passed.error).toBeUndefined();
      expect(passed.status, passed.stderr).toBe(0);
      expect(passed.stdout).toContain("check passed");
      // Prove the real gate still fails closed on that same diff without a body.
      writeFileSync(eventPath, JSON.stringify({ pull_request: { body: "" } }));
      const failed = run();
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("failed");
    },
  );

  it("keeps the verify workflow free of body-sized environment entries and inline body expressions", () => {
    const workflow = readFileSync(join(here, "../../.github/workflows/ci.yml"), "utf8");
    expect(workflow).not.toMatch(/\bPR_BODY\s*:/);
    expect(workflow).not.toMatch(/\$\{\{[^}]*github\.event\.pull_request\.body/);
  });
});
