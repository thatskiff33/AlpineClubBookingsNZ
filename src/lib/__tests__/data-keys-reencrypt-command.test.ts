/**
 * `pnpm run data-keys:reencrypt`'s command layer (#4456 PR 2): arguments, exit
 * status, and that an error prints no stored value even when its own message
 * holds one (a database error can echo the query it failed on).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: { $disconnect: vi.fn() } }));

import {
  parseReencryptArgs,
  runReencryptCommand,
  safeErrorLine,
  USAGE,
} from "../../../scripts/data-keys-reencrypt";
import { DataKeyRingError } from "@/lib/data-encryption-key-material";
import { ReencryptRefusedError, type ReencryptReport } from "@/lib/data-encryption-reencrypt";

function report(remaining = 0): ReencryptReport {
  return {
    currentKeyId: "k1",
    currentKeyFingerprint: "0000-1111-2222-3333",
    keyCheckedAgainst: "a stored credential",
    dryRun: false,
    passes: 1,
    credentials: { moved: 1, lostClaims: 0, unreadable: 0, remaining },
    authenticatorSecrets: { moved: 0, lostClaims: 0, unreadable: 0, remaining: 0 },
    recoveryCodes: { legacyUnused: 0, retired: 0, olderRingKeyUnused: 0 },
  };
}

function io(run: () => Promise<ReencryptReport>) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { log: (line: string) => out.push(line), error: (line: string) => err.push(line), run: vi.fn(run) } };
}

describe("data-keys:reencrypt arguments (#4456 PR 2)", () => {
  it("parses the two flags, the pnpm separator and help, and refuses anything else", () => {
    expect(parseReencryptArgs([])).toEqual({ kind: "run", options: { dryRun: false, retireLegacyRecoveryCodes: false } });
    expect(parseReencryptArgs(["--", "--dry-run", "--retire-legacy-recovery-codes"])).toEqual({
      kind: "run",
      options: { dryRun: true, retireLegacyRecoveryCodes: true },
    });
    expect(parseReencryptArgs(["--dry-run", "-h"])).toEqual({ kind: "help" });
    expect(parseReencryptArgs(["--dryrun"])).toEqual({ kind: "error", message: "Unknown argument: --dryrun" });
  });

  it("takes --expect-fingerprint as a separate or an = value, and refuses it with none (F1)", () => {
    for (const argv of [["--expect-fingerprint", "ab12-cd34-ef56-7890"], ["--expect-fingerprint=ab12-cd34-ef56-7890"]]) {
      expect(parseReencryptArgs(argv)).toEqual({
        kind: "run",
        options: { dryRun: false, retireLegacyRecoveryCodes: false, expectFingerprint: "ab12-cd34-ef56-7890" },
      });
    }
    for (const argv of [["--expect-fingerprint"], ["--expect-fingerprint", "--dry-run"], ["--expect-fingerprint="]]) {
      expect(parseReencryptArgs(argv)).toEqual({
        kind: "error",
        message: "--expect-fingerprint needs the fingerprint Admin → Setup shows",
      });
    }
  });

  it("names itself as the pnpm script an operator runs", () => {
    expect(USAGE).toMatch(/pnpm run data-keys:reencrypt --dry-run \[--retire-legacy-recovery-codes\]/);
    expect(USAGE).toMatch(/pnpm run data-keys:reencrypt --expect-fingerprint <fp> \[--retire-legacy-recovery-codes\]/);
  });
});

describe("data-keys:reencrypt exit status (#4456 PR 2)", () => {
  it("is 0 when nothing is left on an old key, printing the report", async () => {
    const { out, io: deps } = io(async () => report(0));
    await expect(runReencryptCommand(["--dry-run"], deps)).resolves.toBe(0);
    expect(deps.run).toHaveBeenCalledWith({ dryRun: true, retireLegacyRecoveryCodes: false });
    expect(out.join("\n")).toMatch(/IntegrationCredential: remaining on old keys: 0/);
  });

  it("is 2 when rows remain, so a scripted rollout can run it again", async () => {
    const { io: deps } = io(async () => report(3));
    await expect(runReencryptCommand([], deps)).resolves.toBe(2);
  });

  it("is 1 on a bad argument, without running", async () => {
    const { err, io: deps } = io(async () => report());
    await expect(runReencryptCommand(["--force"], deps)).resolves.toBe(1);
    expect(deps.run).not.toHaveBeenCalled();
    expect(err[0]).toMatch(/^Unknown argument: --force/);
  });

  it("is 1 on a refusal, printing its reason", async () => {
    const { err, io: deps } = io(async () => {
      throw new ReencryptRefusedError("Refused: DATA_ENCRYPTION_KEYS is not set.");
    });
    await expect(runReencryptCommand([], deps)).resolves.toBe(1);
    expect(err).toEqual(["Refused: DATA_ENCRYPTION_KEYS is not set."]);
  });
});

describe("data-keys:reencrypt never prints a stored value in an error (#4456 PR 2)", () => {
  it("prints any other error as its class and code only, whatever its message holds", async () => {
    const leaky = Object.assign(new Error('Invalid `update()` invocation: { ciphertext: "deadbeefcafe", value: "sentinel-plaintext" }'), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    });
    const { err, io: deps } = io(async () => {
      throw leaky;
    });
    await expect(runReencryptCommand([], deps)).resolves.toBe(1);
    expect(err).toEqual([
      "The re-encrypt failed (PrismaClientKnownRequestError P2002). Rows already moved stay moved; run it again.",
    ]);
    expect(err.join("")).not.toMatch(/deadbeefcafe|sentinel-plaintext/);
  });

  it("keeps the messages built from fixed text and key ids", () => {
    expect(safeErrorLine(new DataKeyRingError("DATA_ENCRYPTION_KEYS: entry 1 is not in the form <id>:<base64 key>."))).toBe(
      "DATA_ENCRYPTION_KEYS: entry 1 is not in the form <id>:<base64 key>.",
    );
    expect(safeErrorLine("a thrown string")).toBe(
      "The re-encrypt failed (string). Rows already moved stay moved; run it again.",
    );
  });
});
