import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

/**
 * #4966 (`INV-SSOT-001`): the admin "email the member?" dialog has one home,
 * `NotifyChoiceDialog`, because its rule — the last step before an action that
 * cannot be undone always offers a labelled "Go back" — only holds everywhere
 * if there is one footer to hold it in. Twelve hand-rolled copies, each pasted
 * from a dialog that had no way back, is how the rule went missing.
 *
 * Two checks, both enumerating rather than counting:
 *
 * 1. No file outside the shared component renders a dialog footer of its own
 *    holding both an email-less label ("… without emailing", "…, no email")
 *    and an "… and email …" label, bar the named exceptions below.
 * 2. The files that render `NotifyChoiceDialog` are exactly the twelve screens
 *    #4966 moved onto it, so dropping one back to a local copy fails here even
 *    if its labels are reworded past check 1.
 *
 * Disk-scanning: run by name (`pnpm run test:named`).
 */
const ROOT = process.cwd();
const SHARED_COMPONENT = "src/components/admin/notify-choice-dialog.tsx";
const SCANNED_DIRS = ["src/app", "src/components"];

const RENDERS_A_DIALOG_FOOTER = /<(?:Alert)?DialogFooter\b/;
const EMAIL_LESS_LABEL = /\bwithout emailing\b|, no email\b/;
const EMAIL_LABEL = /\band email\b/;

/**
 * Dialogs that already put their own Cancel beside the two email choices, and
 * whose footers do more than the shared one models, so #4966 left them alone.
 */
const HAND_ROLLED_WITH_THEIR_OWN_WAY_BACK = [
  // Two steps sharing one footer slot; Cancel becomes "Close and check" after
  // an unread outcome, which the shared footer does not model.
  "src/components/admin/booking-manual-payment-controls.tsx",
  // Has a ghost Cancel and a second, non-email step in the same dialog.
  "src/app/(admin)/admin/finance/subscriptions/_components/manual-payment-dialog.tsx",
  // Deletion requests are out of #4966's scope; its reject footer has Cancel.
  "src/app/(admin)/admin/membership/deletion-requests/deletion-requests-client.tsx",
];

const MIGRATED_SCREENS = [
  "src/app/(admin)/admin/booking-desk/book/page.tsx",
  "src/app/(admin)/admin/finance/refund-requests/page.tsx",
  "src/app/(admin)/admin/membership/member-applications/page.tsx",
  "src/app/(admin)/admin/membership/members/[id]/_components/member-lifecycle-card.tsx",
  "src/app/(admin)/admin/membership/members/[id]/_components/member-partner-link-card.tsx",
  "src/app/(admin)/admin/membership/membership-cancellations/page.tsx",
  "src/components/admin/booking-requests/booking-approvals-panel.tsx",
  "src/components/admin/booking-requests/public-booking-requests-panel.tsx",
  "src/components/admin/confirm-pending-guests-button.tsx",
  "src/components/admin/family-groups/request-review-section.tsx",
  "src/components/cancel-booking-button.tsx",
  "src/components/edit-booking-panel.tsx",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(full, out);
    } else if (name.endsWith(".tsx") && !/\.(?:test|spec)\.tsx$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function productionSources(): { file: string; code: string }[] {
  return SCANNED_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)))
    .map((full) => ({
      file: path.relative(ROOT, full).split(path.sep).join("/"),
      code: stripComments(readFileSync(full, "utf8")),
    }))
    .filter(({ file }) => file !== SHARED_COMPONENT)
    .sort((a, b) => a.file.localeCompare(b.file));
}

describe("#4966: the email-choice dialog has one home", () => {
  const sources = productionSources();

  it("finds no hand-rolled email-choice footer outside NotifyChoiceDialog", () => {
    const handRolled = sources
      .filter(
        ({ code }) =>
          RENDERS_A_DIALOG_FOOTER.test(code) &&
          EMAIL_LESS_LABEL.test(code) &&
          EMAIL_LABEL.test(code),
      )
      .map(({ file }) => file);

    expect(
      handRolled,
      "a dialog footer offering the email choice by hand — render NotifyChoiceDialog instead, so it gets Go back",
    ).toEqual([...HAND_ROLLED_WITH_THEIR_OWN_WAY_BACK].sort());
  });

  it("renders NotifyChoiceDialog from exactly the screens moved onto it", () => {
    const users = sources
      .filter(({ code }) => /<NotifyChoiceDialog\b/.test(code))
      .map(({ file }) => file);

    expect(users).toEqual([...MIGRATED_SCREENS].sort((a, b) => a.localeCompare(b)));
  });
});
