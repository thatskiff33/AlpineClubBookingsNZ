// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LODGES = vi.hoisted(() => [
  { id: "lodge-1", name: "Lodge One" },
  { id: "lodge-2", name: "Lodge Two" },
]);

const access = vi.hoisted(() => ({ canEdit: true }));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => access.canEdit,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

// The real control is a portalled, pointer-driven Radix Select; the subject
// here is the section's reaction to a scope CHANGE, and a native select drives
// the same onChange contract.
vi.mock("../policy-scope-select", () => ({
  usePolicyScopeOptions: (lodgeId: string | null) => ({
    state: lodgeId
      ? { kind: "lodge", lodgeId, lodgeName: LODGES.find((lodge) => lodge.id === lodgeId)?.name ?? null }
      : { kind: "club-wide" },
    lodges: LODGES,
    reload: vi.fn(),
  }),
  isPolicyScopeReady: () => true,
  PolicyScopeSelect: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (lodgeId: string | null) => void;
    id?: string;
  }) => (
    <select
      aria-label="Rules for"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">Club-wide rules (default)</option>
      {LODGES.map((lodge) => (
        <option key={lodge.id} value={lodge.id}>
          {lodge.name}
        </option>
      ))}
    </select>
  ),
}));

import { AdultMemberHostingSection } from "../adult-member-hosting-section";

/**
 * #2569 — the card refuses to render a row without an `effective` block, because
 * that block IS what it displays as in force; guessing the inheritance in the
 * component is the one thing it must never do. So every fixture carries one, and
 * `effectiveFor` builds the shape the server actually returns.
 */
function effectiveFor(
  mode: "DISABLED" | "ADMIN_REVIEW_REQUIRED" | "ENFORCED",
  modeSource: "LODGE" | "CLUB_WIDE" | "BUILT_IN_DEFAULT",
) {
  return {
    mode,
    modeSource,
    hostScopes: { sameBooking: true, sameBookingOwner: false },
    hostScopeSource: "BUILT_IN_DEFAULT" as const,
    preview: "Preview sentence.",
  };
}

const UNCONFIGURED_CLUB = {
  scopeKey: "club-wide",
  lodgeId: null,
  mode: "DISABLED",
  capacityMode: null,
  hostScopes: null,
  version: 0,
  configured: false,
  effective: effectiveFor("DISABLED", "BUILT_IN_DEFAULT"),
};

const CONFIGURED_CLUB = {
  scopeKey: "club-wide",
  lodgeId: null,
  mode: "ADMIN_REVIEW_REQUIRED",
  capacityMode: "HOLD",
  hostScopes: null,
  version: 4,
  configured: true,
  effective: effectiveFor("ADMIN_REVIEW_REQUIRED", "CLUB_WIDE"),
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  access.canEdit = true;
});

async function renderWith(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  render(<AdultMemberHostingSection />);
  await screen.findByText(/Adult Member Hosting/);
  return fetchMock;
}

describe("adult-member hosting settings card (#2364)", () => {
  it("loads read-only, and Edit reveals Save/Cancel", async () => {
    await renderWith(async () => json(CONFIGURED_CLUB));
    const mode = (await screen.findByLabelText(
      /Non-member guests without an adult member/,
    )) as HTMLSelectElement;
    expect(mode.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Save Hosting Policy/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(mode.disabled).toBe(false);
    expect(
      screen.getByRole("button", { name: /Save Hosting Policy/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("keeps Save disabled until the FIRST save has something to say (D-R6)", async () => {
    await renderWith(async () => json(UNCONFIGURED_CLUB));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    // Unconfigured counts as dirty (there is nothing to be unchanged from), but
    // no capacity mode has been chosen, so the write is still not valid.
    const save = screen.getByRole("button", { name: /Save Hosting Policy/ });
    expect(save.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText(/Exception capacity handling/), {
      target: { value: "NO_HOLD" },
    });
    expect(
      screen.getByRole("button", { name: /Save Hosting Policy/ }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("refuses to re-PUT an unchanged configured policy (#2143)", async () => {
    await renderWith(async () => json(CONFIGURED_CLUB));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(
      screen.getByRole("button", { name: /Save Hosting Policy/ }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("sends the loaded revision and re-seeds from the server's answer", async () => {
    const fetchMock = await renderWith(async (_url, init) => {
      if (init?.method === "PUT") {
        return json({ ...CONFIGURED_CLUB, mode: "DISABLED", version: 5 });
      }
      return json(CONFIGURED_CLUB);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(
      screen.getByLabelText(/Non-member guests without an adult member/),
      { target: { value: "DISABLED" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /Save Hosting Policy/ }));

    await waitFor(() =>
      expect(screen.getByText(/Adult-member hosting policy saved/)).toBeTruthy(),
    );
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({
      mode: "DISABLED",
      capacityMode: "HOLD",
      // #2569 — always sent, including null: null IS "inherit the club's choice",
      // so omitting it would leave the route guessing.
      hostScopes: null,
      version: 4,
    });
    // Re-seeded from the RESPONSE: revision 5, not the 4 that was submitted.
    await waitFor(() => expect(screen.getByText(/Revision 5\./)).toBeTruthy());
  });

  it("omits the revision on a first save, so the route can refuse a resurrection", async () => {
    const fetchMock = await renderWith(async (_url, init) => {
      if (init?.method === "PUT") {
        return json({ ...UNCONFIGURED_CLUB, capacityMode: "HOLD", version: 1, configured: true });
      }
      return json(UNCONFIGURED_CLUB);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText(/Exception capacity handling/), {
      target: { value: "HOLD" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Hosting Policy/ }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
      ).toBe(true),
    );
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({
      mode: "DISABLED",
      capacityMode: "HOLD",
      hostScopes: null,
    });
  });

  it("scopes the GET by lodge and offers Inherit only there", async () => {
    const fetchMock = await renderWith(async (url) =>
      url.includes("lodgeId=lodge-1")
        ? json({
            scopeKey: "lodge-1",
            lodgeId: "lodge-1",
            mode: "INHERIT",
            capacityMode: "NO_HOLD",
            hostScopes: null,
            version: 2,
            configured: true,
            effective: effectiveFor("ADMIN_REVIEW_REQUIRED", "CLUB_WIDE"),
          })
        : json(CONFIGURED_CLUB),
    );
    // Club-wide has no Inherit option: there is nothing above it.
    expect(screen.queryByText("Use the club-wide setting")).toBeNull();

    fireEvent.change(screen.getByLabelText("Rules for"), {
      target: { value: "lodge-1" },
    });
    await screen.findByText(/Adult Member Hosting — Lodge One/);
    expect(screen.getByText("Use the club-wide setting")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("lodgeId=lodge-1")),
    ).toBe(true);
  });

  it("shows UNKNOWN rather than another scope's values when a switch fails", async () => {
    await renderWith(async (url) =>
      url.includes("lodgeId=lodge-1")
        ? new Response("{}", { status: 500 })
        : json(CONFIGURED_CLUB),
    );
    await screen.findByRole("button", { name: "Edit" });

    fireEvent.change(screen.getByLabelText("Rules for"), {
      target: { value: "lodge-1" },
    });
    await screen.findByText(
      /Could not load the adult-member hosting policy for Lodge One/,
    );
    // No editor, and nothing that could write the previous scope's values.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Save Hosting Policy/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("explains view-only access and offers no Edit to a bookings:view admin", async () => {
    access.canEdit = false;
    await renderWith(async () => json(CONFIGURED_CLUB));
    expect(
      screen.getByText(/can view the adult-member hosting policy but cannot change it/),
    ).toBeTruthy();
    const edit = await screen.findByRole("button", { name: "Edit" });
    expect(edit.hasAttribute("disabled")).toBe(true);
  });

  it("lets an admin switch to a custom set and tick same-owner coverage (#2576)", async () => {
    // Both checkboxes are live. The scope was previously rendered disabled with
    // "not available yet" beside it, because nothing could evaluate it; #2576
    // replaced that planned workflow with this narrower same-account rule, which
    // the settings surface carries in full.
    const fetchMock = await renderWith(async (_url, init) => {
      if (init?.method === "PUT") {
        return json({
          ...CONFIGURED_CLUB,
          hostScopes: { sameBooking: true, sameBookingOwner: true },
          version: 5,
        });
      }
      return json(CONFIGURED_CLUB);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    const sameOwner = screen.getByLabelText(
      /Another booking on the same account/,
    ) as HTMLInputElement;
    // Inherit is selected, so the boxes are inert until the admin takes the
    // decision for this scope.
    expect(sameOwner.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Adult members who count/), {
      target: { value: "CUSTOM" },
    });
    expect(sameOwner.disabled).toBe(false);
    fireEvent.click(sameOwner);
    fireEvent.click(screen.getByRole("button", { name: /Save Hosting Policy/ }));

    await waitFor(() =>
      expect(screen.getByText(/Adult-member hosting policy saved/)).toBeTruthy(),
    );
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({
      mode: "ADMIN_REVIEW_REQUIRED",
      capacityMode: "HOLD",
      // #3037. The card sends the COMPLETE set, including the scope it did not
      // tick. Omitting it would leave the route to interpret silence, which is
      // the guess this card avoids one field higher up by sending `null` rather
      // than omitting `hostScopes` for the inherit option.
      hostScopes: {
        sameBooking: true,
        sameBookingOwner: true,
        sameGroupTrip: false,
      },
      version: 4,
    });
  });

  it("offers Group Trip coverage as a third independent, off-by-default box (#3037)", async () => {
    const fetchMock = await renderWith(async (_url, init) => {
      if (init?.method === "PUT") {
        return json({
          ...CONFIGURED_CLUB,
          hostScopes: {
            sameBooking: true,
            sameBookingOwner: false,
            sameGroupTrip: true,
          },
          version: 5,
        });
      }
      return json(CONFIGURED_CLUB);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    const groupTrip = screen.getByLabelText(
      /Another booking in the same Group Trip/,
    ) as HTMLInputElement;
    // Off, and inert while the scope inherits — the same two-step the other
    // boxes follow, so an admin cannot enable cross-account cover by accident.
    expect(groupTrip.checked).toBe(false);
    expect(groupTrip.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Adult members who count/), {
      target: { value: "CUSTOM" },
    });
    expect(groupTrip.disabled).toBe(false);
    // It is genuinely independent: ticking it alone is a valid, saveable set.
    fireEvent.click(
      screen.getByLabelText(/Eligible adult member on the same booking/),
    );
    fireEvent.click(groupTrip);
    fireEvent.click(screen.getByRole("button", { name: /Save Hosting Policy/ }));

    await waitFor(() =>
      expect(screen.getByText(/Adult-member hosting policy saved/)).toBeTruthy(),
    );
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(put[1]!.body)).hostScopes).toEqual({
      sameBooking: false,
      sameBookingOwner: false,
      sameGroupTrip: true,
    });
  });

  it("names the qualifying-source group and associates its shared guidance", async () => {
    await renderWith(async () => json(CONFIGURED_CLUB));

    const source = screen.getByLabelText(
      /Adult members who count/,
    ) as HTMLSelectElement;
    const group = screen.getByRole("group", {
      name: "Qualifying adult-member sources",
    });
    expect(source.getAttribute("aria-describedby")).toBe("hostingScopeHint");
    expect(group.getAttribute("aria-describedby")).toBe("hostingScopeHint");
    expect(document.getElementById("hostingScopeHint")?.textContent).toMatch(
      /These are independent/,
    );
  });

  it("keeps Save unreachable for a custom set with nobody ticked (#2569 §16)", async () => {
    await renderWith(async () => json(CONFIGURED_CLUB));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText(/Adult members who count/), {
      target: { value: "CUSTOM" },
    });
    // The seed is the effective set, so same-booking starts ticked. Untick it and
    // the set says "these are this scope's own rules, and nobody counts", which is
    // only ever a description of Disabled.
    fireEvent.click(
      screen.getByLabelText(/Eligible adult member on the same booking/),
    );
    expect(
      screen
        .getByRole("button", { name: /Save Hosting Policy/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("surfaces a 409 and reloads the authoritative row", async () => {
    let loads = 0;
    await renderWith(async (_url, init) => {
      if (init?.method === "PUT") {
        return json({ error: "This hosting policy changed since you opened it" }, 409);
      }
      loads += 1;
      return json(loads === 1 ? CONFIGURED_CLUB : { ...CONFIGURED_CLUB, version: 9 });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(
      screen.getByLabelText(/Non-member guests without an adult member/),
      { target: { value: "DISABLED" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /Save Hosting Policy/ }));

    await waitFor(() =>
      expect(screen.getByText(/changed since you opened it/)).toBeTruthy(),
    );
    await waitFor(() => expect(screen.getByText(/Revision 9\./)).toBeTruthy());
  });
});
