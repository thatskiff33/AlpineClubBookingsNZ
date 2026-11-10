import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Recursively collect the app/component/lib source files (TS/TSX only). The
// `.css` sheet and the `__tests__` fixtures are excluded: the shims that map
// categorical hues in dark mode legitimately name the Tailwind teal utilities,
// and tests reference the literals they guard.
function listSourceFiles(path: string): string[] {
  // A root that has been renamed or moved would otherwise ENOENT-crash the whole
  // suite with an opaque stack; fail with the actual root name instead.
  const root = join(process.cwd(), path);
  if (!existsSync(root)) {
    throw new Error(
      `brand-color-source-contract: source root "${path}" does not exist. ` +
        `If the tree was renamed, update the contract's source roots.`,
    );
  }
  return readdirSync(root).flatMap((entry) => {
    const child = join(path, entry);
    const normalized = child.replaceAll("\\", "/");
    if (statSync(join(process.cwd(), child)).isDirectory()) {
      return normalized.includes("/__tests__") ? [] : listSourceFiles(child);
    }
    return /\.tsx?$/.test(entry) ? [child] : [];
  });
}

// #2189 P3 — the temporary kiosk-family exclusion (B8) is GONE. In P2 the kiosk
// tree plus its two shared surfaces (the roster-setup page and
// kiosk-lodge-instructions) were still authored in literal slate/colour utilities
// and coupled to the old #1249 light-mode override, so both repo-wide contracts
// carried a kiosk-family exclusion. P3 authored the whole kiosk family on the
// fixed-seed `--kiosk-*` tokens and deleted that override, so the five source
// contracts now run TRULY repo-wide with no kiosk carve-out.

/** Every TS/TSX source file under `src`, minus `__tests__`. */
function listRepoSourceFiles(): string[] {
  return listSourceFiles("src");
}

// #2190 P4 — the categorical-teal allowlist is now EMPTY, and #2218 retired the
// legacy `--hue-*` accent system entirely. `admin-booking-calendar.tsx` painted
// WAITLIST_OFFERED as a raw Tailwind teal swatch; it now uses the categorical
// `bg-cat6-9` step token (the generated teal 6th scale), so no source file names
// a raw Tailwind `teal-*` utility and no chip depends on `--hue-teal`. Everything
// reaches the brand accent through semantic tokens (`--primary`, etc.) and every
// categorical status hue through the cat1..cat6 scales.
const CATEGORICAL_TEAL_ALLOWLIST = new Set<string>(
  ([] as string[]).map((path) => path.replaceAll("\\", "/")),
);

describe("brand accent source contract", () => {
  it("keeps the brand accent on semantic tokens, never hardcoded teal", () => {
    const brandTeal = /\b(?:bg|text|border)-teal-\d/;
    const offenders = listSourceFiles("src").filter((path) => {
      const normalized = path.replaceAll("\\", "/");
      if (CATEGORICAL_TEAL_ALLOWLIST.has(normalized)) {
        return false;
      }
      return brandTeal.test(readFileSync(join(process.cwd(), path), "utf8"));
    });

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `Hardcoded Tailwind teal-* utilities are the brand accent and must ` +
            `not be baked into source. Use semantic tokens (--primary, ` +
            `bg-primary/text-primary-foreground, border-primary/30, ...) so the ` +
            `admin-configured site colours apply, or the cat1..cat6 scales for a ` +
            `categorical status hue. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// #2188 P2 (R5) — the NEW repo-wide colored-family source contract. The 16
// colour families (the 17 the scanner tracks minus `teal`, which M9 routes to
// the brand accent and which the brand-accent contract above already gates) must
// not appear as raw Tailwind utilities anywhere in source: every colored surface
// now reaches its hue through the signed-off scale vocabulary — the semantic
// `bg/text/border-<success|warning|info|danger>-<step>` scales, the categorical
// `cat1..cat6` scales, or CHIP_TONE_CLASSES. Repo-wide, incl. the kiosk family (P3).
const COLORED_FAMILIES_16 = [
  "red", "orange", "amber", "yellow", "lime", "green", "emerald",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink",
  "rose",
];

describe("colored-family source contract (R5, 16 families, repo-wide)", () => {
  it("keeps every colored surface on the scale vocabulary, never raw colour utilities", () => {
    const coloredRe = new RegExp(
      `\\b(?:bg|text|border|ring|ring-offset|divide|outline|fill|stroke|from|via|to|accent|caret|decoration|placeholder)-(?:${COLORED_FAMILIES_16.join(
        "|",
      )})-(?:50|100|200|300|400|500|600|700|800|900|950)\\b`,
    );
    const offenders = listRepoSourceFiles().filter((path) =>
      coloredRe.test(readFileSync(join(process.cwd(), path), "utf8")),
    );
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `Raw Tailwind colour-family utilities must not be baked into source. ` +
            `Use the semantic step scales (bg-danger-3/text-danger-11/…), the ` +
            `categorical scales (bg-cat1-3/…), or CHIP_TONE_CLASSES so the ` +
            `surface follows the club theme. ` +
            `Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// #2188 P2 (lens1 F1) — on-solid AA contract. A saturated step-9 fill carries
// NO guaranteed on-solid foreground (only the role tokens' A4-recomputed
// `*-foreground` pair clears AA on the solid, per the G4 sweep). So a
// text-bearing badge must use the ROLE token pair (`bg-warning
// text-warning-foreground`), never `bg-<scale>-9` with a text utility. Step-9
// stays only for DECORATIVE, text-free fills (e.g. booking strips). This flags
// any class string combining `bg-(success|warning|info|danger|cat1..6)-9` with a
// `text-` utility. A genuinely-decorative exception (text incidental, not on the
// fill) needs an explicit DECORATIVE_SOLID_FILL_ALLOWLIST entry with a reason.
const DECORATIVE_SOLID_FILL_ALLOWLIST = new Set<string>(
  ([] as string[]).map((p) => p.replaceAll("\\", "/")),
);
// Matches `bg-<scale>-9` and a `text-*` utility within the SAME class string
// (only class-token characters between them — a quote/newline ends the string),
// in either order. `/opacity` and variant prefixes are tolerated.
const CLS = "[\\w:/\\[\\]().,#%-]";
const ON_SOLID_TEXT_PAIR = new RegExp(
  `bg-(?:success|warning|info|danger|cat[1-6])-9(?:/\\d{1,3})?(?:\\s+${CLS}+)*\\s+text-${CLS}+` +
    `|text-${CLS}+(?:\\s+${CLS}+)*\\s+bg-(?:success|warning|info|danger|cat[1-6])-9(?:/\\d{1,3})?`,
);

describe("on-solid AA source contract (F1, repo-wide)", () => {
  it("catches a text utility paired with a step-9 solid fill (mutation guard)", () => {
    expect('className="bg-warning-9 text-white"').toMatch(ON_SOLID_TEXT_PAIR);
    expect('className="text-white bg-danger-9"').toMatch(ON_SOLID_TEXT_PAIR);
    // The correct role-token pair and a decorative text-free fill do NOT match.
    expect('className="bg-warning text-warning-foreground"').not.toMatch(
      ON_SOLID_TEXT_PAIR,
    );
    expect('className="absolute inset-y-0 w-1 bg-cat1-9"').not.toMatch(
      ON_SOLID_TEXT_PAIR,
    );
  });

  it("keeps every text-bearing solid badge on the role-token AA pair", () => {
    const offenders = listRepoSourceFiles()
      .filter((path) => !DECORATIVE_SOLID_FILL_ALLOWLIST.has(path.replaceAll("\\", "/")))
      .filter((path) =>
        ON_SOLID_TEXT_PAIR.test(readFileSync(join(process.cwd(), path), "utf8")),
      );
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `A step-9 solid fill paired with a text utility is not AA-guaranteed. ` +
            `Use the role-token pair (bg-warning text-warning-foreground, ` +
            `bg-success text-success-foreground, …). Step-9 is for decorative, ` +
            `text-free fills only. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// The /finance and admin surfaces render inside `app-theme-scope` (see
// `src/app/(finance)/finance/layout.tsx` and the admin layout), which applies
// the club theme.
//
// WHY this matters — precisely. `globals.css` already carries a
// `.dark .app-theme-scope` neutral remap (the #1263 follow-up block) that
// rewrites raw `bg-white`, `bg-{neutral}-50/100/200`, `text-{neutral}-300..950`,
// and `border-{neutral}-100..300` onto `--card` / `--muted` / `--border` /
// `--foreground` / `--muted-foreground`. So dark mode was NOT broken before
// #2137 — that shim covered it. But the shim is `.dark`-ONLY: in LIGHT mode a
// raw neutral stays literally slate/white and does not follow a strongly
// non-default club theme. Using the semantic tokens directly fixes that gap and
// means the surface is correct at source rather than correct-by-shim.
//
// #2137 migrated the finance tree; #2144 swept the ~1,400 raw-neutral
// occurrences out of the admin tree onto the same tokens, so both trees are
// now gated. (Raw hex still exists in finance for the chart NEUTRALS —
// `ratio-explorer.tsx`, `trend-chart.tsx` — the deliberate #1801
// SVG-presentation-attribute carve-out, out of scope for this check.
// `FINANCE_MIX_COLORS` is no longer a literal palette: #2190 P4 derives its
// eight slots from the categorical cat scales, pinned by
// `finance-chart-theme.test.ts`.)
//
// #2188 P2 — the neutral contract is now REPO-WIDE (incl. the kiosk family after P3) via
// `listRepoSourceFiles()`, after P2 migrated every member-facing tree onto the
// shadcn role tokens and deleted the `.dark .app-theme-scope` neutral remap. The
// admin/finance roots that used to be listed here are subsumed by the repo-wide
// scan; the deliberate exceptions live in THEMED_NEUTRAL_ALLOWLIST above.

// Admin-only leaves kept as an explicit existence guard so a rename surfaces as a
// clear failure rather than silently dropping coverage.
const THEMED_TOKEN_ONLY_FILES = [
  "src/components/admin-booking-calendar.tsx",
  "src/components/admin-hub-page.tsx",
  "src/components/admin-permission-matrix-table.tsx",
  "src/lib/admin-family-group-ui-helpers.ts",
];

// Per-FILE exceptions, each with a stated reason. NOTE the granularity: an
// entry exempts the whole file, so it forfeits gate coverage on that file's
// OTHER occurrences too — keep entries to files whose raw neutrals are
// wholly deliberate, and prefer fixing a stray over adding an entry.
const THEMED_NEUTRAL_ALLOWLIST = new Set<string>(
  [
    // Fixed code-preview panes, deliberately theme-isolated; the literal
    // slate strings are REQUIRED by `app-theme-layout-contract.test.ts`
    // ("keeps Site Style app chrome semantic while fixed code previews stay
    // isolated").
    "src/app/(admin)/admin/website/site-style/site-style-wizard.tsx",
    // Print pages: self-consistent hard-light paper surfaces. `bg-white`,
    // `border-gray-400` rules and grey ink are correct for paper output and
    // must not follow the club theme.
    "src/app/(admin)/admin/roster/[date]/print/page.tsx",
    "src/app/(admin)/admin/induction/[id]/print/page.tsx",
    // Reports: the six `print:border-slate-300` PRINT-ONLY variants (the
    // file's screen classes are fully tokenised). Print output is paper, not
    // theme.
    "src/app/(admin)/admin/finance/reports/page.tsx",
    // Signage: `bg-black` letterboxes simulating a display screen.
    "src/app/(admin)/admin/display/builder/display-builder.tsx",
    "src/app/(admin)/admin/display/preview/page.tsx",
    // #2190 P4 — three former entries were the last "deferred work wearing an
    // allowlist badge" and are now GONE: xero-record-activity-panel.tsx (solid
    // slate PENDING chip + selected record pill) moved onto
    // bg-foreground/text-background; member-import-dialog.tsx (active-step chip)
    // moved onto border-foreground; admin-booking-calendar.tsx (DRAFT + fallback
    // swatches, and the WAITLIST_OFFERED teal swatch) moved onto bg-muted and the
    // categorical bg-cat2-9 step. All three now pass this contract directly.
    //
    // NOTE: the roster-setup page and kiosk-lodge-instructions are NOT here —
    // #2189 P3 authored them (and the whole kiosk tree) on the fixed-seed
    // `--kiosk-*` tokens, so they pass this repo-wide contract directly. They
    // never needed an allowlist entry; the allowlist must never carry deferred
    // work.
    //
    // #2188 P2 additions (repo-wide widening).
    // Un-themed system pages: React error/404 boundaries render OUTSIDE
    // app-theme-scope, so there is no club theme to follow — raw neutrals are
    // correct there.
    "src/app/error.tsx",
    "src/app/not-found.tsx",
    // Radix overlay scrims / decorative black overlays (`bg-black/80`,
    // `bg-black/10`): opacity scrims over the page, not theme surfaces.
    "src/components/ui/dialog.tsx",
    "src/components/ui/sheet.tsx",
    "src/components/site-banners.tsx",
  ].map((path) => path.replaceAll("\\", "/")),
);

describe("themed-surface neutral contract (repo-wide, #2188 P2)", () => {
  it("keeps every themed surface on theme tokens, never raw neutrals or bg-white", () => {
    // The repo's own dark shim treats slate/gray/zinc/neutral/stone as ONE
    // family, so this matches the whole family rather than slate alone. Note
    // `text-white` is NOT matched: it is a legitimate paired foreground on a
    // coloured fill (e.g. `bg-brand-charcoal text-white`) and the shim does not
    // remap it either.
    const rawNeutral =
      /\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone)-\d|\b(?:bg|text)-black\b|\bbg-white\b/;
    for (const file of THEMED_TOKEN_ONLY_FILES) {
      if (!existsSync(join(process.cwd(), file))) {
        throw new Error(
          `brand-color-source-contract: gated file "${file}" does not exist. ` +
            `If it was renamed or moved, update THEMED_TOKEN_ONLY_FILES.`,
        );
      }
    }
    // #2188 P2 — widened from the admin/finance roots to the WHOLE repo (kiosk
    // incl. the kiosk family after P3) so raw neutrals cannot re-enter any themed surface. The
    // per-file allowlist above carries the deliberate exceptions.
    const offenders = listRepoSourceFiles().filter((path) => {
      const normalized = path.replaceAll("\\", "/");
      if (THEMED_NEUTRAL_ALLOWLIST.has(normalized)) {
        return false;
      }
      return rawNeutral.test(readFileSync(join(process.cwd(), path), "utf8"));
    });

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `The admin and /finance surfaces render inside app-theme-scope, so ` +
            `raw neutral/bg-white utilities do not follow the club theme in ` +
            `LIGHT mode (the .dark .app-theme-scope shim in globals.css only ` +
            `covers dark). Use the semantic tokens instead: ` +
            `bg-card/text-card-foreground for card surfaces, ` +
            `bg-popover/text-popover-foreground for floating panels, ` +
            `text-muted-foreground for secondary labels, bg-muted for tinted ` +
            `rows and recessed insets, border-border for rules. A wholly ` +
            `deliberate exception needs a per-file THEMED_NEUTRAL_ALLOWLIST ` +
            `entry with a stated reason. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
