// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE } from "@/lib/booking-change-request-guests";
import { ChangeRequestCard } from "@/components/edit-booking/change-request-card";

/**
 * #4030 Part A: the in-progress "Admin Request" card names who the member is
 * asking to add — the guest editor's fields, nights inside the stay — shows the
 * estimate for them, and sends them as `addGuests`. A note alone cannot be sent.
 */

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const AGE_TIERS = [
  { tier: "CHILD" as const, label: "Child (5-9)", sortOrder: 1 },
  { tier: "ADULT" as const, label: "Adult (18+)", sortOrder: 3 },
];

function renderCard(overrides: Partial<Parameters<typeof ChangeRequestCard>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(true);
  const props: Parameters<typeof ChangeRequestCard>[0] = {
    reason: "",
    submitting: false,
    error: "",
    success: "",
    hasEditorChanges: false,
    editorChanges: {},
    guestContext: {
      booking: {
        id: "bk-1",
        checkIn: "2026-06-30",
        checkOut: "2026-07-03",
        guests: [{ memberId: "m-1" }] as never,
        memberGuest: undefined,
        editPolicy: { mode: "in-progress", today: "2026-07-01", editableFrom: "2026-07-02", checkInEditable: false },
      },
      ageTierOptions: AGE_TIERS,
      familyMembers: [
        { id: "m-1", firstName: "Ada", lastName: "Owner", ageTier: "ADULT", relationship: "self" },
        { id: "m-2", firstName: "Kit", lastName: "Owner", ageTier: "CHILD", relationship: "dependent" },
      ],
    },
    onReasonChange: vi.fn(),
    onSubmit,
    ...overrides,
  };
  const view = render(<ChangeRequestCard {...props} />);
  return { onSubmit, rerender: (changes: Partial<typeof props>) => view.rerender(<ChangeRequestCard {...props} {...changes} />) };
}

function addNonMember(firstName: string, lastName: string) {
  fireEvent.change(screen.getByLabelText("First name"), { target: { value: firstName } });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: lastName } });
  fireEvent.change(screen.getByLabelText("Age"), { target: { value: "CHILD" } });
  fireEvent.click(screen.getByRole("button", { name: "Add guest" }));
}

describe("ChangeRequestCard — structured guests (#4030)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        estimate: {
          outcome: "priced",
          guests: [{ priceCents: 6000, nights: 3 }],
          totalCents: 6000,
          excludesMemberGuests: false,
        },
      }),
    );
  });

  it("will not send a note on its own, and says what to add", () => {
    renderCard({ reason: "Can we add three grandchildren" });
    expect(screen.getByRole("button", { name: "Request Admin Review" })).toBeDisabled();
    expect(screen.getByText(/A note on its own can.t be applied/)).toBeInTheDocument();
  });

  it("sends the guests entered, with their nights inside the stay", async () => {
    const { onSubmit } = renderCard();
    addNonMember("Ari", "Example");
    const dateIn = screen.getByLabelText("Date In");
    expect(dateIn).toHaveAttribute("min", "2026-06-30");
    // #4030 review S3: no later than the last locked night (today).
    expect(dateIn).toHaveAttribute("max", "2026-07-01");
    expect(screen.getByLabelText("Date Out")).toHaveAttribute("max", "2026-07-03");
    fireEvent.change(dateIn, { target: { value: "2026-07-01" } });

    fireEvent.click(screen.getByRole("button", { name: "Request Admin Review" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith([
      {
        firstName: "Ari",
        lastName: "Example",
        ageTier: "CHILD",
        isMember: false,
        stayStart: "2026-07-01",
        stayEnd: "2026-07-03",
      },
    ]);
    // Accepted: the list is cleared.
    await waitFor(() => expect(screen.queryByText(/Ari Example/)).not.toBeInTheDocument());
  });

  it("links a family member by member id, and never offers someone already on the booking", async () => {
    const { onSubmit } = renderCard();
    expect(screen.queryByRole("button", { name: "+ Ada Owner" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ Kit Owner" }));
    fireEvent.click(screen.getByRole("button", { name: "Request Admin Review" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toEqual([
      expect.objectContaining({ isMember: true, memberId: "m-2", ageTier: "CHILD" }),
    ]);
  });

  it("shows the estimate for exactly the guests on screen", async () => {
    renderCard();
    addNonMember("Ari", "Example");
    expect(await screen.findByText(/Estimated price for these guests: \$60\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Adding guests carries no change fee/)).toBeInTheDocument();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/bookings/bk-1/change-requests/quote");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      editorChanges: {},
      addGuests: [expect.objectContaining({ firstName: "Ari", stayStart: "2026-06-30", stayEnd: "2026-07-03" })],
    });
  });

  it("sends the editor's added and removed guests with the card's, so the estimate counts the proposed party (#4203)", async () => {
    const editorChanges = {
      removeGuestIds: ["existing"],
      addGuests: [{ firstName: "Cam", lastName: "Owner", ageTier: "CHILD", isMember: true, memberId: "m-2" }],
    };
    renderCard({ editorChanges });
    addNonMember("Ari", "Example");
    await screen.findByText(/Estimated price for these guests/);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body))).toEqual({
      editorChanges,
      addGuests: [expect.objectContaining({ firstName: "Ari" })],
    });
  });

  it("retires an estimate and refusal when only the editor proposal changes (#4090)", async () => {
    const { rerender } = renderCard();
    addNonMember("Ari", "Example");
    await screen.findByText(/Estimated price for these guests/);
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE }, 400));
    rerender({ editorChanges: { checkOut: "2026-07-04" } });
    expect(screen.queryByText(/Estimated price for these guests/)).not.toBeInTheDocument();
    expect(screen.getByText("Working out the price...")).toBeInTheDocument();
    expect(await screen.findByText(CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE)).toBeInTheDocument();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body))).toMatchObject({
      editorChanges: { checkOut: "2026-07-04" },
      addGuests: [expect.objectContaining({ firstName: "Ari" })],
    });
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ estimate: {
      outcome: "priced", guests: [{ priceCents: 2000, nights: 1 }], totalCents: 2000, excludesMemberGuests: false,
    } }));
    rerender({ editorChanges: { checkOut: "2026-07-04", guestStayRanges: [{ guestId: "existing", nights: ["2026-07-03"] }] } });
    expect(screen.queryByText(CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE)).not.toBeInTheDocument();
    expect(await screen.findByText(/Estimated price for these guests: \$20\.00/)).toBeInTheDocument();
  });

  it("ignores a slow quote for an abandoned editor proposal", async () => {
    let finishOldQuote!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOldQuote = resolve; }));
    const { rerender } = renderCard();
    addNonMember("Ari", "Example");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE }, 400));
    rerender({ editorChanges: { checkOut: "2026-07-04" } });
    await screen.findByText(CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE);
    await act(async () => {
      finishOldQuote(jsonResponse({ estimate: {
        outcome: "priced", guests: [{ priceCents: 6000, nights: 3 }], totalCents: 6000, excludesMemberGuests: false,
      } }));
    });
    // The abandoned response cannot replace the current refusal with a stale
    // price or leave the card waiting for an answer it already received.
    await waitFor(() => expect(screen.getByText(CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE)).toBeInTheDocument());
    expect(screen.queryByText("Working out the price...")).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimated price for these guests/)).not.toBeInTheDocument();
  });

  it("lets a request carrying the editor's own change through with no card guests", () => {
    renderCard({ hasEditorChanges: true });
    expect(screen.getByRole("button", { name: "Request Admin Review" })).toBeEnabled();
  });

  it("keeps the list when the request was refused", async () => {
    const { onSubmit } = renderCard();
    onSubmit.mockResolvedValue(false);
    addNonMember("Ari", "Example");
    fireEvent.click(screen.getByRole("button", { name: "Request Admin Review" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(screen.getByText(/Ari Example/)).toBeInTheDocument();
  });

  it("says members are priced on approval, rather than $0.00, when nobody listed is priced (review M5)", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        estimate: { outcome: "priced", guests: [{ priceCents: null, nights: 3 }], totalCents: 0, excludesMemberGuests: true },
      }),
    );
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "+ Kit Owner" }));
    expect(
      await screen.findByText("Members are priced at their membership rate when the officer approves."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
  });

  it("offers the guest entry only on a stay under way, and words a future stay's request plainly (review S4)", () => {
    render(
      <ChangeRequestCard
        reason=""
        submitting={false}
        error=""
        success=""
        hasEditorChanges
        editorChanges={{}}
        guestContext={{
          booking: {
            id: "bk-1",
            checkIn: "2026-08-10",
            checkOut: "2026-08-12",
            guests: [] as never,
            memberGuest: undefined,
            editPolicy: { mode: "future", today: "2026-07-01", editableFrom: "2026-08-10", checkInEditable: true },
          },
          ageTierOptions: AGE_TIERS,
          familyMembers: [],
        }}
        onReasonChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("First name")).toBeNull();
    expect(screen.queryByText(/tonight or earlier/)).toBeNull();
    expect(screen.getByText(/needs the booking officer.s approval/)).toBeInTheDocument();
  });

  it("groups the added rows and the family buttons for assistive tech (review S5)", () => {
    renderCard();
    expect(screen.getByRole("group", { name: "Add a family member" })).toBeInTheDocument();
    addNonMember("Ari", "Example");
    expect(screen.getByRole("group", { name: "Guests to add" })).toBeInTheDocument();
  });
});
