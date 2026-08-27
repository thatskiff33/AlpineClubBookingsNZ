import path from "path";
import type { ESLint, Linter } from "eslint";

/**
 * #2685 — shared coverage audit for the `no-restricted-syntax` guards.
 *
 * WHY THIS EXISTS. Both guard integrity suites — the money one
 * (`money-cents-guard.test.ts`) and the date one (#2684) — used to decide
 * whether a config block "reached production code" by reading the block's GLOB
 * TEXT: `files.some((f) => f.startsWith("src/"))`. That is a string test on a
 * pattern, not a match against a path, and three ordinary edits walked straight
 * through it while the suites stayed green:
 *
 *   1. A glob that does not literally begin with `src/` — one rooted on a
 *      double star and naming the kiosk directory, say — paired with a
 *      shortened restriction list. It disarms the guard for real production
 *      screens, and `startsWith("src/")` is false, so the block was skipped as
 *      if it were irrelevant.
 *   2. A block with NO `files` key at all. Flat config applies such a block to
 *      every file, so it replaces the rule everywhere — and `files ?? []` made
 *      `.some()` false, so it too was skipped.
 *   3. A severity downgrade, `["warn", ...]` instead of `["error", ...]`. The
 *      suites read `option.slice(1)` and never looked at `option[0]`, and
 *      `npm run lint` runs bare `eslint` with no `--max-warnings`, so a
 *      warn-level guard blocks nothing at all.
 *
 * The fix is to stop asking "does this glob look like production?" and ask
 * ESLint instead. Everything here resolves the config the way ESLint itself
 * would, for a fixed roster of representative production paths, and reports what
 * the guard actually IS at each one. No glob spelling, block ordering, missing
 * `files` key or severity can change that answer without changing the result.
 *
 * Both audits return a list of plain-English problems rather than asserting, so
 * a suite can `expect(problems).toEqual([])` and read the whole set at once
 * instead of stopping at the first.
 */

/** One production path the guards must demonstrably reach. */
export type GuardRosterEntry = {
  /** Repo-relative POSIX path. Need not exist: config resolution is path-only. */
  readonly file: string;
  /** What this path stands for. Read by a human deciding whether it still does. */
  readonly why: string;
};

/**
 * REPRESENTATIVE PRODUCTION PATHS, one per surface the guards must cover.
 *
 * A path here does not have to exist — ESLint resolves a config from the path
 * string alone — so these are deliberately a mix of real files (`pricing.ts`,
 * `stripe.ts`, the three number-formatting screens) and stand-ins for a family
 * (`src/lib/x.ts`). What matters is that every distinct config surface has at
 * least one representative: if a block stops reaching one of these, some real
 * file lost its guard.
 *
 * Shared with the #2684 date-guard suite, which needs exactly the same roster
 * for exactly the same reason. Add a path here rather than in one suite.
 */
export const PRODUCTION_GUARD_ROSTER: readonly GuardRosterEntry[] = [
  // --- ordinary application code -------------------------------------------
  { file: "src/lib/x.ts", why: "an ordinary library module" },
  { file: "src/lib/theme/x.ts", why: "a nested library directory" },
  { file: "src/components/x.tsx", why: "a shared React component" },
  { file: "src/app/(admin)/admin/x/page.tsx", why: "an admin screen" },
  {
    file: "src/app/(lodge)/lodge/kiosk/x.tsx",
    why: "the lodge kiosk screens — the surface a `**/kiosk/**` glob would quietly carve out",
  },
  {
    file: "src/app/(lodge)/lodge/lodge-display/x.tsx",
    why: "the lobby display screens, same carve-out shape",
  },
  { file: "src/app/(finance)/finance/x/page.tsx", why: "a finance screen" },
  { file: "src/app/(public)/x/page.tsx", why: "a public screen" },
  {
    file: "src/app/(admin)/admin/xero/_components/x.tsx",
    why: "the Xero admin screens, deliberately NOT money modules: they render API-budget percentages",
  },
  // --- outside src/, where the money-adjacent backfills live -----------------
  { file: "scripts/x.ts", why: "an operator script / money backfill" },
  { file: "prisma/seed-x.ts", why: "a seed or migration helper" },
  // --- the narrowed blocks: an exemption from one guard must not lift another -
  { file: "src/lib/date-only.ts", why: "the date-only helper — exempt from the DATE rules only" },
  {
    file: "src/lib/email-templates/chores.ts",
    why: "the chore-roster subject line — exempt from the DATE rules only",
  },
  {
    file: "src/app/(admin)/admin/site-style/site-style-wizard.tsx",
    why: "number formatting — drops only toLocaleString",
  },
  {
    file: "src/components/admin/notice-editor.tsx",
    why: "number formatting — drops only toLocaleString",
  },
  {
    file: "src/app/(admin)/admin/promo-codes/promo-redemptions-panel.tsx",
    why: "number formatting — drops only toLocaleString",
  },
  // --- the money-domain modules --------------------------------------------
  { file: "src/lib/xero-x.ts", why: "a Xero domain module" },
  { file: "src/lib/xero.ts", why: "the Xero facade, which `xero-*` does not match" },
  { file: "src/lib/xero-inbound/x.ts", why: "a Xero subsystem split directory" },
  { file: "src/lib/finance-x.ts", why: "a finance module" },
  {
    file: "src/lib/membership-cancellation-x.ts",
    why: "a membership-cancellation module",
  },
  { file: "src/lib/pricing.ts", why: "the pricing module" },
  { file: "src/lib/stripe.ts", why: "the Stripe client" },
  {
    file: "src/lib/admin-payments-service.ts",
    why: "the module #2685 calls invisible to any rule keyed off parseFloat or Math.round",
  },
  { file: "src/app/api/admin/x/route.ts", why: "an API route" },
  // --- the declared money exemptions ---------------------------------------
  { file: "src/lib/money-input.ts", why: "EXEMPT: the canonical typed-money parser" },
  {
    file: "src/lib/money-provider-amount.ts",
    why: "EXEMPT: the reviewed provider rounding boundary",
  },
];

/** What `no-restricted-syntax` actually resolves to at one path. */
export type ResolvedRestrictedSyntax = {
  readonly file: string;
  /** ESLint normalises this to a number: 2 error, 1 warn, 0 off. */
  readonly severity: number | null;
  readonly selectors: readonly string[];
  readonly messages: readonly string[];
};

/** A single readable failure. Suites assert the whole list is empty. */
export type GuardCoverageProblem = {
  readonly file: string;
  readonly problem: string;
};

type RestrictedSyntaxEntry = string | { selector?: string; message?: string };

/**
 * Ask ESLint what the rule resolves to for `file`, exactly as a lint run would.
 *
 * `calculateConfigForFile` flattens every matching block in order, so the answer
 * already accounts for glob spelling, block ordering, a block with no `files`
 * key, and the fact that `no-restricted-syntax` REPLACES rather than merges.
 */
export async function resolveRestrictedSyntax(
  eslint: ESLint,
  repoRoot: string,
  file: string,
): Promise<ResolvedRestrictedSyntax> {
  const config = (await eslint.calculateConfigForFile(
    path.join(repoRoot, file),
  )) as Linter.Config | null;

  const option = config?.rules?.["no-restricted-syntax"];

  if (!Array.isArray(option)) {
    // Either unset, or set to a bare severity string with no options at all.
    const severity =
      option === "error" || option === 2
        ? 2
        : option === "warn" || option === 1
          ? 1
          : option === "off" || option === 0
            ? 0
            : null;
    return { file, severity, selectors: [], messages: [] };
  }

  const [severity, ...entries] = option as [
    Linter.RuleSeverity,
    ...RestrictedSyntaxEntry[],
  ];

  return {
    file,
    severity:
      typeof severity === "number"
        ? severity
        : severity === "error"
          ? 2
          : severity === "warn"
            ? 1
            : 0,
    selectors: entries.map((entry) =>
      typeof entry === "string" ? entry : (entry.selector ?? ""),
    ),
    messages: entries.map((entry) =>
      typeof entry === "string" ? "" : (entry.message ?? ""),
    ),
  };
}

/**
 * THE STRUCTURAL AUDIT: for every roster path, the rule must resolve to
 * `error` and must still carry every selector the caller says that path needs.
 *
 * `requiredSelectorsFor` is the caller's declaration of intent — "the money
 * modules must have the money-module arms", "an ordinary src file must have the
 * standard arms" — asserted against what ESLint really resolves. Returning `[]`
 * for a path declares it exempt from that guard, and the severity check still
 * applies, so an exemption cannot quietly switch the whole rule off.
 */
export async function auditResolvedGuardCoverage(options: {
  readonly eslint: ESLint;
  readonly repoRoot: string;
  readonly roster?: readonly GuardRosterEntry[];
  readonly requiredSelectorsFor: (file: string) => readonly string[];
}): Promise<GuardCoverageProblem[]> {
  const roster = options.roster ?? PRODUCTION_GUARD_ROSTER;
  const problems: GuardCoverageProblem[] = [];

  for (const entry of roster) {
    let resolved: ResolvedRestrictedSyntax;
    try {
      resolved = await resolveRestrictedSyntax(
        options.eslint,
        options.repoRoot,
        entry.file,
      );
    } catch (error) {
      problems.push({
        file: entry.file,
        problem: `config could not be resolved: ${String(error)}`,
      });
      continue;
    }

    if (resolved.severity !== 2) {
      // A `warn` blocks nothing: `npm run lint` runs bare `eslint`, with no
      // `--max-warnings`, and the tree already exits 0 carrying warnings.
      problems.push({
        file: entry.file,
        problem: `no-restricted-syntax resolves to severity ${String(
          resolved.severity,
        )}, not error (2)`,
      });
    }

    const present = new Set(resolved.selectors);
    for (const selector of options.requiredSelectorsFor(entry.file)) {
      if (!present.has(selector)) {
        problems.push({
          file: entry.file,
          problem: `missing required selector: ${selector}`,
        });
      }
    }
  }

  return problems;
}

/**
 * THE BEHAVIOURAL AUDIT: lint a known-violating snippet at every roster path and
 * check the guard actually fires, at error severity.
 *
 * The structural audit above compares selector STRINGS; this one compares
 * outcomes, so it also catches a selector that is present but no longer matches
 * anything. Together they are what make a green run mean something: a config
 * edit that disarms the guard has to survive both.
 */
export async function auditEnforcedGuardCoverage(options: {
  readonly eslint: ESLint;
  readonly repoRoot: string;
  readonly roster?: readonly GuardRosterEntry[];
  /** Source that MUST trip the guard wherever the guard applies. */
  readonly violatingCode: string;
  /** Messages are attributed to a guard by their invariant id prefix. */
  readonly messagePrefix: string;
  /** Paths the guard is deliberately lifted from, which must report nothing. */
  readonly isExempt?: (file: string) => boolean;
}): Promise<GuardCoverageProblem[]> {
  const roster = options.roster ?? PRODUCTION_GUARD_ROSTER;
  const problems: GuardCoverageProblem[] = [];

  for (const entry of roster) {
    const results = await options.eslint.lintText(options.violatingCode, {
      filePath: path.join(options.repoRoot, entry.file),
    });
    const messages = results.flatMap((result) => result.messages);

    const fatal = messages.filter((message) => message.fatal);
    if (fatal.length > 0) {
      problems.push({
        file: entry.file,
        problem: `fixture failed to parse: ${fatal[0]?.message ?? "unknown"}`,
      });
      continue;
    }

    const hits = messages.filter(
      (message) =>
        message.ruleId === "no-restricted-syntax" &&
        typeof message.message === "string" &&
        message.message.startsWith(options.messagePrefix),
    );
    const exempt = options.isExempt?.(entry.file) ?? false;

    if (exempt && hits.length > 0) {
      problems.push({
        file: entry.file,
        problem: `guard fires on a path declared exempt (${hits.length} report(s))`,
      });
      continue;
    }
    if (!exempt && hits.length === 0) {
      problems.push({
        file: entry.file,
        problem: "guard does not fire on a known violation",
      });
      continue;
    }
    if (!exempt && hits.some((message) => message.severity !== 2)) {
      problems.push({
        file: entry.file,
        problem: "guard fires below error severity",
      });
    }
  }

  return problems;
}
