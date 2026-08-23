// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  CLUB_TIME_TEST_ZONE,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
  #2259 (owner decision D10) — the per-booking "No emails" switch, admin side.

  The acknowledgement is the ONLY thing paying for D10's "everything is
  suppressible". These tests pin it as a mechanism rather than as copy: the POST
  that turns the switch on must carry `acknowledged: true`, and it must not
  happen until the admin has answered the dialog. Delete the acknowledgement
  from the flow and the first test fails on the request body, not on wording.
*/

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
  },
}));
// The control gates on useAdminAreaEditAccess("bookings"); an all-edit admin
// keeps the button enabled so the flow assertions below are about the dialog.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

import { BookingNoEmailsControls } from "@/components/admin/booking-no-emails-controls";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";

type FetchCall = { url: string; method: string; body: unknown };
let fetchCalls: FetchCall[];

function installFetch(response: { ok?: boolean; body?: unknown } = {}) {
  fetchCalls = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    let parsed: unknown;
    if (typeof init?.body === "string") parsed = JSON.parse(init.body);
    fetchCalls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: parsed,
    });
    return {
      ok: response.ok ?? true,
      json: async () => response.body ?? { success: true },
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderControls(props: Partial<{
  noEmails: boolean;
  noEmailsAt: string | null;
  setByName: string | null;
  hasLiveWaitlistOffer: boolean;
  isWaitlisted: boolean;
}> = {}) {
  return render(
    <BookingNoEmailsControls
      bookingId="bk-1"
      noEmails={props.noEmails ?? false}
      noEmailsAt={props.noEmailsAt ?? null}
      setByName={props.setByName ?? null}
      hasLiveWaitlistOffer={props.hasLiveWaitlistOffer ?? false}
      isWaitlisted={props.isWaitlisted ?? false}
    />,
  );
}

describe("BookingNoEmailsControls (#2259)", () => {
  it("does not POST until the acknowledgement is given, then sends acknowledged: true", async () => {
    const fetchMock = installFetch();
    renderControls();

    fireEvent.click(
      screen.getByRole("button", { name: "Turn off all emails" }),
    );

    // The dialog is open and NOTHING has been written yet.
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        /No emails will be sent for this booking, including cancellation notices and payment reminders/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /You are responsible for telling the member directly/i,
      ),
    ).toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Yes — I will tell the member myself",
      }),
    );

    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].url).toBe("/api/admin/bookings/bk-1/no-emails");
    expect(fetchCalls[0].method).toBe("POST");
    // The acknowledgement itself — not the wording of it.
    expect(fetchCalls[0].body).toEqual({ noEmails: true, acknowledged: true });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("writes nothing when the acknowledgement dialog is cancelled", async () => {
    const fetchMock = installFetch();
    renderControls();

    fireEvent.click(
      screen.getByRole("button", { name: "Turn off all emails" }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("warns about a live waitlist offer before the admin confirms, and only then", () => {
    installFetch();
    const { unmount } = renderControls({ hasLiveWaitlistOffer: true });

    fireEvent.click(
      screen.getByRole("button", { name: "Turn off all emails" }),
    );
    expect(
      within(screen.getByRole("dialog")).getByText(
        /holding a live waitlist offer/i,
      ),
    ).toBeInTheDocument();
    unmount();

    renderControls({ hasLiveWaitlistOffer: false });
    fireEvent.click(
      screen.getByRole("button", { name: "Turn off all emails" }),
    );
    expect(
      within(screen.getByRole("dialog")).queryByText(
        /holding a live waitlist offer/i,
      ),
    ).toBeNull();
  });

  it("raises the live-offer warning from the route's own answer after the write", async () => {
    installFetch({ body: { success: true, hasLiveWaitlistOffer: true } });
    // Page rendered stale (flag false), route says otherwise: the admin still
    // hears about the outstanding offer.
    renderControls({ hasLiveWaitlistOffer: false });

    fireEvent.click(
      screen.getByRole("button", { name: "Turn off all emails" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Yes — I will tell the member myself" }),
    );

    await waitFor(() =>
      expect(mocks.toastWarning).toHaveBeenCalledWith(
        expect.stringMatching(/live waitlist offer/i),
      ),
    );
  });

  it("states the ongoing silence, and clears without asking for an acknowledgement", async () => {
    installFetch();
    renderControls({
      noEmails: true,
      noEmailsAt: "2026-07-20T02:00:00.000Z",
      setByName: "Ada Officer",
    });

    expect(
      screen.getByText("All emails are off for this booking"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Turned on by Ada Officer/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Turn emails back on" }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Turn emails back on" }),
    );

    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    // Clearing carries no acknowledgement: a stuck switch must always be
    // clearable, and restoring normal behaviour needs no undertaking.
    expect(fetchCalls[0].body).toEqual({ noEmails: false });
  });

  it("tells the truth about a live offer: already sent, still acceptable", async () => {
    /*
      Candidacy exclusion means a live offer can only PREDATE the switch, so
      the offer email already went out — the member HAS been told and CAN still
      accept. Saying otherwise is worse than saying nothing: an officer who
      believed the bed was dead might reassign it out from under a member who
      is still entitled to it.
    */
    installFetch();
    renderControls({ hasLiveWaitlistOffer: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Turn off all emails" }),
    );

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/can still accept it, so do not reassign the bed/i),
    ).toBeInTheDocument();
    // …and must NOT claim the member cannot accept.
    expect(dialog.textContent).not.toMatch(/cannot accept/i);
    expect(dialog.textContent).not.toMatch(/never be told the offer was made/i);
  });

  it("states the waitlist consequence nothing else can record", async () => {
    /*
      A silenced WAITLISTED entry is skipped for offers ENTIRELY, so no offer
      is made, nothing is withheld and no row is ever written. The banner is
      structurally blind to it, so the dialog is the only place it can be said.
    */
    installFetch();
    const { unmount } = renderControls({ isWaitlisted: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Turn off all emails" }),
    );
    expect(
      within(screen.getByRole("dialog")).getByText(
        /passed over for waitlist offers/i,
      ),
    ).toBeInTheDocument();
    unmount();

    renderControls({ isWaitlisted: false });
    fireEvent.click(
      screen.getByRole("button", { name: "Turn off all emails" }),
    );
    expect(
      within(screen.getByRole("dialog")).queryByText(
        /passed over for waitlist offers/i,
      ),
    ).toBeNull();
  });

  it("shows a failed write inside the dialog, not behind its overlay", async () => {
    installFetch({ ok: false, body: { error: "Booking not found" } });
    renderControls();

    fireEvent.click(
      screen.getByRole("button", { name: "Turn off all emails" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Yes — I will tell the member myself" }),
    );

    // The dialog stays open on failure, so the error has to live inside it.
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Booking not found",
      ),
    );

    // …and cancelling clears it, so a stale error never sits under the button.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("surfaces the route's refusal instead of claiming success", async () => {
    installFetch({ ok: false, body: { error: "Booking not found" } });
    renderControls();

    fireEvent.click(
      screen.getByRole("button", { name: "Turn off all emails" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Yes — I will tell the member myself" }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("Booking not found"),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});


/**
 * THE DATE THE SILENCE STARTED IS THE CLUB'S (CT-4, #2870; epic #2988;
 * INV-CONFIG-002).
 *
 * The third of the kernel's display shapes to be pinned in this group, and the
 * one where being a day out matters most in prose: this line is the record of
 * WHEN an officer took on the obligation to tell a member by hand, and it is read
 * back by whoever inherits that obligation. `instantDate` renders a real moment,
 * so the zone is a choice — unlike the lodge nights elsewhere on the same screen,
 * which are calendar days and take none.
 *
 * Same fixture, two provider zones, two answers. The suite above is about the
 * acknowledgement mechanism and renders through the harness default, where the
 * persisted zone and `APP_TIME_ZONE` agree; those tests are not about the zone
 * and are correctly left alone.
 */
describe("BookingNoEmailsControls stamps the club's day (CT-4, #2870)", () => {
  /** Behind UTC, so it disagrees with the harness zone and with a UTC host. */
  const CLUB_ZONE_BEHIND_UTC = "America/Denver";

  /** When the switch went on, read as different DAYS by the two zones. */
  const TURNED_ON_AT = "2026-07-20T02:00:00.000Z";

  function providerFor(zone: string) {
    return function PinnedClubTime({ children }: { children: ReactNode }) {
      return <ClubTimeProvider zone={zone}>{children}</ClubTimeProvider>;
    };
  }

  function spelledIn(zone: string): string {
    return bindClubTime(requireClubTimeZone(zone)).instantDate(
      new Date(TURNED_ON_AT),
    );
  }

  function renderIn(zone: string) {
    installFetch();
    return render(
      <BookingNoEmailsControls
        bookingId="bk-1"
        noEmails
        noEmailsAt={TURNED_ON_AT}
        setByName="Ada Officer"
        hasLiveWaitlistOffer={false}
      />,
      { wrapper: providerFor(zone) },
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reads a Denver club's switch as the day before New Zealand's", () => {
    // PREMISE, as an ANSWER rather than an identifier: the two zones really do
    // disagree about this instant, and by a whole day.
    expect(spelledIn(CLUB_ZONE_BEHIND_UTC)).toBe("19 Jul 2026");
    expect(spelledIn(CLUB_TIME_TEST_ZONE)).toBe("20 Jul 2026");

    const { container } = renderIn(CLUB_ZONE_BEHIND_UTC);

    expect(container.textContent).toContain(
      `Turned on by Ada Officer on ${spelledIn(CLUB_ZONE_BEHIND_UTC)}`,
    );
    expect(container.textContent).not.toContain(
      spelledIn(CLUB_TIME_TEST_ZONE),
    );
  });

  it("follows a DIFFERENT club zone for the same switch", () => {
    // The mirror image, and it is what makes the case above about the PROVIDER
    // rather than about a hard-coded 19 July.
    const { container } = renderIn(CLUB_TIME_TEST_ZONE);

    expect(container.textContent).toContain(
      `Turned on by Ada Officer on ${spelledIn(CLUB_TIME_TEST_ZONE)}`,
    );
    expect(container.textContent).not.toContain(
      spelledIn(CLUB_ZONE_BEHIND_UTC),
    );
  });
});
