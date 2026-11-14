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

// #4116: a row's Activate/Deactivate and Delete are direct writes. The minimum
// stay list refreshes through its loading state, unmounting the pressed button;
// a booking period's Delete removes its row, and a toggle is disabled for the
// round trip, which a browser answers by dropping focus to the page. Each
// returns focus to a control in the list, or to the card, through
// `useRowActionFocusReturn` — after a delete, to an Edit, never to a button
// that writes by itself.

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

function period(id: string, name: string) {
  return {
    id,
    name,
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
}

/**
 * GETs answer `before` until a write has landed and `after` from then on; the
 * refresh after the write is held until `release()`, so a test can see the
 * pressed button gone before the list comes back.
 */
function stubWrite(before: unknown[], after: unknown[], written: unknown) {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let wrote = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method) {
        wrote = true;
        return new Response(JSON.stringify(written), { status: 200 });
      }
      if (wrote) await held;
      return new Response(JSON.stringify(wrote ? after : before), {
        status: 200,
      });
    }),
  );
  return { release: () => release(), wrote: () => wrote };
}

/** Let the write's own response, and everything it schedules, finish first. */
async function settleAfter(wrote: () => boolean) {
  await waitFor(() => expect(wrote()).toBe(true));
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** A browser's focus fixup: jsdom will not blur a disabled control itself. */
function dropFocusToPage() {
  const parked = document.body.appendChild(document.createElement("button"));
  parked.focus();
  parked.remove();
  expect(document.activeElement).toBe(document.body);
}

/**
 * A stateful list: each write waits for its own `release`, then changes the
 * rows the next GET answers with, so two writes can overlap in either order.
 */
function stubRows(initial: Array<{ id: string; active: boolean }>) {
  let rows = [...initial];
  const holds = new Map<string, () => void>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const id = url.split("/").pop() ?? "";
      if (init?.method) {
        await new Promise<void>((resolve) => holds.set(init.method!, resolve));
        rows =
          init.method === "DELETE"
            ? rows.filter((row) => row.id !== id)
            : rows.map((row) =>
                row.id === id ? { ...row, active: !row.active } : row,
              );
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify(rows), { status: 200 });
    }),
  );
  return {
    release: async (method: string) => {
      await waitFor(() => expect(holds.has(method)).toBe(true));
      holds.get(method)!();
      holds.delete(method);
    },
  };
}

/** Operate a control the way a keyboard user does: it holds focus first. */
function press(control: HTMLElement) {
  control.focus();
  fireEvent.click(control);
}

const buttons = (name: string) => screen.getAllByRole("button", { name });

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("confirm", () => true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MinimumNightStaySection returns focus after a row write (#4116)", () => {
  it("returns to the row's re-rendered toggle after Deactivate", async () => {
    const inactive = { ...POLICY, active: false, version: 5 };
    const { release } = stubWrite([POLICY], [inactive], inactive);
    render(<MinimumNightStaySection />);
    const deactivate = await screen.findByRole("button", { name: "Deactivate" });
    press(deactivate);

    await screen.findByText("Loading...");
    expect(deactivate.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.body);
    release();

    await expectToHoldFocus(
      await screen.findByRole("button", { name: "Activate" }),
    );
  });

  it("returns to the row's Edit after Delete, never to the toggle that would undo it", async () => {
    const deleted = { ...POLICY, active: false, version: 5 };
    const { release } = stubWrite([POLICY], [deleted], { policy: deleted });
    render(<MinimumNightStaySection />);
    const del = await screen.findByRole("button", { name: "Delete" });
    press(del);

    await screen.findByText("Loading...");
    expect(del.isConnected).toBe(false);
    release();

    await screen.findByText(
      "Minimum stay policy deleted — it is listed as inactive",
    );
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    await expectToHoldFocus(await screen.findByRole("button", { name: "Edit" }));
  });

  it("falls back to the card when the row is gone after the refresh", async () => {
    const { release } = stubWrite([POLICY], [], { policy: null });
    render(<MinimumNightStaySection />);
    press(await screen.findByRole("button", { name: "Delete" }));

    await screen.findByText("Loading...");
    release();

    await expectToHoldFocus(
      await screen.findByRole("region", { name: getAdminPage("booking-policies-minimum-stay").label }),
    );
  });

  it("lands on the could-not-load card when the refresh after a write fails", async () => {
    let wrote = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method) {
          wrote = true;
          return new Response(JSON.stringify({ policy: null }), { status: 200 });
        }
        return wrote
          ? new Response("{}", { status: 500 })
          : new Response(JSON.stringify([POLICY]), { status: 200 });
      }),
    );
    render(<MinimumNightStaySection />);
    press(await screen.findByRole("button", { name: "Delete" }));

    await expectToHoldFocus(
      await screen.findByRole("region", {
        name: "Could not load the minimum-stay policies for the club",
      }),
    );
  });

  it("names each row button by its row's heading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([POLICY]), { status: 200 })),
    );
    render(<MinimumNightStaySection />);
    for (const name of ["Deactivate", "Edit", "Delete"]) {
      expect(
        await screen.findByRole("button", { name, description: "Winter Saturdays" }),
      ).toBeTruthy();
    }
  });
});

describe("BookingPeriodsSection returns focus after a row write (#4116)", () => {
  const A = period("p1", "Term One");
  const B = period("p2", "Term Two");
  const C = period("p3", "Term Three");

  it("returns to the toggle a browser dropped focus from while it was disabled", async () => {
    const { release } = stubWrite([A], [{ ...A, active: false }], {});
    render(<BookingPeriodsSection />);
    const deactivate = await screen.findByRole("button", { name: "Deactivate" });
    press(deactivate);

    // jsdom keeps focus on a disabled button; a browser drops it to the page.
    await waitFor(() =>
      expect((deactivate as HTMLButtonElement).disabled).toBe(true),
    );
    dropFocusToPage();
    release();

    await expectToHoldFocus(
      await screen.findByRole("button", { name: "Activate" }),
    );
  });

  it("returns to the next row's Edit after a Delete", async () => {
    const { release, wrote } = stubWrite([A, B, C], [A, C], {});
    render(<BookingPeriodsSection />);
    await screen.findByText("Term Two");
    const del = buttons("Delete")[1];
    press(del);
    // The refresh lands well after the delete: a return that did not wait for
    // it would fire while the deleted row was still on screen.
    await settleAfter(wrote);
    release();

    await waitFor(() => expect(screen.queryByText("Term Two")).toBeNull());
    expect(del.isConnected).toBe(false);
    await expectToHoldFocus(
      screen.getByRole("button", { name: "Edit", description: "Term Three" }),
    );
  });

  it("returns to the previous row's Edit after deleting the last row", async () => {
    const { release } = stubWrite([A, B], [A], {});
    render(<BookingPeriodsSection />);
    await screen.findByText("Term Two");
    press(buttons("Delete")[1]);
    release();

    await waitFor(() => expect(screen.queryByText("Term Two")).toBeNull());
    await expectToHoldFocus(
      screen.getByRole("button", { name: "Edit", description: "Term One" }),
    );
  });

  it("falls back to the card when the last period is deleted", async () => {
    const { release } = stubWrite([A], [], {});
    render(<BookingPeriodsSection />);
    press(await screen.findByRole("button", { name: "Delete" }));
    release();

    await screen.findByText(/No date-specific periods configured/);
    await expectToHoldFocus(
      screen.getByRole("region", { name: getAdminPage("booking-policies-periods").label }),
    );
  });

  it("returns to the pressed row after a failed Delete, not to its neighbour", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method
          ? new Response("{}", { status: 500 })
          : new Response(JSON.stringify([A, B, C]), { status: 200 }),
      ),
    );
    render(<BookingPeriodsSection />);
    await screen.findByText("Term Two");
    const del = screen.getByRole("button", { name: "Delete", description: "Term Two" });
    press(del);
    dropFocusToPage();

    await screen.findByText("Failed to delete");
    await expectToHoldFocus(del);
  });

  it("keeps each overlapping write's own return", async () => {
    // A toggle captured first and finishing first must not take the delete's
    // return with it: the delete still lands on its neighbour's Edit.
    const { release } = stubRows([A, B, C]);
    render(<BookingPeriodsSection />);
    await screen.findByText("Term Two");
    press(screen.getByRole("button", { name: "Deactivate", description: "Term One" }));
    press(screen.getByRole("button", { name: "Delete", description: "Term Two" }));

    await release("PUT");
    await screen.findByRole("button", { name: "Activate", description: "Term One" });
    await release("DELETE");

    await waitFor(() => expect(screen.queryByText("Term Two")).toBeNull());
    await expectToHoldFocus(
      screen.getByRole("button", { name: "Edit", description: "Term Three" }),
    );
  });

  it("leaves the open editor's own return intact after a row write", async () => {
    // The row write keeps its own anchor: consuming the editor's would leave a
    // later Cancel with nowhere to return to.
    const { release } = stubWrite([A, B], [A, { ...B, active: false }], {});
    render(<BookingPeriodsSection />);
    await screen.findByText("Term Two");
    press(buttons("Edit")[0]);
    press(buttons("Deactivate")[1]);
    release();
    await expectToHoldFocus(await screen.findByRole("button", { name: "Activate" }));

    press(screen.getByRole("button", { name: "Cancel" }));
    await expectToHoldFocus(buttons("Edit")[0]);
  });
});
