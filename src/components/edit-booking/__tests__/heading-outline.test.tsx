// @vitest-environment jsdom
/**
 * #5216 (`INV-PUB-006`) — the booking editor and the edit-booking panel give
 * /bookings/[id] a sound heading outline in every state they render.
 *
 * Both draw their cards straight under the page's "Booking Details" h1
 * (`src/app/(authenticated)/bookings/[id]/page.tsx`): the read view's three
 * cards, and the panel that replaces them when Edit Booking is pressed. So
 * every card title is level 2, whichever cards a state shows. The editor is
 * rendered for real and opened through its own button, under the page's h1.
 *
 * Frozen clock discipline: today is 2026-07-01; the stays sit either side.
 */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingEditor, type BookingEditorData } from "@/components/booking-editor";
import { FINISHED_STAY_SAVE_LOCKED_MESSAGE } from "@/components/edit-booking/finished-stay-promo-correction-card";
import { headingOutline, expectSoundOutline } from "@/lib/__tests__/support/heading-outline";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** What `/api/promo-codes/guest-codes` answers; never resolving keeps the promo card loading. */
let guestCodes: () => Promise<Response>;

beforeEach(() => {
  guestCodes = async () => jsonResponse({ multiPromoCodes: false, guests: [] });
  global.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/members/family")) return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    if (url.includes("/api/promo-codes/guest-codes")) return guestCodes();
    if (url.includes("/api/promo-codes/available")) return jsonResponse([]);
    if (url.includes("/modify-quote")) return jsonResponse({ error: "Quote unavailable in this test" }, 400);
    return jsonResponse({});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function booking(overrides: Partial<BookingEditorData> = {}): BookingEditorData {
  return {
    id: "bk-5216",
    lodgeName: "Main Lodge",
    checkIn: "2026-08-03",
    checkOut: "2026-08-05",
    nights: 2,
    status: "CONFIRMED",
    guests: [
      {
        id: "g1",
        firstName: "Ann",
        lastName: "Hughes",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-1",
        stayStart: "2026-08-03",
        stayEnd: "2026-08-05",
        nights: null,
        priceCents: 20_000,
      },
    ],
    viewerRole: "USER",
    memberId: "member-1",
    totalPriceCents: 20_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 20_000,
    promo: null,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    canEditNonMemberGuestNames: false,
    canFixNonMemberGuestNameTypos: false,
    requiresAdminReview: false,
    adminReviewStatus: null,
    editPolicy: { mode: "future", today: "2026-07-01", editableFrom: null, checkInEditable: true },
    ...overrides,
  } as BookingEditorData;
}

/** /bookings/[id] as `page.tsx` composes it around the editor. */
function renderBookingPage(data: BookingEditorData, access: { canModify: boolean; canAdminOverride?: boolean }) {
  return render(
    <>
      <h1>Booking Details</h1>
      <section id="details">
        <BookingEditor booking={data} canModify={access.canModify} canAdminOverride={access.canAdminOverride} />
      </section>
    </>,
  );
}

function openEditor() {
  fireEvent.click(screen.getByRole("button", { name: "Edit Booking" }));
}

async function waitForPromoCodesChecked() {
  await screen.findByRole("heading", { level: 2, name: "Dates" });
  await waitFor(() => expect(screen.queryByText("Checking promo codes…")).not.toBeInTheDocument());
}

function cardTitles() {
  return headingOutline()
    .filter((entry) => entry.level === 2)
    .map((entry) => entry.name);
}

describe("the booking editor's outline on /bookings/[id] (#5216)", () => {
  it("puts the read view's three cards at level 2 under the page h1", () => {
    renderBookingPage(booking(), { canModify: true });

    expectSoundOutline("Booking Details");
    expect(cardTitles()).toEqual(["Stay Details", "Guests", "Payment"]);
  });

  it("keeps the panel's cards at level 2 while the promo codes are still loading", async () => {
    guestCodes = () => new Promise<Response>(() => {});
    renderBookingPage(booking(), { canModify: true });
    openEditor();

    await screen.findByRole("heading", { level: 2, name: "Dates" });
    expectSoundOutline("Booking Details");
    expect(cardTitles()).toEqual(["Dates", "Guests (1)", "Promo Codes"]);
  });

  it("shows an officer the override and credit cards at level 2, and a price summary once something changes", async () => {
    renderBookingPage(
      booking({
        viewerRole: "ADMIN",
        editPolicy: {
          mode: "future",
          today: "2026-07-01",
          editableFrom: null,
          checkInEditable: true,
          adminOverrideAvailable: true,
        },
        credit: { availableCents: 5_000, electionCents: null, appliedCents: 0 },
      }),
      { canModify: true, canAdminOverride: true },
    );
    openEditor();

    await screen.findByRole("heading", { level: 2, name: "Promo Code" });
    expectSoundOutline("Booking Details");
    expect(cardTitles()).toEqual(["Admin override", "Dates", "Guests (1)", "Promo Code", "Account credit"]);

    fireEvent.change(screen.getByLabelText("Check-out"), { target: { value: "2026-08-06" } });

    await screen.findByRole("heading", { level: 2, name: "Price Summary" });
    expectSoundOutline("Booking Details");
  });

  it("titles the read-only several-codes card at level 2", async () => {
    const promoLines = [
      { code: "SPRING10", type: "PERCENT", description: null, amountCents: -1_000 },
      { code: "GUESTFREE", type: "FREE_NIGHTS", description: null, amountCents: -500 },
    ] as BookingEditorData["promoLines"];
    renderBookingPage(booking({ promoLines }), { canModify: true });
    openEditor();

    await waitForPromoCodesChecked();
    expect(screen.getByRole("heading", { level: 2, name: "Promo Codes" })).toBeInTheDocument();
    expectSoundOutline("Booking Details");
  });

  it("titles the multi-code editor at level 2", async () => {
    guestCodes = async () => jsonResponse({ multiPromoCodes: true, guests: [] });
    renderBookingPage(booking(), { canModify: true });
    openEditor();

    await waitForPromoCodesChecked();
    expect(screen.getByRole("heading", { level: 2, name: "Promo Codes" })).toBeInTheDocument();
    expectSoundOutline("Booking Details");
  });

  it("titles the change-request card on an in-progress stay at level 2", async () => {
    renderBookingPage(
      booking({
        checkIn: "2026-06-29",
        checkOut: "2026-07-04",
        nights: 5,
        editPolicy: { mode: "in-progress", today: "2026-07-01", editableFrom: "2026-07-02", checkInEditable: false },
      }),
      { canModify: true },
    );
    openEditor();

    await screen.findByRole("heading", { level: 2, name: "Admin Request" });
    expectSoundOutline("Booking Details");
  });

  it("titles the finished-stay correction card at level 2", async () => {
    renderBookingPage(
      booking({
        checkIn: "2026-06-10",
        checkOut: "2026-06-16",
        viewerRole: "ADMIN",
        editPolicy: {
          mode: null,
          today: "2026-07-01",
          editableFrom: null,
          checkInEditable: false,
          adminOverrideAvailable: true,
          finishedStayPromoCorrection: true,
        },
      }),
      { canModify: false, canAdminOverride: true },
    );
    openEditor();

    fireEvent.change(await screen.findByPlaceholderText("Enter promo code"), { target: { value: "FREENIGHT" } });
    vi.mocked(global.fetch).mockImplementationOnce(async () =>
      jsonResponse({
        valid: true,
        code: "FREENIGHT",
        description: null,
        type: "FREE_NIGHTS",
        discountCents: 5000,
        promoAdjustmentCents: -5000,
        totalPriceCents: 20000,
        finalPriceCents: 15000,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await screen.findByRole("heading", { level: 2, name: FINISHED_STAY_SAVE_LOCKED_MESSAGE });
    expectSoundOutline("Booking Details");
  });
});
