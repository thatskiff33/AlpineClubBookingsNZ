import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/lib/club-theme-schema";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const migratedAdminChrome = [
  "src/app/(admin)/admin/age-tier-settings/page.tsx",
  "src/app/(admin)/admin/lockers/page.tsx",
  "src/app/(admin)/admin/committee/page.tsx",
  "src/app/(admin)/admin/hut-leaders/page.tsx",
  "src/app/(admin)/admin/hut-leaders/_components/assignment-form.tsx",
  "src/app/(admin)/admin/work-parties/page.tsx",
  "src/app/(admin)/admin/family-suggestions/page.tsx",
  "src/app/(admin)/admin/stuck-states/page.tsx",
  "src/app/(admin)/admin/waitlist/page.tsx",
];

describe("#1819 final accessibility presentation contract", () => {
  it.each(migratedAdminChrome)(
    "keeps the surrounding #1809 chrome token-driven in %s",
    (path) => {
      expect(source(path), path).not.toMatch(
        /(?:bg|text|border|ring|divide|hover:bg|hover:text)-(?:slate|gray|white|red|amber|orange|green|blue|yellow|emerald|indigo|purple|violet|rose)(?:-|\b)|(?:bg|text|border)-white\b/,
      );
    },
  );

  it("keeps the five named wide surfaces usable at mobile width", () => {
    const adminLayout = source("src/app/(admin)/layout.tsx");
    const bookings = source("src/app/(admin)/admin/bookings/page.tsx");
    const table = source("src/components/admin/admin-data-table.tsx");
    const review = source(
      "src/app/(authenticated)/book/_components/review-step.tsx",
    );
    const family = source(
      "src/app/(authenticated)/profile/family-group-section.tsx",
    );
    const memberHeader = source(
      "src/app/(admin)/admin/members/[id]/_components/member-detail-header.tsx",
    );
    const memberContact = source(
      "src/app/(admin)/admin/members/[id]/_components/member-contact-group.tsx",
    );
    // Fifth wide surface, and the only one on the PUBLIC site: the {{hut-fees}}
    // rate table (#2129). It scrolls horizontally rather than shrinking, so the
    // scroll container must stay keyboard-reachable and named — a bare
    // `overflow-x-auto` div trips axe `scrollable-region-focusable` and strands
    // keyboard-only visitors on any column clipped off-screen (WCAG 2.1.1).
    const hutFees = source(
      "src/components/website/public-page-content-token.tsx",
    );

    expect(adminLayout).toContain(
      'className="flex flex-1 flex-col md:flex-row"',
    );
    expect(adminLayout).toContain(
      'className="flex min-w-0 flex-1 flex-col md:overflow-hidden"',
    );
    expect(bookings).toContain('className="min-w-[56rem]"');
    expect(table).toContain('"relative w-full overflow-auto"');
    expect(review).toContain(
      'className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2"',
    );
    expect(review).toContain(
      'className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between"',
    );
    expect(review).toContain(
      'className="flex flex-col gap-3 sm:flex-row"',
    );
    expect(review.match(/className="w-full sm:w-auto"/g)).toHaveLength(2);
    expect(family).not.toMatch(/className="grid grid-cols-2 gap-3"/);
    expect(family).not.toContain('className="flex gap-2"');
    expect(family).toContain("sm:grid-cols-2");
    expect(memberHeader).toContain(
      'className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"',
    );
    expect(memberHeader).toContain("break-all");
    expect(memberContact).not.toMatch(/className="grid grid-cols-2 gap-4"/);
    expect(hutFees).toContain('className="mt-2 max-w-full overflow-x-auto"');
    expect(hutFees).toContain('role="region"');
    expect(hutFees).toContain("tabIndex={0}");
    expect(hutFees).toContain("aria-labelledby={headingId}");
    // The table keeps its natural width inside that scroller rather than
    // compressing rate columns into unreadable slivers.
    expect(hutFees).toContain("w-full min-w-max border-collapse");
    // An absent rate is spoken, not left as a silent em dash ("blank").
    expect(hutFees).toContain('<span className="sr-only">No rate</span>');
  });

  it("exposes payment selection without relying on colour or weakened opacity", () => {
    const review = source(
      "src/app/(authenticated)/book/_components/review-step.tsx",
    );

    expect(review).toContain('aria-pressed={paymentMethod === "stripe"}');
    expect(review).toContain(
      'aria-pressed={paymentMethod === "internet_banking"}',
    );
    expect(review.match(/>\s*Selected\s*<\/span>/g)).toHaveLength(2);
    expect(review.match(/<CheckCircle2 aria-hidden/g)).toHaveLength(2);
    expect(review).not.toContain("opacity-80");
  });

  it("pins non-colour calendar and bed-allocation cues", () => {
    const bookingCalendar = source("src/components/booking-calendar.tsx");
    const occupancyCalendar = source(
      "src/components/admin/occupancy-calendar.tsx",
    );
    const bedSources = [
      "src/app/(admin)/admin/bed-allocation/_components/board-cell.tsx",
      "src/app/(admin)/admin/bed-allocation/_components/guest-chip.tsx",
      "src/app/(admin)/admin/bed-allocation/_components/bucket-board.tsx",
    ].map(source);

    expect(bookingCalendar).toContain("seasonSuffix");
    expect(bookingCalendar).toContain('{season.type === "WINTER" ? "W" : "S"}');
    expect(bookingCalendar).toContain('{isCheckIn ? "In" : isCheckOut ? "Out" : "Stay"}');
    expect(bookingCalendar).toContain("!border-double");
    expect(bookingCalendar).toContain("!border-dashed");
    expect(occupancyCalendar).toContain(
      'overlay ? `, ${overlay.label}` : ""',
    );
    expect(occupancyCalendar).toContain('selectedSingleDate');
    expect(occupancyCalendar).toContain('border-4 border-double');
    expect(occupancyCalendar).toContain('border-2 border-dashed');
    expect(occupancyCalendar).toContain('{selectionLabel}');
    expect(occupancyCalendar).not.toMatch(/hover:bg-(?:danger|warning|info|success)-muted\//);
    for (const bedSource of bedSources) {
      expect(bedSource).toContain("Focused");
      expect(bedSource).toContain("border-dashed");
      expect(bedSource).toContain("<Focus");
    }
  });

  it("keeps every semantic boundary above WCAG AA in light and dark", () => {
    const pairs: Array<[string, string, string]> = [
      ["light success text/muted", "#166534", "#dcfce7"],
      ["light warning text/muted", "#854d0e", "#fef9c3"],
      ["light info text/muted", "#1e40af", "#dbeafe"],
      ["light danger text/muted", "#991b1b", "#fee2e2"],
      ["dark success text/muted", "oklch(0.84 0.11 150)", "oklch(0.33 0.05 150)"],
      ["dark warning text/muted", "oklch(0.84 0.11 75)", "oklch(0.33 0.05 75)"],
      ["dark info text/muted", "oklch(0.84 0.11 250)", "oklch(0.33 0.05 250)"],
      ["dark danger text/muted", "oklch(0.84 0.11 27)", "oklch(0.33 0.05 27)"],
      ["light foreground/success muted", "oklch(0.145 0 0)", "#dcfce7"],
      ["light foreground/warning muted", "oklch(0.145 0 0)", "#fef9c3"],
      ["light foreground/info muted", "oklch(0.145 0 0)", "#dbeafe"],
      ["light foreground/danger muted", "oklch(0.145 0 0)", "#fee2e2"],
      ["dark foreground/success muted", "oklch(0.985 0 0)", "oklch(0.33 0.05 150)"],
      ["dark foreground/warning muted", "oklch(0.985 0 0)", "oklch(0.33 0.05 75)"],
      ["dark foreground/info muted", "oklch(0.985 0 0)", "oklch(0.33 0.05 250)"],
      ["dark foreground/danger muted", "oklch(0.985 0 0)", "oklch(0.33 0.05 27)"],
      ["light danger foreground/solid", "#ffffff", "#991b1b"],
      ["dark danger foreground/solid", "oklch(0.2 0 0)", "oklch(0.84 0.11 27)"],
    ];

    for (const [label, foreground, background] of pairs) {
      expect(contrastRatio(foreground, background), label).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("keeps focus and reduced-motion guards global to every touched app surface", () => {
    const globals = source("src/app/globals.css");

    expect(globals).toContain("@media (prefers-reduced-motion: reduce)");
    expect(globals).toContain("animation-duration: 0.01ms !important");
    expect(globals).toContain("transition-duration: 0.01ms !important");
    expect(globals).toContain(":focus-visible:not(.website-theme *)");
    expect(globals).toContain("outline: 2px solid var(--ring) !important");
    expect(globals).toContain("outline-offset: 2px !important");
  });

  it("keeps payment and Xero statuses as semantic icon-plus-label chips", () => {
    // The tone -> class map is now the single shared source of truth (#156).
    // Assert the full semantic set lives there so dropping any pair — or
    // regressing one off its muted-bg + text token pairing — fails the contract.
    // #2188 P2 — the semantic tones render on the generated step scales via the
    // signed-off `bg-<scale>-3 text-<scale>-11` chip pattern (G2b-AA); neutral
    // keeps the shadcn role tokens. The contract still pins the full set so
    // dropping a pair — or regressing one off its step-3/step-11 pairing — fails.
    const chipTones = source("src/lib/chip-tones.ts");
    expect(chipTones).toContain('neutral: "bg-muted text-foreground"');
    expect(chipTones).toContain('info: "bg-info-3 text-info-11"');
    expect(chipTones).toContain('success: "bg-success-3 text-success-11"');
    expect(chipTones).toContain('warning: "bg-warning-3 text-warning-11"');
    expect(chipTones).toContain('danger: "bg-danger-3 text-danger-11"');

    // The icon + label chip primitives draw their tone from that shared map and
    // render an icon plus a text label — never colour alone. MiniChip backs the
    // payments table's inline signals; ToneChip backs every non-domain Xero
    // status. Both must keep the icon-plus-label shape and the shared tone map.
    const miniChip = source("src/components/ui/mini-chip.tsx");
    const xero = source("src/app/(admin)/admin/xero/_components/shared.tsx");
    for (const text of [miniChip, xero]) {
      expect(text).toContain("inline-flex items-center gap-1");
      expect(text).toContain("<Icon");
      expect(text).toContain("{children}");
      expect(text).toContain("CHIP_TONE_CLASSES[tone]");
    }

    // The payment and Xero surfaces still USE those chips, so an endpoint status
    // keeps its icon-plus-label chip rather than reverting to a colour-only badge.
    const payments = source("src/app/(admin)/admin/payments/page.tsx");
    expect(payments).toContain("<MiniChip");
    expect(payments).toContain('kind="payment"');
    expect(xero).toContain("<ToneChip");
  });

  it("routes actual touched destructive controls through the AA danger pair", () => {
    const button = source("src/components/ui/button.tsx");
    const badge = source("src/components/ui/badge.tsx");
    const destructiveSurfaces = [
      "src/app/(admin)/admin/waitlist/page.tsx",
      "src/app/(admin)/admin/members/[id]/_components/member-detail-header.tsx",
      "src/app/(admin)/admin/members/[id]/_components/member-dependents-card.tsx",
      "src/app/(admin)/admin/members/[id]/_components/member-parent-links-card.tsx",
      "src/app/(admin)/admin/members/[id]/_components/member-delete-request-dialog.tsx",
      "src/app/(admin)/admin/members/[id]/_components/member-deletion-card.tsx",
      "src/app/(admin)/admin/members/[id]/_components/member-lifecycle-card.tsx",
      "src/app/(admin)/admin/members/[id]/_components/member-delete-review-dialog.tsx",
    ].map(source).join("\n");

    for (const primitive of [button, badge]) {
      expect(primitive).toContain("bg-danger text-danger-foreground");
      expect(primitive).not.toMatch(/bg-destructive|text-destructive-foreground/);
    }
    expect(badge).not.toMatch(
      /hover:bg-(?:success|warning|info|danger)-muted\//,
    );
    expect(destructiveSurfaces).toContain('variant="destructive"');
    expect(destructiveSurfaces).toMatch(/Delete|Archive|Inactive|Overbook/);
    expect(destructiveSurfaces).not.toMatch(/bg-destructive|text-destructive/);
    expect(source("src/app/(admin)/admin/waitlist/page.tsx")).toContain(
      "<AlertTriangle aria-hidden",
    );
  });

  it("keeps the admin family tree reachable when its nesting outgrows the card", () => {
    // #2253 — the family tree draws nesting with indentation (7 levels x 1.5rem)
    // inside the member page's `overflow-hidden` Family accordion item, so at
    // phone width the far side of a deep family is clipped with no scrollbar
    // and no way to reach it. Same remedy as the hut-fees rate table above: a
    // focusable, NAMED scroll region, not a bare `overflow-x-auto` div (axe
    // `scrollable-region-focusable`, WCAG 2.1.1).
    const tree = source(
      "src/app/(admin)/admin/members/[id]/_components/member-family-tree-card.tsx",
    );

    expect(tree).toContain('className="max-w-full overflow-x-auto"');
    expect(tree).toContain('role="region"');
    expect(tree).toContain("tabIndex={0}");
    expect(tree).toContain("aria-labelledby={headingId}");
    // ...and node content shrinks and wraps inside it rather than forcing the
    // scroll on every ordinary family.
    expect(tree).toContain("min-w-0");
    expect(tree).toContain("break-words");
  });

  it("keeps partner search results contained on narrow member cards", () => {
    const partner = source(
      "src/app/(admin)/admin/members/[id]/_components/member-partner-link-card.tsx",
    );

    expect(partner).toContain(
      "flex flex-col gap-2 rounded border bg-card p-2 text-card-foreground sm:flex-row",
    );
    expect(partner).toContain('className="min-w-0"');
    expect(partner).toContain("break-all text-xs text-muted-foreground");
    expect(partner).toContain('className="w-full sm:w-auto"');
  });
});
