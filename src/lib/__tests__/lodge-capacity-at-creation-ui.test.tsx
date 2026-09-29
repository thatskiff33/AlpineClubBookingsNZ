// @vitest-environment jsdom

/*
  #3407 (owner decision 14 Sep 2026): "Capacity becomes part of creating a
  lodge ... A capacity step is added to the setup wizard for the case where bed
  allocation is off, so the wizard cannot say 'ready' about a lodge that cannot
  take a booking."

  Two surfaces:
  - Add lodge (`/admin/lodges`) requires a capacity and sends it;
  - the setup wizard asks for it when Bed Allocation is off, and its Finish step
    says "ready" only when the server says the lodge can take a booking — with
    the module on or off.
*/

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  canEdit: vi.fn(() => true),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush, replace: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({ id: "lodge-2" }),
  usePathname: () => "/admin/lodges/lodge-2/setup",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => mocks.canEdit(),
  ADMIN_VIEW_ONLY_ACTION_REASON:
    "Your admin role can view this area but cannot make changes.",
}));

import AdminLodgesPage from "@/app/(admin)/admin/lodges/page";
import LodgeSetupWizardPage from "@/app/(admin)/admin/lodges/[id]/setup/page";
import { NEW_LODGE_CAPACITY_REQUIRED_MESSAGE } from "@/lib/lodge-effective-capacity";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
});

type Call = { url: string; method: string; body: unknown };

describe("Add lodge requires a capacity (#3407)", () => {
  function stubFetch(calls: Call[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({
          url,
          method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (method === "POST") {
          return { ok: true, status: 201, json: async () => ({ lodge: { id: "lodge-2" } }) };
        }
        return { ok: true, status: 200, json: async () => ({ lodges: [] }) };
      }),
    );
  }

  async function openAddLodge() {
    render(<AdminLodgesPage />);
    const addLodge = await screen.findByRole("button", { name: /Add lodge/i });
    await waitFor(() => expect(addLodge).toBeEnabled());
    fireEvent.click(addLodge);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "River Lodge" },
    });
  }

  it.each([
    ["left blank", ""],
    ["zero", "0"],
    ["fractional", "2.5"],
  ])("refuses to create when the capacity is %s, and posts nothing", async (_label, typed) => {
    const calls: Call[] = [];
    stubFetch(calls);
    await openAddLodge();
    fireEvent.change(screen.getByLabelText("Capacity (maximum guests)"), {
      target: { value: typed },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      NEW_LODGE_CAPACITY_REQUIRED_MESSAGE,
    );
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("sends the typed capacity with the new lodge", async () => {
    const calls: Call[] = [];
    stubFetch(calls);
    await openAddLodge();
    fireEvent.change(screen.getByLabelText("Capacity (maximum guests)"), {
      target: { value: "18" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() =>
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(1),
    );
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      name: "River Lodge",
      capacity: 18,
    });
  });

  it("does not ask for a capacity when editing an existing lodge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          lodges: [
            {
              id: "lodge-1",
              name: "Alpine Lodge",
              slug: "alpine-lodge",
              active: true,
              address: null,
              doorCode: null,
              travelNote: null,
            },
          ],
        }),
      })),
    );
    render(<AdminLodgesPage />);
    fireEvent.click(await screen.findByRole("button", { name: /^Edit$/i }));
    expect(screen.queryByLabelText("Capacity (maximum guests)")).toBeNull();
  });
});

describe("the lodge setup wizard's Capacity step and Finish (#3407)", () => {
  function stubWizardFetch(options: {
    bedAllocation: boolean;
    savedCapacity: number | null;
    setUpForBookings: boolean;
    calls: Call[];
  }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        options.calls.push({ url, method, body });
        const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
        if (url.startsWith("/api/admin/lodges/") && method === "PATCH") {
          return ok({
            lodge: {
              id: "lodge-2",
              name: "River Lodge",
              slug: "river-lodge",
              active: true,
              doorCode: null,
              travelNote: null,
            },
          });
        }
        if (url === "/api/admin/lodges") {
          return ok({
            lodges: [
              {
                id: "lodge-2",
                name: "River Lodge",
                slug: "river-lodge",
                active: true,
                doorCode: null,
                travelNote: null,
              },
            ],
          });
        }
        if (url === "/api/admin/modules") {
          return ok({
            settings: {
              bedAllocation: options.bedAllocation,
              lockers: false,
              chores: false,
            },
          });
        }
        if (url.startsWith("/api/admin/lodge-settings")) {
          if (method === "PUT") return ok({ capacity: body.capacity });
          return ok({
            capacity: options.savedCapacity,
            setUpForBookings: options.setUpForBookings,
          });
        }
        return ok({});
      }),
    );
  }

  async function finishIdentity() {
    fireEvent.click(await screen.findByRole("button", { name: "Save and continue" }));
  }

  it("offers a Capacity step when Bed Allocation is off, prefilled, and saves a changed figure", async () => {
    const calls: Call[] = [];
    stubWizardFetch({ bedAllocation: false, savedCapacity: 12, setUpForBookings: true, calls });
    render(<LodgeSetupWizardPage />);

    expect(await screen.findByText("2. Capacity")).toBeInTheDocument();
    await finishIdentity();
    const field = (await screen.findByLabelText(
      "Capacity (maximum guests)",
    )) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("12"));

    fireEvent.change(field, { target: { value: "18" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    await waitFor(() =>
      expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1),
    );
    expect(calls.find((call) => call.method === "PUT")).toMatchObject({
      url: "/api/admin/lodge-settings",
      body: { capacity: 18, lodgeId: "lodge-2" },
    });
  });

  it("does not re-save an unchanged capacity (the route audits every save)", async () => {
    const calls: Call[] = [];
    stubWizardFetch({ bedAllocation: false, savedCapacity: 12, setUpForBookings: true, calls });
    render(<LodgeSetupWizardPage />);
    await finishIdentity();
    const field = (await screen.findByLabelText(
      "Capacity (maximum guests)",
    )) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("12"));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(await screen.findByText("Seasons & rates")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("has no Capacity step when Bed Allocation is on — the Rooms step sets beds there", async () => {
    stubWizardFetch({ bedAllocation: true, savedCapacity: 12, setUpForBookings: true, calls: [] });
    render(<LodgeSetupWizardPage />);
    expect(await screen.findByText("2. Rooms & Beds")).toBeInTheDocument();
    expect(screen.queryByText(/\d\. Capacity/)).toBeNull();
  });

  async function reachFinish(bedAllocation: boolean) {
    await finishIdentity();
    if (!bedAllocation) {
      await screen.findByLabelText("Capacity (maximum guests)");
      fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    } else {
      await screen.findByText("Rooms & beds");
      fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    }
    await screen.findByText("Seasons & rates");
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
  }

  it.each([
    ["off", false],
    ["on", true],
  ])("with Bed Allocation %s, never calls a lodge that resolves to zero ready", async (_label, bedAllocation) => {
    stubWizardFetch({ bedAllocation, savedCapacity: null, setUpForBookings: false, calls: [] });
    render(<LodgeSetupWizardPage />);
    await reachFinish(bedAllocation);

    expect(await screen.findByText("Not ready for bookings yet")).toBeInTheDocument();
    expect(screen.getByText(/River Lodge is not set up for bookings yet/)).toBeInTheDocument();
    expect(screen.queryByText(/is ready/)).toBeNull();
    expect(screen.queryByText("All set")).toBeNull();
  });

  it("says ready when the server says the lodge can take a booking", async () => {
    stubWizardFetch({ bedAllocation: false, savedCapacity: 12, setUpForBookings: true, calls: [] });
    render(<LodgeSetupWizardPage />);
    await reachFinish(false);

    expect(await screen.findByText("All set")).toBeInTheDocument();
    expect(screen.getByText(/River Lodge is ready\./)).toBeInTheDocument();
  });
});
