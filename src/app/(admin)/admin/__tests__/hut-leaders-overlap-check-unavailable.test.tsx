// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

import { settleLodgeScopedPage } from "@/lib/__tests__/helpers/lodge-scope-settle";

/**
 * #4961 review: when the assignments read fails the page clears `assignments`,
 * so the Confirm panel's overlap check compares nothing and draws no clash. An
 * absent warning must not read as "no clash". The real form is rendered here,
 * because the note is its text.
 */
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: { overview: "edit", bookings: "edit", membership: "edit", finance: "edit", lodge: "edit", content: "edit", support: "edit" },
      },
    },
  }),
}));
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));
vi.mock("@/components/admin/occupancy-calendar", () => ({
  OccupancyCalendar: ({ mode, onSelectionChange }: {
    mode: "range" | "single";
    onSelectionChange: (selection: { startDate: string; endDate: string }) => void;
  }) => (
    <button
      type="button"
      onClick={() => onSelectionChange(mode === "range"
        ? { startDate: "2099-07-10", endDate: "2099-07-12" }
        : { startDate: "2099-07-11", endDate: "2099-07-11" })}
    >
      Pick {mode}
    </button>
  ),
}));

const eligibleMember = {
  id: "m1", firstName: "Dana", lastName: "Diaz", email: "dana@test.com", hutLeaderEligible: true,
  hutLeaderEligibleAt: null, bookingCheckIn: "2099-07-10", bookingCheckOut: "2099-07-12",
  suggestedStartDate: "2099-07-10", suggestedEndDate: "2099-07-12", uncoveredNightCount: 3, fullyCovered: false,
};
const existing = {
  id: "a1", memberId: "m2", memberName: "Bob Jones", memberEmail: "bob@test.com", startDate: "2099-07-08",
  endDate: "2099-07-14", createdAt: "2099-01-01T00:00:00.000Z", lodgeId: "lodge-1", lodgeName: "Lodge One",
  bedId: null, bedName: null, bedRoomName: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function stubFetch(assignmentsRead: "ok" | "fails") {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/admin/lodges") return json({ lodges: [{ id: "lodge-1", name: "Lodge One" }] });
    if (url.startsWith("/api/admin/hut-leaders/eligible-members")) return json({ members: [eligibleMember] });
    if (url.startsWith("/api/admin/hut-leaders/unassigned-dates")) return json({ unassignedDates: [] });
    if (url.startsWith("/api/admin/hut-leaders?lodgeId=")) {
      return assignmentsRead === "fails" ? json({ error: "The list service is unavailable." }, 500) : json({ assignments: [existing] });
    }
    return json({});
  }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function reachConfirm() {
  const HutLeadersPage = (await import("@/app/(admin)/admin/hut-leaders/page")).default;
  render(<HutLeadersPage />);
  await settleLodgeScopedPage("/api/admin/hut-leaders?lodgeId=");
  fireEvent.click(screen.getByRole("button", { name: /pick range/i }));
  await screen.findByText("Dana Diaz");
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  await screen.findByRole("button", { name: /confirm assignment/i });
}

describe("Hut Leaders Confirm panel when the assignments read fails (#4961)", () => {
  it("says the overlap check is unavailable instead of showing no clash", async () => {
    stubFetch("fails");
    await reachConfirm();
    expect(await screen.findByText(/The overlap check is unavailable until the assignments load/)).toBeInTheDocument();
    expect(screen.getByTestId("hut-leaders-assignments-load-error")).toBeInTheDocument();
    expect(screen.queryByText(/Overlaps Bob Jones/)).not.toBeInTheDocument();
  });

  it("shows the real clash, and no note, when the assignments loaded", async () => {
    stubFetch("ok");
    await reachConfirm();
    expect(await screen.findByText(/Overlaps Bob Jones/)).toBeInTheDocument();
    expect(screen.queryByText(/The overlap check is unavailable/)).not.toBeInTheDocument();
  });
});
