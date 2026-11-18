// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));
// Single-lodge club: the scope select renders nothing, so the club-wide list.
vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ lodges: [], loading: false }),
}));

import { expectToHoldFocus } from "@/lib/__tests__/helpers/focus";
import { getAdminPage } from "@/lib/admin-hubs";
import { BookingPeriodsSection } from "../booking-periods-section";
import { MinimumNightStaySection } from "../minimum-night-stay-section";

// #4087: these two sections open a per-row editor that is its own component,
// unmounted on close, so `useSectionEditState`'s own return never runs. The list
// owns the return instead (`useEditorFocusReturn`): Cancel and a successful
// save hand focus back to the Add or row Edit that opened the editor.

const PERIOD = {
  id: "p1",
  name: "School Holidays",
  startDate: "2026-07-01T00:00:00.000Z",
  endDate: "2026-07-14T00:00:00.000Z",
  nonMemberHoldEnabled: true,
  nonMemberHoldDays: 5,
  cancellationRules: [
    {
      daysBeforeStay: 21,
      refundPercentage: 100,
      creditRefundPercentage: 100,
      fixedFeeCents: 0,
      creditFixedFeeCents: 0,
    },
  ],
  active: true,
};

const POLICY = {
  id: "m1",
  name: "Winter Saturdays",
  startDate: "2026-07-01T00:00:00.000Z",
  endDate: "2026-09-30T00:00:00.000Z",
  triggerDays: [6],
  minimumNights: 2,
  capacityMode: "HOLD",
  version: 4,
  active: true,
};

/** GETs answer the list; a write answers `written`. */
function stubList(list: unknown[], written?: unknown) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    new Response(JSON.stringify(init?.method ? written : list), {
      status: 200,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Operate a control the way a keyboard user does: it holds focus first. */
function press(control: HTMLElement) {
  control.focus();
  fireEvent.click(control);
}

const button = (name: string) => screen.getByRole("button", { name });

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BookingPeriodsSection returns focus from its editor (#4087)", () => {
  it("names the list card by its title, not by a row's heading", async () => {
    stubList([PERIOD]);
    render(<BookingPeriodsSection />);
    await screen.findByRole("button", { name: "Edit" });

    expect(
      screen.getByRole("region", { name: getAdminPage("booking-policies-periods").label }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "School Holidays" })).toBeNull();
  });

  it("returns to Add Period after Cancel", async () => {
    stubList([]);
    render(<BookingPeriodsSection />);
    press(await screen.findByRole("button", { name: "Add Period" }));
    press(button("Cancel"));

    await expectToHoldFocus(button("Add Period"));
  });

  it("returns to the row's Edit after a successful update", async () => {
    stubList([PERIOD], { ...PERIOD, name: "School Holidays (revised)" });
    render(<BookingPeriodsSection />);
    press(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Period Name"), {
      target: { value: "School Holidays (revised)" },
    });
    press(button("Update Period"));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Update Period" })).toBeNull(),
    );
    await expectToHoldFocus(button("Edit"));
  });
});

describe("the list editors move focus INTO the editor they open (#4115)", () => {
  it("Add Period focuses the new period's first field", async () => {
    stubList([PERIOD]);
    render(<BookingPeriodsSection />);
    press(await screen.findByRole("button", { name: "Add Period" }));

    await expectToHoldFocus(screen.getByLabelText("Period Name"));
    expect((screen.getByLabelText("Period Name") as HTMLInputElement).value).toBe("");
  });

  it("a row's Edit focuses that row's editor, though the Edit stays mounted", async () => {
    stubList([PERIOD]);
    render(<BookingPeriodsSection />);
    const edit = await screen.findByRole("button", { name: "Edit" });
    press(edit);

    const name = screen.getByLabelText("Period Name") as HTMLInputElement;
    expect(name.value).toBe("School Holidays");
    await expectToHoldFocus(name);
  });

  it("Add Policy focuses the new policy's first field", async () => {
    stubList([]);
    render(<MinimumNightStaySection />);
    press(await screen.findByRole("button", { name: "Add Policy" }));

    await expectToHoldFocus(screen.getByLabelText("Policy Name"));
  });

  it("a policy row's Edit focuses that row's editor", async () => {
    stubList([POLICY]);
    render(<MinimumNightStaySection />);
    press(await screen.findByRole("button", { name: "Edit" }));

    const name = screen.getByLabelText("Policy Name") as HTMLInputElement;
    expect(name.value).toBe("Winter Saturdays");
    await expectToHoldFocus(name);
  });
});

describe("MinimumNightStaySection returns focus from its editor (#4087)", () => {
  it("returns to Add Policy after Cancel", async () => {
    stubList([]);
    render(<MinimumNightStaySection />);
    press(await screen.findByRole("button", { name: "Add Policy" }));
    press(button("Cancel"));

    await expectToHoldFocus(button("Add Policy"));
  });

  it("returns to the row's re-rendered Edit after a successful update", async () => {
    // The save refreshes the list through its loading state, so the row's
    // Edit is a NEW element by the time focus returns: found by its marker.
    // The refresh is held until the loading state has rendered, so the test
    // cannot pass on a list that happened to refresh inside one render.
    let releaseRefresh: () => void = () => {};
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let wrote = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method) {
          wrote = true;
          return new Response(
            JSON.stringify({ ...POLICY, name: "Winter weekends", version: 5 }),
            { status: 200 },
          );
        }
        if (wrote) await refreshHeld;
        return new Response(JSON.stringify([POLICY]), { status: 200 });
      }),
    );
    render(<MinimumNightStaySection />);
    const originalEdit = await screen.findByRole("button", { name: "Edit" });
    press(originalEdit);
    fireEvent.change(screen.getByLabelText("Policy Name"), {
      target: { value: "Winter weekends" },
    });
    press(button("Update Policy"));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull(),
    );
    expect(originalEdit.isConnected).toBe(false);
    releaseRefresh();

    const edit = await screen.findByRole("button", { name: "Edit" });
    expect(edit).not.toBe(originalEdit);
    await expectToHoldFocus(edit);
  });

  it("returns to the row's Edit when a 409 closes the stale editor", async () => {
    // A conflict is not a thrown save error: the list refreshes, closes the
    // editor itself and reports the conflict above the list, which takes no
    // focus — so without the return a keyboard user is left on the page.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method
          ? new Response(
              JSON.stringify({ error: "Someone else changed this policy." }),
              { status: 409 },
            )
          : new Response(JSON.stringify([POLICY]), { status: 200 }),
      ),
    );
    render(<MinimumNightStaySection />);
    press(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Policy Name"), {
      target: { value: "Winter weekends" },
    });
    press(button("Update Policy"));

    await screen.findByText("Someone else changed this policy.");
    expect(screen.queryByRole("button", { name: "Update Policy" })).toBeNull();
    await expectToHoldFocus(await screen.findByRole("button", { name: "Edit" }));
  });
});
