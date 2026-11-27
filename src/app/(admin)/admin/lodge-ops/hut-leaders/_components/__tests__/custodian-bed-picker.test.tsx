// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustodianBedPicker } from "../custodian-bed-picker";

/*
 * The custodian bed picker (#2286).
 *
 * It renders INSIDE the hut-leaders assignment form and, since #2286's review
 * M7, once per assignment row being edited. So its failure modes are the page's
 * failure modes, and each is deliberate rather than incidental:
 *
 *  - a malformed `rooms` payload must degrade to "no beds offered", never take
 *    the whole Hut Leaders page down (review L4: this shape tolerance had no
 *    test, so a refactor could have dropped it silently);
 *  - a 404 means the bedAllocation module is off — not an error, so the section
 *    stays out of the way entirely;
 *  - anything ELSE that fails must SAY it failed and offer a retry (review L6):
 *    an empty select is indistinguishable from "this lodge has no beds", so an
 *    admin would conclude there was nothing to hold;
 *  - each option names the bed TYPE, because holding a DOUBLE removes a
 *    two-person bed and the bed name alone never says which kind it is.
 */

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

const ROOMS = [
  {
    roomId: "room-1",
    roomName: "Kea",
    beds: [
      {
        bedId: "bed-1",
        bedName: "A1",
        bedType: "DOUBLE",
        roomId: "room-1",
        roomName: "Kea",
        available: true,
        allocatedNights: [],
        custodianHeldNights: [],
        heldByThisAssignment: false,
      },
      {
        bedId: "bed-2",
        bedName: "A2",
        bedType: "BUNK_TOP",
        roomId: "room-1",
        roomName: "Kea",
        available: false,
        allocatedNights: [],
        custodianHeldNights: ["2026-07-03"],
        heldByThisAssignment: false,
      },
    ],
  },
];

function renderPicker(onChange = vi.fn()) {
  render(
    <CustodianBedPicker
      lodgeId="lodge-1"
      startDate="2026-07-02"
      endDate="2026-07-04"
      value={null}
      onChange={onChange}
      canEdit
    />,
  );
  return onChange;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rooms: ROOMS }),
    }),
  );
});

describe("CustodianBedPicker", () => {
  it("names the bed TYPE alongside the bed, so a DOUBLE is visible before it is held", async () => {
    renderPicker();

    const option = await screen.findByRole("option", { name: /A1/ });
    expect(option).toHaveTextContent("double");
    // An unavailable bed is listed with the reason rather than hidden, in the
    // club's own word for the role.
    const blocked = screen.getByRole("option", { name: /A2/ });
    expect(blocked).toHaveTextContent("bunk top");
    expect(blocked).toHaveTextContent("held by another hut leader on 2026-07-03");
    expect(blocked).toBeDisabled();
  });

  it("renders nothing at all on a 404 — the module being off is not an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );
    const { container } = render(
      <CustodianBedPicker
        lodgeId="lodge-1"
        startDate="2026-07-02"
        endDate="2026-07-04"
        value={null}
        onChange={vi.fn()}
        canEdit
      />,
    );

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("degrades to an empty list rather than crashing on a malformed payload", async () => {
    // The shape tolerance (#2286 review L4): this picker is a child of the
    // assignment form, so an unexpected body must not take the page down.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({ rooms: "nope" }) }),
    );
    renderPicker();

    // The select still renders, with only the role-only choice.
    const select = await screen.findByRole("combobox");
    expect(select).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/no active beds set up/i)).toBeInTheDocument();
    });
  });

  it("SAYS a non-404 failure failed, and retries on demand", async () => {
    // #2286 review L6: before this, a 500 rendered an empty select that read as
    // "this lodge has no beds" — the opposite of the truth.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ rooms: ROOMS }) });
    vi.stubGlobal("fetch", fetchMock);
    renderPicker();

    const notice = await screen.findByText(/could not be loaded/i);
    expect(notice).toBeInTheDocument();
    // And it explicitly denies the wrong reading.
    expect(notice.textContent).toMatch(/NOT/);
    // The "no beds" message must NOT also be on screen — that is the confusion.
    expect(screen.queryByText(/no active beds set up/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /A1/ })).toBeInTheDocument();
    });
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });

  it("passes the assignmentId so an edit does not clash with its own hold", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rooms: ROOMS }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CustodianBedPicker
        lodgeId="lodge-1"
        startDate="2026-07-02"
        endDate="2026-07-04"
        value="bed-1"
        onChange={vi.fn()}
        assignmentId="a1"
        canEdit
      />,
    );

    await waitFor(() => {
      expect(String(fetchMock.mock.calls[0][0])).toContain("assignmentId=a1");
    });
  });

  it("reports a cleared selection as null, which is what RELEASES a hold", async () => {
    const onChange = renderPicker();
    const select = await screen.findByRole("combobox");

    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
