// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

/*
  #2690 — the partner quick-add button's label, asserted so the bug that lived in
  it cannot come back.

  WHAT WAS WRONG. The label was written with an em dash spelled as the escape
  sequence backslash-u-2-0-1-4 in JSX TEXT, where JSX does not interpret escape
  sequences. React rendered the six characters literally, so an officer read
  "Jane Smith — partner of Bob". It had been on screen since #1746 and no
  test asserted the label, which is exactly why it survived: it is invisible in
  code review (the source looks like an em dash to anyone who has read a string
  literal) and invisible to every test that never looked at the text.

  The neighbouring tick, `{alreadyAdded ? "✓ " : "+ "}`, is a STRING
  LITERAL inside a JSX expression, where the escape does resolve — so it was
  always correct and is deliberately left alone. That asymmetry, two lines apart,
  is the whole trap.

  The class of defect is guarded tree-wide by
  `src/lib/__tests__/jsx-text-escape-guard.test.ts`. This suite pins the one
  label a member of the club actually reads.
*/

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-2690-partner";
const EM_DASH = String.fromCharCode(0x2014);

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch() {
  global.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    // The admin on-behalf route is the ONLY one that returns partner-sharing
    // candidates (#1746); the member family route never does.
    if (url.includes("/eligible-family")) {
      return jsonResponse({
        familyMembers: [],
        partnerSharingCandidates: [
          {
            id: "member-jane",
            firstName: "Jane",
            lastName: "Smith",
            partnerOfMemberId: "member-bob",
            partnerOfName: "Bob Reid",
          },
        ],
      });
    }
    if (url.includes("/api/promo-codes/available")) return jsonResponse([]);
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

function makeBooking() {
  return {
    id: BOOKING_ID,
    checkIn: "2026-09-04",
    checkOut: "2026-09-06",
    guests: [
      {
        id: "g1",
        firstName: "Bob",
        lastName: "Reid",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-bob",
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 5000,
      },
    ],
    viewerRole: "ADMIN",
    finalPriceCents: 5000,
    totalPriceCents: 5000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    promo: null,
    canEditNonMemberGuestNames: true,
    canFixNonMemberGuestNameTypos: true,
    editPolicy: {
      mode: "future" as const,
      today: "2026-08-01",
      editableFrom: null,
      checkInEditable: true,
      adminOverrideAvailable: false,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
  };
}

beforeEach(() => {
  installFetch();
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the partner quick-add button names the partner in readable English", () => {
  it("renders a real em dash, not the six characters of an escape sequence", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={() => {}} />);

    const button = await waitFor(
      () => screen.getByRole("button", { name: /Jane Smith/ }),
      { timeout: 2500 },
    );

    const label = button.textContent ?? "";
    expect(label).toContain(`Jane Smith ${EM_DASH} partner of Bob Reid`);
    // The failure this pins is a LITERAL backslash reaching the screen. Asserting
    // the em dash alone would still pass if somebody wrote "— —".
    expect(
      label,
      "a backslash reached the button label; an escape sequence in JSX text is " +
        "rendered literally, it is not interpreted",
    ).not.toContain("\\");
    expect(label).not.toContain("u2014");
  });

  it("still resolves the tick, which is a string literal and not JSX text", async () => {
    // The other half of the asymmetry: the escape two lines above the bug is
    // correct BECAUSE it sits in a string literal, and must not be "fixed" too.
    render(<EditBookingPanel booking={makeBooking()} onDone={() => {}} />);

    const button = await waitFor(
      () => screen.getByRole("button", { name: /Jane Smith/ }),
      { timeout: 2500 },
    );
    // Jane is not on the booking yet, so this row shows the "+ " prefix. The tick
    // form is asserted through the family quick-add path in the panel's own
    // suites; what matters here is that no escape text leaks from either branch.
    expect(button.textContent ?? "").not.toContain("u2713");
  });
});
