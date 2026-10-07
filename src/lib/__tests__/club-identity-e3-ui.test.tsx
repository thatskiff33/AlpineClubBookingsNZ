// @vitest-environment jsdom

// E3 #1929 UI regressions:
//   - The Lodges management page (multi-lodge hub) must expose an Address field
//     and send it in the create/edit payload, so the per-lodge {{lodge-address}}
//     token is populated for non-default lodges (docs "Adding a Second Lodge").
//   - LodgeDetailsPanel on /admin/appearance/identity loads via GET
//     /api/admin/lodges (lodge:view). A content-only admin gets a 403 there; that
//     must render an explanatory read-only notice, NOT a raw failure + Retry.

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1940: the Lodges page reads the session permission matrix for view-only
// gating; provide an edit-level admin session so the create-payload case works.
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

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  canEdit: vi.fn(() => true),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush, replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => mocks.canEdit(),
  // ViewOnlyActionButton (rendered by the now-gated Lodges page) imports this
  // reason string from the same module, so the mock must expose it too (#1940).
  ADMIN_VIEW_ONLY_ACTION_REASON:
    "Your admin role can view this area but cannot make changes.",
}));

import AdminLodgesPage from "@/app/(admin)/admin/lodges/page";
import { LodgeDetailsPanel } from "@/components/admin/lodge-details-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Lodges page — address field (E3 #1929)", () => {
  it("renders an Address input and includes it in the create payload", async () => {
    const fetchBodies: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          fetchBodies.push({
            url,
            body: JSON.parse(String(init.body)),
          });
          return {
            ok: true,
            json: async () => ({ lodge: { id: "new-lodge" } }),
          };
        }
        return { ok: true, json: async () => ({ lodges: [] }) };
      }),
    );

    render(<AdminLodgesPage />);

    // #2887: Add lodge is held closed until the lodge list has actually
    // answered. Creating one against a list that failed to load is how a
    // duplicate second "first lodge" got made, so the button is disabled while
    // `loading` and after an error, and the test has to wait like a user does.
    const addLodge = await screen.findByRole("button", { name: /Add lodge/i });
    await waitFor(() => expect(addLodge).toBeEnabled());
    fireEvent.click(addLodge);

    const addressField = screen.getByLabelText("Address");
    expect(addressField).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "West Peak Lodge" },
    });
    fireEvent.change(addressField, {
      target: { value: "12 Alpine Road, Ohakune" },
    });
    // Required on create since #3407.
    fireEvent.change(screen.getByLabelText("Capacity (maximum guests)"), {
      target: { value: "16" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => expect(fetchBodies).toHaveLength(1));
    expect(fetchBodies[0].body).toMatchObject({
      name: "West Peak Lodge",
      address: "12 Alpine Road, Ohakune",
    });
    // A created lodge routes to its guided setup wizard.
    await waitFor(() =>
      expect(mocks.routerPush).toHaveBeenCalledWith(
        "/admin/lodges/new-lodge/setup",
      ),
    );
  });
});

/*
  #2925: the door-code wipe path.

  `PATCH /api/admin/lodges/[id]` reads an ABSENT key as "leave unchanged" and a
  `null` as "clear it". So an editor seeded from a narrowed record — one with no
  `doorCode` field at all — that always sent `doorCode: form.doorCode.trim() ||
  null` would silently and irreversibly wipe a live door code on the next Save.
  The editor therefore sends only the detail fields the record it loaded
  actually carried.
*/
describe("Lodges page — a narrowed record cannot wipe a door code (#2925)", () => {
  function stubLodgeList(lodge: Record<string, unknown>) {
    const patches: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patches.push(JSON.parse(String(init.body)));
          return { ok: true, status: 200, json: async () => ({ lodge }) };
        }
        return { ok: true, status: 200, json: async () => ({ lodges: [lodge] }) };
      }),
    );
    return patches;
  }

  async function editAndSave() {
    const edit = await screen.findByRole("button", { name: /Edit/i });
    fireEvent.click(edit);
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
  }

  it("omits the detail fields it was never given", async () => {
    const patches = stubLodgeList({
      id: "lodge-1",
      name: "Alpine Lodge",
      slug: "alpine-lodge",
      active: true,
    });

    render(<AdminLodgesPage />);
    await editAndSave();

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ name: "Alpine Lodge" });
    expect(patches[0]).not.toHaveProperty("doorCode");
    expect(patches[0]).not.toHaveProperty("address");
    expect(patches[0]).not.toHaveProperty("travelNote");
  });

  it("still sends every detail field of a full record, including a cleared one", async () => {
    // The other half: the belt must not quietly stop an ordinary admin from
    // CLEARING a door code they can see, which is a real thing they may want.
    const patches = stubLodgeList({
      id: "lodge-1",
      name: "Alpine Lodge",
      slug: "alpine-lodge",
      active: true,
      address: "12 Mountain Road",
      doorCode: "4821",
      travelNote: "Chains required.",
    });

    render(<AdminLodgesPage />);
    const edit = await screen.findByRole("button", { name: /Edit/i });
    fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText("Door code"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      name: "Alpine Lodge",
      address: "12 Mountain Road",
      doorCode: null,
      travelNote: "Chains required.",
    });
  });
});

describe("LodgeDetailsPanel — cross-area denial (E3 #1929)", () => {
  it("renders a read-only notice on a 403 instead of a raw failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })),
    );

    render(<LodgeDetailsPanel />);

    await waitFor(() =>
      expect(
        screen.getByText(/does not include lodge access/i),
      ).toBeInTheDocument(),
    );
    // Not treated as a failure: no error toast, no generic error + Retry.
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(screen.queryByText("Could not load lodge details.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/i })).toBeNull();
  });

  /*
    #2925: `GET /api/admin/lodges` now admits any admitted admin and NARROWS its
    payload for a caller without `lodge:view`, so the refusal this card used to
    read off a 403 arrives as a 200 carrying only `{ id, name, slug, active }`.
    Keying on the status alone would render a live-looking form whose address,
    travel note and door code are silently blank — and whose Save would post
    those blanks back over the real values.
  */
  it("renders the same read-only notice for a narrowed 200, not a blank form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          lodges: [
            { id: "lodge-1", name: "Alpine Lodge", slug: "alpine-lodge", active: true },
          ],
        }),
      })),
    );

    render(<LodgeDetailsPanel />);

    await waitFor(() =>
      expect(
        screen.getByText(/does not include lodge access/i),
      ).toBeInTheDocument(),
    );
    // The form the narrowing would otherwise have rendered blank.
    expect(screen.queryByLabelText("Door code")).toBeNull();
    expect(screen.queryByLabelText("Address")).toBeNull();
    expect(screen.queryByLabelText("Travel note")).toBeNull();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("still edits a lodge whose detail fields are present but empty", async () => {
    // The distinction the `in` check exists to keep: a lodge with no door code
    // SET sends `doorCode: null`, which is an editable empty value, not a
    // refusal. A null check here would have refused a perfectly ordinary lodge.
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

    render(<LodgeDetailsPanel />);

    await waitFor(() =>
      expect(screen.getByLabelText("Door code")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/does not include lodge access/i)).toBeNull();
  });

  it("still shows the generic error + Retry on a non-403 failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    render(<LodgeDetailsPanel />);

    await waitFor(() =>
      expect(
        screen.getByText("Could not load lodge details."),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
    expect(mocks.toastError).toHaveBeenCalled();
    expect(screen.queryByText(/does not include lodge access/i)).toBeNull();
  });
});
