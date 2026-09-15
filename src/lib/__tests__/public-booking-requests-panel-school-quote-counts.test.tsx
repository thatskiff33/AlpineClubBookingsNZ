// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicBookingRequestsPanel } from "@/components/admin/booking-requests/public-booking-requests-panel";

// next/navigation: the panel replaces the URL in an effect and reads search params.
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Radix Select needs jsdom polyfills this suite does not provide, so it stands
// in as a native select — the pricing mode has to be switchable here, because
// the per guest-night rate boxes are one of the things the adjusted counts
// change.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value?: string;
    onValueChange?: (next: string) => void;
  }) => (
    <select
      data-testid="select"
      value={value ?? ""}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

vi.mock("@/components/admin/booking-requests/booking-request-contact-picker", () => ({
  BookingRequestContactPicker: () => <div data-testid="contact-picker" />,
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
  ClubIdentityProvider: ({ children }: { children: ReactNode }) => children,
}));

// A VERIFIED school request: one teacher plus four youth, which is what the
// group-number boxes prefill from.
const baseSchoolRequest = {
  id: "req-school",
  type: "SCHOOL",
  status: "VERIFIED",
  schoolName: "Test School",
  lodgeId: "lodge-a",
  lodgeName: "Lodge A",
  otherLodgeId: null,
  otherLodgeName: null,
  suggestedGuestNightRates: {},
  cateringPreference: "NON_CATERED",
  schoolGroupSoftCap: 25,
  teachers: [{ firstName: "Tui", lastName: "Teacher", email: null }],
  linkedGuestMembers: [],
  contactFirstName: "Ada",
  contactLastName: "Lovelace",
  contactEmail: "ada@example.com",
  contactPhone: null,
  checkIn: "2026-08-01",
  checkOut: "2026-08-03",
  guests: [
    { firstName: "Tui", lastName: "Teacher", ageTier: "ADULT" },
    ...Array.from({ length: 4 }, (_, index) => ({
      firstName: "School Child",
      lastName: String(index + 1),
      ageTier: "YOUTH",
    })),
  ],
  message: null,
  indicativePriceCents: null,
  priceCents: null,
  verifiedAt: "2026-07-01T00:00:00.000Z",
  pricedAt: null,
  pricedByMemberId: null,
  pricedByMemberName: null,
  reviewedAt: null,
  reviewedByMemberId: null,
  reviewedByMemberName: null,
  declineReason: null,
  convertedBookingId: null,
  attendeesConfirmedAt: null,
  convertedMemberId: null,
  heldBookingId: null,
  heldBookingStatus: null,
  acceptedQuoteOptionId: null,
  acceptedPriceCents: null,
  acceptedAt: null,
  responseMessage: null,
  responseMessageAt: null,
  latestQuote: null,
  createdAt: "2026-07-01T00:00:00.000Z",
};

/**
 * Serve the queue, and record every POST the panel makes.
 *
 * `served` is re-read on every queue fetch, so a test can change what the
 * server returns after a successful save — which is how the "clears the local
 * edit" assertion below can tell a cleared box from a box that merely happens
 * to still show the same number.
 */
function mockFetch(request: unknown) {
  const served = { current: request };
  const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      String(url).includes("/quote") ? {} : { data: [served.current] },
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return Object.assign(fetchMock, { served });
}

function sendQuoteBody(fetchMock: ReturnType<typeof mockFetch>) {
  const call = fetchMock.mock.calls.find(([url]) =>
    String(url).endsWith("/send-quote"),
  );
  const init = call?.[1] as RequestInit | undefined;
  return init?.body ? JSON.parse(String(init.body)) : null;
}

function quoteBody(fetchMock: ReturnType<typeof mockFetch>) {
  const call = fetchMock.mock.calls.find(
    ([url]) =>
      String(url).endsWith("/quote") && !String(url).endsWith("/send-quote"),
  );
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : null;
}

/** The single Non-catered option's total field (the request's catering preference). */
async function enterTotal(value: string) {
  const field = await screen.findByLabelText(/^Total \(/);
  fireEvent.change(field, { target: { value } });
}

async function editYouthCount(value: string) {
  const box = await screen.findByLabelText("Youth");
  fireEvent.change(box, { target: { value } });
}

describe("PublicBookingRequestsPanel school group numbers on Save quote (#3412)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the officer's adjusted counts with the quote", async () => {
    // The live defect: the panel read "= 20 total" and posted nothing about it,
    // so the quote was priced from the stored list.
    const fetchMock = mockFetch(baseSchoolRequest);
    render(<PublicBookingRequestsPanel />);

    await editYouthCount("2");
    await enterTotal("105.00");
    fireEvent.click(await screen.findByRole("button", { name: "Save quote" }));

    await waitFor(() => expect(quoteBody(fetchMock)).not.toBeNull());
    expect(quoteBody(fetchMock).childCounts).toEqual({
      INFANT: 0,
      CHILD: 0,
      YOUTH: 2,
    });
  });

  it("sends no counts when the officer did not touch the boxes", async () => {
    const fetchMock = mockFetch(baseSchoolRequest);
    render(<PublicBookingRequestsPanel />);

    await enterTotal("105.00");
    fireEvent.click(await screen.findByRole("button", { name: "Save quote" }));

    await waitFor(() => expect(quoteBody(fetchMock)).not.toBeNull());
    expect(quoteBody(fetchMock)).not.toHaveProperty("childCounts");
  });

  it("says why a count change cannot be saved while beds are held, and does not offer the click", async () => {
    const fetchMock = mockFetch({
      ...baseSchoolRequest,
      heldBookingId: "booking-held",
      heldBookingStatus: "AWAITING_REVIEW",
    });
    render(<PublicBookingRequestsPanel />);

    await editYouthCount("2");

    expect(
      await screen.findByText(/Beds are held for this request's current numbers/i),
    ).toBeTruthy();
    const saveQuote = await screen.findByRole("button", { name: "Save quote" });
    expect((saveQuote as HTMLButtonElement).disabled).toBe(true);
    expect(quoteBody(fetchMock)).toBeNull();
  });

  it("offers a rate box for every age group the adjusted numbers contain", async () => {
    // The stored group is youth; the officer re-counts them as children. Read
    // from the stored list, the per guest-night editor would offer no child
    // rate at all and the save would fail on a missing one.
    mockFetch(baseSchoolRequest);
    render(<PublicBookingRequestsPanel />);

    const pricingMode = (await screen.findAllByTestId("select")).find((node) =>
      node.textContent?.includes("Per guest-night"),
    );
    expect(pricingMode).toBeTruthy();
    fireEvent.change(pricingMode!, { target: { value: "PER_GUEST_NIGHT" } });

    expect(await screen.findByLabelText("YOUTH non-member")).toBeTruthy();

    await editYouthCount("0");
    fireEvent.change(await screen.findByLabelText("Children"), {
      target: { value: "3" },
    });

    expect(await screen.findByLabelText("CHILD non-member")).toBeTruthy();
    expect(screen.queryByLabelText("YOUTH non-member")).toBeNull();
    // The named teacher is still there, so the adult rate stays.
    expect(await screen.findByLabelText("ADULT non-member")).toBeTruthy();
  });

  it("holds the beds only once the change is saved", async () => {
    mockFetch(baseSchoolRequest);
    render(<PublicBookingRequestsPanel />);

    const holdSlots = await screen.findByRole("button", { name: "Hold slots" });
    expect((holdSlots as HTMLButtonElement).disabled).toBe(false);

    // With an unsaved change, holding would reserve the count being replaced —
    // and beds held for it then refuse the save.
    await editYouthCount("2");
    expect((holdSlots as HTMLButtonElement).disabled).toBe(true);
    expect(
      await screen.findByText(
        /Hold slots and Send quote are off until you save the quote/i,
      ),
    ).toBeTruthy();
  });

  /*
   * #3412 review (F8) — "clears the local edit once saved" is named in the
   * issue and in the pull request, and was pinned by nothing.
   *
   * A probe proved it: `if (false && childCounts)` around the clear left all
   * five panel tests green. It is what stands between the officer and a stale
   * override that keeps winning over the server's numbers and re-posts itself
   * on every later action — including an Approve long after they moved on.
   */
  it("drops the local edit once the save lands, and reads the saved numbers back", async () => {
    const fetchMock = mockFetch(baseSchoolRequest);
    render(<PublicBookingRequestsPanel />);

    await editYouthCount("2");
    await enterTotal("105.00");
    // The server accepted the change, so the queue now serves the new party.
    fetchMock.served.current = {
      ...baseSchoolRequest,
      guests: [
        { firstName: "Tui", lastName: "Teacher", ageTier: "ADULT" },
        ...Array.from({ length: 2 }, (_, index) => ({
          firstName: "School Child",
          lastName: String(index + 1),
          ageTier: "YOUTH",
        })),
      ],
    };
    fireEvent.click(await screen.findByRole("button", { name: "Save quote" }));

    await waitFor(() => expect(quoteBody(fetchMock)).not.toBeNull());
    // The box shows what was SAVED, and — because the local edit is gone — the
    // card no longer reads as carrying an unsaved change, so Hold slots is live
    // again and nothing would re-post the override.
    await waitFor(() =>
      expect((screen.getByLabelText("Youth") as HTMLInputElement).value).toBe("2"),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Hold slots" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  /*
   * #3412 review (B1) — Send quote is the other button that holds beds.
   *
   * Save a quote, adjust Youth, press Send: the beds and the school's email
   * both come from the party stored on the request. That is the reported defect
   * one button over, and Send had no count term at all.
   */
  it("will not send a quote while the group numbers are unsaved", async () => {
    const fetchMock = mockFetch({
      ...baseSchoolRequest,
      latestQuote: {
        id: "quote-1",
        version: 1,
        status: "DRAFT",
        pricingMode: "OVERALL_TOTAL",
        sentAt: null,
        responseTokenExpiresAt: null,
        options: [],
      },
    });
    render(<PublicBookingRequestsPanel />);

    const sendQuote = await screen.findByRole("button", { name: "Send quote" });
    expect((sendQuote as HTMLButtonElement).disabled).toBe(false);

    await editYouthCount("2");
    expect((sendQuote as HTMLButtonElement).disabled).toBe(true);
    expect(sendQuoteBody(fetchMock)).toBeNull();
  });

  it("posts the numbers on screen with a send, so the service can refuse a stale one", async () => {
    const fetchMock = mockFetch({
      ...baseSchoolRequest,
      latestQuote: {
        id: "quote-1",
        version: 1,
        status: "DRAFT",
        pricingMode: "OVERALL_TOTAL",
        sentAt: null,
        responseTokenExpiresAt: null,
        options: [],
      },
    });
    render(<PublicBookingRequestsPanel />);

    // Typing the stored numbers back leaves Send live — the panel posts the
    // override whenever a box was touched at all, and the service compares.
    // (Away and back: React fires no change event for a value that did not
    // move, so setting 4 on a box already reading 4 would touch nothing.)
    await editYouthCount("2");
    await editYouthCount("4");
    fireEvent.click(await screen.findByRole("button", { name: "Send quote" }));

    await waitFor(() => expect(sendQuoteBody(fetchMock)).not.toBeNull());
    expect(sendQuoteBody(fetchMock).childCounts).toEqual({
      INFANT: 0,
      CHILD: 0,
      YOUTH: 4,
    });
  });

  /*
   * #3412 review (F7) — the 422 got neither a warning nor a disabled button,
   * though the 409 got both.
   */
  it("names the member and the row when the new numbers would move a member link", async () => {
    const fetchMock = mockFetch({
      ...baseSchoolRequest,
      // Index 2 is the second school child: a row the regeneration renumbers.
      linkedGuestMembers: [{ guestIndex: 2, memberId: "member-1" }],
    });
    render(<PublicBookingRequestsPanel />);

    // Youth become children: every child row changes tier from index 1 on, so
    // the link at index 2 would land on a different person's bed.
    await editYouthCount("0");
    fireEvent.change(await screen.findByLabelText("Children"), {
      target: { value: "3" },
    });

    // The warning names the ROW in bold; the guest list below also prints that
    // name, so pick the emphasised one out of both.
    const named = await screen.findAllByText("School Child 2");
    expect(named.some((node) => node.tagName === "STRONG")).toBe(true);
    expect(
      await screen.findByText(/renumber that row/i),
    ).toBeTruthy();
    const saveQuote = await screen.findByRole("button", { name: "Save quote" });
    expect((saveQuote as HTMLButtonElement).disabled).toBe(true);
    expect(quoteBody(fetchMock)).toBeNull();
  });

  it("leaves a link on a row the change does not touch alone", async () => {
    // Appending a fifth youth renumbers nothing: rows 0-4 are identical in both
    // lists, so the link at index 2 still means the same placeholder.
    mockFetch({
      ...baseSchoolRequest,
      linkedGuestMembers: [{ guestIndex: 2, memberId: "member-1" }],
    });
    render(<PublicBookingRequestsPanel />);

    await editYouthCount("5");
    await enterTotal("105.00");

    const saveQuote = await screen.findByRole("button", { name: "Save quote" });
    expect((saveQuote as HTMLButtonElement).disabled).toBe(false);
  });

  /*
   * #3412 review (F16) — panel and service drew the hold gate differently.
   *
   * The service blocks only a LIVE hold; a pointer left by a cancelled booking
   * reserves nothing and "must not trap the officer". Keyed on the pointer, the
   * panel disabled Save quote and sent the officer to Release hold, which 409s
   * on that same dead pointer — both doors shut on a save the service accepts.
   */
  it("does not treat a dangling hold pointer as held beds", async () => {
    mockFetch({
      ...baseSchoolRequest,
      heldBookingId: "booking-cancelled",
      heldBookingStatus: "CANCELLED",
    });
    render(<PublicBookingRequestsPanel />);

    await editYouthCount("2");

    const saveQuote = await screen.findByRole("button", { name: "Save quote" });
    expect((saveQuote as HTMLButtonElement).disabled).toBe(false);
    expect(
      screen.queryByText(/Beds are held for this request/i),
    ).toBeNull();
  });
});
