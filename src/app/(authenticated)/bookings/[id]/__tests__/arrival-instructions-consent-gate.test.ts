// "+ Add Member Guest" (epic #2305) MG2 (#2307) — domain invariant D-12 on the
// member booking page's ARRIVAL INSTRUCTIONS block.
//
// WHY THIS IS A SOURCE-TEXT CONTRACT AND NOT A RENDER TEST. The gate lives
// inside an async React Server Component several hundred lines long that loads
// a booking, a session, module flags, payments, credits and lodge email
// settings before it decides anything; standing all of that up would test the
// mocks rather than the rule. What actually has to be true is narrow and
// structural — the arrival-instructions predicate must consult the viewer's own
// consent state — so that is what is asserted, over the executable source with
// comments stripped so a comment mentioning the helper cannot satisfy it.
//
// D-12 keeps a member guest whose consent is still PENDING (or declined, or
// lapsed) off every operational surface: the kiosk, the chore roster, the
// arrival emails, the bed allocations. This page was the one that was missed,
// and what it leaks is the LODGE DOOR CODE — data the repo classifies as
// sensitive opt-in — to somebody who has not yet said they are coming.
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// Comments are stripped so only EXECUTABLE text is matched. Without this,
// deleting the guard but leaving the paragraph that explains it would still pass
// — the exact laxity that lets a regression through a source contract (same
// reasoning as review-findings-contracts.test.ts).
import { stripComments } from "@/lib/__tests__/support/strip-comments";

const PAGE = "src/app/(authenticated)/bookings/[id]/page.tsx";
// #2958: the block the gate protects now renders in this section component; the
// page hands it `memberArrivalInstructions`, already null whenever the gate
// says no, so the door code still never leaves the page's decision.
const STAY_PREFERENCES =
  "src/app/(authenticated)/bookings/[id]/_components/booking-stay-preferences.tsx";

function readPageSource(): string {
  // Test helper: a fixed repo file under process.cwd(), not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), PAGE), "utf8");
}

function readStayPreferencesSource(): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), STAY_PREFERENCES), "utf8");
}

/** The `const showMemberArrivalInstructions = ...;` assignment, executable only. */
function arrivalInstructionsGate(source: string): string {
  const code = stripComments(source);
  const start = code.indexOf("const showMemberArrivalInstructions");
  expect(start).toBeGreaterThan(-1);
  const end = code.indexOf(";", start);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end + 1);
}

describe("the member booking page's arrival instructions (D-12)", () => {
  it("gates them on the viewer's consent being operationally present", () => {
    const gate = arrivalInstructionsGate(readPageSource());
    expect(gate).toContain("isOperationallyPresentConsent");
    // It is the VIEWER's own row that is consulted — not some other guest's.
    expect(gate).toContain("viewerGuestRow");
    // And the check applies to the linked-guest viewer, who is the only one it
    // can apply to: the booking owner has no consent row of their own.
    expect(gate).toContain("isLinkedGuestViewer");
  });

  it("imports the shared predicate rather than re-deriving the rule", () => {
    // A second hand-written `=== "CONFIRMED"` somewhere on this page is how the
    // kiosk/roster/email surfaces would drift apart again. The shared helper is
    // declared beside its SQL twin so the two can be seen to agree.
    expect(stripComments(readPageSource())).toContain(
      'import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";',
    );
  });

  it("still shows the door code inside that block, so the gate is what protects it", () => {
    // If the door code ever moves out from under `memberArrivalInstructions`,
    // this contract stops covering it and must be rewritten rather than
    // quietly passing.
    const code = stripComments(readStayPreferencesSource());
    expect(code).toContain("memberArrivalInstructions.doorCode");
    // And the component reads it from the prop the page's gate decided, never
    // from the lodge settings directly.
    expect(code).not.toContain("loadEmailMessageSettingsForLodge");
  });
});
