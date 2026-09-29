// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import { MemberGroupJoinPanel } from "@/app/(website-dynamic)/join/[code]/member-group-join-panel";

const CODE = "ABCD2345";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    code: CODE,
    status: "OPEN",
    paymentMode: "ORGANISER_PAYS",
    organiserFirstName: "Olive",
    lodgeName: "West Ridge Hut",
    checkIn: "2026-07-01",
    checkOut: "2026-07-03",
    joinDeadline: null,
    isJoinable: true,
    ...overrides,
  };
}

const family = {
  familyMembers: [
    {
      id: "self-1",
      firstName: "Mel",
      lastName: "Member",
      ageTier: "ADULT",
      relationship: "self",
      canBeBooked: true,
    },
    {
      id: "kid-1",
      firstName: "Kid",
      lastName: "Member",
      ageTier: "CHILD",
      relationship: "dependent",
      canBeBooked: true,
    },
  ],
};

function stubFetch(opts: {
  summary?: Record<string, unknown>;
  joinOk?: boolean;
  joinBody?: Record<string, unknown>;
  internetBankingEnabled?: boolean;
  bookingMessages?: Record<string, string>;
  bookingMessageTokens?: Record<string, string>;
}) {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (u.includes("/api/booking-messages")) {
      return {
        ok: true,
        json: async () => ({
          messages: opts.bookingMessages ?? {},
          tokens: opts.bookingMessageTokens ?? {},
        }),
      } as Response;
    }
    if (u.includes("/join") && init?.method === "POST") {
      return {
        ok: opts.joinOk ?? true,
        json: async () => opts.joinBody ?? {},
      } as Response;
    }
    if (u.includes("/api/payments/options")) {
      return {
        ok: true,
        json: async () => ({
          methods: {
            stripe: { enabled: true },
            internetBanking: { enabled: opts.internetBankingEnabled ?? false },
          },
        }),
      } as Response;
    }
    if (u.includes("/api/members/family")) {
      return { ok: true, json: async () => family } as Response;
    }
    if (u.includes("/api/group-bookings/")) {
      return { ok: true, json: async () => opts.summary ?? summary() } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  pushMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MemberGroupJoinPanel", () => {
  it("pre-selects the member and confirms in place for ORGANISER_PAYS", async () => {
    stubFetch({
      joinBody: { bookingId: "b1", organiserSettled: true, requiresPayment: false },
    });

    render(<MemberGroupJoinPanel code={CODE} />);

    // The heading names the group's OWN lodge (from the summary), not the
    // static club-wide lodge name (#11).
    expect(await screen.findByText(/group at West Ridge Hut/)).toBeDefined();

    // Self is pre-selected (ticked button).
    const selfButton = await screen.findByRole("button", {
      name: /Mel Member \(You\)/,
    });
    expect(selfButton.textContent).toContain("✓");

    fireEvent.click(screen.getByRole("button", { name: /Join group/ }));

    expect(await screen.findByText(/You're in/)).toBeDefined();
    // ORGANISER_PAYS: no redirect to a pay page.
    expect(pushMock).not.toHaveBeenCalledWith(expect.stringContaining("/bookings/b1"));
  });

  it("redirects to pay for an EACH_PAYS_OWN join", async () => {
    stubFetch({
      summary: summary({ paymentMode: "EACH_PAYS_OWN" }),
      joinBody: { bookingId: "b1", organiserSettled: false, requiresPayment: true },
    });

    render(<MemberGroupJoinPanel code={CODE} />);

    fireEvent.click(await screen.findByRole("button", { name: /Join and pay/ }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/bookings/b1");
    });
  });

  it("offers internet banking for EACH_PAYS_OWN and confirms in place with a reference", async () => {
    const fetchMock = stubFetch({
      summary: summary({ paymentMode: "EACH_PAYS_OWN" }),
      internetBankingEnabled: true,
      joinBody: { bookingId: "b1", organiserSettled: false, requiresPayment: true },
    });

    render(<MemberGroupJoinPanel code={CODE} />);

    // Pick internet banking, then join.
    fireEvent.click(await screen.findByRole("button", { name: /Internet Banking/ }));
    fireEvent.click(screen.getByRole("button", { name: /Join \(invoice by email\)/ }));

    // Confirms in place with the BOOKING- reference, no redirect to pay. The
    // reference now appears both in the explanatory sentence and the dedicated
    // "Payment reference" box, so match the box's exact value to stay unique.
    expect(await screen.findByText("BOOKING-B1")).toBeDefined();
    expect(pushMock).not.toHaveBeenCalledWith("/bookings/b1");

    // The join POST forwarded the internet_banking method.
    const joinCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes("/join") && init?.method === "POST"
    );
    expect(joinCall).toBeDefined();
    expect(JSON.parse((joinCall![1] as { body: string }).body).paymentMethod).toBe(
      "internet_banking"
    );
  });

  it("hides the internet banking option when the module is off", async () => {
    stubFetch({
      summary: summary({ paymentMode: "EACH_PAYS_OWN" }),
      internetBankingEnabled: false,
      joinBody: { bookingId: "b1", requiresPayment: true },
    });

    render(<MemberGroupJoinPanel code={CODE} />);

    await screen.findByRole("button", { name: /Join and pay/ });
    expect(screen.queryByRole("button", { name: /Internet Banking/ })).toBeNull();
  });

  // #2919 review round 2: the two payment-CHOICE bodies were still printed raw
  // beside the one that had been fixed. They only exist before the join is
  // submitted, so the post-submit "no braces" assertion below never saw them.
  it("fills in the merge fields of both payment choices before the join is submitted", async () => {
    stubFetch({
      summary: summary({ paymentMode: "EACH_PAYS_OWN" }),
      internetBankingEnabled: true,
      joinBody: { bookingId: "b1", organiserSettled: false, requiresPayment: true },
      bookingMessages: {
        "booking.payment.card.description":
          "Pay now to hold your bed at {{CLUB_LODGE_NAME}}.",
        "booking.payment.internetBanking.description":
          "{{CLUB_NAME}} will invoice you for {{CLUB_LODGE_NAME}}. Questions: {{SUPPORT_EMAIL}}.",
      },
      bookingMessageTokens: {
        CLUB_NAME: "Alpine Club",
        // The club default, which is NOT the lodge this group is at.
        CLUB_LODGE_NAME: "Default Lodge",
        SUPPORT_EMAIL: "support@example.test",
        BASE_URL: "https://example.test",
      },
    });

    render(<MemberGroupJoinPanel code={CODE} />);

    expect(
      await screen.findByText("Pay now to hold your bed at West Ridge Hut.")
    ).toBeDefined();
    expect(
      screen.getByText(
        "Alpine Club will invoice you for West Ridge Hut. Questions: support@example.test."
      )
    ).toBeDefined();
    expect(document.body.textContent).not.toContain("{{");
    expect(document.body.textContent).not.toContain("Default Lodge");
  });

  // #2919 review: the panel rendered this body with only {{paymentReference}}
  // substituted, so an operator who wrote {{CLUB_LODGE_NAME}} into it sent the
  // joiner literal braces.
  it("fills in every merge field in an edited payment message, naming the group's lodge", async () => {
    stubFetch({
      summary: summary({ paymentMode: "EACH_PAYS_OWN" }),
      internetBankingEnabled: true,
      joinBody: { bookingId: "b1", organiserSettled: false, requiresPayment: true },
      bookingMessages: {
        "paymentLink.internetBanking.description":
          "Transfer to {{CLUB_LODGE_NAME}} ({{CLUB_NAME}}) using {{paymentReference}}. Questions: {{SUPPORT_EMAIL}}.",
      },
      bookingMessageTokens: {
        CLUB_NAME: "Alpine Club",
        // The club default, which is NOT the lodge this group is at.
        CLUB_LODGE_NAME: "Default Lodge",
        SUPPORT_EMAIL: "support@example.test",
        BASE_URL: "https://example.test",
      },
    });

    render(<MemberGroupJoinPanel code={CODE} />);

    fireEvent.click(await screen.findByRole("button", { name: /Internet Banking/ }));
    fireEvent.click(screen.getByRole("button", { name: /Join \(invoice by email\)/ }));

    expect(
      await screen.findByText(
        "Transfer to West Ridge Hut (Alpine Club) using BOOKING-B1. Questions: support@example.test."
      )
    ).toBeDefined();
    expect(document.body.textContent).not.toContain("{{");
    expect(document.body.textContent).not.toContain("Default Lodge");
  });

  it("surfaces a join error from the API", async () => {
    stubFetch({
      joinOk: false,
      joinBody: { error: "You have already joined this group" },
    });

    render(<MemberGroupJoinPanel code={CODE} />);

    fireEvent.click(await screen.findByRole("button", { name: /Join group/ }));

    expect(
      await screen.findByText(/You have already joined this group/)
    ).toBeDefined();
  });
});
