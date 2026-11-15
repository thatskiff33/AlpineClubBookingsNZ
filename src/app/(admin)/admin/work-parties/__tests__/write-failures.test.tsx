// @vitest-environment jsdom

/**
 * Every other work-party read and write says why it failed (ALP-649, #4976
 * follow-up; the delete has its own file).
 *
 * The list load, save, active toggle and attending-bookings read each parsed
 * the reply as JSON before checking `ok`. An HTML error page from the proxy in
 * front of the app reached the officer as a JSON parse error, the toggle and
 * the bookings read had no catch at all, and a refused bookings read left
 * "Loading bookings..." standing for good. Each now throws the refusal through
 * `apiRefusalFromResponse`: the route's own sentence when it sent one, this
 * screen's fallback otherwise, and the fallback again when the request never
 * arrives. A 403 save or toggle keeps its own permission sentence.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

vi.mock("@/components/lodge-select", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/components/lodge-select")),
  useLodgeOptions: () => ({
    lodges: [{ id: "lodge-a", name: "Lodge A" }],
    loading: false,
    failed: false,
    forbidden: false,
    reload: vi.fn(),
  }),
}));

import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
import AdminWorkPartiesPage from "../page";

const BEE = {
  id: "wp-1",
  name: "Spring working bee",
  description: null,
  startDate: "2026-09-12T00:00:00.000Z",
  endDate: "2026-09-13T00:00:00.000Z",
  discountPercent: 100,
  active: true,
  lodgeId: null,
  lodgeName: null,
  bookingCount: 0,
  totalDiscountCents: 0,
};

type Answer = () => Response | Promise<Response>;

const LIST = "/api/admin/work-parties";

// "Show bookings" only renders for an event that has some.
let events = [BEE];

/** Answers the request `target` picks with `answer`; everything else succeeds. */
function stubFetch(target: (url: string, method: string) => boolean, answer: Answer) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (target(url, method)) return answer();
    if (url === LIST && method === "GET") return Response.json({ events });
    if (url.startsWith(`${LIST}/`)) {
      return method === "GET"
        ? Response.json({ attendingBookings: [], totalDiscountCents: 0 })
        : Response.json({ event: BEE });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const listReads = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([input, init]) => String(input) === LIST && (init?.method ?? "GET") === "GET");

const isSave = (url: string, method: string) => url === `${LIST}/wp-1` && method === "PUT";

async function saveEdit(answer: Answer) {
  const fetchMock = stubFetch(isSave, answer);
  render(<AdminWorkPartiesPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  return fetchMock;
}

async function toggle(answer: Answer) {
  const fetchMock = stubFetch(isSave, answer);
  render(<AdminWorkPartiesPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
  return fetchMock;
}

async function showBookings(answer: Answer) {
  events = [{ ...BEE, bookingCount: 2 }];
  stubFetch((url, method) => url === `${LIST}/wp-1` && method === "GET", answer);
  render(<AdminWorkPartiesPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Show bookings" }));
}

afterEach(() => {
  events = [BEE];
  cleanup();
  vi.unstubAllGlobals();
});

describe("Work parties: a failed list load says why", () => {
  itShowsEveryRefusal({
    submit: async (answer) => {
      stubFetch((url, method) => url === LIST && method === "GET", answer);
      render(<AdminWorkPartiesPage />);
    },
    fallback: "Failed to load work party events",
  });

  it("lists the events when the load succeeds", async () => {
    stubFetch(() => false, () => Response.json({}));
    render(<AdminWorkPartiesPage />);
    expect(await screen.findByText("Spring working bee")).toBeInTheDocument();
  });
});

describe("Work parties: a refused save says why", () => {
  itShowsEveryRefusal({ submit: async (answer) => void (await saveEdit(answer)), fallback: "Failed to save work party event" });

  it("keeps the permission sentence for a 403", async () => {
    await saveEdit(() => Response.json({ error: "Forbidden" }, { status: 403 }));
    expect(await screen.findByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeInTheDocument();
  });

  it("closes the form and reloads the events after a successful save", async () => {
    const fetchMock = await saveEdit(() => Response.json({ event: BEE }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument());
    await waitFor(() => expect(listReads(fetchMock)).toHaveLength(2));
  });
});

describe("Work parties: a refused active toggle says why", () => {
  itShowsEveryRefusal({ submit: async (answer) => void (await toggle(answer)), fallback: "Failed to update work party event" });

  it("keeps the permission sentence for a 403", async () => {
    await toggle(() => Response.json({ error: "Forbidden" }, { status: 403 }));
    expect(await screen.findByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeInTheDocument();
  });

  it("reloads the events after a successful toggle", async () => {
    const fetchMock = await toggle(() => Response.json({ event: { ...BEE, active: false } }));
    await waitFor(() => expect(listReads(fetchMock)).toHaveLength(2));
  });
});

describe("Work parties: a failed attending-bookings read says why", () => {
  itShowsEveryRefusal({ submit: showBookings, fallback: "Failed to load attending bookings" });

  it("shows the bookings table when the read succeeds", async () => {
    await showBookings(() => Response.json({ attendingBookings: [], totalDiscountCents: 0 }));
    expect(await screen.findByRole("columnheader", { name: "Member" })).toBeInTheDocument();
  });
});
