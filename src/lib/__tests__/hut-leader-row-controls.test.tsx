// @vitest-environment jsdom

/**
 * The hut-leaders table's per-row controls (#3821).
 *
 * - A school teacher's row offers neither "Hold a bed" nor the custodian
 *   toggle: a held bed is a custodian occupancy, and the server refuses both.
 * - A row edit shows the server's school-nights advisory in the same note a
 *   create uses.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/hut-leaders",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "a1",
        adminPermissionMatrix: {
          overview: "view", bookings: "edit", membership: "edit",
          finance: "edit", lodge: "edit", content: "view", support: "view",
        },
      },
    },
    status: "authenticated",
  }),
}));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: vi.fn(async () => false), confirmDialog: null }),
}));

import HutLeadersPage from "@/app/(admin)/admin/lodge-ops/hut-leaders/page";
import { ClubIdentityProvider } from "@/components/club-identity-provider";
import { clubIdentity } from "@/config/club-identity";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (overrides: Record<string, unknown>) => ({
  memberEmail: "leader@example.org",
  startDate: "2099-07-01",
  endDate: "2099-07-05",
  createdAt: "2099-06-01T00:00:00.000Z",
  lodgeId: "lodge-1",
  lodgeName: "Lodge One",
  bedId: null,
  bedName: null,
  bedRoomName: null,
  isCustodian: false,
  ...overrides,
});

const WARNING =
  "2 of these nights are a school group's (from 2099-07-02), and this lodge does not accept this kind of hut leader for school bookings.";

function stubFetch(puts: Array<{ url: string; body: unknown }>) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/admin/lodges")) {
      return Response.json({ lodges: [{ id: "lodge-1", name: "Lodge One", active: true }] });
    }
    if (url.includes("/api/admin/hut-leaders/unassigned-dates")) {
      return Response.json({ unassignedDates: [] });
    }
    if (url.includes("/api/admin/hut-leaders/") && init?.method === "PUT") {
      puts.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ success: true, schoolNightsWarning: WARNING });
    }
    if (url.includes("/api/admin/hut-leaders")) {
      return Response.json({
        bedAllocationEnabled: true,
        assignments: [
          row({ id: "manual-1", memberId: "m1", memberName: "Mia Manual", source: "MANUAL" }),
          row({ id: "teacher-1", memberId: "t1", memberName: "Tia Teacher", source: "SCHOOL_BOOKING" }),
        ],
      });
    }
    if (url.includes("/api/admin/occupancy")) {
      return Response.json({ month: "2099-07", nights: [], bookings: [] });
    }
    return Response.json({});
  }));
}

function renderPage() {
  render(
    <ClubIdentityProvider value={clubIdentity}>
      <HutLeadersPage />
    </ClubIdentityProvider>,
  );
}

const rowOf = async (name: string) =>
  (await screen.findByText(name, {}, { timeout: 10000 })).closest("tr") as HTMLElement;

describe("hut-leaders table row controls (#3821)", () => {
  it("offers Hold a bed and the custodian toggle on an ordinary row, and neither on a teacher's", async () => {
    stubFetch([]);
    renderPage();

    const manual = await rowOf("Mia Manual");
    const teacher = await rowOf("Tia Teacher");
    expect(within(manual).getByText("Hold a bed")).toBeInTheDocument();
    expect(within(manual).getByText("Custodian (lives on site)")).toBeInTheDocument();
    expect(within(teacher).queryByText("Hold a bed")).not.toBeInTheDocument();
    expect(within(teacher).queryByText("Change bed")).not.toBeInTheDocument();
    expect(within(teacher).queryByText("Custodian (lives on site)")).not.toBeInTheDocument();
  });

  it("shows the edit's school-nights warning in the advisory note", async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    stubFetch(puts);
    renderPage();

    const manual = await rowOf("Mia Manual");
    await act(async () => {
      fireEvent.click(within(manual).getByText("Custodian (lives on site)").closest("button") as HTMLElement);
    });

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ url: "/api/admin/hut-leaders/manual-1", body: { isCustodian: true } });
    expect(await screen.findByText(WARNING)).toBeInTheDocument();
  });
});
