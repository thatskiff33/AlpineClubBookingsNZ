// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #2142 review: the rest of this suite mocks `useLodgeOptions` to ZERO lodges,
// so `PolicyScopeSelect` renders nothing and no scope-switch path is exercised
// at all. That gap hid a real defect: `useSectionEditState` leaves `saved` and
// `draft` untouched when a load FAILS, and this PR newly DERIVES two decisions
// from `saved` — whether a lodge has an override, and whether the first-save
// exception applies. After a failed scope switch the snapshot still describes
// the PREVIOUS partition, so those derivations were being made from a value
// that says nothing about the lodge on screen.
//
// The invariant these tests pin: a snapshot is authoritative ONLY for the scope
// it was loaded for. A mismatch means "unknown" — no editor, no override
// affordances, no first-save exception — until a load for the current scope
// succeeds.

const LODGES = vi.hoisted(() => [
  { id: "lodge-1", name: "Lodge One" },
  { id: "lodge-2", name: "Lodge Two" },
]);

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ lodges: LODGES, loading: false }),
}));

// The real scope control is a Radix `Select` (portalled, pointer-driven), which
// is not the subject here — the section's reaction to a scope CHANGE is. A
// plain native select drives the same `onChange` contract.
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

import { DefaultCancellationPolicySection } from "../default-cancellation-policy-section";

const CLUB_RULES = [
  {
    daysBeforeStay: 30,
    refundPercentage: 100,
    creditRefundPercentage: 100,
    fixedFeeCents: 0,
    creditFixedFeeCents: 0,
  },
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

/**
 * Route each GET by scope. `lodgeOne` is what the lodge partition's GET does —
 * a body to return, or `"fail"` for a 500.
 */
function stubFetch(options: {
  clubRules?: unknown[];
  lodgeOne: "fail" | { rules: unknown[] };
}) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url) => {
      if (url.includes("lodgeId=lodge-1")) {
        if (options.lodgeOne === "fail") {
          return new Response("{}", { status: 500 });
        }
        return jsonResponse(options.lodgeOne);
      }
      return jsonResponse({
        rules: options.clubRules ?? CLUB_RULES,
        nonMemberHoldEnabled: true,
        nonMemberHoldDays: 7,
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function scopeSelect() {
  return screen.getByLabelText("Rules for") as HTMLSelectElement;
}

function switchScopeTo(value: string) {
  fireEvent.change(scopeSelect(), { target: { value } });
}

function writeCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method !== undefined,
  );
}

async function renderClubWide() {
  render(<DefaultCancellationPolicySection />);
  await waitFor(() => expect(screen.getByText("Default Policy")).toBeTruthy());
}

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DefaultCancellationPolicySection scope switching (#2142 review)", () => {
  it("shows the club-wide fallback card, not an editor, after a SUCCESSFUL switch to a lodge with no override", async () => {
    stubFetch({ lodgeOne: { rules: [] } });
    await renderClubWide();

    switchScopeTo("lodge-1");

    await waitFor(() =>
      expect(
        screen.getByText("Lodge One uses the club-wide rules"),
      ).toBeTruthy(),
    );
    expect(
      screen.getByRole("button", { name: "Create override for this lodge" }),
    ).toBeTruthy();
    expect(screen.queryByText("Lodge One Override")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Remove override (use club-wide rules)",
      }),
    ).toBeNull();
  });

  it("shows no override affordances at all when the switch FAILS, so the club-wide snapshot cannot masquerade as a lodge override", async () => {
    // Before the fix: `saved` still held the club-wide policy, `hasOverride`
    // read its non-empty rules, and the admin was shown a "Lodge One Override"
    // editor pre-filled with the CLUB-WIDE rules plus a Remove button — for a
    // lodge that has no override. Removing would have fired a no-op deleteMany
    // AND a `cancellation-policy.update` audit entry: exactly the #2143 erosion
    // this change exists to stop.
    const fetchMock = stubFetch({ lodgeOne: "fail" });
    await renderClubWide();

    switchScopeTo("lodge-1");

    // Settle on the load failure itself — the assertions below are about what
    // the section must NOT offer once it has failed.
    await waitFor(() =>
      expect(screen.getByText(/Failed to fetch policy/i)).toBeTruthy(),
    );
    expect(screen.queryByText("Lodge One Override")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Remove override (use club-wide rules)",
      }),
    ).toBeNull();
    // Not offered as "no override" either — we do not know that it has none.
    expect(
      screen.queryByRole("button", { name: "Create override for this lodge" }),
    ).toBeNull();
    // And nothing reached a write route.
    expect(writeCalls(fetchMock)).toHaveLength(0);
    // What IS shown says plainly that this scope's state is unknown.
    expect(
      screen.getByText(/Could not load the policy for Lodge One/i),
    ).toBeTruthy();
  });

  it("does not carry the first-save exception across a failed switch, so a pristine form cannot blind-write a new lodge override", async () => {
    // Before the fix: with no club-wide rules persisted the snapshot carried
    // `configured: false`, that survived the failed switch, `isDirty`
    // short-circuited true while the form was still pristine, and one click
    // PUT the hard-coded FALLBACK_RULES as a brand-new Lodge One override.
    const fetchMock = stubFetch({ clubRules: [], lodgeOne: "fail" });
    await renderClubWide();
    // Sanity: the exception DOES apply on the club-wide scope it was loaded for.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      (
        screen.getByRole("button", {
          name: "Save Default Policy",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    switchScopeTo("lodge-1");

    await waitFor(() =>
      expect(screen.getByText(/Failed to fetch policy/i)).toBeTruthy(),
    );
    // There is no Save to click, because there is no editor to save from.
    expect(
      screen.queryByRole("button", { name: "Save Lodge Override" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(writeCalls(fetchMock)).toHaveLength(0);
    expect(
      screen.getByText(/Could not load the policy for Lodge One/i),
    ).toBeTruthy();
  });

  it("restores the editor when the admin switches back to a scope that loads", async () => {
    stubFetch({ lodgeOne: "fail" });
    await renderClubWide();

    switchScopeTo("lodge-1");
    await waitFor(() =>
      expect(screen.getByText(/Failed to fetch policy/i)).toBeTruthy(),
    );

    switchScopeTo("");

    await waitFor(() => expect(screen.getByText("Default Policy")).toBeTruthy());
    expect(screen.queryByText(/Could not load the policy/i)).toBeNull();
    // Freshly loaded and unchanged, so the #2143 dirty gate holds it shut.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      (
        screen.getByRole("button", {
          name: "Save Default Policy",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("shows the lodge's own override after a successful switch to a lodge that has one", async () => {
    stubFetch({
      lodgeOne: {
        rules: [
          {
            daysBeforeStay: 3,
            refundPercentage: 25,
            creditRefundPercentage: 25,
            fixedFeeCents: 0,
            creditFixedFeeCents: 0,
          },
        ],
      },
    });
    await renderClubWide();

    switchScopeTo("lodge-1");

    await waitFor(() =>
      expect(screen.getByText("Lodge One Override")).toBeTruthy(),
    );
    expect(
      screen.getByRole("button", {
        name: "Remove override (use club-wide rules)",
      }),
    ).toBeTruthy();
  });
});

// #2142 review (round 3): two async handlers in this section still read the
// scope (or its NAME) from render scope AFTER an await, so a scope switch during
// the round trip re-targets them at whatever is selected by the time they
// resolve. `load` already carries the guard; these two did not.
describe("in-flight scope changes cannot re-target a click (#2142 review)", () => {
  /**
   * Route by scope, with the club-wide GET held open on demand so a scope switch
   * can be interleaved with the "Create override" seed fetch, and the PUT held
   * open so a scope switch can be interleaved with a save.
   */
  function stubDeferrable() {
    const state = {
      holdClubGet: false,
      releaseClubGet: (() => {}) as () => void,
      holdPut: false,
      releasePut: (() => {}) as () => void,
    };
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async (url, init) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        const response = () =>
          jsonResponse({ rules: body.rules ?? [] });
        if (state.holdPut) {
          return new Promise<Response>((resolve) => {
            state.releasePut = () => resolve(response());
          });
        }
        return response();
      }
      if (url.includes("lodgeId=")) {
        // Neither lodge has an override.
        return jsonResponse({ rules: [] });
      }
      const clubBody = {
        rules: CLUB_RULES,
        nonMemberHoldEnabled: true,
        nonMemberHoldDays: 7,
      };
      if (state.holdClubGet) {
        return new Promise<Response>((resolve) => {
          state.releaseClubGet = () => resolve(jsonResponse(clubBody));
        });
      }
      return jsonResponse(clubBody);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, state };
  }

  async function goToLodgeOne() {
    await renderClubWide();
    switchScopeTo("lodge-1");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create override for this lodge" }),
      ).toBeTruthy(),
    );
  }

  // Click "Create override" on lodge B, switch to lodge C before the seed fetch
  // resolves: the scope effect clears `creatingOverride` and C loads clean, then
  // B's fetch resolves and flips `creatingOverride` back on — for C. The editor
  // opened in create mode on C, pre-filled with club-wide rules, Save enabled,
  // on a lodge the admin never chose.
  it("does not open a create-override editor on the lodge the admin switched TO", async () => {
    const { fetchMock, state } = stubDeferrable();
    await goToLodgeOne();

    state.holdClubGet = true;
    fireEvent.click(
      screen.getByRole("button", { name: "Create override for this lodge" }),
    );

    switchScopeTo("lodge-2");
    await waitFor(() =>
      expect(
        screen.getByText("Lodge Two uses the club-wide rules"),
      ).toBeTruthy(),
    );

    // Lodge One's seed fetch lands now, on Lodge Two's screen.
    state.releaseClubGet();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(screen.queryByText("Lodge Two Override")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Save Lodge Override" }),
    ).toBeNull();
    // Still exactly where the admin actually is.
    expect(screen.getByText("Lodge Two uses the club-wide rules")).toBeTruthy();
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  // `successMessage` is evaluated when the save RESOLVES, so reading the lodge
  // name from render scope there named whatever lodge was selected by then.
  it("names the lodge that was actually written, not the one now selected", async () => {
    const { state } = stubDeferrable();
    await goToLodgeOne();

    // Creating an override is the first-save exception, so Save is live with no
    // field change needed.
    fireEvent.click(
      screen.getByRole("button", { name: "Create override for this lodge" }),
    );
    await waitFor(() =>
      expect(screen.getByText("Lodge One Override")).toBeTruthy(),
    );
    state.holdPut = true;
    fireEvent.click(screen.getByRole("button", { name: "Save Lodge Override" }));

    switchScopeTo("lodge-2");
    await waitFor(() =>
      expect(
        screen.getByText("Lodge Two uses the club-wide rules"),
      ).toBeTruthy(),
    );

    state.releasePut();

    await waitFor(() =>
      expect(screen.getByText(/Override saved for Lodge One/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Override saved for Lodge Two/)).toBeNull();
  });
});

// #2142 review (round 4): this section's loading state was an EARLY RETURN
// above everything else, and a scope change drives `reload`, which flips
// `loading` back on. So the scope select — which lives below it — was unmounted
// for the whole round trip, and the keyboard user who had just changed scope
// from "Rules for" lost focus to `<body>`. `PolicyFeedback` was below it too,
// so a failed FIRST load mounted its live regions ALREADY POPULATED in a single
// commit, which is the announcement pattern its header comment says the
// unconditional wrappers exist to avoid. The frame — banner, feedback, scope
// select — is now rendered in every state.
describe("the frame outlives the loading state (#2142 review)", () => {
  it("keeps the same scope select node, focused, for the whole scope change", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("lodgeId=lodge-1")) {
          await gate;
          return jsonResponse({ rules: [] });
        }
        return jsonResponse({
          rules: CLUB_RULES,
          nonMemberHoldEnabled: true,
          nonMemberHoldDays: 7,
        });
      }),
    );
    await renderClubWide();

    const select = scopeSelect();
    select.focus();
    expect(document.activeElement).toBe(select);

    switchScopeTo("lodge-1");

    // Mid-load: the editor is gone (correct — it described the scope being
    // left) but the control the admin just used is not.
    expect(screen.getByText("Loading...")).toBeTruthy();
    expect(document.body.contains(select)).toBe(true);
    expect(scopeSelect()).toBe(select);
    expect(document.activeElement).toBe(select);

    release();
    await act(async () => {});
    await waitFor(() =>
      expect(screen.getByText("Lodge One uses the club-wide rules")).toBeTruthy(),
    );
    expect(scopeSelect()).toBe(select);
    expect(document.activeElement).toBe(select);
  });

  it("mounts the alert region empty, then populates that same node", async () => {
    let release: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending),
    );

    const { container } = render(<DefaultCancellationPolicySection />);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert?.textContent).toBe("");
    expect(screen.getByText("Loading...")).toBeTruthy();

    release(new Response("{}", { status: 500 }));

    await waitFor(() =>
      expect(alert?.textContent).toMatch(/Failed to fetch policy/i),
    );
    // Same NODE, newly populated — an announcement, not an injection.
    expect(container.querySelector('[role="alert"]')).toBe(alert);
  });

  it("retries the failed load in place, without a page reload", async () => {
    let failing = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        failing
          ? new Response("{}", { status: 500 })
          : jsonResponse({
              rules: CLUB_RULES,
              nonMemberHoldEnabled: true,
              nonMemberHoldDays: 7,
            }),
      ),
    );
    render(<DefaultCancellationPolicySection />);
    await waitFor(() =>
      expect(
        screen.getByText(/Could not load the policy for the club/i),
      ).toBeTruthy(),
    );

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.getByText("Default Policy")).toBeTruthy());
    expect(screen.queryByText(/Could not load the policy/i)).toBeNull();
  });
});
