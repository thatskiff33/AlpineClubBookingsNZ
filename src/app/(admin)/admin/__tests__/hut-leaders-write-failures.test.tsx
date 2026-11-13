// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleLodgeScopedPage } from "@/lib/__tests__/helpers/lodge-scope-settle";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";
import HutLeadersPage from "@/app/(admin)/admin/hut-leaders/page";

/*
  The assignment save and the kiosk PIN reset read a refusal without a bare
  `res.json()` (ALP-589): an HTML error page from the proxy, or a request that
  never gets an answer, shows the screen's own sentence. Set-up mirrors
  `hut-leaders-error-placement.test.tsx`.
*/

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
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));
vi.mock("@/components/admin/occupancy-calendar", () => ({
  OccupancyCalendar: ({
    mode,
    onSelectionChange,
  }: {
    mode: "range" | "single";
    onSelectionChange: (selection: { startDate: string; endDate: string }) => void;
  }) =>
    mode === "range" ? (
      <button
        type="button"
        onClick={() => onSelectionChange({ startDate: "2099-07-10", endDate: "2099-07-12" })}
      >
        Pick range
      </button>
    ) : null,
}));

const ELIGIBLE_MEMBER = {
  id: "m1",
  firstName: "Dana",
  lastName: "Diaz",
  email: "dana@test.com",
  hutLeaderEligible: true,
  hutLeaderEligibleAt: null,
  bookingCheckIn: "2099-07-10",
  bookingCheckOut: "2099-07-12",
  suggestedStartDate: "2099-07-10",
  suggestedEndDate: "2099-07-12",
  uncoveredNightCount: 3,
  fullyCovered: false,
};

const ASSIGNMENT = {
  id: "a1",
  memberId: "m1",
  memberName: "Dana Diaz",
  memberEmail: "dana@test.com",
  startDate: "2099-07-10",
  endDate: "2099-07-12",
  createdAt: "2099-01-01T00:00:00.000Z",
  lodgeId: "lodge-1",
  lodgeName: "Lodge One",
  bedId: null,
  bedName: null,
  bedRoomName: null,
};

function stubFetch(
  write: { url: string; method: string },
  answer: () => Response | Promise<Response>,
  assignments: unknown[],
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === write.url && method === write.method) return answer();
    if (url === "/api/admin/lodges") return Response.json({ lodges: [{ id: "lodge-1", name: "Lodge One" }] });
    if (url.startsWith("/api/admin/hut-leaders/eligible-members")) return Response.json({ members: [ELIGIBLE_MEMBER] });
    if (url.startsWith("/api/admin/hut-leaders/unassigned-dates")) return Response.json({ unassignedDates: [] });
    if (url.startsWith("/api/admin/hut-leaders?lodgeId=")) return Response.json({ assignments });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const listLoads = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/admin/hut-leaders?lodgeId=")).length;

async function confirmAssignment(answer: () => Response | Promise<Response>) {
  const fetchMock = stubFetch({ url: "/api/admin/hut-leaders", method: "POST" }, answer, []);
  render(<HutLeadersPage />);
  await settleLodgeScopedPage("/api/admin/hut-leaders?lodgeId=");
  fireEvent.click(screen.getByRole("button", { name: /pick range/i }));
  fireEvent.click(await screen.findByRole("button", { name: "Select" }));
  fireEvent.click(await screen.findByRole("button", { name: /confirm assignment/i }));
  return fetchMock;
}

async function resetPin(answer: () => Response | Promise<Response>) {
  const fetchMock = stubFetch({ url: "/api/admin/hut-leaders/a1/pin", method: "POST" }, answer, [ASSIGNMENT]);
  vi.stubGlobal("confirm", () => true);
  render(<HutLeadersPage />);
  await settleLodgeScopedPage("/api/admin/hut-leaders?lodgeId=");
  fireEvent.click(await screen.findByRole("button", { name: "Reset kiosk PIN" }));
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hut leaders: assignment save refused", () => {
  itShowsEveryRefusal({ submit: async (answer) => void (await confirmAssignment(answer)), fallback: "Failed to create" });

  it("reloads the assignments on success", async () => {
    const fetchMock = await confirmAssignment(() => Response.json({ id: "a2" }));

    await waitFor(() => expect(listLoads(fetchMock)).toBeGreaterThanOrEqual(2));
  });
});

describe("hut leaders: kiosk PIN reset refused", () => {
  itShowsEveryRefusal({ submit: async (answer) => void (await resetPin(answer)), fallback: "Failed to reset PIN" });

  it("shows the new PIN and reloads the assignments on success", async () => {
    const fetchMock = await resetPin(() => Response.json({ pin: "4821", emailSent: false }));

    expect(await screen.findByText("4821")).toBeInTheDocument();
    expect(listLoads(fetchMock)).toBeGreaterThanOrEqual(2);
  });
});
