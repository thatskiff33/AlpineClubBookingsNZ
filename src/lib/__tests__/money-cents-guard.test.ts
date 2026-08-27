import path from "path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  auditEnforcedGuardCoverage,
  auditResolvedGuardCoverage,
  PRODUCTION_GUARD_ROSTER,
  resolveRestrictedSyntax,
} from "./support/eslint-guard-coverage";

/*
  THE COST, AND WHERE IT IS PAID.

  The flat-config bootstrap — resolving `eslint.config.mjs`, its Next presets and
  every plugin — happens on the FIRST `lintText`. `new ESLint(...)` does none of
  it. Left to itself the first `it.each` case paid that whole bill against
  vitest's 5000 ms default, and this file failed roughly two runs in three
  (#2685 review).

  `beforeAll` pays it instead, against budgets with real headroom. Measured on
  this tree: the bootstrap lint is ~1.2 s against the 60 s hook budget, and every
  `lintText` after it is ~5 ms against the 20 s per-case budget — so a machine
  would have to be fifty times slower to trip the hook, and thousands of times
  slower to trip a case. Whatever remains after that is not a clock problem,
  which is why the hook also asserts the guard is genuinely running: see the
  canary below.
*/
const BOOTSTRAP_TIMEOUT_MS = 60_000;
const CASE_TIMEOUT_MS = 20_000;

vi.setConfig({
  testTimeout: CASE_TIMEOUT_MS,
  hookTimeout: BOOTSTRAP_TIMEOUT_MS,
});

/**
 * #2685 — the money cents-conversion lint rule, exercised through the REAL
 * `eslint.config.mjs`.
 *
 * This runs the actual config rather than a copy of the selectors, so it also
 * proves the file-block resolution: which paths the rule reaches, and which two
 * modules it is deliberately lifted from. A selector list copied into a test
 * would pass happily while the config that ships had dropped the rule.
 *
 * ENFORCES INV-MONEY-003 (`docs/invariants/money.md`), which names this rule and
 * this file as its enforcement arms. Every failure message below repeats the id.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Where a fixture is pretended to live. Never a real file. */
const ORDINARY_SRC_FILE = path.join(REPO_ROOT, "src/lib/money-guard-fixture.ts");
const XERO_MODULE_FILE = path.join(REPO_ROOT, "src/lib/xero-money-guard-fixture.ts");
const FINANCE_MODULE_FILE = path.join(
  REPO_ROOT,
  "src/lib/finance-money-guard-fixture.ts",
);
const THEME_FILE = path.join(REPO_ROOT, "src/lib/theme/money-guard-fixture.ts");
const SCRIPTS_FILE = path.join(REPO_ROOT, "scripts/money-guard-fixture.ts");
const XERO_ADMIN_SCREEN_FILE = path.join(
  REPO_ROOT,
  "src/app/(admin)/admin/xero/_components/money-guard-fixture.tsx",
);
const HELPER_TEXT_FILE = path.join(REPO_ROOT, "src/lib/money-input.ts");
const HELPER_PROVIDER_FILE = path.join(REPO_ROOT, "src/lib/money-provider-amount.ts");

/*
  The paths the module list was WIDENED to (#2685 review). Each was a silent hole
  before: `xero.ts` because `xero-*` does not match `xero`; the
  `membership-cancellation-*` directory because that family had no `/**` form
  although the other two did; `.tsx` at the lib root because the globs said `.ts`;
  and the payment/promo/credit modules plus every API route because the arm was
  confined to three `src/lib/` families, leaving the very module the issue calls
  "invisible to any rule keyed off parseFloat or Math.round" invisible to this
  rule too.
*/
const XERO_FACADE_FILE = path.join(REPO_ROOT, "src/lib/xero.ts");
const XERO_LIB_ROOT_TSX_FILE = path.join(
  REPO_ROOT,
  "src/lib/xero-money-guard-fixture.tsx",
);
const MEMBERSHIP_CANCELLATION_DIR_FILE = path.join(
  REPO_ROOT,
  "src/lib/membership-cancellation-money-guard/fixture.ts",
);
const ADMIN_PAYMENTS_FILE = path.join(
  REPO_ROOT,
  "src/lib/admin-payments-service.ts",
);
const STRIPE_FILE = path.join(REPO_ROOT, "src/lib/stripe.ts");
const PROMO_FILE = path.join(REPO_ROOT, "src/lib/promo.ts");
const JOINING_FEE_FILE = path.join(REPO_ROOT, "src/lib/joining-fee.ts");
const API_ROUTE_FILE = path.join(
  REPO_ROOT,
  "src/app/api/admin/money-guard-fixture/route.ts",
);

const MONEY_RULE_ID = "INV-MONEY-003";

let eslint: ESLint;

/*
  THE CANARY. Every negative fixture in this file asserts "zero money errors",
  so ANY condition that makes ESLint return no rule messages at all — a fixture
  that fails to parse, a path that turns out to be ignored, a bootstrap that
  silently produced an empty config — passes every one of them vacuously while
  failing the positive ones. That is a failure mode which reads as a partial
  flake rather than as "the guard is not running", and a reviewer on another lane
  saw exactly that: 26 then 44 failures in a single file, then three clean runs
  (#2685 review).

  So the warm-up lints a known violation instead of an inert `const`, and the
  hook THROWS unless it produces exactly one report. A cold, broken or ignored
  run now fails loudly in the hook, before a single vacuous green is printed.
*/
const CANARY_CODE = "export const amountCents = Math.round(parseFloat(raw) * 100);\n";

beforeAll(async () => {
  eslint = new ESLint({ cwd: REPO_ROOT, warnIgnored: false });
  // Force the config/plugin bootstrap here rather than inside the first case:
  // resolving the flat config, the Next presets and every plugin costs 5–6
  // seconds and none of it happens until the first `lintText`.
  const results = await eslint.lintText(CANARY_CODE, {
    filePath: ORDINARY_SRC_FILE,
  });
  const messages = results.flatMap((result) => result.messages);

  const fatal = messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(
      `${MONEY_RULE_ID} canary did not parse, so every negative fixture in this file would have passed vacuously: ${fatal[0]?.message}`,
    );
  }

  const hits = messages.filter(
    (message) =>
      message.ruleId === "no-restricted-syntax" &&
      typeof message.message === "string" &&
      message.message.startsWith(MONEY_RULE_ID),
  );
  if (hits.length !== 1) {
    throw new Error(
      `${MONEY_RULE_ID} canary produced ${hits.length} report(s), expected exactly 1. The guard is not running against ${ORDINARY_SRC_FILE}, so the negative fixtures below would have passed vacuously. Messages seen: ${JSON.stringify(
        messages.map((message) => ({
          ruleId: message.ruleId,
          severity: message.severity,
          message: message.message?.slice(0, 120),
        })),
      )}`,
    );
  }
}, BOOTSTRAP_TIMEOUT_MS);

type ConfigBlock = { files?: string[]; rules?: Record<string, unknown> };
type GuardExemption = { file: string; reason: string };
type MoneyGuardArms = { standard: string[]; moneyModule: string[] };

/**
 * Whether a glob can only ever match a TEST file.
 *
 * `__tests__/` directories and `*.test.ts` / `*.spec.ts` filenames are the two
 * spellings this repository uses. Anything else in an `off` block is production
 * code with the guard switched off.
 */
function isTestOnlyGlob(glob: string): boolean {
  return (
    glob.includes("__tests__") ||
    /\*\.(test|spec)\./.test(glob) ||
    glob.includes(".test.") ||
    glob.includes(".spec.")
  );
}

/** The real `eslint.config.mjs`: its blocks, arms, and declared exemption list. */
async function loadEslintConfig(): Promise<{
  blocks: ConfigBlock[];
  arms: MoneyGuardArms;
  exemptions: GuardExemption[];
  exemptFiles: Set<string>;
}> {
  const { pathToFileURL } = await import("url");
  const configModule: {
    default: unknown;
    MONEY_GUARD_ARMS?: unknown;
    MONEY_GUARD_EXEMPTIONS?: unknown;
  } = await import(
    pathToFileURL(path.join(REPO_ROOT, "eslint.config.mjs")).href
  );

  const exemptions = (configModule.MONEY_GUARD_EXEMPTIONS ??
    []) as GuardExemption[];

  return {
    blocks: configModule.default as ConfigBlock[],
    arms: (configModule.MONEY_GUARD_ARMS ?? {
      standard: [],
      moneyModule: [],
    }) as MoneyGuardArms,
    exemptions,
    exemptFiles: new Set(exemptions.map((entry) => entry.file)),
  };
}

/** Every money-rule complaint in `code`, as `line:column` strings. */
async function moneyErrorLocationsIn(
  code: string,
  filePath: string,
): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath });
  return results
    .flatMap((result) => result.messages)
    .filter(
      (message) =>
        message.ruleId === "no-restricted-syntax" &&
        typeof message.message === "string" &&
        message.message.startsWith(MONEY_RULE_ID),
    )
    .map((message) => `${message.line}:${message.column}`);
}

async function moneyErrorsIn(code: string, filePath: string): Promise<number> {
  return (await moneyErrorLocationsIn(code, filePath)).length;
}

/** The line numbers complained about, in order — one entry per report. */
async function moneyErrorLinesIn(
  code: string,
  filePath: string,
): Promise<number[]> {
  return (await moneyErrorLocationsIn(code, filePath)).map((location) =>
    Number(location.split(":")[0]),
  );
}

/** Every money-domain module the roster covers, plus an ordinary file as control. */
const MONEY_MODULE_CASES: ReadonlyArray<readonly [string, string]> = [
  ["an ordinary src file (the control)", ORDINARY_SRC_FILE],
  ["a Xero module", XERO_MODULE_FILE],
  ["the Xero facade", XERO_FACADE_FILE],
  ["a finance module", FINANCE_MODULE_FILE],
  ["the pricing module", path.join(REPO_ROOT, "src/lib/pricing.ts")],
  ["the admin payments service", ADMIN_PAYMENTS_FILE],
  ["the Stripe client", STRIPE_FILE],
  ["an API route", API_ROUTE_FILE],
];

describe("money cents-conversion guard: positive fixtures", () => {
  /*
    Alternate spellings and compositions of the SAME mistake. Banning
    `parseFloat` by name would catch only the first two of these; the rule
    matches the composition, which is what the owner's 9 Aug 2026 decision asked
    for after a bare-`parseFloat` ban was measured and rejected.
  */
  it.each([
    ["parseFloat", "const c = Math.round(parseFloat(raw) * 100);"],
    ["Number.parseFloat", "const c = Math.round(Number.parseFloat(raw) * 100);"],
    ["Number", "const c = Math.round(Number(raw) * 100);"],
    ["parseInt", "const c = Math.round(parseInt(raw) * 100);"],
    ["Number.parseInt", "const c = Math.round(Number.parseInt(raw) * 100);"],
    ["a defaulted parse", "const c = Math.round((parseFloat(raw) || 0) * 100);"],
    ["a summed parse", "const c = Math.round((Number(raw) + Number(raw)) * 100);"],
    ["a hand-rolled parser", "const c = Number(d) * 100 + Number(cts);"],
    ["a unary + coercion", "const c = Math.round(+raw * 100);"],
    ["the operands reversed", "const c = Math.round(100 * parseFloat(raw));"],
    ["a nested parse", "const c = Math.round(Math.max(0, Number(raw)) * 100);"],
    ["a ternary parse", "const c = Math.round((raw ? Number(raw) : 0) * 100);"],
  ])("catches %s", async (_label, body) => {
    const code = `export function f(raw: string, d: string, cts: string) {\n  ${body}\n  return c;\n}\n`;
    await expect(moneyErrorsIn(code, ORDINARY_SRC_FILE)).resolves.toBeGreaterThan(0);
  });

  it.each([
    ["a const declaration", "const amountCents = Math.round(dollars * 100);"],
    ["a let reassignment", "let totalCents = 0; totalCents = Math.round(dollars * 100);"],
    ["an object property", "const p = { valueCents: Math.round(dollars * 100) };"],
    [
      "a member assignment",
      "const p: Record<string, number> = {}; p.amountCents = Math.round(dollars * 100);",
    ],
  ])("catches a plain variable scaled into %s", async (_label, body) => {
    const code = `export function f(dollars: number) {\n  ${body}\n  return 1;\n}\n`;
    await expect(moneyErrorsIn(code, ORDINARY_SRC_FILE)).resolves.toBeGreaterThan(0);
  });

  /*
    The two spellings that scale to cents with no `* 100` in the source at all.
    `c *= 100` escaped every arm — including the broad money-module one, which
    matches a `BinaryExpression` that a compound assignment does not create — and
    it is one refactoring step from the shape this whole issue is about (#2685
    review).
  */
  it.each([
    ["a compound `*= 100`", "let c = parseFloat(raw); c *= 100;"],
    ["a division by a hundredth", "const c = Math.round(Number(raw) / 0.01);"],
  ])("catches %s", async (_label, body) => {
    const code = `export function f(raw: string) {\n  ${body}\n  return 1;\n}\n`;
    await expect(moneyErrorsIn(code, ORDINARY_SRC_FILE)).resolves.toBeGreaterThan(0);
  });

  it.each([
    ["a Xero module", XERO_MODULE_FILE],
    ["the Xero facade, which `xero-*` does not match", XERO_FACADE_FILE],
    ["a `.tsx` at the lib root", XERO_LIB_ROOT_TSX_FILE],
    ["a finance module", FINANCE_MODULE_FILE],
    ["a membership-cancellation directory", MEMBERSHIP_CANCELLATION_DIR_FILE],
    ["the admin payments service", ADMIN_PAYMENTS_FILE],
    ["the Stripe client", STRIPE_FILE],
    ["the promo module", PROMO_FILE],
    ["the joining-fee module", JOINING_FEE_FILE],
    ["an API route", API_ROUTE_FILE],
  ])("catches a bare `x * 100` inside %s", async (_label, filePath) => {
    const code = "export function f(total: number) {\n  return Math.round(total * 100);\n}\n";
    await expect(moneyErrorsIn(code, filePath)).resolves.toBeGreaterThan(0);
  });

  /*
    The intermediate-variable form — the parse and the scaling in different
    statements — is the defect class the issue describes, one refactoring step
    removed. No shape-based arm can see it, because there is nothing in the
    multiplication to recognise; only the module-scoped arm catches it, which is
    the concrete reason that arm was widened past three `src/lib/` families.
  */
  it.each([
    ["a Xero module", XERO_MODULE_FILE],
    ["the admin payments service", ADMIN_PAYMENTS_FILE],
    ["an API route", API_ROUTE_FILE],
  ])("catches a parse held in a variable first, inside %s", async (_label, filePath) => {
    const code = [
      "export function f(raw: string) {",
      "  const dollars = Number.parseFloat(raw);",
      "  return Math.round(dollars * 100);",
      "}",
      "",
    ].join("\n");
    await expect(moneyErrorsIn(code, filePath)).resolves.toBeGreaterThan(0);
  });

  /*
    A TYPED AMOUNT DIVIDED, AND THEN SCALED — the hole this fix closes.

    The broad money-module arm excludes a division sitting inside the
    multiplication, so a genuine percentage stays writable inside these files.
    For a while that exclusion was the ONLY money rule those files had, because
    the config claimed the broad arm "subsumed" the narrow ones. It does not: a
    GST-exclusive split, a per-guest share and a unit price all convert typed
    text to cents THROUGH a division, and every one of them converted unguarded
    in every money module and every API route while the identical line was caught
    in an ordinary `src/lib` file — the guard at its weakest exactly where money
    lives (#2685 review).

    All four must be reported, once each, everywhere — including in the ordinary
    file, which is the control that proves the fixture really is a violation.
  */
  const RATIO_OF_PARSE_PROBE = [
    "export function f(gross: string, raw: string, guests: number, line: { total: string; qty: number }) {",
    "  const gstExclusive = Math.round((parseFloat(gross) / 1.15) * 100);",
    "  const perGuest = Math.round((parseFloat(raw) / guests) * 100);",
    "  const mirrored = Math.round(100 * (Number(raw) / guests));",
    "  const unitPrice = Math.round((parseFloat(line.total) / line.qty) * 100);",
    "  return gstExclusive + perGuest + mirrored + unitPrice;",
    "}",
    "",
  ].join("\n");

  it.each(MONEY_MODULE_CASES)(
    "catches a typed amount divided then scaled, once per line, inside %s",
    async (_label, filePath) => {
      await expect(
        moneyErrorLinesIn(RATIO_OF_PARSE_PROBE, filePath),
      ).resolves.toEqual([2, 3, 4, 5]);
    },
  );

  it.each(MONEY_MODULE_CASES)(
    "reports a divided parse into a `…Cents` binding exactly once in %s",
    async (_label, filePath) => {
      // Two arms can see this shape — the parse arm and the ratio-into-`…Cents`
      // arm — and they anchor one column apart, which is precisely the
      // duplicate-message defect the earlier review made this config fix once.
      const code = "export const amountCents = Math.round((parseFloat(x) / n) * 100);\n";
      await expect(moneyErrorLocationsIn(code, filePath)).resolves.toHaveLength(1);
    },
  );

  it("catches a money property whose key does not end in Cents", async () => {
    // `{ unit_amount: … }` for Stripe and `{ amount: … }` for a webhook are real
    // shapes that arm 3's `…Cents` convention cannot see; the module arm can.
    const code = "export const price = { unit_amount: Math.round(dollars * 100) };\n";
    await expect(moneyErrorsIn(code, STRIPE_FILE)).resolves.toBeGreaterThan(0);
  });

  it("reaches scripts/, where the money-adjacent backfills live", async () => {
    const code = "export function f(raw: string) {\n  return Math.round(parseFloat(raw) * 100);\n}\n";
    await expect(moneyErrorsIn(code, SCRIPTS_FILE)).resolves.toBeGreaterThan(0);
  });

  /*
    ONE complaint per mistake. The arms overlap by design — the same
    `parseFloat(raw) * 100` matches the parse arm, the `…Cents` arm and, in a
    money module, the broad arm — and `parseFloat(raw)` starts at the same column
    as `parseFloat(raw) * 100`, so the overlap printed the identical message two
    and three times at the identical line:column. A 25-site regression printed
    about sixty of them and read far worse than it was (#2685 review).
  */
  it.each([
    ["an ordinary src file", ORDINARY_SRC_FILE],
    ["a money-domain module", XERO_MODULE_FILE],
  ])("reports a parse scaled into a `…Cents` binding once in %s", async (_label, filePath) => {
    const code = "export const amountCents = Math.round(parseFloat(raw) * 100);\n";
    await expect(moneyErrorLocationsIn(code, filePath)).resolves.toHaveLength(1);
  });

  it.each([
    ["a unary + coercion", "export const amountCents = Math.round(+raw * 100);"],
    ["a plain variable", "export const amountCents = Math.round(dollars * 100);"],
    ["the operands reversed", "export const amountCents = Math.round(100 * dollars);"],
    ["a nested unary +", "export const amountCents = Math.round((a + +b) * 100);"],
  ])("still reports %s into a `…Cents` binding exactly once", async (_label, code) => {
    await expect(
      moneyErrorLocationsIn(`${code}\n`, ORDINARY_SRC_FILE),
    ).resolves.toHaveLength(1);
  });

  it("names both canonical helpers in its message", async () => {
    const code = "export const c = Math.round(parseFloat('1') * 100);\n";
    const results = await eslint.lintText(code, { filePath: ORDINARY_SRC_FILE });
    const message = results
      .flatMap((result) => result.messages)
      .find((entry) => entry.message?.startsWith(MONEY_RULE_ID))?.message;

    expect(message).toBeDefined();
    expect(message).toContain("parseDecimalDollarsToCents");
    expect(message).toContain("@/lib/money-input");
    expect(message).toContain("providerAmountToCents");
    expect(message).toContain("@/lib/money-provider-amount");
    /*
      And the THIRD helper. An author holding a Xero report cell has text, so the
      first sentence sends them to the typed-money parser — which refuses the
      thousands separators and bracket negatives a report cell is full of, with
      nothing to say a report-cell parser exists (#2685 review).
    */
    expect(message).toContain("parseProviderReportAmountToCents");
  });

  it("points its escape hatch at a move that actually passes CI", async () => {
    const code = "export const c = Math.round(parseFloat('1') * 100);\n";
    const results = await eslint.lintText(code, { filePath: ORDINARY_SRC_FILE });
    const message = results
      .flatMap((result) => result.messages)
      .find((entry) => entry.message?.startsWith(MONEY_RULE_ID))?.message;

    // The named list is the one the integrity test above reads, so following
    // this instruction is legal. Naming a list the test hard-coded was not.
    expect(message).toContain("MONEY_GUARD_EXEMPTIONS");
    expect(message).toContain("eslint.config.mjs");
    expect(message).toContain("Never an eslint-disable comment");
  });
});

describe("money cents-conversion guard: negative fixtures", () => {
  /*
    Every one of these is a real shape from this tree that superficially looks
    like the banned composition. If any starts failing, the rule has widened onto
    legitimate arithmetic and the selector — not the code — is what to fix.
  */
  it.each([
    ["occupancy", "const pct = Math.round((beds / capacity) * 100);"],
    ["setup progress", "const pct = capacity > 0 ? Math.round((beds / capacity) * 100) : 0;"],
    ["a success rate", "const pct = Math.round((beds / Math.max(capacity, 1)) * 100);"],
    ["an API budget share", "const pct = Math.round(usagePercent * 100);"],
    ["a clamped share", "const pct = Math.min(100, usagePercent * 100);"],
    ["a formatted share", "const pct = (usagePercent * 100).toFixed(0);"],
    ["a calendar column width", "const w = (beds / 7) * 100;"],
    ["two-decimal rounding", "const r = Math.round(usagePercent * 100) / 100;"],
    ["three-decimal rounding", "const r = Math.round(usagePercent * 1000) / 1000;"],
    ["a packed date key", "const key = beds * 10_000 + capacity * 100 + beds;"],
    ["a ratio comparison", "const ok = beds * 100 <= capacity * 5;"],
    ["cents back to dollars", "const d = (beds / 100).toFixed(2);"],
    ["a percentage OF cents", "const c = Math.round((beds * capacity) / 100);"],
    ["a parse with no scaling", "const n = Math.round(Number.parseFloat(String(beds)));"],
    ["a parse divided by 100", "const n = Number.parseFloat(String(beds)) / 100;"],
  ])("does not flag %s", async (_label, body) => {
    const code = `export function f(beds: number, capacity: number, usagePercent: number) {\n  ${body}\n  return 1;\n}\n`;
    await expect(moneyErrorsIn(code, ORDINARY_SRC_FILE)).resolves.toBe(0);
  });

  it("does not flag the theme module's two-decimal roundings", async () => {
    const code = [
      "const round2 = (n: number) => Math.round(n * 100) / 100;",
      "const round3 = (n: number) => Math.round(n * 1000) / 1000;",
      "export const both = [round2, round3];",
      "",
    ].join("\n");
    await expect(moneyErrorsIn(code, THEME_FILE)).resolves.toBe(0);
  });

  it("does not reach the Xero ADMIN SCREENS, which render budget percentages", async () => {
    // The broad `x * 100` arm is scoped to money modules precisely so this stays
    // legal: it is a percentage, and it is spelled the same way.
    const code = "export function f(usagePercent: number) {\n  return Math.round(usagePercent * 100);\n}\n";
    await expect(moneyErrorsIn(code, XERO_ADMIN_SCREEN_FILE)).resolves.toBe(0);
  });

  /*
    A RATIO SCALED TO A PERCENTAGE STAYS LEGAL EVEN IN A MONEY MODULE.

    A division sitting directly inside the multiplication is a percentage by
    construction — nothing in this repository builds cents from a quotient — and
    the shape is real inside the very files the broad arm covers.
    `src/lib/xero-api-usage.ts` computes `usagePercent` as `calls / budget`, and
    the obvious fix for the dashboard that renders it as `${usagePercent}%` is a
    `* 100` at source; without this exclusion that fix would be lint-illegal, and
    a rule whose only answer is "suppress me" trains maintainers to suppress it
    (#2685 review).
  */
  it.each([
    ["a Xero module", XERO_MODULE_FILE],
    ["a finance module", FINANCE_MODULE_FILE],
    ["the admin payments service", ADMIN_PAYMENTS_FILE],
    ["an API route", API_ROUTE_FILE],
  ])("does not flag a ratio scaled to a percentage inside %s", async (_label, filePath) => {
    const code = [
      "export function f(calls: number, budget: number) {",
      "  const used = Math.round((calls / budget) * 100);",
      "  const share = (calls / Math.max(budget, 1)) * 100;",
      "  return used + share;",
      "}",
      "",
    ].join("\n");
    await expect(moneyErrorsIn(code, filePath)).resolves.toBe(0);
  });

  it("still flags a ratio scaled INTO a `…Cents` binding", async () => {
    // The exclusion above gives up exactly one thing, and this is the half of it
    // that matters: the `…Cents` convention says the result is money.
    const code = "export const amountCents = Math.round((total / nights) * 100);\n";
    await expect(moneyErrorsIn(code, XERO_MODULE_FILE)).resolves.toBeGreaterThan(0);
    await expect(moneyErrorsIn(code, ORDINARY_SRC_FILE)).resolves.toBeGreaterThan(0);
  });
});

describe("money cents-conversion guard: the approved helper modules", () => {
  it.each([
    ["the exact text parser", HELPER_TEXT_FILE],
    ["the provider boundary", HELPER_PROVIDER_FILE],
  ])("lifts the money rules inside %s", async (_label, filePath) => {
    const code = [
      "export function f(value: number, raw: string) {",
      "  const cents = Math.round(value * 100);",
      "  const parsed = Math.round(Number.parseFloat(raw) * 100);",
      "  return cents + parsed;",
      "}",
      "",
    ].join("\n");
    await expect(moneyErrorsIn(code, filePath)).resolves.toBe(0);
  });

  /*
    THE FLAT-CONFIG HAZARD, pinned.

    `no-restricted-syntax` does not merge across config blocks: a later block
    that sets its own restrictions REPLACES the earlier list wholesale. The
    money rules therefore have to be re-stated in every block that touches the
    rule, and the day somebody adds a block for an unrelated exemption is the
    day the money guard silently stops existing for those files — with lint
    still green. This test is what makes that fail instead.

    IT READS DECLARATIONS, so it is the weaker of the two halves and is kept for
    what it says plainly: which blocks name which guard. Whether the guard
    actually REACHES production code is settled by the roster audits below, which
    ask ESLint rather than reading glob text.
  */
  it("is re-stated by every block that sets no-restricted-syntax", async () => {
    const { blocks, exemptFiles } = await loadEslintConfig();

    const setters = blocks.filter(
      (block) => block?.rules && "no-restricted-syntax" in block.rules,
    );
    // Four pre-existing blocks, the two this issue added, and the tests block.
    expect(setters.length).toBeGreaterThanOrEqual(7);

    const withoutMoneyRule: string[] = [];
    const withoutRawSqlRule: string[] = [];
    const belowErrorSeverity: string[] = [];

    for (const block of setters) {
      const option = block.rules!["no-restricted-syntax"];
      const globs = block.files ?? ["<no files glob>"];
      const label = globs.join(", ");

      if (option === "off") {
        // Only a TEST-file block may switch the rule off outright — and EVERY
        // glob in it has to be one, not just the joined string. Asserting on
        // the join let a two-glob block pair an ordinary `src/lib` glob with a
        // `__tests__` one and pass, disarming the guard for all of `src/lib`
        // while reading as a test exemption (#2685 review).
        for (const glob of globs) {
          expect({ glob, isTestGlob: isTestOnlyGlob(glob) }).toEqual({
            glob,
            isTestGlob: true,
          });
        }
        continue;
      }

      const entries = (option as Array<string | { message?: string }>).slice(1);
      const messages = entries.map((entry) =>
        typeof entry === "string" ? entry : (entry.message ?? ""),
      );

      // The severity slot, which this test used to skip straight past. A block
      // spelled `["warn", ...]` states every restriction and enforces none:
      // `npm run lint` runs bare `eslint` with no `--max-warnings`, and the tree
      // already exits 0 carrying warnings (#2685 review).
      const severity = (option as Array<unknown>)[0];
      if (severity !== "error" && severity !== 2) {
        belowErrorSeverity.push(`${label} => ${String(severity)}`);
      }

      if (!messages.some((message) => message.startsWith(MONEY_RULE_ID))) {
        withoutMoneyRule.push(label);
      }
      if (!messages.some((message) => message.startsWith("INV-OPS-001"))) {
        withoutRawSqlRule.push(label);
      }
    }

    // Only a path on the declared exemption list may drop the money
    // restrictions, and even it keeps the raw-SQL ones.
    expect(
      withoutMoneyRule.filter(
        (label) => !label.split(", ").every((file) => exemptFiles.has(file)),
      ),
    ).toEqual([]);
    expect(withoutRawSqlRule).toEqual([]);
    expect(belowErrorSeverity).toEqual([]);
  });

  /*
    THE ESCAPE HATCH HAS TO OPEN.

    The rule's message, CONTRIBUTING.md and docs/invariants/money.md all tell an
    author hit by a false positive to add their file to the exemption list with a
    reason. Before this test the list was hard-coded HERE as well as in the
    config, so following that instruction failed CI — leaving a developer with no
    legal move at all, since `eslint-disable` is banned by the same rule (#2685
    review). The test now reads the config's own list, so adding an entry passes;
    what it still insists on is that the entry says WHY.
  */
  it("reads its exemption list from the config, and every entry states a reason", async () => {
    const { exemptions } = await loadEslintConfig();

    expect(exemptions.length).toBeGreaterThan(0);
    for (const entry of exemptions) {
      expect(typeof entry.file).toBe("string");
      expect(entry.file.trim().length).toBeGreaterThan(0);
      // A reason, not a placeholder: one real sentence about why this path is
      // allowed to build cents itself.
      expect(typeof entry.reason).toBe("string");
      expect(entry.reason.trim().length).toBeGreaterThanOrEqual(40);
    }

    // And the block that lifts the rule covers exactly that list — an entry with
    // a reason but no block, or a block with no entry, is the same silent hole.
    const { blocks } = await loadEslintConfig();
    const liftingBlocks = blocks.filter((block) => {
      const option = block?.rules?.["no-restricted-syntax"];
      if (!option || option === "off") return false;
      const entries = (option as Array<string | { message?: string }>).slice(1);
      return !entries.some(
        (entry) =>
          typeof entry !== "string" &&
          (entry.message ?? "").startsWith(MONEY_RULE_ID),
      );
    });
    expect(liftingBlocks.flatMap((block) => block.files ?? []).sort()).toEqual(
      exemptions.map((entry) => entry.file).sort(),
    );
  });

  it("carries no eslint-disable for this rule anywhere in the tree", async () => {
    // The escape hatch is the config's module list, with a stated reason — never
    // a disable comment (#2685). `npm run lint` reports an unused directive, so a
    // stale one cannot hide here either.
    const { execSync } = await import("child_process");
    const hits = execSync(
      'git grep -n --fixed-strings "eslint-disable" -- "src/**/*.ts" "src/**/*.tsx" "scripts/**/*.ts" || true',
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const moneyDisables = hits
      .split("\n")
      .filter((line) => line.includes("no-restricted-syntax"));
    expect(moneyDisables).toEqual([]);
  });
});

/*
  THE GUARD MUST REACH REAL PATHS — asked of ESLint, not of the glob text.

  The declaration test above, and its counterpart on the date lane, both used to
  decide "is this block production code?" with
  `files.some((f) => f.startsWith("src/"))`. That is a string test on a PATTERN.
  Three ordinary-looking edits walked through it while both suites stayed green,
  and all three were reproduced (#2685 review):

    1. A glob rooted on a double star rather than on `src/` — one naming the
       kiosk and lodge-display directories — paired with a shortened restriction
       list. Real screens lose the guard; neither glob begins with `src/`, so
       the block was skipped as irrelevant.
    2. A block with NO `files` key. Flat config applies it to every file, so it
       replaces the rule everywhere — and `files ?? []` made `.some()` false.
    3. `["warn", ...]` instead of `["error", ...]`. `option.slice(1)` never
       looked at `option[0]`, and a warn-level guard blocks nothing.

  The two audits below close all three at once, because neither one reads a glob:
  the first resolves the config ESLint would really use at a roster of production
  paths, the second lints an actual violation there. Both live in
  `./support/eslint-guard-coverage`, shared with the #2684 date-guard suite,
  which needs the identical treatment for the identical reason.
*/
describe("money cents-conversion guard: the paths it must reach", () => {
  /**
   * Which arm family each roster path must carry — declared HERE, as the test's
   * own statement of intent, and checked against what ESLint resolves. Reading
   * it out of the config's globs instead would just re-assert the config against
   * itself.
   */
  const MONEY_ARM_EXPECTATIONS: Readonly<
    Record<string, "standard" | "moneyModule" | "exempt">
  > = {
    "src/lib/x.ts": "standard",
    "src/lib/theme/x.ts": "standard",
    "src/components/x.tsx": "standard",
    "src/app/(admin)/admin/x/page.tsx": "standard",
    "src/app/(lodge)/lodge/kiosk/x.tsx": "standard",
    "src/app/(lodge)/lodge/lodge-display/x.tsx": "standard",
    "src/app/(finance)/finance/x/page.tsx": "standard",
    "src/app/(public)/x/page.tsx": "standard",
    "src/app/(admin)/admin/xero/_components/x.tsx": "standard",
    "scripts/x.ts": "standard",
    "prisma/seed-x.ts": "standard",
    "src/lib/date-only.ts": "standard",
    "src/lib/email-templates/chores.ts": "standard",
    "src/app/(admin)/admin/site-style/site-style-wizard.tsx": "standard",
    "src/components/admin/notice-editor.tsx": "standard",
    "src/app/(admin)/admin/promo-codes/promo-redemptions-panel.tsx": "standard",
    "src/lib/xero-x.ts": "moneyModule",
    "src/lib/xero.ts": "moneyModule",
    "src/lib/xero-inbound/x.ts": "moneyModule",
    "src/lib/finance-x.ts": "moneyModule",
    "src/lib/membership-cancellation-x.ts": "moneyModule",
    "src/lib/pricing.ts": "moneyModule",
    "src/lib/stripe.ts": "moneyModule",
    "src/lib/admin-payments-service.ts": "moneyModule",
    "src/app/api/admin/x/route.ts": "moneyModule",
    "src/lib/money-input.ts": "exempt",
    "src/lib/money-provider-amount.ts": "exempt",
  };

  it("has an arm expectation for every roster path, and no stale ones", () => {
    const roster = PRODUCTION_GUARD_ROSTER.map((entry) => entry.file);
    // A new roster path forces a decision about which arms it needs, rather
    // than defaulting into whichever family happens to be checked.
    expect(roster.filter((file) => !(file in MONEY_ARM_EXPECTATIONS))).toEqual(
      [],
    );
    expect(
      Object.keys(MONEY_ARM_EXPECTATIONS).filter(
        (file) => !roster.includes(file),
      ),
    ).toEqual([]);
  });

  it("keeps both arm families populated", async () => {
    const { arms } = await loadEslintConfig();
    /*
      A FLOOR UNDER THE BASELINE. The audit below compares the resolved config
      against these arrays, so emptying an array would empty the expectation with
      it. The floors are the arms as designed: ten standard (four parse × two
      operand orders, two unary `+`, two `…Cents`, two no-`* 100` spellings) and
      eight money-module (two broad, two ratio-of-a-parse, two ratio-into-cents,
      two no-`* 100`).
    */
    expect(arms.standard.length).toBeGreaterThanOrEqual(10);
    expect(arms.moneyModule.length).toBeGreaterThanOrEqual(8);
  });

  it("resolves to an armed `error` rule at every production path", async () => {
    const { arms, exemptFiles } = await loadEslintConfig();

    const problems = await auditResolvedGuardCoverage({
      eslint,
      repoRoot: REPO_ROOT,
      requiredSelectorsFor: (file) => {
        if (exemptFiles.has(file)) return [];
        return MONEY_ARM_EXPECTATIONS[file] === "moneyModule"
          ? arms.moneyModule
          : arms.standard;
      },
    });

    expect(problems).toEqual([]);
  });

  it("actually fires on a real violation at every production path", async () => {
    // The audit above compares selector STRINGS; this one compares outcomes, so
    // a selector that is still listed but no longer matches anything fails too.
    const { exemptFiles } = await loadEslintConfig();

    const problems = await auditEnforcedGuardCoverage({
      eslint,
      repoRoot: REPO_ROOT,
      violatingCode:
        "export function f(raw: string) {\n  return Math.round(parseFloat(raw) * 100);\n}\n",
      messagePrefix: MONEY_RULE_ID,
      isExempt: (file) => exemptFiles.has(file),
    });

    expect(problems).toEqual([]);
  });

  it("holds the declared exemptions to exactly the two helper modules", async () => {
    const { exemptFiles } = await loadEslintConfig();

    // Every exempt path is on the roster, so the audits above check it rather
    // than skipping it: an exemption must still resolve to an `error` rule
    // carrying the date and raw-SQL restrictions, and must report nothing for
    // the money one. A third entry appearing here is a deliberate act that has
    // to be argued for, not a config edit nobody notices.
    const roster = new Set(PRODUCTION_GUARD_ROSTER.map((entry) => entry.file));
    for (const file of exemptFiles) {
      expect({ file, onRoster: roster.has(file) }).toEqual({
        file,
        onRoster: true,
      });
    }

    const resolved = await resolveRestrictedSyntax(
      eslint,
      REPO_ROOT,
      "src/lib/money-input.ts",
    );
    expect(resolved.severity).toBe(2);
    expect(
      resolved.messages.some((message) => message.startsWith("INV-DATE-015")),
    ).toBe(true);
    expect(
      resolved.messages.some((message) => message.startsWith("INV-OPS-001")),
    ).toBe(true);
    expect(
      resolved.messages.some((message) => message.startsWith(MONEY_RULE_ID)),
    ).toBe(false);
  });
});
