import path from "path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  auditEnforcedGuardCoverage,
  auditResolvedGuardCoverage,
  resolveRestrictedSyntax,
} from "./support/eslint-guard-coverage";

/*
  #3302 — the MIRROR of `money-cents-guard.test.ts`, for the opposite
  direction. INV-MONEY-003 catches BUILDING cents inline; nothing caught
  RENDERING them with a hand-rolled `(cents / 100).toFixed(n)` instead of the
  shared `formatCents` / `formatCentsPlain`. That was #3302's acceptance
  criterion three — "no new copy can be added without the compiler or a test
  objecting" — and it was unmet: nine separate copies of `formatCents` existed
  before this issue, and a tenth (`formatOfferCents`, a different name for the
  identical shape) escaped its own census entirely. A census that keys on a
  NAME cannot hold this; only a structural check on the SHAPE can.

  This file does NOT reuse `PRODUCTION_GUARD_ROSTER` (the shared money/date
  roster in `eslint-guard-coverage.ts`): every roster entry there would need a
  fresh `CENTS_DISPLAY_ARM_EXPECTATIONS`-style verdict, rippling into the date
  guard's own "no stale roster entries" test for paths it has never heard of.
  `auditResolvedGuardCoverage` and `auditEnforcedGuardCoverage` both accept a
  `roster` override for exactly this reason, so this suite passes its OWN
  small roster: one ordinary path (must catch), and every
  `CENTS_DISPLAY_EXEMPTIONS` path (must not).
*/

const BOOTSTRAP_TIMEOUT_MS = 60_000;
const CASE_TIMEOUT_MS = 20_000;

// Same reasoning as `money-cents-guard.test.ts`: the flat-config/plugin
// bootstrap costs several seconds on the FIRST `lintText`, which `beforeAll`
// below pays deliberately rather than the first `it.each`-style case eating
// it against vitest's 5000 ms default.
vi.setConfig({
  testTimeout: CASE_TIMEOUT_MS,
  hookTimeout: BOOTSTRAP_TIMEOUT_MS,
});

const REPO_ROOT = path.resolve(__dirname, "../../..");
const RULE_ID = "INV-SSOT-001 / #3302";
const ORDINARY_FILE = "src/lib/cents-display-guard-fixture.ts";
/** A `.tsx` counterpart: JSX in a real exempted file cannot parse under a `.ts` filePath. */
const ORDINARY_TSX_FILE = "src/components/cents-display-guard-fixture.tsx";
/** A file exempted from `CENTS_DISPLAY_RESTRICTIONS` AND `MONEY_DOMAIN_MODULES`'s money arm swap. */
const LAYERED_FILE = "src/lib/finance-legacy-dashboard-export.ts";

/** A single `(cents / 100).toFixed(2)` call — the exact shape the rule bans. */
const VIOLATING_CODE =
  "export function f(cents: number): string {\n  return `$${(cents / 100).toFixed(2)}`;\n}\n";

let eslint: ESLint;

type ConfigBlock = { files?: string[]; rules?: Record<string, unknown> };
type CentsDisplayExemption = { files: string[]; reason: string };

async function loadEslintConfig(): Promise<{
  blocks: ConfigBlock[];
  arm: string[];
  exemptions: CentsDisplayExemption[];
  exemptFiles: Set<string>;
}> {
  const { pathToFileURL } = await import("url");
  const configModule: {
    default: unknown;
    CENTS_DISPLAY_GUARD_ARM?: unknown;
    CENTS_DISPLAY_EXEMPTIONS?: unknown;
  } = await import(
    pathToFileURL(path.join(REPO_ROOT, "eslint.config.mjs")).href
  );

  const exemptions = (configModule.CENTS_DISPLAY_EXEMPTIONS ??
    []) as CentsDisplayExemption[];

  return {
    blocks: configModule.default as ConfigBlock[],
    arm: (configModule.CENTS_DISPLAY_GUARD_ARM ?? []) as string[],
    exemptions,
    exemptFiles: new Set(exemptions.flatMap((entry) => entry.files)),
  };
}

beforeAll(async () => {
  eslint = new ESLint({ cwd: REPO_ROOT, warnIgnored: false });
  // Same canary discipline as `money-cents-guard.test.ts`: force the flat-config
  // bootstrap here, against a real violation, so a cold/broken/ignored run
  // fails loudly instead of every negative fixture below passing vacuously.
  const results = await eslint.lintText(VIOLATING_CODE, {
    filePath: path.join(REPO_ROOT, ORDINARY_FILE),
  });
  const messages = results.flatMap((result) => result.messages);

  const fatal = messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(
      `${RULE_ID} canary did not parse: ${fatal[0]?.message}`,
    );
  }

  const hits = messages.filter(
    (message) =>
      message.ruleId === "no-restricted-syntax" &&
      typeof message.message === "string" &&
      message.message.startsWith(RULE_ID),
  );
  if (hits.length !== 1) {
    throw new Error(
      `${RULE_ID} canary produced ${hits.length} report(s), expected exactly 1. The guard is not running against ${ORDINARY_FILE}, so every negative fixture below would pass vacuously. Messages seen: ${JSON.stringify(
        messages.map((message) => ({
          ruleId: message.ruleId,
          severity: message.severity,
          message: message.message?.slice(0, 120),
        })),
      )}`,
    );
  }
}, BOOTSTRAP_TIMEOUT_MS);

describe("cents-display guard: catches the shape", () => {
  it("fires on a hand-rolled (cents / 100).toFixed(n) at an ordinary src file", async () => {
    const results = await eslint.lintText(VIOLATING_CODE, {
      filePath: path.join(REPO_ROOT, ORDINARY_FILE),
    });
    const hits = results
      .flatMap((result) => result.messages)
      .filter(
        (message) =>
          message.ruleId === "no-restricted-syntax" &&
          typeof message.message === "string" &&
          message.message.startsWith(RULE_ID),
      );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe(2);
  });

  it("names both canonical helpers in its message", async () => {
    const results = await eslint.lintText(VIOLATING_CODE, {
      filePath: path.join(REPO_ROOT, ORDINARY_FILE),
    });
    const message = results
      .flatMap((result) => result.messages)
      .find((entry) => entry.message?.startsWith(RULE_ID))?.message;
    expect(message).toContain("formatCents");
    expect(message).toContain("formatCentsPlain");
    expect(message).toContain("CENTS_DISPLAY_EXEMPTIONS");
  });

  // Money by construction, not a percentage: `Math.round(x * 100) / 100` — the
  // `theme/` two-decimal rounding shape money-cents-guard.test.ts also checks
  // — divides by 100 but never calls `.toFixed` on the division, so this rule
  // (unlike the inline-cents one) does not need a percentage exclusion at all.
  it("does not fire on a percentage rounding that never calls toFixed on the division", async () => {
    const code =
      "export function round2(x: number): number {\n  return Math.round(x * 100) / 100;\n}\n";
    const results = await eslint.lintText(code, {
      filePath: path.join(REPO_ROOT, ORDINARY_FILE),
    });
    const hits = results
      .flatMap((result) => result.messages)
      .filter((message) => message.message?.startsWith(RULE_ID));
    expect(hits).toEqual([]);
  });

  it("does not fire on formatCents/formatCentsPlain themselves being CALLED", async () => {
    const code =
      'import { formatCents, formatCentsPlain } from "@/lib/utils";\nexport const a = formatCents(100);\nexport const b = formatCentsPlain(100);\n';
    const results = await eslint.lintText(code, {
      filePath: path.join(REPO_ROOT, ORDINARY_FILE),
    });
    const hits = results
      .flatMap((result) => result.messages)
      .filter((message) => message.message?.startsWith(RULE_ID));
    expect(hits).toEqual([]);
  });
});

describe("currency-locale guard (#3325, INV-CONFIG-001): a literal locale on a currency formatter", () => {
  const LOCALE_RULE_ID = "INV-CONFIG-001";
  const hitsIn = (results: Awaited<ReturnType<ESLint["lintText"]>>) =>
    results
      .flatMap((result) => result.messages)
      .filter(
        (message) =>
          message.ruleId === "no-restricted-syntax" &&
          typeof message.message === "string" &&
          message.message.startsWith(LOCALE_RULE_ID),
      );

  it("fires on new Intl.NumberFormat(\"en-NZ\", { style: \"currency\" }) at an ordinary src file", async () => {
    const code =
      'export const dollars = (cents: number) => new Intl.NumberFormat("en-NZ", { style: "currency", currency: "NZD" }).format(cents / 100);\n';
    const results = await eslint.lintText(code, {
      filePath: path.join(REPO_ROOT, ORDINARY_FILE),
    });
    const hits = hitsIn(results);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe(2);
    expect(hits[0]?.message).toContain("formatCents");
    expect(hits[0]?.message).toContain("finance-format");
  });

  it("does not fire when the locale is the configured APP_LOCALE", async () => {
    const code =
      'import { APP_CURRENCY, APP_LOCALE } from "@/config/operational";\nexport const f = new Intl.NumberFormat(APP_LOCALE, { style: "currency", currency: APP_CURRENCY });\n';
    const results = await eslint.lintText(code, {
      filePath: path.join(REPO_ROOT, ORDINARY_FILE),
    });
    expect(hitsIn(results)).toEqual([]);
  });

  it("does not fire on a literal-locale formatter that is not a currency one", async () => {
    const code =
      'export const f = new Intl.NumberFormat("en-NZ", { maximumFractionDigits: 0 });\n';
    const results = await eslint.lintText(code, {
      filePath: path.join(REPO_ROOT, ORDINARY_FILE),
    });
    expect(hitsIn(results)).toEqual([]);
  });

  it("is NOT lifted at a file on the toFixed exemption list — that list excuses an input's plain value, never a hard-coded locale", async () => {
    const { exemptFiles } = await loadEslintConfig();
    const [exempted] = Array.from(exemptFiles).filter((file) => file !== "src/lib/utils.ts");
    expect(exempted).toBeDefined();
    const code =
      'export const dollars = (cents: number) => new Intl.NumberFormat("en-NZ", { style: "currency", currency: "NZD" }).format(cents / 100);\n';
    const results = await eslint.lintText(code, {
      filePath: path.join(REPO_ROOT, exempted as string),
    });
    expect(hitsIn(results)).toHaveLength(1);
  });
});

describe("cents-display guard: the declared exemptions", () => {
  it("reads its exemption list from the config, and every entry states files and a reason", async () => {
    const { exemptions } = await loadEslintConfig();

    expect(exemptions.length).toBeGreaterThan(0);
    for (const entry of exemptions) {
      expect(Array.isArray(entry.files)).toBe(true);
      expect(entry.files.length).toBeGreaterThan(0);
      for (const file of entry.files) {
        expect(typeof file).toBe("string");
        expect(file.trim().length).toBeGreaterThan(0);
      }
      expect(typeof entry.reason).toBe("string");
      expect(entry.reason.trim().length).toBeGreaterThanOrEqual(40);
    }
  });

  it("still finds the real hand-rolled pattern in every exempted file — an exemption is deleted when its cause is", async () => {
    const { readFileSync } = await import("node:fs");
    const { exemptFiles } = await loadEslintConfig();

    const stale: string[] = [];
    for (const file of exemptFiles) {
      const code = readFileSync(path.join(REPO_ROOT, file), "utf8");
      // Lint the file's REAL content at an ORDINARY (non-exempt) path, so the
      // exemption block cannot mask the check — this asks "does this file's
      // actual code still contain the pattern", not "is the guard armed here".
      // Extension must match: JSX in a real .tsx file fails to parse under a
      // .ts filePath, which would misreport every such file as stale.
      const ordinaryCounterpart = file.endsWith(".tsx")
        ? ORDINARY_TSX_FILE
        : ORDINARY_FILE;
      const results = await eslint.lintText(code, {
        filePath: path.join(REPO_ROOT, ordinaryCounterpart),
      });
      const messages = results.flatMap((result) => result.messages);
      if (messages.some((message) => message.fatal)) {
        stale.push(`${file} (failed to parse as ${ordinaryCounterpart})`);
        continue;
      }
      const hits = messages.filter((message) =>
        message.message?.startsWith(RULE_ID),
      );
      if (hits.length === 0) stale.push(file);
    }
    expect(stale).toEqual([]);
  });

  it("lifts the rule at every exempted file, and nowhere else", async () => {
    const { exemptFiles } = await loadEslintConfig();

    const problems = await auditEnforcedGuardCoverage({
      eslint,
      repoRoot: REPO_ROOT,
      roster: [
        { file: ORDINARY_FILE, why: "an ordinary src file — the guard must catch it" },
        ...Array.from(exemptFiles, (file) => ({
          file,
          why: "a declared CENTS_DISPLAY_EXEMPTIONS path — the guard must not fire here",
        })),
      ],
      violatingCode: VIOLATING_CODE,
      messagePrefix: RULE_ID,
      isExempt: (file) => exemptFiles.has(file),
    });

    expect(problems).toEqual([]);
  });

  it("resolves to an armed error-severity rule at every exempted file, minus only this one selector", async () => {
    const { arm, exemptFiles } = await loadEslintConfig();

    const problems = await auditResolvedGuardCoverage({
      eslint,
      repoRoot: REPO_ROOT,
      roster: [
        { file: ORDINARY_FILE, why: "an ordinary src file — must carry the arm" },
        ...Array.from(exemptFiles, (file) => ({
          file,
          why: "a declared exemption — must NOT carry the arm, but must stay armed for everything else",
        })),
      ],
      requiredSelectorsFor: (file) => (exemptFiles.has(file) ? [] : arm),
    });

    expect(problems).toEqual([]);

    // The "everything else stays" half: an exempted file's resolved rule is
    // still `error`, and still carries at least the raw-SQL restriction — an
    // exemption block that switched the whole rule off instead of dropping one
    // named group would pass the check above (an empty required-selector list
    // is trivially satisfied) but silently lift every other guard too.
    for (const file of exemptFiles) {
      const resolved = await resolveRestrictedSyntax(eslint, REPO_ROOT, file);
      expect(resolved.severity).toBe(2);
      expect(
        resolved.messages.some((message) => message.startsWith("INV-OPS-001")),
      ).toBe(true);
    }
  });

  it("swaps in the money-MODULE arm, not the narrow one, for the three MONEY_DOMAIN_MODULES overlaps", async () => {
    // `LAYERED_FILE` is also a `finance-*` member, so its resolved config must
    // still carry `MONEY_MODULE_RESTRICTIONS` (the broad arm) even though it
    // drops `CENTS_DISPLAY_RESTRICTIONS` — proving the two exemption blocks
    // did not collapse into one that silently reverts it to the narrow arm.
    const resolved = await resolveRestrictedSyntax(eslint, REPO_ROOT, LAYERED_FILE);
    expect(resolved.severity).toBe(2);
    // A money-MODULE-arm selector this file must still carry: the broad
    // "anything * 100 that is not a ratio" arm from `MONEY_MODULE_RESTRICTIONS`.
    expect(
      resolved.selectors.some((selector) => selector.includes('operator="*"')),
    ).toBe(true);
  });
});
