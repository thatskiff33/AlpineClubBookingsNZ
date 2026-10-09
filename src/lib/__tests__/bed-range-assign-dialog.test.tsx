// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClubIdentityProvider } from "@/components/club-identity-provider";
import { clubIdentity } from "@/config/club-identity";
import {
  BedRangeAssignDialog,
  rangeAssignError,
  type BedRangeAssignTarget,
} from "@/components/admin/bed-range-assign-dialog";

const fetchMock = vi.fn();
const toastError = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: (props: ComponentProps<"label">) => <label {...props} />,
}));

const target: BedRangeAssignTarget = {
  bookingGuestId: "guest-1",
  bookingId: "booking-1",
  guestName: "Range Guest",
  memberName: "Range Member",
  bedId: "bed-1",
  fromDate: "2026-06-01",
  toDate: "2026-06-06",
};

const bedOptionGroups = [
  { roomId: "room-1", roomName: "Room One", beds: [{ id: "bed-1", bedName: "Bed One" }] },
];

// The dialog reads the club's own word for a hut leader (#2286): admin copy is
// label-driven, only the lobby TV is pinned to the fixed word "Custodian". The
// provider is always mounted above this component in the app shell.
function renderDialog(
  overrides: { onAssigned?: () => void; hutLeaderLabel?: string } = {},
) {
  const onAssigned = overrides.onAssigned ?? vi.fn();
  render(
    <ClubIdentityProvider
      value={{
        ...clubIdentity,
        ...(overrides.hutLeaderLabel
          ? { hutLeaderLabel: overrides.hutLeaderLabel }
          : {}),
      }}
    >
      <BedRangeAssignDialog
        open
        onOpenChange={vi.fn()}
        target={target}
        bedOptionGroups={bedOptionGroups}
        canEdit
        onAssigned={onAssigned}
      />
    </ClubIdentityProvider>,
  );
  return { onAssigned };
}

function refusalResponse(status: number, result: Record<string, unknown>) {
  return {
    ok: false,
    status,
    json: async () => ({ error: "Nothing was written", result }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

describe("BedRangeAssignDialog", () => {
  it("shows the range summary and warns that assigning approves the beds", () => {
    renderDialog();

    expect(screen.getByTestId("range-summary")).toHaveTextContent(
      "5 nights · first night 2026-06-01 · last night 2026-06-05",
    );
    // Under auto-approve, the member lock fires on the FIRST range assign.
    expect(
      screen.getByText(/locks this booking's member out of changing/i),
    ).toBeInTheDocument();
  });

  it("attempts the whole range with no preview step", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          applied: true,
          partialByConsent: false,
          bookingId: "booking-1",
          bookingGuestId: "guest-1",
          guestName: "Range Guest",
          bedId: "bed-1",
          bedName: "Bed One",
          roomName: "Room One",
          fromDate: "2026-06-01",
          toDate: "2026-06-06",
          requestedNights: [],
          freeNights: [],
          writtenNights: ["2026-06-01"],
          refusals: [],
        },
      }),
    });
    const { onAssigned } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));

    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/bed-allocation/allocations/range");
    expect(JSON.parse(init.body)).toEqual({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
    });
  });

  it("renders all three refusal categories distinctly and arms the free-nights action", async () => {
    fetchMock.mockResolvedValueOnce(
      refusalResponse(400, {
        applied: false,
        partialByConsent: false,
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        guestName: "Range Guest",
        bedId: "bed-1",
        bedName: "Bed One",
        roomName: "Room One",
        fromDate: "2026-06-01",
        toDate: "2026-06-06",
        requestedNights: [
          "2026-06-01",
          "2026-06-02",
          "2026-06-03",
          "2026-06-04",
          "2026-06-05",
        ],
        freeNights: ["2026-06-01", "2026-06-05"],
        writtenNights: [],
        refusals: [
          {
            stayDate: "2026-06-02",
            category: "BED_TAKEN",
            occupiedBy: {
              guestName: "Other Guest",
              memberName: "Other Member",
              bookingId: "booking-other",
              holdsCapacity: false,
            },
          },
          { stayDate: "2026-06-03", category: "GUEST_NOT_BOOKED" },
          {
            stayDate: "2026-06-04",
            category: "EXCLUSIVE_HOLD",
            hold: {
              bookingId: "booking-1",
              memberName: "Own Member",
              ownBooking: true,
            },
          },
        ],
      }),
    );
    const { onAssigned } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));

    await screen.findByTestId("range-refusal-report");
    // Nothing was applied, so the dialog stays open with the evidence.
    expect(onAssigned).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Nothing was written — 3 of 5 nights are blocked/),
    ).toBeInTheDocument();

    // Three distinct categories, never merged into "skipped".
    const bedTaken = screen.getByTestId("refusal-category-BED_TAKEN");
    expect(bedTaken).toHaveTextContent("Bed already allocated");
    expect(bedTaken).toHaveTextContent("Other Guest");
    // Provisional occupant: still a conflict, badged as not holding.
    expect(bedTaken).toHaveTextContent("Provisional");

    const notBooked = screen.getByTestId("refusal-category-GUEST_NOT_BOOKED");
    expect(notBooked).toHaveTextContent("Guest is not booked that night");
    expect(notBooked).toHaveTextContent(/not a clash/i);

    const hold = screen.getByTestId("refusal-category-EXCLUSIVE_HOLD");
    expect(hold).toHaveTextContent("Whole-lodge hold");
    expect(hold).toHaveTextContent("This booking holds the whole lodge");

    // The second action is explicit, states the exact count, and is the only
    // way a partial result can happen. This report contains a GUEST_NOT_BOOKED
    // night, so it asks before writing (#2251 residual R2).
    fireEvent.click(
      screen.getByRole("button", { name: /^Assign the 2 free nights…$/ }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const confirmation = screen.getByTestId("range-skip-confirmation");
    expect(confirmation).toHaveTextContent(
      "1 night is not part of this guest's booking and will NOT be assigned",
    );
    expect(confirmation).toHaveTextContent("Assign the 2 free nights anyway?");

    const freeNightsButton = screen.getByRole("button", {
      name: "Yes, assign the 2 free nights",
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          applied: true,
          partialByConsent: true,
          bookingId: "booking-1",
          bookingGuestId: "guest-1",
          guestName: "Range Guest",
          bedId: "bed-1",
          bedName: "Bed One",
          roomName: "Room One",
          fromDate: "2026-06-01",
          toDate: "2026-06-06",
          requestedNights: [],
          freeNights: [],
          writtenNights: ["2026-06-01", "2026-06-05"],
          refusals: [],
        },
      }),
    });
    fireEvent.click(freeNightsButton);

    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1));
    // The second action sends the EXACT nights the report showed as free, not a
    // flag for the server to re-derive from (#2251 review A6/B5): what the admin
    // saw is what gets written, and a night taken in the meantime refuses the
    // whole thing instead of silently dropping out.
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      from: "2026-06-01",
      to: "2026-06-06",
      nights: ["2026-06-01", "2026-06-05"],
    });
  });

  /*
   * #2251 residual R2: GUEST_NOT_BOOKED is the one refusal category that means
   * the REQUEST is wrong rather than the bed being busy, so proceeding past it is
   * gated on an explicit confirmation naming both counts. A clash-only report has
   * no such gate — the free nights are simply the ones that are free.
   */
  it("writes the free nights with no extra step when a clash is the only blocker", async () => {
    fetchMock.mockResolvedValueOnce(
      refusalResponse(409, {
        applied: false,
        partialByConsent: false,
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        guestName: "Range Guest",
        bedId: "bed-1",
        bedName: "Bed One",
        roomName: "Room One",
        fromDate: "2026-06-01",
        toDate: "2026-06-06",
        requestedNights: [
          "2026-06-01",
          "2026-06-02",
          "2026-06-03",
          "2026-06-04",
          "2026-06-05",
        ],
        freeNights: ["2026-06-01", "2026-06-02", "2026-06-04", "2026-06-05"],
        writtenNights: [],
        refusals: [{ stayDate: "2026-06-03", category: "BED_TAKEN" }],
      }),
    );
    const { onAssigned } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));
    await screen.findByTestId("range-refusal-report");

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          applied: true,
          partialByConsent: true,
          bookingId: "booking-1",
          bookingGuestId: "guest-1",
          guestName: "Range Guest",
          bedId: "bed-1",
          bedName: "Bed One",
          roomName: "Room One",
          fromDate: "2026-06-01",
          toDate: "2026-06-06",
          requestedNights: [],
          freeNights: [],
          writtenNights: [
            "2026-06-01",
            "2026-06-02",
            "2026-06-04",
            "2026-06-05",
          ],
          refusals: [],
        },
      }),
    });
    // One click, straight to the write: no confirmation step is inserted.
    fireEvent.click(
      screen.getByRole("button", { name: "Assign the 4 free nights" }),
    );

    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByTestId("range-skip-confirmation"),
    ).not.toBeInTheDocument();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).nights).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-04",
      "2026-06-05",
    ]);
  });

  it("asks before skipping nights the guest is not booked on, and can be backed out of", async () => {
    fetchMock.mockResolvedValueOnce(
      refusalResponse(400, {
        applied: false,
        partialByConsent: false,
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        guestName: "Range Guest",
        bedId: "bed-1",
        bedName: "Bed One",
        roomName: "Room One",
        fromDate: "2026-06-01",
        toDate: "2026-06-06",
        requestedNights: [
          "2026-06-01",
          "2026-06-02",
          "2026-06-03",
          "2026-06-04",
          "2026-06-05",
        ],
        freeNights: ["2026-06-01", "2026-06-02", "2026-06-03"],
        writtenNights: [],
        refusals: [
          { stayDate: "2026-06-04", category: "GUEST_NOT_BOOKED" },
          { stayDate: "2026-06-05", category: "GUEST_NOT_BOOKED" },
        ],
      }),
    );
    const { onAssigned } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));
    await screen.findByTestId("range-refusal-report");

    fireEvent.click(
      screen.getByRole("button", { name: /^Assign the 3 free nights…$/ }),
    );
    const confirmation = screen.getByTestId("range-skip-confirmation");
    expect(confirmation).toHaveTextContent(
      "2 nights are not part of this guest's booking and will NOT be assigned",
    );
    expect(confirmation).toHaveTextContent("Assign the 3 free nights anyway?");
    // Nothing is sent by arming the gate.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onAssigned).not.toHaveBeenCalled();

    // Consent is reversible: the report stays, the gate closes, nothing is sent.
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(
      screen.queryByTestId("range-skip-confirmation"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("range-refusal-report")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Yes, assign the 3 free nights" }),
    ).not.toBeInTheDocument();

    // Editing the dates drops the gate with the report it belongs to, so an
    // armed consent can never be spent on a different range.
    fireEvent.click(
      screen.getByRole("button", { name: /^Assign the 3 free nights…$/ }),
    );
    expect(screen.getByTestId("range-skip-confirmation")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Date Out (checkout)"), {
      target: { value: "2026-06-04" },
    });
    expect(
      screen.queryByTestId("range-skip-confirmation"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("range-refusal-report")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /*
   * The consent gate belongs to ONE report. A yes armed against report A must
   * never survive into report B — otherwise the click after a re-attempt writes
   * a night set the admin never confirmed.
   */
  it("re-arms the gate for a fresh refusal instead of inheriting the previous yes", async () => {
    const refusal = (freeNights: string[]) =>
      refusalResponse(400, {
        applied: false,
        partialByConsent: false,
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        guestName: "Range Guest",
        bedId: "bed-1",
        bedName: "Bed One",
        roomName: "Room One",
        fromDate: "2026-06-01",
        toDate: "2026-06-06",
        requestedNights: [
          "2026-06-01",
          "2026-06-02",
          "2026-06-03",
          "2026-06-04",
          "2026-06-05",
        ],
        freeNights,
        writtenNights: [],
        refusals: [{ stayDate: "2026-06-05", category: "GUEST_NOT_BOOKED" }],
      });

    fetchMock.mockResolvedValueOnce(
      refusal(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"]),
    );
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));
    await screen.findByTestId("range-refusal-report");
    fireEvent.click(
      screen.getByRole("button", { name: /^Assign the 4 free nights…$/ }),
    );
    expect(screen.getByTestId("range-skip-confirmation")).toBeInTheDocument();

    // A second all-nights attempt comes back refused again, with a DIFFERENT
    // free set. The gate must close, so the next click cannot write the new set
    // on the strength of the yes given for the old one.
    fetchMock.mockResolvedValueOnce(refusal(["2026-06-01", "2026-06-02"]));
    fireEvent.click(
      screen.getByRole("button", { name: /^Try all nights again$/ }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Assign the 2 free nights…$/ }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("range-skip-confirmation"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Yes, assign/ }),
    ).not.toBeInTheDocument();
    // Two attempts sent, neither of them a night list.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(call[1].body).nights).toBeUndefined();
    }
  });

  it("offers no free-nights action when every night is blocked", async () => {
    fetchMock.mockResolvedValue(
      refusalResponse(409, {
        applied: false,
        partialByConsent: false,
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        guestName: "Range Guest",
        bedId: "bed-1",
        bedName: "Bed One",
        roomName: "Room One",
        fromDate: "2026-06-01",
        toDate: "2026-06-06",
        requestedNights: ["2026-06-01"],
        freeNights: [],
        writtenNights: [],
        refusals: [
          {
            stayDate: "2026-06-01",
            category: "EXCLUSIVE_HOLD",
            hold: {
              bookingId: "booking-1",
              memberName: "Own Member",
              ownBooking: true,
            },
          },
        ],
      }),
    );
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));

    await screen.findByTestId("range-refusal-report");
    expect(
      screen.getByText(/No night in this range is free/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /free night/ }),
    ).not.toBeInTheDocument();
    // The only hold this endpoint refuses on is the guest's OWN booking's.
    expect(
      screen.getByTestId("refusal-category-EXCLUSIVE_HOLD"),
    ).toHaveTextContent("This booking holds the whole lodge");
  });

  it("drops a refusal report once the range is edited, so stale evidence is never read", async () => {
    fetchMock.mockResolvedValue(
      refusalResponse(409, {
        applied: false,
        partialByConsent: false,
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        guestName: "Range Guest",
        bedId: "bed-1",
        bedName: "Bed One",
        roomName: "Room One",
        fromDate: "2026-06-01",
        toDate: "2026-06-06",
        requestedNights: ["2026-06-01"],
        freeNights: ["2026-06-01"],
        writtenNights: [],
        refusals: [{ stayDate: "2026-06-02", category: "BED_TAKEN" }],
      }),
    );
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));
    await screen.findByTestId("range-refusal-report");

    fireEvent.change(screen.getByLabelText("Date Out (checkout)"), {
      target: { value: "2026-06-04" },
    });

    expect(screen.queryByTestId("range-refusal-report")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /free night/ }),
    ).not.toBeInTheDocument();
  });

  it("refuses an over-long range on the client rather than shortening it", () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText("Date Out (checkout)"), {
      target: { value: "2028-06-01" },
    });

    // The typed dates stay exactly as typed; the button is blocked instead.
    expect(screen.getByLabelText("Date Out (checkout)")).toHaveValue("2028-06-01");
    expect(screen.getByText(/covers at most 366 nights/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Assign/ })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not build a night list for a range it has already refused", () => {
    renderDialog();

    // A slipped keystroke in a year field. Counting this arithmetically is the
    // difference between an instant error and building a Date per night for the
    // next thousand years.
    fireEvent.change(screen.getByLabelText("Date Out (checkout)"), {
      target: { value: "3026-06-01" },
    });

    expect(screen.getByText(/covers at most 366 nights/)).toBeInTheDocument();
    expect(screen.getByTestId("range-summary")).toHaveTextContent(
      "No nights selected yet.",
    );
    expect(screen.getByRole("button", { name: /^Assign$/ })).toBeDisabled();
  });
});

describe("BedRangeAssignDialog refusal categories (#2286)", () => {
  // Regression guard for the drift class this dialog used to have: it declared
  // its OWN three-member category union while the server emitted four, so a
  // CUSTODIAN_HOLD night was counted in the "N of M nights are blocked" banner
  // and then rendered nowhere. The types are now imported from the server, and
  // this test walks EVERY category the server can emit.
  const MIXED_REFUSAL = {
    applied: false,
    partialByConsent: false,
    bookingId: "booking-1",
    bookingGuestId: "guest-1",
    guestName: "Range Guest",
    bedId: "bed-1",
    bedName: "Bed One",
    roomName: "Room One",
    fromDate: "2026-06-01",
    toDate: "2026-06-06",
    requestedNights: [
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
    ],
    freeNights: ["2026-06-05"],
    writtenNights: [],
    refusals: [
      {
        stayDate: "2026-06-01",
        category: "EXCLUSIVE_HOLD",
        hold: {
          bookingId: "booking-1",
          memberName: "Own Member",
          ownBooking: true,
        },
      },
      { stayDate: "2026-06-02", category: "GUEST_NOT_BOOKED" },
      { stayDate: "2026-06-03", category: "CUSTODIAN_HOLD" },
      {
        stayDate: "2026-06-04",
        category: "BED_TAKEN",
        occupiedBy: {
          guestName: "Other Guest",
          memberName: "Other Member",
          bookingId: "booking-other",
          holdsCapacity: true,
        },
      },
    ],
  };

  it("renders one night of EVERY server category, so the banner count and the list agree", async () => {
    fetchMock.mockResolvedValueOnce(refusalResponse(409, MIXED_REFUSAL));
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));
    await screen.findByTestId("range-refusal-report");

    expect(
      screen.getByText(/Nothing was written — 4 of 5 nights are blocked/),
    ).toBeInTheDocument();

    // Four blocks for four blocked nights — the count in the banner is the
    // number of nights the admin can actually read below it.
    for (const category of [
      "CUSTODIAN_HOLD",
      "BED_TAKEN",
      "GUEST_NOT_BOOKED",
      "EXCLUSIVE_HOLD",
    ]) {
      expect(screen.getByTestId(`refusal-category-${category}`)).toBeVisible();
    }
    const listedNights = screen
      .getAllByTestId(/^refusal-category-/)
      .flatMap((block) => Array.from(block.querySelectorAll("li")))
      .map((item) => item.textContent ?? "");
    expect(listedNights).toHaveLength(4);
    expect(listedNights.join(" ")).toContain("2026-06-03");
  });

  it("puts the custodian block above the clashes and names the page that fixes it", async () => {
    fetchMock.mockResolvedValueOnce(refusalResponse(409, MIXED_REFUSAL));
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));
    await screen.findByTestId("range-refusal-report");

    const custodian = screen.getByTestId("refusal-category-CUSTODIAN_HOLD");
    // The club's own label, not a hardcoded "Custodian": only the lobby TV is
    // pinned to the fixed word.
    expect(custodian).toHaveTextContent(
      `Held for a ${clubIdentity.hutLeaderLabel.toLowerCase()}`,
    );
    // The fix is on another page, so the block has to say which one.
    expect(custodian).toHaveTextContent(
      new RegExp(`${clubIdentity.hutLeaderLabel} Assignments page`),
    );
    expect(custodian).toHaveTextContent("no booking behind it");

    // Display order: the block whose fix is elsewhere leads, so it is never
    // buried under a list of clashes on this page.
    const order = screen
      .getAllByTestId(/^refusal-category-/)
      .map((block) => block.getAttribute("data-testid"));
    expect(order).toEqual([
      "refusal-category-CUSTODIAN_HOLD",
      "refusal-category-BED_TAKEN",
      "refusal-category-GUEST_NOT_BOOKED",
      "refusal-category-EXCLUSIVE_HOLD",
    ]);
  });

  it("uses the club's own word for the role in the custodian block", async () => {
    fetchMock.mockResolvedValueOnce(refusalResponse(409, MIXED_REFUSAL));
    renderDialog({ hutLeaderLabel: "Warden" });

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));
    await screen.findByTestId("range-refusal-report");

    const custodian = screen.getByTestId("refusal-category-CUSTODIAN_HOLD");
    expect(custodian).toHaveTextContent("Held for a warden");
    expect(custodian).toHaveTextContent("Warden Assignments page");
    expect(custodian).toHaveTextContent("(Admin → Wardens)");
    expect(custodian).not.toHaveTextContent(/custodian/i);
  });

  it("names the sidebar entry without doubling the s on a plural label (#3976)", async () => {
    fetchMock.mockResolvedValueOnce(refusalResponse(409, MIXED_REFUSAL));
    renderDialog({ hutLeaderLabel: "Hut Leaders" });

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));
    await screen.findByTestId("range-refusal-report");

    const custodian = screen.getByTestId("refusal-category-CUSTODIAN_HOLD");
    expect(custodian).toHaveTextContent("(Admin → Hut Leaders)");
    expect(custodian).not.toHaveTextContent("Hut Leaderss");
  });

  it("RENDERS a category it has never heard of rather than dropping the nights", async () => {
    // Deploy drain: a new server answering an old browser bundle. Dropping the
    // block would print a blocked-night count above a shorter list, which is a
    // worse failure than an unstyled row.
    fetchMock.mockResolvedValueOnce(
      refusalResponse(409, {
        ...MIXED_REFUSAL,
        freeNights: ["2026-06-01"],
        refusals: [{ stayDate: "2026-06-02", category: "SOMETHING_NEW" }],
      }),
    );
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^Assign 5 nights$/ }));
    await screen.findByTestId("range-refusal-report");

    const unknown = screen.getByTestId("refusal-category-SOMETHING_NEW");
    expect(unknown).toHaveTextContent("Blocked for another reason");
    expect(unknown).toHaveTextContent("2026-06-02");
    expect(unknown).toHaveTextContent(/reload the page/i);
  });
});

describe("rangeAssignError", () => {
  it("accepts a well-formed range of any length up to the cap", () => {
    expect(rangeAssignError("2026-06-01", "2026-09-01")).toBeNull();
  });

  it("refuses a backwards range and an over-long one", () => {
    expect(rangeAssignError("2026-06-08", "2026-06-01")).toBe(
      "Date out must be after date in.",
    );
    expect(rangeAssignError("2026-01-01", "2027-06-01")).toContain(
      "at most 366 nights",
    );
  });
});
