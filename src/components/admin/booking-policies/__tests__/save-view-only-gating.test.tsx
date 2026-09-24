// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/lib/__tests__/support/club-time-render";
import { StrictMode, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hookMock = vi.hoisted(() => ({ canEdit: true as boolean | undefined }));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => hookMock.canEdit,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

// Single-lodge club: `PolicyScopeSelect` renders nothing below two lodges, so
// these suites exercise the club-wide scope only — which is all the Save gating
// depends on.
vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ lodges: [], loading: false }),
}));

import { ClubIdentityProvider } from "@/components/club-identity-provider";
import { clubIdentity } from "@/config/club-identity";
import { BookingPeriodsSection } from "../booking-periods-section";
import { DefaultCancellationPolicySection } from "../default-cancellation-policy-section";
import { GroupDiscountSection } from "../group-discount-section";
import { MinimumNightStaySection } from "../minimum-night-stay-section";
import { PublicBookingRequestsSection } from "../public-booking-requests-section";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  ADMIN_VIEW_ONLY_SECTION_HEADING,
} from "@/components/admin/view-only-action";

// #2142: every booking-policies section's Save is wrapped in
// `ViewOnlyActionButton`, matching the security cards and the sections' own
// Edit/Add buttons. The interesting case is the tri-state
// `useAdminAreaEditAccess` flipping AFTER the form was opened — a session
// refetch narrowing the actor mid-edit. Before this change Save stayed
// clickable in that window and the admin walked into a 403.
//
// The EXPLANATION for that disabled state is now section-level: these five
// sections render one `AdminViewOnlySectionBanner` and pass
// `describeReason={false}` to every button, because a disabled button is out of
// the tab order and so its `title` / `aria-describedby` were unreachable by
// exactly the keyboard and screen-reader users they were meant for.
//
// #2143: the three formerly hand-rolled sections now track draft-vs-snapshot
// dirtiness through `useSectionEditState`, so an Edit -> Save that changed
// nothing cannot reach a write route that logs an audit entry unconditionally.

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

/**
 * Narrow the actor and force a re-render.
 *
 * `useAdminAreaEditAccess` reads the client session, so in the real app a
 * mid-edit narrowing re-renders the SECTION (the hook's own state changed) and
 * the new `canEdit` flows down to every button, including the ones inside the
 * open editor sub-component. The module-level mock here cannot push a render on
 * its own, so the caller supplies one: either RTL's `rerender` (the faithful
 * stand-in for a section re-render) or, for sections that own their field state
 * directly, a real form interaction.
 */
function narrowTo(canEdit: boolean | undefined, rerenderBy: () => void) {
  hookMock.canEdit = canEdit;
  rerenderBy();
}

/**
 * The section's view-only banner, as a live region.
 *
 * Queried by testid rather than by role (#2142 review): `PolicyFeedback` now
 * mounts its own permanently-registered regions — `role="alert"` for a save
 * failure, `role="status"` for a save confirmation — so "the status region" is
 * no longer unambiguous, and counting `role="status"` nodes across the whole
 * section would pin an unrelated component's a11y shape. The role is still
 * asserted here, once, because it is the property that matters.
 */
function viewOnlyBanner() {
  const banner = screen.getByTestId("admin-view-only-banner");
  expect(banner.getAttribute("role")).toBe("status");
  return banner;
}

function expectViewOnly(button: HTMLButtonElement) {
  expect(button.disabled).toBe(true);
  // The reason is NOT hung off the button any more (#2142 owner decision) …
  expect(button.getAttribute("title")).toBeNull();
  expect(button.getAttribute("aria-describedby")).toBeNull();
  // … it is announced once, in the reading order, by the section banner.
  expect(viewOnlyBanner().textContent).toContain(
    ADMIN_VIEW_ONLY_SECTION_HEADING,
  );
}

function expectNeutralDisabled(button: HTMLButtonElement) {
  // The resolving (`undefined`) window must not flash the read-only reason at
  // an admin who may well turn out to be edit-capable.
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("title")).toBeNull();
  expect(button.getAttribute("aria-describedby")).toBeNull();
  // The live region itself is always mounted (#2142 review) — a polite region
  // must be registered before its content changes or some screen-reader/browser
  // pairings drop the announcement. What must be absent is its CONTENT.
  expect(viewOnlyBanner().textContent).toBe("");
}

/** Every write verb the section could have fired, across the whole stub. */
function writeCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method !== undefined,
  );
}

beforeEach(() => {
  hookMock.canEdit = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BookingPeriodsSection Save gating (#2142, #2143)", () => {
  const PERIOD = {
    id: "p1",
    name: "School Holidays",
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-07-14T00:00:00.000Z",
    nonMemberHoldEnabled: true,
    nonMemberHoldDays: 5,
    cancellationRules: [
      {
        daysBeforeStay: 21,
        refundPercentage: 100,
        creditRefundPercentage: 100,
        fixedFeeCents: 0,
        creditFixedFeeCents: 0,
      },
    ],
    active: true,
  };

  function stub(list: unknown[] = []) {
    const fetchMock = vi.fn(async () => jsonResponse(list));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function openForm() {
    stub([]);
    const { rerender } = render(<BookingPeriodsSection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Period" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Period" }));
    fireEvent.change(screen.getByLabelText("Period Name"), {
      target: { value: "School Holidays" },
    });
    fireEvent.change(screen.getByLabelText("Start Date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("End Date"), {
      target: { value: "2026-07-14" },
    });
    return () => rerender(<BookingPeriodsSection />);
  }

  async function openExistingPeriod() {
    const fetchMock = stub([PERIOD]);
    render(<BookingPeriodsSection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    return fetchMock;
  }

  function createButton() {
    return screen.getByRole("button", {
      name: "Create Period",
    }) as HTMLButtonElement;
  }

  function updateButton() {
    return screen.getByRole("button", {
      name: "Update Period",
    }) as HTMLButtonElement;
  }

  it("enables Create Period for an edit-capable admin", async () => {
    await openForm();
    expect(createButton().disabled).toBe(false);
  });

  it("disables Create Period when the actor is narrowed mid-edit", async () => {
    const rerender = await openForm();
    narrowTo(false, rerender);
    expectViewOnly(createButton());
  });

  it("disables Create Period neutrally while access is resolving", async () => {
    const rerender = await openForm();
    narrowTo(undefined, rerender);
    expectNeutralDisabled(createButton());
  });

  // #2143: `periods/[id]` PUT writes a `booking-period.update` audit entry with
  // a before/after pair unconditionally, so a pristine Update would record a
  // change that never happened. The form must not let one through.
  it("keeps Update Period disabled while the open editor is unchanged", async () => {
    const fetchMock = await openExistingPeriod();
    expect(updateButton().disabled).toBe(true);
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  it("enables Update Period once a field actually changes, and again disables it when reverted", async () => {
    await openExistingPeriod();
    fireEvent.change(screen.getByLabelText("Period Name"), {
      target: { value: "School Holidays (revised)" },
    });
    expect(updateButton().disabled).toBe(false);

    fireEvent.change(screen.getByLabelText("Period Name"), {
      target: { value: "School Holidays" },
    });
    expect(updateButton().disabled).toBe(true);
  });

  it("still allows a first save on Create, where there is no persisted row to be unchanged from", async () => {
    await openForm();
    // Every field still holds the form's own defaults for hold days and rules;
    // only the required identity fields were filled. Create stays available.
    expect(createButton().disabled).toBe(false);
  });
});

describe("MinimumNightStaySection Save gating (#2142, #2143)", () => {
  const POLICY = {
    id: "m1",
    name: "Winter Saturdays",
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-09-30T00:00:00.000Z",
    triggerDays: [6],
    minimumNights: 2,
    capacityMode: "HOLD",
    version: 4,
    active: true,
  };

  function stub(list: unknown[] = []) {
    const fetchMock = vi.fn(async () => jsonResponse(list));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function openForm(
    options: { capacityMode?: "HOLD" | "NO_HOLD" | null } = {},
  ) {
    stub([]);
    const { rerender } = render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Policy" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Policy" }));
    fireEvent.change(screen.getByLabelText("Policy Name"), {
      target: { value: "Winter Saturdays" },
    });
    fireEvent.change(screen.getByLabelText("Start Date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("End Date"), {
      target: { value: "2026-09-30" },
    });
    const capacityMode =
      options.capacityMode === undefined ? "HOLD" : options.capacityMode;
    if (capacityMode) {
      fireEvent.change(screen.getByLabelText("Exception capacity handling"), {
        target: { value: capacityMode },
      });
    }
    return () => rerender(<MinimumNightStaySection />);
  }

  async function openExistingPolicy() {
    const fetchMock = stub([POLICY]);
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    return fetchMock;
  }

  function createButton() {
    return screen.getByRole("button", {
      name: "Create Policy",
    }) as HTMLButtonElement;
  }

  function updateButton() {
    return screen.getByRole("button", {
      name: "Update Policy",
    }) as HTMLButtonElement;
  }

  it("enables Create Policy for an edit-capable admin", async () => {
    await openForm();
    expect(createButton().disabled).toBe(false);
  });

  it("does not enable Create until capacity handling is chosen explicitly", async () => {
    await openForm({ capacityMode: null });
    expect(createButton().disabled).toBe(true);
    expect(
      (screen.getByLabelText("Exception capacity handling") as HTMLSelectElement)
        .value,
    ).toBe("");
  });

  it("associates the capacity explanation with its select", async () => {
    await openForm();
    const select = screen.getByLabelText("Exception capacity handling");
    const descriptionId = select.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId!)?.textContent).toContain(
      "New policies have no automatic choice",
    );
  });

  it("disables Create Policy when the actor is narrowed mid-edit", async () => {
    const rerender = await openForm();
    narrowTo(false, rerender);
    expectViewOnly(createButton());
  });

  it("disables Create Policy neutrally while access is resolving", async () => {
    const rerender = await openForm();
    narrowTo(undefined, rerender);
    expectNeutralDisabled(createButton());
  });

  it("keeps Update Policy disabled while the open editor is unchanged", async () => {
    const fetchMock = await openExistingPolicy();
    expect(updateButton().disabled).toBe(true);
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  it("enables Update Policy once a field actually changes", async () => {
    await openExistingPolicy();
    fireEvent.change(screen.getByLabelText("Minimum Nights"), {
      target: { value: "3" },
    });
    expect(updateButton().disabled).toBe(false);
  });

  // Trigger days are a SET: ticking a day and unticking it is not a change.
  it("treats a ticked-then-unticked trigger day as unchanged", async () => {
    await openExistingPolicy();
    const sunday = screen.getAllByRole("checkbox")[0];
    fireEvent.click(sunday);
    expect(updateButton().disabled).toBe(false);
    fireEvent.click(sunday);
    expect(updateButton().disabled).toBe(true);
  });
});

describe("DefaultCancellationPolicySection Save gating (#2142, #2143)", () => {
  const RULES = [
    {
      daysBeforeStay: 14,
      refundPercentage: 100,
      creditRefundPercentage: 100,
      fixedFeeCents: 0,
      creditFixedFeeCents: 0,
    },
  ];
  const LOADED = {
    rules: RULES,
    nonMemberHoldEnabled: true,
    nonMemberHoldDays: 7,
  };

  async function startEditing(body: unknown = LOADED) {
    const fetchMock = vi.fn(async () => jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    render(<DefaultCancellationPolicySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    return fetchMock;
  }

  function saveButton() {
    return screen.getByRole("button", {
      name: "Save Default Policy",
    }) as HTMLButtonElement;
  }

  function bumpHoldDays(value: string) {
    fireEvent.change(
      screen.getByLabelText("Non-member confirmation threshold"),
      { target: { value } },
    );
  }

  it("enables Save Default Policy once a field changes", async () => {
    await startEditing();
    bumpHoldDays("9");
    expect(saveButton().disabled).toBe(false);
  });

  it("disables Save Default Policy when the actor is narrowed mid-edit", async () => {
    await startEditing();
    narrowTo(false, () => bumpHoldDays("9"));
    expectViewOnly(saveButton());
  });

  it("disables Save Default Policy neutrally while access is resolving", async () => {
    await startEditing();
    narrowTo(undefined, () => bumpHoldDays("9"));
    expectNeutralDisabled(saveButton());
  });

  // #2143: the cancellation PUT logs `cancellation-policy.update` and
  // revalidates the public pages unconditionally, so an Edit -> Save that
  // touched nothing used to record a policy change that never happened.
  it("keeps Save Default Policy disabled while the form is unchanged", async () => {
    const fetchMock = await startEditing();
    expect(saveButton().disabled).toBe(true);
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  it("re-disables Save Default Policy when a change is reverted by hand", async () => {
    await startEditing();
    bumpHoldDays("9");
    expect(saveButton().disabled).toBe(false);
    bumpHoldDays("7");
    expect(saveButton().disabled).toBe(true);
  });

  // #2142 first-save exception: the club-wide GET returns no rules on a club
  // that never saved a policy, and the form seeds itself from its own fallback
  // rules — so draft and snapshot are equal and gating on that alone would make
  // committing the defaults unreachable.
  it("allows a first save when no club-wide rules are persisted yet", async () => {
    await startEditing({
      rules: [],
      nonMemberHoldEnabled: true,
      nonMemberHoldDays: 7,
    });
    expect(saveButton().disabled).toBe(false);
  });

  // #2142 review (destructive): a failed FIRST load used to render the full
  // "Default Policy" editor over the hard-coded FALLBACK_RULES, indistinguishable
  // from real data. `CANCELLATION_DEFAULTS.scope` was `null` and club-wide scope
  // is ALSO `null`, so the round-2 scope invariant read `null === null` and
  // called the never-loaded seed authoritative for the scope the section mounts
  // on. `configured: true` blocked a PRISTINE save, but nothing blocked the
  // realistic one: click Edit, change the hold days, Save — and the PUT carries
  // `rules: FALLBACK_RULES`, which the route applies as `deleteMany` +
  // `createMany` over the whole club-wide partition. The club's real refund
  // schedule is gone.
  it("shows no editor at all when the FIRST load fails, so hardcoded fallbacks can never be saved over a real policy", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DefaultCancellationPolicySection />);

    await waitFor(() =>
      expect(
        screen.getByText(/Could not load the policy for the club/i),
      ).toBeTruthy(),
    );
    // No way in: no Edit, therefore no Save, therefore no PUT.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Save Default Policy" }),
    ).toBeNull();
    // And the fallback rules are not on screen dressed as the stored policy.
    expect(screen.queryByText("Default Policy")).toBeNull();
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  // The same seed, once a load SUCCEEDS, must still behave: a club with rules
  // stored is not "nothing persisted".
  it("re-opens the editor, dirty-gated, once a load finally succeeds", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fail ? new Response("{}", { status: 500 }) : jsonResponse(LOADED),
      ),
    );
    render(<DefaultCancellationPolicySection />);
    await waitFor(() =>
      expect(screen.getByText(/Could not load the policy/i)).toBeTruthy(),
    );

    // A reload is the admin's remedy; simulate it by remounting.
    fail = false;
    cleanup();
    render(<DefaultCancellationPolicySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(saveButton().disabled).toBe(true);
  });
});

// #2142 review (a11y blocker): the polite live region has to be registered in
// the accessibility tree BEFORE its content changes. Every one of these sections
// short-circuits to a loading placeholder first, so if the banner lived only in
// the loaded branch, React would create the region AND its content in a single
// mutation — announced by some screen-reader/browser pairings and silently
// dropped by others. The region must therefore be mounted ABOVE each section's
// loading early-return.
describe("view-only live region is mounted before the loading early-return (#2142)", () => {
  function stubPendingFetch() {
    // Never resolves: the section stays in its loading branch for the assertion.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
  }

  /** Section, and a loaded body its own fetch can parse. */
  const SECTIONS: [string, () => ReactElement, unknown][] = [
    ["BookingPeriodsSection", () => <BookingPeriodsSection />, []],
    ["MinimumNightStaySection", () => <MinimumNightStaySection />, []],
    [
      "DefaultCancellationPolicySection",
      () => <DefaultCancellationPolicySection />,
      { rules: [], nonMemberHoldEnabled: true, nonMemberHoldDays: 7 },
    ],
    [
      "PublicBookingRequestsSection",
      () => <PublicBookingRequestsSection />,
      {
        showPricingToNonMembers: false,
        quoteResponseTtlDays: 14,
        quoteReminderLeadDays: 3,
        attendeeConfirmationLeadDays: 14,
        attendeeConfirmationReminderDays: 3,
      },
    ],
    [
      "GroupDiscountSection",
      () => (
        <ClubIdentityProvider value={clubIdentity}>
          <GroupDiscountSection />
        </ClubIdentityProvider>
      ),
      { minGroupSize: 5, summerOnly: true, enabled: false, configured: true },
    ],
  ];

  it.each(SECTIONS)(
    "%s mounts the region, empty, while still loading",
    (_name, renderSection) => {
      stubPendingFetch();
      // The real arrival order: the session has not resolved yet either.
      hookMock.canEdit = undefined;

      render(renderSection());

      // Still loading …
      expect(screen.getByText("Loading...")).toBeTruthy();
      // … and the region already exists and is empty, so the banner text that
      // lands later is a CONTENT change inside a registered region.
      expect(viewOnlyBanner().textContent).toBe("");
      // The same rule applies to `PolicyFeedback`'s assertive region, and
      // nothing pinned its POSITION until the #2162 review: a section that
      // early-returns its loading state ABOVE `PolicyFeedback` mounts the alert
      // already populated on a failed FIRST load, which is exactly the
      // announcement some screen-reader/browser pairings drop. This one line
      // covers all five sections.
      expect(screen.getByRole("alert").textContent).toBe("");
    },
  );

  it.each(SECTIONS)(
    "%s keeps the same region node from loading through to the resolved banner",
    async (_name, renderSection, body) => {
      let release: (value: Response) => void = () => {};
      const pending = new Promise<Response>((resolve) => {
        release = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(() => pending),
      );
      hookMock.canEdit = undefined;

      const { rerender } = render(renderSection());
      const region = viewOnlyBanner();
      expect(region.textContent).toBe("");

      // The section's own fetch settles first …
      release(jsonResponse(body));
      await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull());
      expect(viewOnlyBanner()).toBe(region);
      expect(viewOnlyBanner().textContent).toBe("");

      // … then the session resolves the actor as view-only.
      narrowTo(false, () => rerender(renderSection()));

      // Same NODE, newly populated — an announcement, not an injection.
      expect(viewOnlyBanner()).toBe(region);
      expect(region.textContent).toContain(ADMIN_VIEW_ONLY_SECTION_HEADING);
    },
  );
});

// #2142 review: `PeriodForm` / `MinStayForm` mirror the hook's error up through
// `useEffect(() => onError(error))`, and the 403 path was rewritten to throw
// `ForbiddenSaveError` -> hook -> effect -> the parent's `PolicyFeedback`.
// Neither leg of that plumbing was covered.
describe("open-editor save failures reach the section feedback (#2142)", () => {
  function stubSaveOutcome(status: number, body: unknown = {}) {
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async (...args) =>
      args[1]?.method
        ? new Response(JSON.stringify(body), { status })
        : jsonResponse([]),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function createPeriod() {
    render(<BookingPeriodsSection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Period" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Period" }));
    fireEvent.change(screen.getByLabelText("Period Name"), {
      target: { value: "School Holidays" },
    });
    fireEvent.change(screen.getByLabelText("Start Date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("End Date"), {
      target: { value: "2026-07-14" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Period" }));
  }

  async function createMinStay() {
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Policy" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Policy" }));
    fireEvent.change(screen.getByLabelText("Policy Name"), {
      target: { value: "Winter Saturdays" },
    });
    fireEvent.change(screen.getByLabelText("Start Date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("End Date"), {
      target: { value: "2026-09-30" },
    });
    fireEvent.change(screen.getByLabelText("Exception capacity handling"), {
      target: { value: "HOLD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Policy" }));
  }

  it("surfaces a failed period save above the list, with the form still open", async () => {
    stubSaveOutcome(500, { error: "Overlapping period" });
    await createPeriod();

    await waitFor(() =>
      expect(screen.getByText("Overlapping period")).toBeTruthy(),
    );
    // The write failed, so the editor must stay open with the admin's draft.
    expect(screen.getByRole("button", { name: "Create Period" })).toBeTruthy();
    expect(
      (screen.getByLabelText("Period Name") as HTMLInputElement).value,
    ).toBe("School Holidays");
  });

  it("maps a 403 on a period save to the shared not-saved copy", async () => {
    // Defence in depth behind the UI gating (#1927): a stale tab whose actor was
    // narrowed after the page loaded.
    stubSaveOutcome(403);
    await createPeriod();

    await waitFor(() =>
      expect(screen.getByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeTruthy(),
    );
  });

  it("surfaces a failed minimum-stay save above the list", async () => {
    stubSaveOutcome(500, { error: "Overlapping policy" });
    await createMinStay();

    await waitFor(() =>
      expect(screen.getByText("Overlapping policy")).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Create Policy" })).toBeTruthy();
  });

  it("maps a 403 on a minimum-stay save to the shared not-saved copy", async () => {
    stubSaveOutcome(403);
    await createMinStay();

    await waitFor(() =>
      expect(screen.getByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeTruthy(),
    );
  });

  // #2142 review: the save callback now parses the server row AFTER the write
  // has already succeeded. On an EDIT that is safe — the retry re-PUTs the same
  // row — but on a CREATE the row exists while the form still has no id, so
  // leaving the form open turns the natural retry into a SECOND row.
  describe("a 2xx whose body cannot be parsed", () => {
    function stubUnparseableWrite() {
      const fetchMock = vi.fn<
        (url: string, init?: RequestInit) => Promise<Response>
      >(async (...args) =>
        args[1]?.method
          ? // A truncated proxy response: 2xx, but not the row.
            new Response("<html>502 upstream</html>", { status: 200 })
          : jsonResponse([PERIOD_ROW]),
      );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    const PERIOD_ROW = {
      id: "p1",
      name: "School Holidays",
      startDate: "2026-07-01T00:00:00.000Z",
      endDate: "2026-07-14T00:00:00.000Z",
      nonMemberHoldEnabled: true,
      nonMemberHoldDays: 5,
      cancellationRules: [],
      active: true,
    };

    it("closes the CREATE form anyway, so a retry cannot POST a second period", async () => {
      const fetchMock = stubUnparseableWrite();
      await createPeriod();

      await waitFor(() =>
        expect(screen.getByText("Period created")).toBeTruthy(),
      );
      expect(screen.queryByRole("button", { name: "Create Period" })).toBeNull();
      expect(
        fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
    });

    it("closes the CREATE form anyway, so a retry cannot POST a second minimum-stay policy", async () => {
      const fetchMock = vi.fn<
        (url: string, init?: RequestInit) => Promise<Response>
      >(async (...args) =>
        args[1]?.method
          ? new Response("<html>502 upstream</html>", { status: 200 })
          : jsonResponse([]),
      );
      vi.stubGlobal("fetch", fetchMock);
      await createMinStay();

      await waitFor(() =>
        expect(screen.getByText("Minimum stay policy created")).toBeTruthy(),
      );
      expect(screen.queryByRole("button", { name: "Create Policy" })).toBeNull();
      expect(
        fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
    });

    it("keeps the EDIT form open and says so, because re-PUTting the same row is idempotent", async () => {
      stubUnparseableWrite();
      render(<BookingPeriodsSection />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      fireEvent.change(screen.getByLabelText("Period Name"), {
        target: { value: "School Holidays (revised)" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Update Period" }));

      await waitFor(() =>
        expect(screen.getByText(/could not be read/i)).toBeTruthy(),
      );
      expect(screen.getByRole("button", { name: "Update Period" })).toBeTruthy();
    });
  });

  // #2142 review: Cancel closes the editor, so the message the editor mirrored
  // up must go with it — the child clears its own error on unmount but the
  // parent's copy is one-way, so it used to outlive the form that caused it.
  it("clears the mirrored error when the editor is cancelled", async () => {
    stubSaveOutcome(500, { error: "Overlapping period" });
    await createPeriod();
    await waitFor(() =>
      expect(screen.getByText("Overlapping period")).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Overlapping period")).toBeNull();
  });

  // #2142 review: re-clicking Edit on the row that is ALREADY open must reset
  // the form. The editor is keyed, and without an instance counter the key is
  // unchanged for the same row, so React reuses the hook instance and the fresh
  // `initial` is ignored — the unsaved draft silently survives.
  it("resets the editor when Edit is clicked again on the row already open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          {
            id: "p1",
            name: "School Holidays",
            startDate: "2026-07-01T00:00:00.000Z",
            endDate: "2026-07-14T00:00:00.000Z",
            nonMemberHoldEnabled: true,
            nonMemberHoldDays: 5,
            cancellationRules: [],
            active: true,
          },
        ]),
      ),
    );
    render(<BookingPeriodsSection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Period Name"), {
      target: { value: "Abandoned edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      (screen.getByLabelText("Period Name") as HTMLInputElement).value,
    ).toBe("School Holidays");
    expect(
      (screen.getByRole("button", { name: "Update Period" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("PublicBookingRequestsSection Save gating (#2142)", () => {
  const LOADED = {
    showPricingToNonMembers: false,
    quoteResponseTtlDays: 14,
    quoteReminderLeadDays: 3,
    attendeeConfirmationLeadDays: 14,
    attendeeConfirmationReminderDays: 3,
  };

  // This section was already gated correctly on `!canEdit` by hand, so these
  // are not correctness fixes — they pin that the two Saves are shared themed
  // buttons participating in the section-level view-only treatment. Its own
  // dirty tracking is preserved, now expressed as each timing card's
  // `useSectionEditState` dirty flag (#2166).
  //
  // #2166: both timing cards are read-only until their own Edit, so these
  // assertions open both cards first. That is the state they describe — two
  // Saves on screen at once, gated independently.
  async function loadSection() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(LOADED)),
    );
    render(<PublicBookingRequestsSection />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit quote timing" }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit quote timing" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Edit attendee prompts" }),
    );
  }

  function quoteButton() {
    return screen.getByRole("button", {
      name: "Save quote timing",
    }) as HTMLButtonElement;
  }

  function attendeeButton() {
    return screen.getByRole("button", {
      name: "Save attendee prompts",
    }) as HTMLButtonElement;
  }

  function dirtyQuoteTiming(value: string) {
    fireEvent.change(screen.getByLabelText("Quote response window (days)"), {
      target: { value },
    });
  }

  function dirtyAttendeeTiming(value: string) {
    fireEvent.change(
      screen.getByLabelText("First prompt (days before check-in)"),
      { target: { value } },
    );
  }

  it("keeps both Saves disabled while pristine", async () => {
    await loadSection();
    expect(quoteButton().disabled).toBe(true);
    expect(attendeeButton().disabled).toBe(true);
  });

  it("enables each Save independently once its own fields are dirty", async () => {
    await loadSection();
    dirtyQuoteTiming("20");
    expect(quoteButton().disabled).toBe(false);
    // The two cards track dirtiness separately; one must not enable the other.
    expect(attendeeButton().disabled).toBe(true);

    dirtyAttendeeTiming("21");
    expect(attendeeButton().disabled).toBe(false);
  });

  it("disables both Saves and explains it once, section-wide, when the actor is narrowed mid-edit", async () => {
    await loadSection();
    dirtyQuoteTiming("20");
    dirtyAttendeeTiming("21");
    expect(quoteButton().disabled).toBe(false);

    narrowTo(false, () => dirtyQuoteTiming("21"));

    expectViewOnly(quoteButton());
    expectViewOnly(attendeeButton());
    // One banner for the whole section, not one reason per button. Asserted on
    // the banner specifically rather than by counting every `role="status"` in
    // the section, which would also sweep up `PolicyFeedback`'s save-confirmation
    // region and break the moment an unrelated live region is added (#2142
    // review).
    expect(screen.getAllByTestId("admin-view-only-banner")).toHaveLength(1);
  });

  it("disables both Saves neutrally while access is resolving", async () => {
    await loadSection();
    dirtyQuoteTiming("20");
    dirtyAttendeeTiming("21");

    narrowTo(undefined, () => dirtyQuoteTiming("21"));

    expectNeutralDisabled(quoteButton());
    expectNeutralDisabled(attendeeButton());
  });
});

// #2162: the "Show indicative pricing" checkbox used to persist the instant it
// was clicked — the last control in Booking Policies that auto-saved, and the
// reason this section was listed as an acknowledged divergent in `AGENTS.md`
// and `docs/ARCHITECTURE.md`. It now stages behind its own Edit -> Save ->
// Cancel cycle on `useSectionEditState`, like the group discount card.
describe("PublicBookingRequestsSection indicative pricing stages behind Save (#2162)", () => {
  const STORED = {
    showPricingToNonMembers: false,
    quoteResponseTtlDays: 14,
    quoteReminderLeadDays: 3,
    attendeeConfirmationLeadDays: 14,
    attendeeConfirmationReminderDays: 3,
  };

  /**
   * A stub that behaves like the real endpoint: the GET returns what is stored
   * and the PUT merges its whole-object body and echoes the row back. The
   * echo matters — the card re-seeds its draft AND its snapshot from it.
   */
  function stubSettings(
    stored: Record<string, unknown> = STORED,
    options: { changedByAnotherAdmin?: Partial<typeof STORED> } = {},
  ) {
    let current = { ...stored };
    let reads = 0;
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async (_url, init) => {
      if (init?.method === "PUT") {
        current = { ...current, ...JSON.parse(String(init.body)) };
        return jsonResponse(current);
      }
      // `jsonResponse` serialises now, so this body is the row as it stood for
      // THIS read.
      const body = jsonResponse(current);
      reads += 1;
      // Between the section's mount-time load and any later read, a second
      // admin changes the row. Without this the card's load-time snapshot IS
      // what is stored, so a save that skipped the fresh read would produce a
      // byte-identical body and every "merges the fresh row" assertion would
      // pass against an implementation that never re-read (#2162 review).
      if (reads === 1 && options.changedByAnotherAdmin) {
        current = { ...current, ...options.changedByAnotherAdmin };
      }
      return body;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /**
   * The body of the single write, plus how many READS ran before it.
   *
   * The count is the point. "The call immediately before the PUT was a read" is
   * satisfied by the mount-time load on its own, so it stays true even with the
   * save-step read deleted — a guard that cannot fail, which is this area's
   * recurring bug (#2162 review). Two reads means the mount-time load PLUS the
   * fresh read the save takes; one means the fresh read is gone.
   */
  function writeContext(fetchMock: ReturnType<typeof vi.fn>) {
    const calls = fetchMock.mock.calls;
    const index = calls.findIndex(
      (call) => (call[1] as RequestInit | undefined)?.method !== undefined,
    );
    return {
      body: JSON.parse(String((calls[index][1] as RequestInit).body)),
      readsBeforeWrite: calls
        .slice(0, index)
        .filter((call) => (call[1] as RequestInit | undefined)?.method === undefined)
        .length,
    };
  }

  function quoteWindowInput() {
    return screen.getByLabelText(
      "Quote response window (days)",
    ) as HTMLInputElement;
  }

  function quoteTimingButton() {
    return screen.getByRole("button", {
      name: "Save quote timing",
    }) as HTMLButtonElement;
  }

  async function loadSection() {
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit indicative pricing" }),
      ).toBeTruthy(),
    );
  }

  function pricingCheckbox() {
    return screen.getByLabelText(
      "Show indicative pricing on the request form",
    ) as HTMLInputElement;
  }

  // #2166: all three cards carry an Edit and can carry a Cancel at the same
  // time, so the shared visible word is no longer the whole accessible name.
  // Each button carries an `aria-label` naming its card, which REPLACES the
  // accessible name rather than appending to it — so these queries match the
  // label, not the visible "Edit". The label starts with the visible word, so
  // WCAG 2.5.3 Label in Name still holds for speech input.
  function editButton() {
    return screen.getByRole("button", {
      name: "Edit indicative pricing",
    }) as HTMLButtonElement;
  }

  function saveButton() {
    return screen.getByRole("button", {
      name: "Save indicative pricing",
    }) as HTMLButtonElement;
  }

  it("leaves the checkbox read-only until Edit is clicked, and writes nothing on a click", async () => {
    const fetchMock = stubSettings();
    render(<PublicBookingRequestsSection />);
    await loadSection();

    expect(pricingCheckbox().disabled).toBe(true);
    // No Save is even offered before Edit.
    expect(
      screen.queryByRole("button", { name: "Save indicative pricing" }),
    ).toBeNull();

    // `fireEvent.click` dispatches straight at the node, so jsdom flips the DOM
    // `checked` property even on a disabled input — which a real browser would
    // not. What is asserted is the part that matters and that a browser and
    // jsdom agree on: React's `onChange` never runs, so nothing is staged and
    // nothing is written.
    fireEvent.click(pricingCheckbox());
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  it("stages the tick and writes only once Save is clicked", async () => {
    const fetchMock = stubSettings();
    render(<PublicBookingRequestsSection />);
    await loadSection();

    fireEvent.click(editButton());
    fireEvent.click(pricingCheckbox());

    // Staged, not persisted.
    expect(pricingCheckbox().checked).toBe(true);
    expect(writeCalls(fetchMock)).toHaveLength(0);
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByText("Booking request settings saved")).toBeTruthy(),
    );
    expect(writeCalls(fetchMock)).toHaveLength(1);
    expect(JSON.parse(String(writeCalls(fetchMock)[0][1]?.body))).toMatchObject({
      showPricingToNonMembers: true,
    });
    // The card closes back to read-only and the new value is the snapshot.
    expect(
      screen.queryByRole("button", { name: "Save indicative pricing" }),
    ).toBeNull();
    expect(pricingCheckbox().checked).toBe(true);
  });

  // #2143: the write logs `booking_request.settings_updated` unconditionally, so
  // a pristine Save would record a change that never happened.
  it("keeps Save disabled while the draft matches what is stored", async () => {
    const fetchMock = stubSettings();
    render(<PublicBookingRequestsSection />);
    await loadSection();

    fireEvent.click(editButton());
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(pricingCheckbox());
    expect(saveButton().disabled).toBe(false);

    // Ticked and unticked again is not a change.
    fireEvent.click(pricingCheckbox());
    expect(saveButton().disabled).toBe(true);
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  it("reverts the checkbox and closes the card on Cancel, writing nothing", async () => {
    const fetchMock = stubSettings();
    render(<PublicBookingRequestsSection />);
    await loadSection();

    fireEvent.click(editButton());
    fireEvent.click(pricingCheckbox());
    expect(pricingCheckbox().checked).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel indicative pricing" }),
    );

    expect(pricingCheckbox().checked).toBe(false);
    expect(pricingCheckbox().disabled).toBe(true);
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  // All five settings share ONE whole-object PUT, so every card must send the
  // four fields it does not own as the values STORED AT WRITE TIME — never a
  // sibling card's uncommitted draft, and never its own load-time snapshot of
  // one. Each of these three saves therefore has another admin move a field it
  // does not own, between the load and the save, and asserts the moved value
  // goes back out.
  it("merges the fresh row on a pricing save, over both a stale snapshot and an unsaved draft", async () => {
    const fetchMock = stubSettings(STORED, {
      changedByAnotherAdmin: { quoteResponseTtlDays: 30 },
    });
    render(<PublicBookingRequestsSection />);
    await loadSection();

    // The admin has the quote card open and has typed into it, but not saved.
    // Two cards can be in edit mode at once (#2166) — only a SAVE is exclusive.
    fireEvent.click(screen.getByRole("button", { name: "Edit quote timing" }));
    fireEvent.change(quoteWindowInput(), { target: { value: "45" } });
    fireEvent.click(editButton());
    fireEvent.click(pricingCheckbox());
    fireEvent.click(saveButton());

    await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    const { body, readsBeforeWrite } = writeContext(fetchMock);
    // Asserted BEFORE the body, so a missing fresh read is reported as the
    // missing read it is rather than being shadowed by the deep-equal.
    expect(readsBeforeWrite).toBe(2);
    // 30 = what is stored now. NOT 14 (the load-time snapshot) and NOT 45 (the
    // uncommitted draft).
    expect(body).toEqual({
      ...STORED,
      quoteResponseTtlDays: 30,
      showPricingToNonMembers: true,
    });
  });

  it("merges the fresh row on a quote-timing save, so it cannot revert a pricing change", async () => {
    const fetchMock = stubSettings(STORED, {
      changedByAnotherAdmin: { showPricingToNonMembers: true },
    });
    render(<PublicBookingRequestsSection />);
    await loadSection();

    fireEvent.click(screen.getByRole("button", { name: "Edit quote timing" }));
    fireEvent.change(quoteWindowInput(), { target: { value: "20" } });
    fireEvent.click(quoteTimingButton());

    await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    const { body, readsBeforeWrite } = writeContext(fetchMock);
    // Asserted BEFORE the body, so a missing fresh read is reported as the
    // missing read it is rather than being shadowed by the deep-equal.
    expect(readsBeforeWrite).toBe(2);
    expect(body).toEqual({
      ...STORED,
      showPricingToNonMembers: true,
      quoteResponseTtlDays: 20,
    });
  });

  it("merges the fresh row on an attendee-timing save, so it cannot revert a pricing change", async () => {
    const fetchMock = stubSettings(STORED, {
      changedByAnotherAdmin: { showPricingToNonMembers: true },
    });
    render(<PublicBookingRequestsSection />);
    await loadSection();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit attendee prompts" }),
    );
    fireEvent.change(screen.getByLabelText("First prompt (days before check-in)"), {
      target: { value: "21" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save attendee prompts" }));

    await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    const { body, readsBeforeWrite } = writeContext(fetchMock);
    // Asserted BEFORE the body, so a missing fresh read is reported as the
    // missing read it is rather than being shadowed by the deep-equal.
    expect(readsBeforeWrite).toBe(2);
    expect(body).toEqual({
      ...STORED,
      showPricingToNonMembers: true,
      attendeeConfirmationLeadDays: 21,
    });
  });

  // #2162 review, restated for #2166. The hazard was: every card wrote through
  // ONE shared snapshot that each save re-seeded from its fresh read, so a
  // sibling card's untouched box could end up disagreeing with the snapshot its
  // dirty flag compared against — a Save lit up with no admin input, one click
  // from reverting the other admin. `beginSaveDraftSync` re-seeded the clean
  // boxes to defend that.
  //
  // With one hook instance per card there is no shared snapshot: a card's draft
  // and snapshot only ever move TOGETHER, and only via its own load or its own
  // save. So the defence is gone and the hazard cannot occur. What the untouched
  // card shows is what it loaded with — read-only, behind an Edit, and unarmed.
  it("leaves an untouched timing card alone across a pricing save, with nothing armed", async () => {
    stubSettings(STORED, { changedByAnotherAdmin: { quoteResponseTtlDays: 30 } });
    render(<PublicBookingRequestsSection />);
    await loadSection();

    // The admin touches nothing but the pricing checkbox.
    expect(quoteWindowInput().value).toBe("14");
    fireEvent.click(editButton());
    fireEvent.click(pricingCheckbox());
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByText("Booking request settings saved")).toBeTruthy(),
    );
    // Still read-only, still showing what it loaded — no other card reaches in.
    expect(quoteWindowInput().disabled).toBe(true);
    expect(quoteWindowInput().value).toBe("14");
    // And opening it offers a Save the admin has not armed.
    fireEvent.click(screen.getByRole("button", { name: "Edit quote timing" }));
    expect(quoteTimingButton().disabled).toBe(true);
  });

  it("leaves a timing box the admin typed into alone across another card's save", async () => {
    stubSettings(STORED, { changedByAnotherAdmin: { quoteResponseTtlDays: 30 } });
    render(<PublicBookingRequestsSection />);
    await loadSection();

    fireEvent.click(screen.getByRole("button", { name: "Edit quote timing" }));
    fireEvent.change(quoteWindowInput(), { target: { value: "45" } });
    fireEvent.click(editButton());
    fireEvent.click(pricingCheckbox());
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByText("Booking request settings saved")).toBeTruthy(),
    );
    // Their own in-progress input survives, the card stays open, and its Save
    // stays armed for it.
    expect(quoteWindowInput().value).toBe("45");
    expect(quoteTimingButton().disabled).toBe(false);
  });

  it("offers no way in for a view-only admin, and explains it once section-wide", async () => {
    hookMock.canEdit = false;
    stubSettings();
    render(<PublicBookingRequestsSection />);
    await loadSection();

    expectViewOnly(editButton());
    expect(pricingCheckbox().disabled).toBe(true);
    expect(screen.getAllByTestId("admin-view-only-banner")).toHaveLength(1);
  });

  it("disables Edit neutrally while access is still resolving", async () => {
    hookMock.canEdit = undefined;
    stubSettings();
    render(<PublicBookingRequestsSection />);
    await loadSection();

    expectNeutralDisabled(editButton());
  });

  // Defence in depth behind the UI gating (#1927): a stale tab whose actor was
  // narrowed after the page loaded.
  it("maps a 403 on the pricing save to the shared not-saved copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
        async (_url, init) =>
          init?.method
            ? new Response("{}", { status: 403 })
            : jsonResponse(STORED),
      ),
    );
    render(<PublicBookingRequestsSection />);
    await loadSection();

    fireEvent.click(editButton());
    fireEvent.click(pricingCheckbox());
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeTruthy(),
    );
    // The write failed, so the card stays open holding the admin's draft.
    expect(saveButton()).toBeTruthy();
    expect(pricingCheckbox().checked).toBe(true);
  });

  // #2162 review: the save's fresh read is part of the WRITE. When it fails for
  // anything other than a 403 the PUT never goes out, so the message the admin
  // gets after clicking Save must say the CHANGE did not land. Reusing the
  // mount-time load's "Failed to fetch booking request settings" reports a read
  // they never asked for and says nothing about the change they did.
  it("says the change was not saved when the save's fresh read fails", async () => {
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
        async (_url, init) => {
          if (init?.method) return jsonResponse(STORED);
          reads += 1;
          // Read 1 is the mount-time load and must succeed, or the section
          // never renders a Save to click. Read 2 is the save step.
          return reads === 1
            ? jsonResponse(STORED)
            : new Response("{}", { status: 500 });
        },
      ),
    );
    render(<PublicBookingRequestsSection />);
    await loadSection();

    fireEvent.click(screen.getByRole("button", { name: "Edit quote timing" }));
    fireEvent.change(quoteWindowInput(), { target: { value: "20" } });
    fireEvent.click(quoteTimingButton());

    await waitFor(() =>
      expect(
        screen.getByText(
          "Your change was not saved: the current settings could not be re-read. Please try again.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("Failed to fetch booking request settings")).toBeNull();
  });
});

// #2166 (owner decision): the two timing cards were the last acknowledged
// divergence from the canonical settings pattern in Booking Policies —
// always-editable boxes with a dirty-gated Save and no Edit or Cancel. They now
// follow the pricing card exactly: read-only until Edit, Save and Cancel only
// while editing, Save gated on dirty, and the write still preceded by the fresh
// read that keeps the shared whole-object PUT from reverting a sibling card.
describe("PublicBookingRequestsSection timing cards stage behind Edit (#2166)", () => {
  const STORED = {
    showPricingToNonMembers: false,
    quoteResponseTtlDays: 14,
    quoteReminderLeadDays: 3,
    attendeeConfirmationLeadDays: 14,
    attendeeConfirmationReminderDays: 3,
  };

  /** GET returns what is stored; PUT merges its whole-object body and echoes. */
  function stubSettings(
    options: {
      changedByAnotherAdmin?: Partial<typeof STORED>;
      /** Override the starting row, for cases STORED's values cannot express. */
      stored?: Partial<typeof STORED>;
    } = {},
  ) {
    let current = { ...STORED, ...options.stored };
    let reads = 0;
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async (_url, init) => {
      if (init?.method === "PUT") {
        current = { ...current, ...JSON.parse(String(init.body)) };
        return jsonResponse(current);
      }
      const body = jsonResponse(current);
      reads += 1;
      if (reads === 1 && options.changedByAnotherAdmin) {
        current = { ...current, ...options.changedByAnotherAdmin };
      }
      return body;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const CARDS = [
    {
      name: "quote timing",
      edit: "Edit quote timing",
      save: "Save quote timing",
      cancel: "Cancel quote timing",
      field: "Quote response window (days)",
      stored: "14",
      typed: "20",
      // What the other admin moves, in the field this card does NOT own.
      elsewhere: { showPricingToNonMembers: true } as Partial<typeof STORED>,
      expected: { showPricingToNonMembers: true, quoteResponseTtlDays: 20 },
    },
    {
      name: "attendee prompts",
      edit: "Edit attendee prompts",
      save: "Save attendee prompts",
      cancel: "Cancel attendee prompts",
      field: "First prompt (days before check-in)",
      stored: "14",
      typed: "21",
      elsewhere: { showPricingToNonMembers: true } as Partial<typeof STORED>,
      expected: {
        showPricingToNonMembers: true,
        attendeeConfirmationLeadDays: 21,
      },
    },
  ] as const;

  async function loadSection() {
    render(<PublicBookingRequestsSection />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit quote timing" }),
      ).toBeTruthy(),
    );
  }

  function button(name: string) {
    return screen.getByRole("button", { name }) as HTMLButtonElement;
  }

  function input(label: string) {
    return screen.getByLabelText(label) as HTMLInputElement;
  }

  it.each(CARDS)(
    "$name is read-only until Edit, offering no Save and no Cancel",
    async (card) => {
      const fetchMock = stubSettings();
      await loadSection();

      expect(input(card.field).disabled).toBe(true);
      expect(screen.queryByRole("button", { name: card.save })).toBeNull();
      expect(screen.queryByRole("button", { name: card.cancel })).toBeNull();
      expect(writeCalls(fetchMock)).toHaveLength(0);
    },
  );

  it.each(CARDS)(
    "$name reveals Save and Cancel on Edit, and stages typing without writing",
    async (card) => {
      const fetchMock = stubSettings();
      await loadSection();

      fireEvent.click(button(card.edit));
      expect(input(card.field).disabled).toBe(false);
      fireEvent.change(input(card.field), { target: { value: card.typed } });

      expect(input(card.field).value).toBe(card.typed);
      expect(button(card.save).disabled).toBe(false);
      expect(writeCalls(fetchMock)).toHaveLength(0);
    },
  );

  // #2143: the write logs `booking_request.settings_updated` unconditionally, so
  // a pristine Save would record a change that never happened.
  it.each(CARDS)("$name keeps Save disabled while pristine", async (card) => {
    const fetchMock = stubSettings();
    await loadSection();

    fireEvent.click(button(card.edit));
    expect(button(card.save).disabled).toBe(true);

    fireEvent.change(input(card.field), { target: { value: card.typed } });
    expect(button(card.save).disabled).toBe(false);

    // Typed back to what is stored is not a change …
    fireEvent.change(input(card.field), { target: { value: card.stored } });
    expect(button(card.save).disabled).toBe(true);
    // … and neither is re-typing the same number with a leading zero, which the
    // route would store identically.
    fireEvent.change(input(card.field), { target: { value: `0${card.stored}` } });
    expect(button(card.save).disabled).toBe(true);
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  it.each(CARDS)(
    "$name reverts every box and closes the card on Cancel, writing nothing",
    async (card) => {
      const fetchMock = stubSettings();
      await loadSection();

      fireEvent.click(button(card.edit));
      fireEvent.change(input(card.field), { target: { value: card.typed } });
      fireEvent.click(button(card.cancel));

      expect(input(card.field).value).toBe(card.stored);
      expect(input(card.field).disabled).toBe(true);
      expect(screen.queryByRole("button", { name: card.save })).toBeNull();
      expect(button(card.edit)).toBeTruthy();
      expect(writeCalls(fetchMock)).toHaveLength(0);
    },
  );

  // All five settings share ONE whole-object PUT. Each newly-gated card must
  // still GET the fresh row immediately before it writes and merge only its own
  // fields, so a card the admin opened minutes ago cannot revert a sibling's
  // change. `readsBeforeWrite` is asserted first and must be 2 — the mount-time
  // load PLUS the save-step read. One means the fresh read is gone.
  it.each(CARDS)(
    "$name merges the fresh row on save, not its load-time snapshot",
    async (card) => {
      const fetchMock = stubSettings({ changedByAnotherAdmin: card.elsewhere });
      await loadSection();

      fireEvent.click(button(card.edit));
      fireEvent.change(input(card.field), { target: { value: card.typed } });
      fireEvent.click(button(card.save));

      await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
      const calls = fetchMock.mock.calls;
      const index = calls.findIndex(
        (call) => (call[1] as RequestInit | undefined)?.method !== undefined,
      );
      const readsBeforeWrite = calls
        .slice(0, index)
        .filter(
          (call) => (call[1] as RequestInit | undefined)?.method === undefined,
        ).length;
      expect(readsBeforeWrite).toBe(2);
      expect(JSON.parse(String((calls[index][1] as RequestInit).body))).toEqual({
        ...STORED,
        ...card.expected,
      });
    },
  );

  it.each(CARDS)(
    "$name closes back to read-only once its save lands",
    async (card) => {
      stubSettings();
      await loadSection();

      fireEvent.click(button(card.edit));
      fireEvent.change(input(card.field), { target: { value: card.typed } });
      fireEvent.click(button(card.save));

      await waitFor(() =>
        expect(screen.getByText("Booking request settings saved")).toBeTruthy(),
      );
      expect(screen.queryByRole("button", { name: card.save })).toBeNull();
      // Re-seeded from the SERVER's echo, not from the submitted draft.
      expect(input(card.field).value).toBe(card.typed);
      expect(input(card.field).disabled).toBe(true);
    },
  );

  // The dirty gate must not swallow the reason a save is refused: an
  // out-of-range or cross-field-invalid draft IS dirty, so Save stays clickable
  // and the click explains the problem rather than greying the button out.
  it("explains an out-of-range quote window instead of writing it", async () => {
    const fetchMock = stubSettings();
    await loadSection();

    fireEvent.click(button("Edit quote timing"));
    fireEvent.change(input("Quote response window (days)"), {
      target: { value: "99" },
    });
    fireEvent.click(button("Save quote timing"));

    expect(
      screen.getByText(
        "Quote response window must be a whole number of days between 1 and 60.",
      ),
    ).toBeTruthy();
    expect(writeCalls(fetchMock)).toHaveLength(0);
    // The card stays open holding what they typed.
    expect(input("Quote response window (days)").value).toBe("99");
  });

  it("still enforces that the reminder is shorter than the quote window", async () => {
    const fetchMock = stubSettings();
    await loadSection();

    fireEvent.click(button("Edit quote timing"));
    fireEvent.change(input("Reminder lead time (days before expiry)"), {
      target: { value: "20" },
    });
    fireEvent.click(button("Save quote timing"));

    expect(
      screen.getByText(
        "Reminder lead time must be shorter than the quote response window.",
      ),
    ).toBeTruthy();
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  // Three cards, one row, one PUT: a save in flight must not be joined by a
  // second one built on a settings object that is already moving.
  it("disables every other card's controls while one card is saving", async () => {
    let releasePut: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
        async (_url, init) =>
          init?.method
            ? new Promise<Response>((resolve) => {
                releasePut = resolve;
              })
            : jsonResponse(STORED),
      ),
    );
    await loadSection();

    fireEvent.click(button("Edit quote timing"));
    fireEvent.change(input("Quote response window (days)"), {
      target: { value: "20" },
    });
    fireEvent.click(button("Save quote timing"));

    await waitFor(() =>
      expect(button("Edit attendee prompts").disabled).toBe(true),
    );
    expect(button("Edit indicative pricing").disabled).toBe(true);
    expect(
      input("Show indicative pricing on the request form").disabled,
    ).toBe(true);

    releasePut(jsonResponse({ ...STORED, quoteResponseTtlDays: 20 }));
    await waitFor(() =>
      expect(button("Edit attendee prompts").disabled).toBe(false),
    );
  });

  // Each card owns its own draft: opening, typing in, and cancelling one must
  // leave the others exactly as they were.
  it("keeps each card's draft to itself", async () => {
    stubSettings();
    await loadSection();

    fireEvent.click(button("Edit quote timing"));
    fireEvent.click(button("Edit attendee prompts"));
    fireEvent.change(input("Quote response window (days)"), {
      target: { value: "20" },
    });
    fireEvent.change(input("First prompt (days before check-in)"), {
      target: { value: "21" },
    });

    // Cancelling one card reverts only its own boxes and closes only itself.
    fireEvent.click(button("Cancel quote timing"));

    expect(input("Quote response window (days)").value).toBe("14");
    expect(input("First prompt (days before check-in)").value).toBe("21");
    expect(input("First prompt (days before check-in)").disabled).toBe(false);
    expect(button("Save attendee prompts").disabled).toBe(false);
    expect(button("Edit quote timing")).toBeTruthy();
  });

  it("offers a view-only admin no Edit on either timing card", async () => {
    hookMock.canEdit = false;
    stubSettings();
    await loadSection();

    expectViewOnly(button("Edit quote timing"));
    expectViewOnly(button("Edit attendee prompts"));
    expect(input("Quote response window (days)").disabled).toBe(true);
    expect(input("First prompt (days before check-in)").disabled).toBe(true);
    expect(screen.getAllByTestId("admin-view-only-banner")).toHaveLength(1);
  });

  it("disables both timing Edits neutrally while access is resolving", async () => {
    hookMock.canEdit = undefined;
    stubSettings();
    await loadSection();

    expectNeutralDisabled(button("Edit quote timing"));
    expectNeutralDisabled(button("Edit attendee prompts"));
  });

  // Defence in depth behind the UI gating (#1927): a stale tab whose actor was
  // narrowed after the page loaded.
  it.each(CARDS)("$name maps a 403 to the shared not-saved copy", async (card) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
        async (_url, init) =>
          init?.method
            ? new Response("{}", { status: 403 })
            : jsonResponse(STORED),
      ),
    );
    await loadSection();

    fireEvent.click(button(card.edit));
    fireEvent.change(input(card.field), { target: { value: card.typed } });
    fireEvent.click(button(card.save));

    await waitFor(() =>
      expect(screen.getByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeTruthy(),
    );
    // The write failed, so the card stays open holding the admin's draft.
    expect(button(card.save)).toBeTruthy();
    expect(input(card.field).value).toBe(card.typed);
  });

  // Three cards, one `PolicyFeedback`: a card starting a save clears the other
  // two, so one card's stale confirmation never sits above another's result.
  it("replaces one card's confirmation when another card saves", async () => {
    stubSettings();
    await loadSection();

    fireEvent.click(button("Edit quote timing"));
    fireEvent.change(input("Quote response window (days)"), {
      target: { value: "20" },
    });
    fireEvent.click(button("Save quote timing"));
    await waitFor(() =>
      expect(screen.getByText("Booking request settings saved")).toBeTruthy(),
    );

    fireEvent.click(button("Edit attendee prompts"));
    fireEvent.change(input("First prompt (days before check-in)"), {
      target: { value: "0" },
    });
    fireEvent.click(button("Save attendee prompts"));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save attendee prompts" })).toBeNull(),
    );
    // Exactly one confirmation, not two stacked.
    expect(screen.getAllByText("Booking request settings saved")).toHaveLength(1);
  });

  // The three cards each hold a `useSectionEditState`, and the hook fetches per
  // instance — so the section would issue three identical mount-time GETs, and
  // three snapshots a concurrent write could leave disagreeing, without the
  // shared in-flight load.
  it("loads the whole section with a single GET", async () => {
    const fetchMock = stubSettings();
    await loadSection();

    expect(
      fetchMock.mock.calls.filter(
        (call) => (call[1] as RequestInit | undefined)?.method === undefined,
      ),
    ).toHaveLength(1);
  });

  // #2166 review. The shared mount-time GET is held in a ref that is only
  // cleared in a MICROTASK (`pending.then(release, release)`), while React
  // StrictMode's mount -> cleanup -> re-mount is SYNCHRONOUS. So the re-mounted
  // hooks are handed the FIRST mount's promise. If that promise carried the
  // first mount's `AbortSignal` — which its cleanup has just aborted — it
  // rejects with `AbortError`, every hook swallows it as an ordinary unmount,
  // and each one still clears `loading` (its OWN signal was never aborted)
  // without ever seeding `saved`/`draft`. The section then renders
  // `SETTINGS_FALLBACK` as though those were the stored values, so the admin
  // edits against fabricated numbers, and any field they then change is written
  // over a stored value they never saw. (Only that field: each save sends just
  // the CHANGED fields merged over a fresh read, so the fallback itself never
  // reaches the wire.)
  // `next dev` enables StrictMode by default, so that is every local session.
  //
  // No other mock in this file honours `init.signal` — which is exactly why the
  // rest of the suite could not see this. This one does.
  it("seeds from the stored row under StrictMode, not the hardcoded fallback", async () => {
    // Deliberately none of SETTINGS_FALLBACK's values (14 / 3), so a fallback
    // render is unmistakable.
    const ROW = {
      ...STORED,
      quoteResponseTtlDays: 30,
      quoteReminderLeadDays: 7,
    };
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          const abort = () =>
            reject(new DOMException("The operation was aborted.", "AbortError"));
          if (signal?.aborted) return abort();
          signal?.addEventListener("abort", abort);
          // Settle a macrotask later, so StrictMode's synchronous remount lands
          // while the request is genuinely still in flight.
          setTimeout(() => resolve(jsonResponse(ROW)), 0);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <StrictMode>
        <PublicBookingRequestsSection />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(button("Edit quote timing")).toBeTruthy(),
    );

    expect(input("Quote response window (days)").value).toBe("30");
    expect(input("Reminder lead time (days before expiry)").value).toBe("7");
    // Still one GET for the whole section: the ref did its job.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // #2166 review. GET-fresh-then-merge only protects the fields a card does NOT
  // own. A field the card owns but the admin never touched was still written
  // from the stale draft, silently reverting whoever moved it — so each save
  // sends only the fields the admin actually CHANGED.
  it("keeps another admin's change to an untouched box in the same card", async () => {
    const fetchMock = stubSettings({
      changedByAnotherAdmin: { quoteReminderLeadDays: 5 },
    });
    await loadSection();

    fireEvent.click(button("Edit quote timing"));
    // The reminder box still shows the 3 it loaded with; 5 is what is stored.
    expect(input("Reminder lead time (days before expiry)").value).toBe("3");
    fireEvent.change(input("Quote response window (days)"), {
      target: { value: "20" },
    });
    fireEvent.click(button("Save quote timing"));

    await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    // The untouched reminder is NOT sourced from the draft: 5 (stored), not 3.
    expect(JSON.parse(String(writeCalls(fetchMock)[0][1]?.body))).toEqual({
      ...STORED,
      quoteResponseTtlDays: 20,
      quoteReminderLeadDays: 5,
    });
    // And the server echo leaves the other admin's value on screen.
    await waitFor(() =>
      expect(input("Reminder lead time (days before expiry)").value).toBe("5"),
    );
  });

  it("keeps another admin's change to an untouched attendee box", async () => {
    const fetchMock = stubSettings({
      changedByAnotherAdmin: { attendeeConfirmationReminderDays: 6 },
    });
    await loadSection();

    fireEvent.click(button("Edit attendee prompts"));
    fireEvent.change(input("First prompt (days before check-in)"), {
      target: { value: "21" },
    });
    fireEvent.click(button("Save attendee prompts"));

    await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(writeCalls(fetchMock)[0][1]?.body))).toEqual({
      ...STORED,
      attendeeConfirmationLeadDays: 21,
      attendeeConfirmationReminderDays: 6,
    });
    await waitFor(() =>
      expect(input("Reminder interval (days)").value).toBe("6"),
    );
  });

  // The cost of sending only the changed field: the quote card owns BOTH halves
  // of the route's cross-field rule, so the pair that would reach the route can
  // be one the admin never saw. The card's click-time validation compares the
  // two DRAFT values and cannot see it, so the composed pair is re-checked after
  // the fresh read.
  it("refuses a quote pair another admin's change would make invalid, and says why", async () => {
    const fetchMock = stubSettings({
      stored: { quoteResponseTtlDays: 30, quoteReminderLeadDays: 7 },
      // Both the loaded pair (30/7) and the concurrently-stored one (10/7)
      // satisfy the route's own `reminderLead < responseTtl` refinement, so this
      // models a state the server can actually be in.
      changedByAnotherAdmin: { quoteResponseTtlDays: 10 },
    });
    await loadSection();

    fireEvent.click(button("Edit quote timing"));
    // Valid against what this admin can see (15 < 30); invalid against what is
    // now stored (15 >= 10).
    fireEvent.change(input("Reminder lead time (days before expiry)"), {
      target: { value: "15" },
    });
    fireEvent.click(button("Save quote timing"));

    await waitFor(() =>
      expect(
        screen.getByText(/the quote timing has been changed since this page loaded/),
      ).toBeTruthy(),
    );
    // Refused BEFORE the write — the other admin's 10 is untouched — and the
    // card stays open holding this admin's input.
    expect(writeCalls(fetchMock)).toHaveLength(0);
    expect(input("Reminder lead time (days before expiry)").value).toBe("15");
  });

  // #2166 review: Tailwind's preflight resets `color`, `background-color` and
  // `opacity` on `input` at AUTHOR origin, which overrides the UA's `:disabled`
  // presentation entirely — so `disabled` on its own is invisible and a gated
  // box looks exactly like an editable one. The reference section
  // (`group-discount-section.tsx`) carries these same two classes for it.
  //
  // #2144: the pair moved from `bg-slate-50 text-slate-700` onto semantic
  // tokens, but deliberately onto `bg-muted` rather than the `bg-card` the
  // sweep's raw->token table gives for `bg-*-50`. `--card` and `--background`
  // are the same colour in light mode (both `--brand-snow` inside
  // `.app-theme-scope`), so `bg-card` here would have rendered the shading
  // invisible in light mode and deleted the affordance this test exists to
  // protect. `bg-muted` (`--brand-mist`) reads as shaded in both modes and is
  // in the muted-foreground clamp set, so the pair stays AA.
  it.each(CARDS)("$name shades its boxes while they are read-only", async (card) => {
    stubSettings();
    await loadSection();

    expect(input(card.field).className).toContain("bg-muted");
    expect(input(card.field).className).toContain("text-muted-foreground");

    fireEvent.click(button(card.edit));
    expect(input(card.field).className).not.toContain("bg-muted");
    expect(input(card.field).className).not.toContain("text-muted-foreground");
  });

  // #2166 review: a validation failure returns BEFORE `save()`, and `save()` is
  // what clears this card's own feedback pair — so an earlier green
  // confirmation would sit above the fresh red error.
  it("clears its own earlier confirmation when the next save fails validation", async () => {
    stubSettings();
    await loadSection();

    fireEvent.click(button("Edit quote timing"));
    fireEvent.change(input("Quote response window (days)"), {
      target: { value: "20" },
    });
    fireEvent.click(button("Save quote timing"));
    await waitFor(() =>
      expect(screen.getByText("Booking request settings saved")).toBeTruthy(),
    );

    fireEvent.click(button("Edit quote timing"));
    fireEvent.change(input("Quote response window (days)"), {
      target: { value: "99" },
    });
    fireEvent.click(button("Save quote timing"));

    expect(
      screen.getByText(
        "Quote response window must be a whole number of days between 1 and 60.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Booking request settings saved")).toBeNull();
  });

  it("clears its own earlier confirmation when an attendee save fails validation", async () => {
    stubSettings();
    await loadSection();

    fireEvent.click(button("Edit attendee prompts"));
    fireEvent.change(input("First prompt (days before check-in)"), {
      target: { value: "21" },
    });
    fireEvent.click(button("Save attendee prompts"));
    await waitFor(() =>
      expect(screen.getByText("Booking request settings saved")).toBeTruthy(),
    );

    fireEvent.click(button("Edit attendee prompts"));
    fireEvent.change(input("Reminder interval (days)"), {
      target: { value: "99" },
    });
    fireEvent.click(button("Save attendee prompts"));

    expect(
      screen.getByText(
        "The attendee reminder interval must be a whole number of days between 1 and 30.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Booking request settings saved")).toBeNull();
  });
});

// #2142 review (#2143, second route in): Activate/Deactivate is a one-click
// direct write, never covered by the Save dirty gate. It read `active` off a row
// that only changes once the refresh resolves, so two quick clicks both saw the
// old value and both sent the same new one — the second PUT writing an update
// entry whose `before` and `after` are identical AND busting the public-page
// cache. One admin, no concurrency required.
describe("row toggles are guarded against a double-click (#2143)", () => {
  const PERIOD = {
    id: "p1",
    name: "School Holidays",
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-07-14T00:00:00.000Z",
    nonMemberHoldEnabled: true,
    nonMemberHoldDays: 5,
    cancellationRules: [],
    active: true,
  };

  const POLICY = {
    id: "m1",
    name: "Winter Saturdays",
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-09-30T00:00:00.000Z",
    triggerDays: [6],
    minimumNights: 2,
    capacityMode: "HOLD",
    version: 4,
    active: true,
  };

  /**
   * Two clicks with genuinely NO render between them.
   *
   * `fireEvent` twice does NOT test this guard (#2142 review, round 4): RTL
   * wraps each dispatch in its own `act()`, so the first click's
   * `setTogglingId` is flushed before the second is dispatched, the button is
   * already `disabled`, and React never calls the handler again. That passes
   * with or without `togglingRef` — it only re-tests the `disabled` attribute.
   *
   * The guard exists for the case `disabled` alone cannot catch: a real
   * double-click delivered inside one tick, where BOTH handlers run against the
   * same pre-update state. Dispatching both inside a SINGLE `act()` reproduces
   * exactly that — no commit in between, so the second dispatch reaches a button
   * that is still enabled and a handler that still sees `active: true`.
   */
  async function doubleClickInOneTick(button: HTMLElement) {
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  /** GETs return the list unchanged, so the row never flips on its own. */
  function stubList(list: unknown[]) {
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async (...args) =>
      args[1]?.method ? jsonResponse({}) : jsonResponse(list),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends one booking-period PUT for two clicks in the same tick", async () => {
    const fetchMock = stubList([PERIOD]);
    render(<BookingPeriodsSection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Deactivate" })).toBeTruthy(),
    );

    const toggle = screen.getByRole("button", { name: "Deactivate" });
    await doubleClickInOneTick(toggle);

    await waitFor(() => expect(writeCalls(fetchMock).length).toBeGreaterThan(0));
    expect(writeCalls(fetchMock)).toHaveLength(1);
    expect(
      JSON.parse(String(writeCalls(fetchMock)[0][1]?.body)),
    ).toEqual({ active: false });
  });

  it("sends one minimum-stay PUT for two clicks in the same tick", async () => {
    const fetchMock = stubList([POLICY]);
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Deactivate" })).toBeTruthy(),
    );

    const toggle = screen.getByRole("button", { name: "Deactivate" });
    await doubleClickInOneTick(toggle);

    await waitFor(() => expect(writeCalls(fetchMock).length).toBeGreaterThan(0));
    expect(writeCalls(fetchMock)).toHaveLength(1);
    expect(
      JSON.parse(String(writeCalls(fetchMock)[0][1]?.body)),
    ).toEqual({ active: false, version: 4 });
  });

  // #2142 review: an active minimum-stay row used to carry TWO buttons both
  // labelled "Deactivate" — the reversible toggle and the (soft) delete — with
  // nothing but the colour to tell them apart.
  it("gives an active minimum-stay row one Deactivate and one Delete", async () => {
    stubList([POLICY]);
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Deactivate" })).toBeTruthy(),
    );

    expect(screen.getAllByRole("button", { name: "Deactivate" })).toHaveLength(
      1,
    );
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });
});

describe("minimum-stay mutation responses and stale-revision recovery (#2363)", () => {
  const POLICY = {
    id: "m1",
    name: "Winter Saturdays",
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-09-30T00:00:00.000Z",
    triggerDays: [6],
    minimumNights: 2,
    capacityMode: "HOLD",
    version: 4,
    active: true,
  };

  function mutationThenFailedRefresh(
    initial: unknown[],
    writeBody: unknown,
  ) {
    let reads = 0;
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async (_url, init) => {
      if (init?.method) return jsonResponse(writeBody);
      reads += 1;
      return reads === 1
        ? jsonResponse(initial)
        : new Response("{}", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function fillNewPolicy(capacityMode: "HOLD" | "NO_HOLD" = "HOLD") {
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Policy" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Policy" }));
    fireEvent.change(screen.getByLabelText("Policy Name"), {
      target: { value: POLICY.name },
    });
    fireEvent.change(screen.getByLabelText("Start Date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("End Date"), {
      target: { value: "2026-09-30" },
    });
    fireEvent.change(screen.getByLabelText("Exception capacity handling"), {
      target: { value: capacityMode },
    });
  }

  async function expectUnknownAfterWrite() {
    await waitFor(() =>
      expect(
        screen.getByText(/Could not load the minimum-stay policies/i),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
  }

  it("sends the selected NO_HOLD mode in the exact POST body, then fails closed when its refresh fails", async () => {
    const fetchMock = mutationThenFailedRefresh([], POLICY);
    render(<MinimumNightStaySection />);
    await fillNewPolicy("NO_HOLD");
    fireEvent.click(screen.getByRole("button", { name: "Create Policy" }));

    await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(writeCalls(fetchMock)[0][1]?.body))).toEqual({
      name: POLICY.name,
      startDate: "2026-07-01",
      endDate: "2026-09-30",
      triggerDays: [6],
      minimumNights: 2,
      capacityMode: "NO_HOLD",
    });
    await expectUnknownAfterWrite();
    expect(screen.queryByText("Minimum stay policy created")).toBeNull();
  });

  it("sends the exact versioned PUT body, then fails closed when refresh fails", async () => {
    const updated = { ...POLICY, minimumNights: 3, version: 5 };
    const fetchMock = mutationThenFailedRefresh([POLICY], updated);
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Minimum Nights"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Policy" }));

    await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(writeCalls(fetchMock)[0][1]?.body))).toEqual({
      name: POLICY.name,
      startDate: "2026-07-01",
      endDate: "2026-09-30",
      triggerDays: [6],
      minimumNights: 3,
      capacityMode: "HOLD",
      version: 4,
    });
    await expectUnknownAfterWrite();
  });

  it("consumes the versioned toggle row, then fails closed when refresh fails", async () => {
    const fetchMock = mutationThenFailedRefresh(
      [POLICY],
      { ...POLICY, active: false, version: 5 },
    );
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Deactivate" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));

    await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(writeCalls(fetchMock)[0][1]?.body))).toEqual({
      active: false,
      version: 4,
    });
    await expectUnknownAfterWrite();
  });

  it("sends one exact DELETE for same-tick clicks and hides stale actions after refresh failure", async () => {
    const fetchMock = mutationThenFailedRefresh(
      [POLICY],
      { success: true, policy: { ...POLICY, active: false, version: 5 } },
    );
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy(),
    );
    const button = screen.getByRole("button", { name: "Delete" });
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(writeCalls(fetchMock)[0][1]?.method).toBe("DELETE");
    expect(JSON.parse(String(writeCalls(fetchMock)[0][1]?.body))).toEqual({
      version: 4,
    });
    await expectUnknownAfterWrite();
    expect(
      screen.queryByText(/Minimum stay policy deleted/i),
    ).toBeNull();
  });

  it("closes a stale editor on 409 and re-seeds from the refreshed revision", async () => {
    const current = {
      ...POLICY,
      minimumNights: 4,
      capacityMode: "NO_HOLD",
      version: 5,
    };
    let reads = 0;
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async (_url, init) => {
      if (init?.method) {
        return new Response(JSON.stringify({
          error: "This policy changed since it was loaded. Reload it and try again.",
          code: "POLICY_VERSION_CONFLICT",
          currentVersion: 5,
        }), { status: 409 });
      }
      reads += 1;
      return jsonResponse(reads === 1 ? [POLICY] : [current]);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Minimum Nights"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Policy" }));

    await waitFor(() =>
      expect(screen.getByText(/changed since it was loaded/i)).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Update Policy" })).toBeNull();
    expect(screen.getByText(/Revision 5/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      (screen.getByLabelText("Minimum Nights") as HTMLInputElement).value,
    ).toBe("4");
    expect(
      (screen.getByLabelText("Exception capacity handling") as HTMLSelectElement)
        .value,
    ).toBe("NO_HOLD");
    expect(writeCalls(fetchMock)).toHaveLength(1);
  });

  it("recovers an unreadable successful edit through an awaited refresh", async () => {
    const current = { ...POLICY, minimumNights: 3, version: 5 };
    let reads = 0;
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async (_url, init) => {
      if (init?.method) {
        return new Response("<html>truncated</html>", { status: 200 });
      }
      reads += 1;
      return jsonResponse(reads === 1 ? [POLICY] : [current]);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Minimum Nights"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Policy" }));

    await waitFor(() => expect(screen.getByText(/Revision 5/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Update Policy" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      (screen.getByLabelText("Minimum Nights") as HTMLInputElement).value,
    ).toBe("3");
    expect(writeCalls(fetchMock)).toHaveLength(1);
  });
});

// #2142 review (a11y): `PolicyFeedback` is where every booking-policy section
// reports the outcome of a write — including the 403 "not saved" copy this
// change added plumbing for — and it had no live region at all, so none of it
// was announced to anybody. The two halves are deliberately different: a
// FAILURE contradicts what the admin believes just happened and interrupts
// (`role="alert"`), a confirmation only reassures and waits its turn
// (`role="status"`).
describe("PolicyFeedback announces save outcomes (#2142)", () => {
  function stubSaveOutcome(status: number, body: unknown = {}) {
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async (...args) =>
      args[1]?.method
        ? new Response(JSON.stringify(body), { status })
        : jsonResponse([]),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function fillNewPeriod() {
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Period" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Period" }));
    fireEvent.change(screen.getByLabelText("Period Name"), {
      target: { value: "School Holidays" },
    });
    fireEvent.change(screen.getByLabelText("Start Date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("End Date"), {
      target: { value: "2026-07-14" },
    });
  }

  it("announces a failed save assertively", async () => {
    stubSaveOutcome(500, { error: "Overlapping period" });
    render(<BookingPeriodsSection />);
    await fillNewPeriod();
    fireEvent.click(screen.getByRole("button", { name: "Create Period" }));

    await waitFor(() =>
      expect(screen.getByText("Overlapping period")).toBeTruthy(),
    );
    expect(
      within(screen.getByRole("alert")).getByText(/Overlapping period/),
    ).toBeTruthy();
  });

  it("announces the shared 403 not-saved copy assertively", async () => {
    stubSaveOutcome(403);
    render(<BookingPeriodsSection />);
    await fillNewPeriod();
    fireEvent.click(screen.getByRole("button", { name: "Create Period" }));

    await waitFor(() =>
      expect(screen.getByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeTruthy(),
    );
    expect(
      within(screen.getByRole("alert")).getByText(ADMIN_FORBIDDEN_SAVE_REASON),
    ).toBeTruthy();
  });

  it("announces a successful save politely, in a region that was already registered", async () => {
    stubSaveOutcome(200, {
      id: "p1",
      name: "School Holidays",
      startDate: "2026-07-01T00:00:00.000Z",
      endDate: "2026-07-14T00:00:00.000Z",
      nonMemberHoldEnabled: true,
      nonMemberHoldDays: 5,
      cancellationRules: [],
      active: true,
    });
    render(<BookingPeriodsSection />);
    await fillNewPeriod();

    // Both regions exist and are EMPTY before anything is saved. That ordering
    // is the whole point: a live region injected already-populated in a single
    // mutation is silently dropped by some screen-reader/browser pairings, so
    // the message has to land as a content change inside a registered region.
    const alertRegion = screen.getByRole("alert");
    const statusRegion = screen
      .getAllByRole("status")
      .filter((node) => node.dataset.testid !== "admin-view-only-banner");
    expect(statusRegion).toHaveLength(1);
    expect(alertRegion.textContent).toBe("");
    expect(statusRegion[0].textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Create Period" }));

    await waitFor(() => expect(screen.getByText("Period created")).toBeTruthy());
    // Same NODE, newly populated — and the confirmation is polite, not an alert.
    expect(statusRegion[0].textContent).toContain("Period created");
    expect(screen.getByRole("alert").textContent).toBe("");
  });
});
