import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The out-of-band `npm run config:self-heal` entrypoint
 * (`scripts/config-self-heal.ts`).
 *
 * Its whole job is to tell an operator what happened, so the behaviour worth
 * testing is what it PRINTS. Since CT-1 (#2989) a run on a non-primary
 * `config/club.json` is no longer "nothing happened": the club-config steps are
 * skipped, but the environment-sourced club-timezone step still runs and can
 * write a row. A skip notice printed on its own would tell the operator the
 * database was untouched when it was not — the one thing a deploy log must never
 * do.
 *
 * The script runs `main()` at import, so each case re-imports it with mocked
 * dependencies. `process.exitCode` is saved and restored around every case,
 * because the script sets it and the test worker shares that process.
 */

const { mockRunConfigSelfHeal, mockDisconnect } = vi.hoisted(() => ({
  mockRunConfigSelfHeal: vi.fn(),
  mockDisconnect: vi.fn(async () => {}),
}));

vi.mock("../../../src/lib/config-self-heal", () => ({
  runConfigSelfHeal: mockRunConfigSelfHeal,
}));
vi.mock("../../../src/lib/prisma", () => ({
  prisma: { $disconnect: mockDisconnect },
}));

const originalExitCode = process.exitCode;

function summary(overrides: Record<string, unknown> = {}) {
  return {
    healed: 0,
    alreadyPresent: 0,
    failed: 0,
    skipped: false,
    provenance: "primary",
    results: [],
    ...overrides,
  };
}

/** Import the script and let its top-level promise chain settle. */
async function runCli() {
  const logged: string[] = [];
  const errored: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      errored.push(args.map(String).join(" "));
    });
  try {
    vi.resetModules();
    await import("../../../scripts/config-self-heal");
    // The script does not await its own `main()`, so give the chain — including
    // the `finally` that disconnects — room to settle.
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    return { logged: logged.join("\n"), errored: errored.join("\n") };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = originalExitCode;
});

afterEach(() => {
  process.exitCode = originalExitCode;
});

describe("config:self-heal CLI output", () => {
  it("prints every step's outcome and a success line on a primary run", async () => {
    mockRunConfigSelfHeal.mockResolvedValue(
      summary({
        healed: 1,
        alreadyPresent: 1,
        results: [
          { name: "club-identity-settings", outcome: "already-present" },
          { name: "club-time-zone", outcome: "healed" },
        ],
      }),
    );

    const { logged, errored } = await runCli();

    expect(logged).toContain("club-identity-settings: already-present");
    expect(logged).toContain("club-time-zone: healed");
    expect(logged).toContain("Config self-heal complete");
    expect(errored).toBe("");
    expect(process.exitCode).toBeFalsy();
  });

  it("still prints what ran when the config/club.json steps were skipped", async () => {
    // The CT-1 case: provenance is not primary, so the club-config steps are
    // skipped — but the timezone row was written, and the operator has to see it.
    mockRunConfigSelfHeal.mockResolvedValue(
      summary({
        healed: 1,
        skipped: true,
        provenance: "safe-default",
        results: [{ name: "club-time-zone", outcome: "healed" }],
      }),
    );

    const { logged, errored } = await runCli();

    expect(logged).toContain("club-time-zone: healed");
    // Still loud, and still a non-zero exit: the club.json steps really were
    // skipped and that needs fixing.
    expect(errored).toMatch(/SKIPPED the config\/club\.json-derived steps/);
    expect(errored).toContain("safe-default");
    expect(process.exitCode).toBe(1);
  });

  it("exits non-zero and names the error when a step fails", async () => {
    mockRunConfigSelfHeal.mockResolvedValue(
      summary({
        failed: 1,
        results: [
          { name: "club-time-zone", outcome: "failed", error: "connect ECONNREFUSED" },
        ],
      }),
    );

    const { logged } = await runCli();

    expect(logged).toContain("club-time-zone: failed — connect ECONNREFUSED");
    expect(process.exitCode).toBe(1);
  });
});
