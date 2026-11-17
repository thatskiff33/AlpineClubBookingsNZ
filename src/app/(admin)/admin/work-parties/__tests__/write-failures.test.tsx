// @vitest-environment jsdom

/**
 * Every other work-party read and write says why it failed (ALP-649, #4976
 * follow-up; the delete has its own file).
 *
 * The list load, save, active toggle and attending-bookings read each parsed
 * the reply as JSON before checking `ok`. The list load and save caught the
 * parse error and showed their fixed fallback, so their cases here pin that
 * behaviour through the shared reader rather than fix a visible fault. The
 * toggle and the bookings read had no catch at all: an error page or a dropped
 * connection was silent, and a refused bookings read left "Loading
 * bookings..." standing for good. Each now throws the refusal through
 * `apiRefusalFromResponse`: the route's own sentence when it sent one, this
 * screen's fallback otherwise, and the fallback again when the request never
 * arrives. A 403 save or toggle keeps its own permission sentence. A failed
 * bookings read is reported inside the event's card, with "Try again".
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { htmlErrorPage, itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";

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
  const fetchMock = stubFetch((url, method) => url === `${LIST}/wp-1` && method === "GET", answer);
  render(<AdminWorkPartiesPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Show bookings" }));
  return fetchMock;
}

const detailReads = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([input, init]) => String(input) === `${LIST}/wp-1` && (init?.method ?? "GET") === "GET");

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
  itShowsEveryRefusal({ submit: async (answer) => void (await showBookings(answer)), fallback: "Failed to load attending bookings" });

  it("says why inside the event's card, not in the page banner, and stops loading", async () => {
    await showBookings(() => htmlErrorPage(502));
    const alert = await screen.findByText("Failed to load attending bookings");
    expect(alert.closest("#wp-bookings-error-wp-1")).not.toBeNull();
    expect(screen.queryByText("Loading bookings...")).not.toBeInTheDocument();
  });

  it("clears the reason when a retry loads the bookings", async () => {
    let fail = true;
    const fetchMock = await showBookings(() =>
      fail ? htmlErrorPage(502) : Response.json({ attendingBookings: [], totalDiscountCents: 0 }),
    );
    const card = (await screen.findByText("Failed to load attending bookings")).closest("#wp-bookings-error-wp-1");
    fail = false;
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("columnheader", { name: "Member" })).toBeInTheDocument();
    expect(screen.queryByText("Failed to load attending bookings")).not.toBeInTheDocument();
    expect(detailReads(fetchMock)).toHaveLength(2);
  });

  it("reads again with a clean card when the officer hides and re-opens a failed row", async () => {
    let fail = true;
    await showBookings(() =>
      fail ? htmlErrorPage(502) : Response.json({ attendingBookings: [], totalDiscountCents: 0 }),
    );
    await screen.findByText("Failed to load attending bookings");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Hide bookings" }));
    fireEvent.click(screen.getByRole("button", { name: "Show bookings" }));
    expect(await screen.findByRole("columnheader", { name: "Member" })).toBeInTheDocument();
    expect(screen.queryByText("Failed to load attending bookings")).not.toBeInTheDocument();
  });

  it("shows the bookings table when the read succeeds", async () => {
    await showBookings(() => Response.json({ attendingBookings: [], totalDiscountCents: 0 }));
    expect(await screen.findByRole("columnheader", { name: "Member" })).toBeInTheDocument();
  });
});
