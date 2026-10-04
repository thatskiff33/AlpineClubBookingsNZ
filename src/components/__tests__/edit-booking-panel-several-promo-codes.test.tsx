// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

// #3828 (review E1): a booking carrying several promo codes reaches the panel
// as `promo: null` plus `promoLines`. The one-code card would read that as "no
// code — apply one", and applying would send the legacy one-code request, which
// replaces every code on the booking. The card is locked instead, and the
// codes are shown read-only — unless (#3492) the club's `multiPromoCodes`
// switch is on, where the list editor edits the codes through `promoCodes`,
// the one field the server never refuses on such a booking.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

type Captured = { url: string; body: Record<string, unknown> };
let quoteBodies: Captured[] = [];
let saveBodies: Captured[] = [];
let validateBodies: Captured[] = [];

type GuestCodesAnswer = boolean | "pending" | { status: number } | Promise<Response>;

/**
 * `multiPromoCodes`: the guest-code lookup's answer; `"pending"` never answers;
 * `{ status }` fails with that status; a promise answers when the test says.
 */
function installFetch(
  multiPromoCodes: GuestCodesAnswer,
  guests: Array<{ guestRef: string; codes: Array<{ code: string; benefit: string }> }> = [],
) {
  quoteBodies = [];
  saveBodies = [];
  validateBodies = [];
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT" && url.includes("/modify")) {
      saveBodies.push({ url, body: JSON.parse(String(init.body)) });
      return jsonResponse({ booking: { id: "bk-3828" } });
    }
    if (url.includes("/modify-quote")) {
      quoteBodies.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({
        newTotalPriceCents: 12000,
        newDiscountCents: 5000,
        newPromoAdjustmentCents: -3000,
        newFinalPriceCents: 9000,
        priceDiffCents: 2000,
        changeFeeCents: 0,
        netChargeCents: 2000,
        settlementOptions: null,
        availableCreditCents: 0,
        capacityAvailable: true,
        minimumStayValid: true,
        minimumStayViolations: [],
        promoStillValid: true,
        promoValidation: null,
        itemizedChanges: [],
      });
    }
    if (url.includes("/api/promo-codes/guest-codes")) {
      if (multiPromoCodes === "pending") return new Promise<Response>(() => {});
      if (multiPromoCodes instanceof Promise) return multiPromoCodes;
      if (typeof multiPromoCodes === "object") {
        return new Response(JSON.stringify({ error: "x" }), { status: multiPromoCodes.status });
      }
      return jsonResponse({ multiPromoCodes, guests });
    }
    if (url.includes("/api/promo-codes/validate")) {
      const body = JSON.parse(String(init?.body));
      validateBodies.push({ url, body });
      if (!body.codes) {
        return jsonResponse({
          valid: true,
          code: body.code,
          description: null,
          type: "FREE_NIGHTS",
          discountCents: 2000,
          promoAdjustmentCents: -2000,
          totalPriceCents: 12000,
          finalPriceCents: 10000,
        });
      }
      return jsonResponse({
        valid: true,
        codes: (body.codes as Array<{ code: string }>).map((entry) => ({
          code: entry.code,
          valid: true,
          promoAdjustmentCents: -2000,
          discountCents: 2000,
          type: "FREE_NIGHTS",
        })),
        totalPriceCents: 12000,
        finalPriceCents: 10000,
      });
    }
    if (url.includes("/api/promo-codes/available")) return jsonResponse([]);
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

beforeEach(() => installFetch(false));

const SEVERAL = {
  promo: null,
  promoLines: [
    { code: "SPRING10", type: "PERCENTAGE", description: null, amountCents: -3000 },
    { code: "GUESTFREE", type: "FREE_NIGHTS", description: null, amountCents: -2000 },
  ],
};

/** No request this panel sent carries a one-code field. */
function expectNoOneCodeField(bodies: Captured[]) {
  for (const { body } of bodies) {
    expect(body).not.toHaveProperty("promoCode");
    expect(body).not.toHaveProperty("removePromoCode");
  }
}

function makeBooking(promo: {
  promo: { code: string; type: string; description: string | null } | null;
  promoLines?: Array<{ code: string; type: string; description: string | null; amountCents: number }>;
}) {
  return {
    id: "bk-3828",
    checkIn: "2026-09-01",
    checkOut: "2026-09-03",
    guests: [
      {
        id: "g1",
        firstName: "Ann",
        lastName: "Hughes",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-ann",
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 5000,
      },
    ],
    viewerRole: "MEMBER",
    finalPriceCents: 7000,
    totalPriceCents: 12000,
    discountCents: 5000,
    promoAdjustmentCents: -5000,
    ...promo,
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

describe("EditBookingPanel on a several-code booking (#3828)", () => {
  it.each([
    ["the club's multiPromoCodes switch is off", false],
  ] as const)("locks the one-code controls and shows the codes read-only when %s", async (_label, mode) => {
    installFetch(mode);
    render(<EditBookingPanel booking={makeBooking(SEVERAL)} onDone={vi.fn()} />);

    expect(await screen.findByText(/can't be added, removed or swapped here/)).toBeInTheDocument();
    expect(screen.getByText("Promo Codes")).toBeInTheDocument();
    expect(screen.getByText("SPRING10")).toBeInTheDocument();
    expect(screen.getByText("GUESTFREE")).toBeInTheDocument();
    // No one-code card: nothing to apply, remove or replace a code with.
    expect(screen.queryByText("Promo Code")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /promo/i })).not.toBeInTheDocument();
  });

  // C4 review (privacy 4): a lookup that could not answer is said as such — the
  // switch may well be on, so "can't be changed here" would be false.
  it.each([
    [429, /Too many requests/],
    [500, /couldn't check your guests' promo codes/],
  ] as const)("says the switch could not be checked when the lookup fails with %s", async (status, message) => {
    installFetch({ status });
    render(<EditBookingPanel booking={makeBooking(SEVERAL)} onDone={vi.fn()} />);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByText("SPRING10")).toBeInTheDocument();
    expect(screen.queryByText(/can't be added, removed or swapped here/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  });

  it("keeps a one-code booking's card as it was", async () => {
    render(
      <EditBookingPanel
        booking={makeBooking({
          promo: { code: "SPRING10", type: "PERCENTAGE", description: null },
        })}
        onDone={vi.fn()}
      />,
    );

    expect(await screen.findByText("Promo Code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(screen.queryByText("Promo Codes")).not.toBeInTheDocument();
  });
});

describe("EditBookingPanel on a several-code booking with the switch on (#3492)", () => {
  beforeEach(() => installFetch(true));

  it("offers the list editor instead of the lock, with no one-code control", async () => {
    render(<EditBookingPanel booking={makeBooking(SEVERAL)} onDone={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Remove SPRING10" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove GUESTFREE" })).toBeInTheDocument();
    expect(screen.queryByText(/can't be added, removed or swapped here/)).not.toBeInTheDocument();
    expect(screen.queryByText("Promo Code")).not.toBeInTheDocument();
  });

  it("removes one code by sending the list, keeping the other code", async () => {
    render(<EditBookingPanel booking={makeBooking(SEVERAL)} onDone={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove SPRING10" }));

    await waitFor(() =>
      expect(quoteBodies.at(-1)?.body.promoCodes).toEqual([{ code: "GUESTFREE" }]),
    );
    const save = await screen.findByRole("button", { name: /save changes/i });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(saveBodies).toHaveLength(1));
    expect(saveBodies[0].body.promoCodes).toEqual([{ code: "GUESTFREE" }]);
    expectNoOneCodeField([...quoteBodies, ...saveBodies]);
  });

  it("reorders the codes by sending the whole list in its new order", async () => {
    render(<EditBookingPanel booking={makeBooking(SEVERAL)} onDone={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Move GUESTFREE earlier" }));

    await waitFor(() =>
      expect(quoteBodies.at(-1)?.body.promoCodes).toEqual([
        { code: "GUESTFREE" },
        { code: "SPRING10" },
      ]),
    );
    expectNoOneCodeField(quoteBodies);
  });
});

// C4 review (correctness 5): until the switch is answered the card offers no
// promo control, so nothing can be staged on the one-code card and then carried,
// unseen, into the list editor.
describe("EditBookingPanel before the multiPromoCodes switch answers (#3492)", () => {
  it.each([
    ["a several-code booking", SEVERAL],
    ["a one-code booking", { promo: { code: "SPRING10", type: "PERCENTAGE", description: null } }],
  ] as const)("shows %s's promo card as loading, with no control", async (_label, promo) => {
    installFetch("pending");
    render(<EditBookingPanel booking={makeBooking(promo)} onDone={vi.fn()} />);
    expect(await screen.findByText("Checking promo codes…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/can't be added, removed or swapped here/)).not.toBeInTheDocument();
  });

  it("opens the list editor with nothing staged once the answer is on", async () => {
    let answer: (response: Response) => void = () => {};
    installFetch(new Promise<Response>((resolve) => (answer = resolve)));
    render(
      <EditBookingPanel
        booking={makeBooking({ promo: { code: "SPRING10", type: "PERCENTAGE", description: null } })}
        onDone={vi.fn()}
      />,
    );
    await screen.findByText("Checking promo codes…");
    answer(jsonResponse({ multiPromoCodes: true, guests: [] }));
    expect(await screen.findByRole("button", { name: "Remove SPRING10" })).toBeInTheDocument();
    for (const { body } of quoteBodies) {
      expect(body).not.toHaveProperty("removePromoCode");
      expect(body).not.toHaveProperty("promoCodes");
    }
  });
});

// C4 review (correctness 1, D-3492-4): a confirmed cross-family guest's chip is
// previewed against the booking's stored consent, so it can be applied.
describe("EditBookingPanel guest chips with the switch on (#3492)", () => {
  it("previews a guest's chip against this booking and its guest rows, and stages it", async () => {
    installFetch(true, [{ guestRef: "g2", codes: [{ code: "BENFREE", benefit: "3 free nights per booking" }] }]);
    const booking = makeBooking({ promo: null });
    booking.guests.push({ ...booking.guests[0]!, id: "g2", firstName: "Ben", lastName: "Outside", memberId: "member-ben" });
    render(<EditBookingPanel booking={booking} onDone={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Apply BENFREE — 3 free nights per booking, applies to Ben Outside only",
      }),
    );
    expect(await screen.findByRole("button", { name: "Remove BENFREE" })).toBeInTheDocument();
    expect(validateBodies).toHaveLength(1);
    expect(validateBodies[0]!.body).toMatchObject({ bookingId: "bk-3828", forBookingEdit: true });
    expect((validateBodies[0]!.body.guests as Array<Record<string, unknown>>).map((guest) => guest.bookingGuestId)).toEqual([
      "g1",
      "g2",
    ]);
    await waitFor(() => expect(quoteBodies.at(-1)?.body.promoCodes).toEqual([{ code: "BENFREE" }]));
  });
});

// Coordinator follow-up to C4 review correctness 1: with the switch OFF the
// one-code card offers guest chips too, so its preview must also be judged
// against the booking's stored consent — while the modify-quote and modify
// bodies keep their legacy one-code shape exactly.
describe("EditBookingPanel guest chips with the switch off (#3492)", () => {
  function bookingWithBen() {
    const booking = makeBooking({ promo: null });
    booking.guests.push({ ...booking.guests[0]!, id: "g2", firstName: "Ben", lastName: "Outside", memberId: "member-ben" });
    return booking;
  }

  it("previews a confirmed cross-family guest's chip against this booking and its guest rows", async () => {
    installFetch(false, [{ guestRef: "g2", codes: [{ code: "BENFREE", benefit: "3 free nights per booking" }] }]);
    render(<EditBookingPanel booking={bookingWithBen()} onDone={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Apply BENFREE — 3 free nights per booking, applies to Ben Outside only",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    await waitFor(() => expect(validateBodies).toHaveLength(1));
    expect(validateBodies[0]!.body).toMatchObject({ code: "BENFREE", bookingId: "bk-3828", forBookingEdit: true });
    expect((validateBodies[0]!.body.guests as Array<Record<string, unknown>>).map((guest) => guest.bookingGuestId)).toEqual([
      "g1",
      "g2",
    ]);
    expect(await screen.findByText("(-$20.00)")).toBeInTheDocument();
  });

  it("keeps the modify-quote and modify bodies in their legacy one-code shape", async () => {
    installFetch(false, [{ guestRef: "g2", codes: [{ code: "BENFREE", benefit: "3 free nights per booking" }] }]);
    render(<EditBookingPanel booking={bookingWithBen()} onDone={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /Apply BENFREE/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    await waitFor(() => expect(quoteBodies.at(-1)?.body.promoCode).toBe("BENFREE"));
    const save = await screen.findByRole("button", { name: /save changes/i });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(saveBodies).toHaveLength(1));
    for (const { body } of [quoteBodies.at(-1)!, saveBodies[0]!]) {
      expect(body.promoCode).toBe("BENFREE");
      expect(body).not.toHaveProperty("promoCodes");
      expect(body).not.toHaveProperty("bookingId");
      expect(body).not.toHaveProperty("promoGuestIds");
      expect(JSON.stringify(body)).not.toContain("bookingGuestId");
    }
  });
});
