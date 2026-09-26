// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/lib/__tests__/support/club-time-render";

/*
  The club currency and locale page for an admin who is NOT a Full Admin
  (#3596). The owner's decision: any admin may view the club's currency and
  locale; only a Full Admin may change them. So this file proves the screen
  half of that — a non-Full-Admin sees the stored values, meets the view-only
  banner, and is offered no enabled way to save — while the route's own test
  proves the server refuses the write regardless.

  The session is mocked per test, because `canEdit` comes from it: the three
  states that matter are a Full Admin, an admin who is not one, and the
  resolving window before the session has settled.
*/

const session = vi.hoisted(() => ({
  value: {
    status: "authenticated" as "authenticated" | "loading",
    data: null as null | { user: { id: string; accessRoles: string[]; canLogin: boolean } },
  },
}));

vi.mock("next-auth/react", () => ({
  useSession: () => session.value,
}));

import ClubFormatPage from "@/app/(admin)/admin/club-format/page";
import { ClubFormatPanel } from "@/components/admin/club-format-panel";
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action";
import { ADMIN_FULL_ADMIN_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";

/*
  CHF and de-CH, not the NZD/en-NZ the test environment resolves to, so a value
  on screen can only have come from this payload.
*/
const STORED_STATE = {
  currencyCode: "CHF",
  locale: "de-CH",
  currencySource: "persisted",
  localeSource: "persisted",
  updatedAt: "2026-06-30T21:30:00.000Z",
  updatedByName: "Ada Lovelace",
  unusableStoredCurrency: null,
  unusableStoredLocale: null,
};

const fetchMock = vi.fn();

function signInAs(accessRoles: string[]) {
  session.value = {
    status: "authenticated",
    data: { user: { id: "member-1", accessRoles, canLogin: true } },
  };
}

function putCalls() {
  return fetchMock.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ state: STORED_STATE }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  signInAs(["ADMIN"]);
});

describe("an admin who is not a Full Admin (#3596)", () => {
  beforeEach(() => {
    // The shipped "Finance Viewer": an admitted admin, and not a Full Admin.
    signInAs(["FINANCE_USER"]);
  });

  it("opens the page and sees the stored values, not a refusal", async () => {
    render(<ClubFormatPage />);
    expect(
      await screen.findByTestId("current-club-currency"),
    ).toHaveTextContent("CHF");
    expect(screen.getByTestId("current-club-locale")).toHaveTextContent(
      "de-CH",
    );
    expect(
      screen.queryByText(/available to full administrators only/i),
    ).not.toBeInTheDocument();
  });

  it("is told once, in the banner, that changing them needs Full Admin", async () => {
    render(<ClubFormatPanel />);
    await screen.findByTestId("current-club-currency");
    const banner = screen.getByTestId("admin-view-only-banner");
    expect(banner).toHaveTextContent(ADMIN_VIEW_ONLY_SECTION_HEADING);
    expect(banner).toHaveTextContent(/needs Full Admin/);
    // One banner for the section, not one per state.
    expect(screen.getAllByTestId("admin-view-only-banner")).toHaveLength(1);
  });

  it("is offered no enabled way to change or save them", async () => {
    render(<ClubFormatPanel />);
    await screen.findByTestId("current-club-currency");
    const change = screen.getByRole("button", {
      name: "Change currency and format",
    });
    expect(change).toBeDisabled();
    fireEvent.click(change);
    // The editor never opens, so there is no Save to press at all…
    expect(
      screen.queryByRole("button", { name: "Save currency and format" }),
    ).not.toBeInTheDocument();
    // …and nothing was sent.
    expect(putCalls()).toHaveLength(0);
  });

  it("keeps the banner's live region mounted from the first paint", () => {
    // Before the fetch settles the section is still loading; the region has
    // to exist already so its content is announced when it arrives.
    fetchMock.mockImplementation(() => new Promise(() => {}));
    render(<ClubFormatPanel />);
    expect(
      screen.getByText(/Loading the club.s currency and locale/),
    ).toBeInTheDocument();
    expect(screen.getByTestId("admin-view-only-banner")).toBeInTheDocument();
  });
});

describe("a Full Admin", () => {
  it("sees no banner and can open the editor", async () => {
    render(<ClubFormatPanel />);
    await screen.findByTestId("current-club-currency");
    expect(screen.getByTestId("admin-view-only-banner")).toBeEmptyDOMElement();
    const change = screen.getByRole("button", {
      name: "Change currency and format",
    });
    expect(change).toBeEnabled();
    fireEvent.click(change);
    // Save exists, and waits for the acknowledgement like it always has.
    expect(
      screen.getByRole("button", { name: "Save currency and format" }),
    ).toBeDisabled();
  });

  it("is told which permission it lost when a stale tab's save is refused", async () => {
    render(<ClubFormatPanel />);
    await screen.findByTestId("current-club-currency");
    fireEvent.click(
      screen.getByRole("button", { name: "Change currency and format" }),
    );
    fireEvent.change(screen.getByLabelText("Number and date format"), {
      target: { value: "fr-CH" },
    });
    fireEvent.click(screen.getByRole("checkbox"));

    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "Forbidden" }),
    }));
    fireEvent.click(
      screen.getByRole("button", { name: "Save currency and format" }),
    );
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    // The shared forbidden-save notice (`role="alert"`), carrying the
    // Full-Admin reason rather than its area-level default copy.
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(ADMIN_FULL_ADMIN_ONLY_ACTION_REASON);
    expect(notice).toHaveTextContent(/Refresh the page/);
    expect(notice).not.toHaveTextContent(/can view this area/);
    // The editor stays open, so the admin can see what was refused.
    expect(
      screen.getByRole("button", { name: "Save currency and format" }),
    ).toBeInTheDocument();
  });
});

describe("a currency change (#3567, owner decisions D1, D2, D8)", () => {
  const IN_FLIGHT = {
    unpaidCardPayments: 2,
    pendingSavedCardCharges: 1,
    openRecoveryRetries: 3,
  };

  async function openAndChooseCurrency(code: string) {
    render(<ClubFormatPanel />);
    await screen.findByTestId("current-club-currency");
    fireEvent.click(screen.getByRole("button", { name: "Change currency and format" }));
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: code } });
  }

  beforeEach(() => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ state: STORED_STATE, inFlight: IN_FLIGHT }),
    }));
  });

  it("counts the card payments under way and names Stripe and Xero", async () => {
    await openAndChooseCurrency("AUD");
    const block = screen.getByTestId("club-format-currency-change");
    expect(block).toHaveTextContent("Card payments move from CHF to AUD when you save");
    const counts = within(block).getByTestId("club-format-in-flight");
    expect(counts).toHaveTextContent("2 card payments already started and not yet paid — these stay in CHF.");
    expect(counts).toHaveTextContent("1 saved card waiting to be charged later — these are charged in AUD.");
    expect(counts).toHaveTextContent("3 payment-recovery retries still open");
    expect(block).toHaveTextContent(/Stripe account and its Xero organisation's base currency/);
  });

  it("needs its own tick before Save, and sends it", async () => {
    await openAndChooseCurrency("AUD");
    const save = screen.getByRole("button", { name: "Save currency and format" });
    const [ordinary, currencyTick] = screen.getAllByRole("checkbox");
    fireEvent.click(ordinary);
    expect(save).toBeDisabled();
    fireEvent.click(currencyTick);
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const body = JSON.parse(String((putCalls()[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toMatchObject({ currencyCode: "AUD", confirmed: true, currencyChangeConfirmed: true });
  });

  it("says so when the counts could not be read, rather than showing zero", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ state: STORED_STATE, inFlight: null }),
    }));
    await openAndChooseCurrency("AUD");
    expect(screen.getByTestId("club-format-in-flight-unknown")).toBeInTheDocument();
    expect(screen.queryByTestId("club-format-in-flight")).not.toBeInTheDocument();
  });

  it("is not shown for a locale-only change", async () => {
    render(<ClubFormatPanel />);
    await screen.findByTestId("current-club-currency");
    fireEvent.click(screen.getByRole("button", { name: "Change currency and format" }));
    fireEvent.change(screen.getByLabelText("Number and date format"), { target: { value: "fr-CH" } });
    expect(screen.queryByTestId("club-format-currency-change")).not.toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });
});

describe("while the session is still resolving", () => {
  it("offers nothing and explains nothing yet", async () => {
    session.value = { status: "loading", data: null };
    render(<ClubFormatPanel />);
    await screen.findByTestId("current-club-currency");
    // Neutral: disabled, but no view-only reason flashed at a Full Admin.
    expect(
      screen.getByRole("button", { name: "Change currency and format" }),
    ).toBeDisabled();
    expect(
      within(screen.getByTestId("admin-view-only-banner")).queryByText(
        ADMIN_VIEW_ONLY_SECTION_HEADING,
        { exact: false },
      ),
    ).not.toBeInTheDocument();
  });
});
