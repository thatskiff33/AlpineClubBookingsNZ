// Every staged section wires its focus return (#4087, `INV-SSOT-001`).
//
// `useSectionEditState` returns focus after Save or Cancel by itself, but the
// Edit it returns to is unmounted while the editor is open, so the one rendered
// in its place is found by the per-instance marker in `editTriggerProps`; the
// section to fall back to is marked, and made a named region, by
// `sectionRegionProps`; and that name comes from the title carrying
// `titleProps` (or from `regionLabel`, for a card with no visible title). A
// section that forgets any of them still works — focus falls back to the
// nearest landmark, or lands on an unnamed region — so nothing else would
// notice. This census does. A list whose per-row editor is its own component
// owns the return through `useEditorFocusReturn` instead, and is held to the
// same wiring.
//
// The way IN is the hook's too (#4115): `startEditing` (and a list editor's
// `capture`) moves focus to the first control the edit opened, or to the
// section. So an adopter never reveals its own editor — no attention reveal,
// no direct `.focus()`, `autoFocus` or `focusAndKeepInView` (a pinned,
// counted exclusion names any `.focus()` that is a FAILURE position instead) —
// and the `revealTarget` escape hatch, kept for the two sections whose card
// reveal predates the shared one, is pinned to those two, however it is
// spelled: `revealTarget: x`, the shorthand, or inside a spread.
//
// The adopter lists are PINNED: a new adopter fails here until it is added,
// which is the moment to check its wiring by eye as well as by this scan.
//
// It reads the tree from disk, so `pnpm run test:related` cannot reach it — run
// it by name (`pnpm run test:named`) when a section adopts either hook.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

const SECTION_EDIT_ADOPTERS = [
  "src/app/(admin)/admin/backups/backups-client.tsx",
  "src/app/(admin)/admin/backups/local-backup-card.tsx",
  "src/app/(admin)/admin/lodges/[id]/_components/lodge-central-lodge-card.tsx",
  "src/app/(admin)/admin/lodges/[id]/_components/lodge-roster-settings-card.tsx",
  "src/app/(admin)/admin/member-fields/page.tsx",
  "src/app/(admin)/admin/privacy-retention/privacy-retention-client.tsx",
  "src/app/(admin)/admin/video-meetings/setup/video-meetings-setup.tsx",
  "src/app/(admin)/admin/xero/_components/webhook-health-panel.tsx",
  "src/components/admin/allocation-preferences-section.tsx",
  "src/components/admin/analytics-integration-card.tsx",
  "src/components/admin/booking-policies/adult-member-hosting-section.tsx",
  "src/components/admin/booking-policies/default-cancellation-policy-section.tsx",
  "src/components/admin/booking-policies/group-discount-section.tsx",
  "src/components/admin/booking-policies/public-booking-requests-section.tsx",
  "src/components/admin/club-identity-panel.tsx",
  "src/components/admin/club-posts/club-post-retention-section.tsx",
  "src/components/admin/google-security-card.tsx",
  "src/components/admin/magic-link-security-card.tsx",
  "src/components/admin/maintenance/maintenance-questions-section.tsx",
  "src/components/admin/maintenance/maintenance-settings-section.tsx",
  "src/components/admin/member-guest-settings-card.tsx",
  "src/components/admin/roster-editor.tsx",
  "src/components/admin/school-hut-leader-kinds-card.tsx",
  "src/components/admin/security/password-policy-card.tsx",
];

const LIST_EDITOR_ADOPTERS = [
  "src/components/admin/booking-policies/booking-periods-section.tsx",
  "src/components/admin/booking-policies/minimum-night-stay-section.tsx",
];

const REVEAL_TARGET_ADOPTERS = [
  "src/components/admin/allocation-preferences-section.tsx",
  "src/components/admin/club-identity-panel.tsx",
];

/**
 * Adopters allowed a direct `.focus()` call, with how many and why. Each is a
 * position the reveal does not cover; a new one is a decision to record here.
 */
const DIRECT_FOCUS_EXCLUSIONS: ReadonlyArray<{
  file: string;
  count: number;
  reason: string;
}> = [
  {
    file: "src/components/admin/roster-editor.tsx",
    count: 1,
    reason:
      "a row-level save FAILURE focuses that row's own invalid select — a failure position, not the reveal on Edit",
  },
];

/**
 * The shared implementation: the hooks themselves, which define the reveal
 * and the props the census looks for rather than adopting them.
 */
const IMPLEMENTATION = new Set([
  "src/hooks/use-editor-focus-return.ts",
  "src/hooks/use-scroll-to-feedback.ts",
  "src/hooks/use-section-edit-state.ts",
]);

const REVEAL_FAILURE =
  "INV-SSOT-001 / #4115: Edit's reveal lives in `useEditorFocusReturn` " +
  "(`src/hooks/use-editor-focus-return.ts`), which `startEditing` and a list " +
  "editor's `capture` already run: focus goes to the first control the edit " +
  "opened, or to the section. Do not reveal the editor again in the section, " +
  "and leave `revealTarget` to the two sections pinned here.";

const FAILURE =
  "INV-SSOT-001 / #4087: focus after Save or Cancel goes through the one " +
  "return primitive in `src/hooks/use-scroll-to-feedback.ts`. Spread " +
  "`editTriggerProps` on the section's Edit, `sectionRegionProps` on its card " +
  "and `titleProps` on the card's title (or pass `regionLabel` when the card " +
  "has no visible title); a list editor wires `useEditorFocusReturn`'s " +
  "`capture`, `close`, `triggerProps`, `regionProps` and `titleProps`.";

function trackedSources(): string[] {
  const listing = execFileSync("git", ["ls-files", "-z", "src"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listing
    .split("\0")
    .filter(Boolean)
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => !file.includes("__tests__/") && !/\.test\.tsx?$/.test(file))
    .filter((file) => !IMPLEMENTATION.has(file))
    .sort();
}

function read(file: string) {
  return stripComments(fs.readFileSync(path.join(process.cwd(), file), "utf8"));
}

function escape(name: string) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uses(source: string, name: string, member: string) {
  return new RegExp(`\\b${escape(name)}\\.${member}\\b`).test(source);
}

/** Each `const x = useSectionEditState…` whose editor the section opens. */
function editableInstances(source: string): string[] {
  return [...source.matchAll(/const\s+(\w+)\s*=\s*useSectionEditState\b/g)]
    .map((match) => match[1])
    .filter((name) => uses(source, name, "startEditing"));
}

/** Each `const x = useEditorFocusReturn(…)`. */
function listEditorInstances(source: string): string[] {
  return [...source.matchAll(/const\s+(\w+)\s*=\s*useEditorFocusReturn\b/g)].map(
    (match) => match[1],
  );
}

describe("staged sections wire their focus return (#4087)", () => {
  const sources = trackedSources().map((file) => ({ file, source: read(file) }));

  const sectionAdopters = sources.filter(
    ({ source }) => editableInstances(source).length > 0,
  );
  // The hook's own use of it (`use-section-edit-state.ts`) is the shared
  // implementation, not an adopter, and is left out of `sources`.
  const listAdopters = sources.filter(
    ({ source }) => listEditorInstances(source).length > 0,
  );

  it("finds exactly the pinned useSectionEditState adopters", () => {
    expect(
      sectionAdopters.map(({ file }) => file),
      `${FAILURE} A new adopter belongs in SECTION_EDIT_ADOPTERS.`,
    ).toEqual(SECTION_EDIT_ADOPTERS);
  });

  it("finds exactly the pinned useEditorFocusReturn list editors", () => {
    expect(
      listAdopters.map(({ file }) => file),
      `${FAILURE} A new list editor belongs in LIST_EDITOR_ADOPTERS.`,
    ).toEqual(LIST_EDITOR_ADOPTERS);
  });

  it("spreads the trigger, region and title props for every section instance that opens an editor", () => {
    const missing = sectionAdopters.flatMap(({ file, source }) =>
      editableInstances(source).flatMap((name) => {
        const gaps = ["editTriggerProps", "sectionRegionProps"].filter(
          (member) => !uses(source, name, member),
        );
        if (!uses(source, name, "titleProps") && !/\bregionLabel\s*:/.test(source)) {
          gaps.push("titleProps (or regionLabel)");
        }
        return gaps.map((gap) => `${file}: ${name}.${gap}`);
      }),
    );
    expect(missing, FAILURE).toEqual([]);
  });

  it("leaves the reveal on Edit to the hook in every adopter", () => {
    const adopters = [...sectionAdopters, ...listAdopters];
    const handRolled = adopters.flatMap(({ file, source }) => {
      const found = [
        /\b(useRevealAttention|revealEditor|focusAndKeepInView)\b/.test(source)
          ? "an attention reveal"
          : null,
        /\bautoFocus\b/.test(source) ? "autoFocus" : null,
      ].filter(Boolean);
      const direct = (source.match(/\.focus\s*\(/g) ?? []).length;
      const allowed =
        DIRECT_FOCUS_EXCLUSIONS.find((entry) => entry.file === file)?.count ?? 0;
      if (direct > allowed) found.push(`${direct} direct .focus() (allowed ${allowed})`);
      return found.map((what) => `${file}: reveals its own editor (${what})`);
    });
    expect(handRolled, REVEAL_FAILURE).toEqual([]);
    // An exclusion that no longer matches is stale, not slack.
    for (const entry of DIRECT_FOCUS_EXCLUSIONS) {
      const adopter = adopters.find(({ file }) => file === entry.file);
      expect(
        (adopter?.source.match(/\.focus\s*\(/g) ?? []).length,
        `${entry.file} is listed in DIRECT_FOCUS_EXCLUSIONS for ${entry.count} .focus() call(s)`,
      ).toBe(entry.count);
    }
  });

  it("keeps `revealTarget` to the two sections whose card reveal predates the shared one", () => {
    expect(
      sources
        .filter(({ source }) => /\brevealTarget\b/.test(source))
        .map(({ file }) => file),
      REVEAL_FAILURE,
    ).toEqual(REVEAL_TARGET_ADOPTERS);
  });

  it("wires capture, close and every prop for each list editor", () => {
    const missing = listAdopters.flatMap(({ file, source }) =>
      listEditorInstances(source).flatMap((name) =>
        ["capture", "close", "triggerProps", "regionProps", "titleProps"]
          .filter((member) => !uses(source, name, member))
          .map((member) => `${file}: ${name}.${member}`),
      ),
    );
    expect(missing, FAILURE).toEqual([]);
  });
});
