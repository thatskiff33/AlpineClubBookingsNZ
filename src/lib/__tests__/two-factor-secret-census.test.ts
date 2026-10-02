/**
 * The two-factor secret census, as a gate (#3454).
 *
 * Every statement that writes a member's second factor — the authenticator-app
 * secret, the two-factor switch and method, or the recovery codes — is pinned
 * below with how it is audited. A new writer fails this test by name until it
 * is added with that answer. The scanner's own discrimination is proved against
 * synthetic trees at the bottom, because the real tree contains no unaudited
 * writer and would pass whether the walk worked or not.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanTwoFactorSecretCensus } from "../../../scripts/audit/two-factor-secret-census";

/**
 * Every write site, with how it is recorded. The audited ones write their row
 * through `recordTwoFactorMutation` in the same transaction.
 */
const TWO_FACTOR_WRITE_SITES: Record<string, string> = {
  "src/lib/two-factor.ts::enrollTwoFactor#0":
    "member.update{totpSecret,twoFactorEnabled,twoFactorMethod} — enrolment; `security.two_factor.enrolled` in the same transaction",
  "src/lib/two-factor.ts::enrollTwoFactor#1":
    "twoFactorRecoveryCode.deleteMany — enrolment's code rotation, same transaction and row",
  "src/lib/two-factor.ts::enrollTwoFactor#2":
    "twoFactorRecoveryCode.createMany — enrolment's code rotation, same transaction and row",
  "src/lib/two-factor.ts::replaceRecoveryCodes#0":
    "twoFactorRecoveryCode.deleteMany — `security.two_factor.recovery_codes_replaced` in the same transaction",
  "src/lib/two-factor.ts::replaceRecoveryCodes#1":
    "twoFactorRecoveryCode.createMany — same transaction and row",
  "src/lib/two-factor.ts::consumeRecoveryCode.updated#0":
    "twoFactorRecoveryCode.updateMany — marks ONE code used during sign-in; it mints and clears nothing, and is a sign-in event rather than a credential change",
  "src/app/api/admin/deletion-requests/[id]/route.ts::POST#0":
    "member.update{totpSecret,twoFactorEnabled,twoFactorMethod} — the erasure's anonymisation; `security.two_factor.cleared` via `recordErasureTwoFactorClear` in the same transaction",
  "src/app/api/admin/deletion-requests/[id]/route.ts::POST#1":
    "twoFactorRecoveryCode.deleteMany — the erasure's revocation of every second-factor artefact, same transaction as the clear's row",
};

describe("two-factor secret census: the tree (#3454)", { timeout: 180_000 }, () => {
  const census = scanTwoFactorSecretCensus();

  it("resolved a real population, so a clean report means something", () => {
    expect(census.filesScanned).toBeGreaterThan(1500);
    expect(census.sites.length).toBeGreaterThanOrEqual(6);
  });

  it("pins every writer of a member's second factor, with how it is audited", () => {
    expect(
      census.sites.map((site) => site.id),
      "A writer of `totpSecret`, `twoFactorEnabled`, `twoFactorMethod` or the " +
        "recovery codes appeared or moved. Route it through the audited paths in " +
        "`src/lib/two-factor.ts` / `two-factor-audit.ts` (INV-PRIV-020), then add " +
        "its row to TWO_FACTOR_WRITE_SITES saying how it is recorded.",
    ).toEqual(Object.keys(TWO_FACTOR_WRITE_SITES).sort());
  });
});

describe("two-factor secret census: the scanner discriminates (#3454)", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  function tree(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "two-factor-census-"));
    roots.push(root);
    for (const dir of ["src", "scripts", "e2e", "prisma"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    return scanTwoFactorSecretCensus(root).sites.map((site) => site.statement);
  }

  it("REPORTS a write of the secret, the switch and the codes outside the audited paths", () => {
    expect(
      tree({
        "src/lane.ts": `
          export async function reset(tx: any, totpSecret: null) {
            await tx.member.update({ where: { id: "m" }, data: { totpSecret: null } });
            await tx.member.updateMany({ where: {}, data: { twoFactorEnabled: false } });
            await tx.member.upsert({ where: {}, create: {}, update: { totpSecret } });
            await tx.twoFactorRecoveryCode.deleteMany({ where: {} });
          }
        `,
      }),
    ).toEqual([
      "member.update{totpSecret}",
      "member.updateMany{twoFactorEnabled}",
      "member.upsert{totpSecret}",
      "twoFactorRecoveryCode.deleteMany",
    ]);
  });

  it("does NOT report a read, a select or a filter", () => {
    expect(
      tree({
        "src/lane.ts": `
          export async function read(tx: any) {
            await tx.member.findUnique({ where: { id: "m" }, select: { totpSecret: true } });
            await tx.member.update({ where: { twoFactorEnabled: true }, data: { firstName: "x" } });
            await tx.twoFactorRecoveryCode.findMany({ where: {} });
            await enroll({ totpSecret: "x" });
          }
        `,
      }),
    ).toEqual([]);
  });
});
