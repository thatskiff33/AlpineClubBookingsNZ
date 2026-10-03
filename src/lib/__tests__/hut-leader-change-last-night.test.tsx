// @vitest-environment jsdom

/**
 * The stay refusal's corrected end (#3817, owner decision "Block it outright").
 *
 * When the server refuses a night the member is not staying, it names the last
 * night they do stay from the start date. The form offers "Change last night to
 * …", and adopting it changes ONLY the end date — the chosen member stays
 * chosen, unlike picking new nights, which deliberately clears the member.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
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

import HutLeadersPage from "@/app/(admin)/admin/hut-leaders/page";
import { ClubIdentityProvider } from "@/components/club-identity-provider";
import { clubIdentity } from "@/config/club-identity";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("hut-leader stay refusal offers the last night stayed (#3817)", () => {
  it("shows the refusal, and Change last night keeps the member and moves only the end date", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/lodges")) {
        return Response.json({ lodges: [{ id: "lodge-1", name: "Lodge One", active: true }] });
      }
      if (url.includes("/api/admin/hut-leaders/eligible-members")) {
        return Response.json({
          members: [
            {
              id: "m1",
              firstName: "Sam",
              lastName: "Stayer",
              email: "sam@example.org",
              hutLeaderEligible: true,
              hutLeaderEligibleAt: null,
              bookingCheckIn: "2099-07-10",
              bookingCheckOut: "2099-07-13",
              suggestedStartDate: "2099-07-10",
              suggestedEndDate: "2099-07-13",
              uncoveredNightCount: 3,
              fullyCovered: false,
            },
          ],
        });
      }
      if (url.includes("/api/admin/hut-leaders/unassigned-dates")) {
        return Response.json({ unassignedDates: [] });
      }
      if (url.includes("/api/admin/hut-leaders") && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return Response.json(
          {
            error:
              "The member is not staying at this lodge on the night of 2099-07-13, so they cannot be hut leader for it. Their last night stayed from the start date is 2099-07-12.",
            code: "HUT_LEADER_NIGHTS_NOT_STAYED",
            firstNightNotStayed: "2099-07-13",
            lastNightStayed: "2099-07-12",
          },
          { status: 409 },
        );
      }
      if (url.includes("/api/admin/hut-leaders")) {
        return Response.json({ assignments: [], members: [] });
      }
      if (url.includes("/api/admin/occupancy")) {
        return Response.json({ month: "2099-07", nights: [], bookings: [] });
      }
      return Response.json({});
    }));

    render(
      <ClubIdentityProvider value={clubIdentity}>
        <HutLeadersPage />
      </ClubIdentityProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Start Date")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Start Date"), { target: { value: "2099-07-10" } });
    fireEvent.change(screen.getByLabelText("Last night"), { target: { value: "2099-07-13" } });

    // The suggestions load after the dates settle; a cold transform of the
    // page can take seconds on a loaded runner, so give that fetch its time.
    await screen.findByText("Sam Stayer", {}, { timeout: 10000 });
    fireEvent.click(await screen.findByRole("button", { name: /^Select$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Confirm assignment/ }));

    const change = await screen.findByRole("button", {
      name: "Change last night to 2099-07-12",
    });
    expect(posts).toHaveLength(1);
    await act(async () => {
      fireEvent.click(change);
    });

    expect(screen.getByLabelText("Last night")).toHaveValue("2099-07-12");
    expect(screen.getByLabelText("Start Date")).toHaveValue("2099-07-10");
    // The member is still the chosen one, and the refusal has cleared.
    expect(screen.getByRole("button", { name: /^Selected$/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Change last night to/ }),
    ).not.toBeInTheDocument();
  });

  it("sends the Custodian (lives on site) tick with the assignment (#3817)", async () => {
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/lodges")) {
        return Response.json({ lodges: [{ id: "lodge-1", name: "Lodge One", active: true }] });
      }
      if (url.includes("/api/admin/hut-leaders/eligible-members")) {
        return Response.json({
          members: [
            {
              id: "m1", firstName: "Cat", lastName: "Custodian", email: "cat@example.org",
              hutLeaderEligible: true, hutLeaderEligibleAt: null,
              bookingCheckIn: "2099-07-10", bookingCheckOut: "2099-07-13",
              suggestedStartDate: "2099-07-10", suggestedEndDate: "2099-07-12",
              uncoveredNightCount: 3, fullyCovered: false,
            },
          ],
        });
      }
      if (url.includes("/api/admin/hut-leaders/unassigned-dates")) {
        return Response.json({ unassignedDates: [] });
      }
      if (url.includes("/api/admin/hut-leaders") && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return Response.json({ id: "new-1", emailSent: true }, { status: 201 });
      }
      if (url.includes("/api/admin/hut-leaders")) {
        return Response.json({ assignments: [], bedAllocationEnabled: false });
      }
      if (url.includes("/api/admin/occupancy")) {
        return Response.json({ month: "2099-07", nights: [], bookings: [] });
      }
      return Response.json({});
    }));

    render(
      <ClubIdentityProvider value={clubIdentity}>
        <HutLeadersPage />
      </ClubIdentityProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Start Date")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Start Date"), { target: { value: "2099-07-10" } });
    fireEvent.change(screen.getByLabelText("Last night"), { target: { value: "2099-07-12" } });
    await screen.findByText("Cat Custodian", {}, { timeout: 10000 });
    fireEvent.click(await screen.findByRole("button", { name: /^Select$/ }));

    // Offered with bed allocation OFF, and the bed picker is not.
    const tick = await screen.findByLabelText("Custodian (lives on site)");
    expect(screen.queryByText("Hold a bed (optional)")).not.toBeInTheDocument();
    fireEvent.click(tick);
    fireEvent.click(await screen.findByRole("button", { name: /Confirm assignment/ }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ memberId: "m1", isCustodian: true });
  });

  it("drops the custodian tick when the member or the nights change (#3817 review)", async () => {
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/lodges")) {
        return Response.json({ lodges: [{ id: "lodge-1", name: "Lodge One", active: true }] });
      }
      if (url.includes("/api/admin/hut-leaders/eligible-members")) {
        return Response.json({
          members: [
            {
              id: "m1", firstName: "Cat", lastName: "Custodian", email: "cat@example.org",
              hutLeaderEligible: true, hutLeaderEligibleAt: null,
              bookingCheckIn: "2099-07-10", bookingCheckOut: "2099-07-13",
              suggestedStartDate: "2099-07-10", suggestedEndDate: "2099-07-12",
              uncoveredNightCount: 3, fullyCovered: false,
            },
          ],
        });
      }
      if (url.includes("/api/admin/hut-leaders/unassigned-dates")) {
        return Response.json({ unassignedDates: [] });
      }
      if (url.includes("/api/admin/hut-leaders") && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return Response.json({ id: "new-1", emailSent: true }, { status: 201 });
      }
      if (url.includes("/api/admin/hut-leaders")) {
        return Response.json({ assignments: [], bedAllocationEnabled: false });
      }
      if (url.includes("/api/admin/occupancy")) {
        return Response.json({ month: "2099-07", nights: [], bookings: [] });
      }
      return Response.json({});
    }));

    render(
      <ClubIdentityProvider value={clubIdentity}>
        <HutLeadersPage />
      </ClubIdentityProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Start Date")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Start Date"), { target: { value: "2099-07-10" } });
    fireEvent.change(screen.getByLabelText("Last night"), { target: { value: "2099-07-12" } });
    await screen.findByText("Cat Custodian", {}, { timeout: 10000 });
    fireEvent.click(await screen.findByRole("button", { name: /^Select$/ }));
    fireEvent.click(await screen.findByLabelText("Custodian (lives on site)"));

    // Re-pick the nights (which clears the member), then choose again.
    fireEvent.change(screen.getByLabelText("Last night"), { target: { value: "2099-07-11" } });
    fireEvent.click(await screen.findByRole("button", { name: /^Select$/ }));
    expect(await screen.findByLabelText("Custodian (lives on site)")).not.toBeChecked();
    fireEvent.click(await screen.findByRole("button", { name: /Confirm assignment/ }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty("isCustodian");
  });

  it("marks an EXISTING row Custodian through the row toggle (#3817)", async () => {
    const puts: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/lodges")) {
        return Response.json({ lodges: [{ id: "lodge-1", name: "Lodge One", active: true }] });
      }
      if (url.includes("/api/admin/hut-leaders/unassigned-dates")) {
        return Response.json({ unassignedDates: [] });
      }
      if (url.includes("/api/admin/hut-leaders/row-1") && init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return Response.json({ success: true });
      }
      if (url.includes("/api/admin/hut-leaders")) {
        return Response.json({
          assignments: [
            {
              id: "row-1", memberId: "m1", memberName: "Cat Custodian",
              memberEmail: "cat@example.org", startDate: "2099-07-01",
              endDate: "2099-09-30", createdAt: "2099-06-01T00:00:00.000Z",
              lodgeId: "lodge-1", lodgeName: "Lodge One", bedId: "bed-1",
              bedName: "A1", bedRoomName: "Kea", isCustodian: false,
            },
          ],
          bedAllocationEnabled: false,
        });
      }
      if (url.includes("/api/admin/occupancy")) {
        return Response.json({ month: "2099-07", nights: [], bookings: [] });
      }
      return Response.json({});
    }));

    render(
      <ClubIdentityProvider value={clubIdentity}>
        <HutLeadersPage />
      </ClubIdentityProvider>,
    );

    const toggle = await screen.findByRole(
      "button",
      { name: "Custodian (lives on site)" },
      { timeout: 10000 },
    );
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ isCustodian: true });
  });
});
