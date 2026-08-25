// @vitest-environment jsdom

/**
 * THE CLIENT ADMIN LISTS PUBLISH WHAT THEY APPLIED (#2816, owner decision
 * 13 Aug 2026).
 *
 * Each page is rendered inside a real `HelpWidgetProvider` and read back through
 * `useDiagnosticsViewState` — the same channel the Diagnostics panel reads — so
 * what is asserted is what a question would actually carry, not a mock of it.
 *
 * The payments case is the one the design was argued from: on a bare
 * `/admin/payments` the activity window is applied from React state and never
 * appears in the address at all, and the registry calls that window "the single
 * most common reason a payment an operator expects is not on screen".
 */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HelpWidgetProvider,
  useDiagnosticsViewState,
} from "@/components/help-widget/help-widget-context";
import { APPLIED_PAYMENTS_SEARCH_MAX_CHARS } from "@/app/(admin)/admin/payments/_applied-query-vocabulary";
import { getPaymentsDatasetDefaults } from "@/lib/admin-dataset-reset-state";
import { CLUB_TIME_TEST_ZONE } from "@/lib/__tests__/support/club-time-render";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { APP_TIME_ZONE } from "@/config/operational";
import { chooseDivergentClubZone } from "@/lib/__tests__/helpers/club-time-zone";
import { getDiagnosticsPageContextRoute } from "@/lib/diagnostics/page-context/registry";
import { DIAGNOSTICS_PAGE_CONTEXT_BOUNDS } from "@/lib/diagnostics/page-context/types";

/**
 * The club day the PAGE will be on, taken from the zone the render actually
 * supplies (CT-4, #2870).
 *
 * This was `todayDateOnlyForTimeZone()`, which defaults its zone to
 * `APP_TIME_ZONE` — the container's `TZ`. Since CT-4 the payments page takes
 * its default activity window from the club's zone delivered through
 * `ClubTimeProvider`, so the two only agree while the environment happens to
 * BE the provider's zone. MEASURED: with `TZ=America/Denver` this suite failed
 * three payments assertions against entirely correct code — the fixture said
 * 30 June and the page, correctly reading its provider, said 1 July.
 *
 * An expectation derived from the environment while the component reads the
 * provider is the reverse of the defect this epic is closing, and it fails on
 * exactly the deployments the epic exists to protect. It is computed with an
 * independent `Intl` projection rather than through the kernel, so a defect
 * inside `@/lib/club-time` cannot satisfy both sides of the comparison.
 */
const dayIn = (zone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const clubTodayForRender = () => dayIn(CLUB_TIME_TEST_ZONE);

const routerMocks = vi.hoisted(() => ({
  replace: vi.fn(),
  search: "",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: routerMocks.replace,
    push: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(routerMocks.search),
  usePathname: () => "/admin",
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/use-admin-area-edit-access")
  >()),
  useAdminAreaEditAccess: () => true,
}));
vi.mock("@/hooks/use-xero-status", () => ({
  useXeroStatus: () => ({ connected: false }),
}));
vi.mock("@/hooks/use-xero-org-short-code", () => ({
  useXeroOrgShortCode: () => ({ shortCode: null }),
}));
vi.mock("@/components/admin/manual-refund-task-queue", () => ({
  ManualRefundTaskQueue: () => null,
}));

// --- members-list dependencies -------------------------------------------
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "admin-1", accessRoles: [{ role: "ADMIN" }] } },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

/**
 * The members query state is mocked so the DRAFT and the APPLIED search can be
 * set to different values — which is the whole point of the assertion below, and
 * something the real 300ms debounce cannot be asked for directly.
 */
const membersQueryState = vi.hoisted(() => ({
  search: "",
  setSearch: vi.fn(),
  debouncedSearch: "",
  page: 1,
  setPage: vi.fn(),
  pageSize: 25,
  sortBy: "name",
  sortDir: "asc" as const,
  filters: {} as Record<string, string>,
  setFilter: vi.fn(),
  resetDataset: vi.fn(),
  isDatasetDefault: true,
  activeFilterCount: 0,
  toggleSort: vi.fn(),
  buildMembersSearchParams: vi.fn(() => new URLSearchParams()),
  buildMembersListPath: vi.fn(() => "/admin/members"),
  buildExportUrl: vi.fn(() => "/api/admin/members/export"),
}));

vi.mock("@/app/(admin)/admin/members/_hooks/use-members-query-state", () => ({
  useMembersQueryState: () => membersQueryState,
}));
vi.mock("@/app/(admin)/admin/members/_hooks/use-xero-contact-groups", () => ({
  useXeroContactGroups: () => ({
    xeroConnected: false,
    xeroFeatures: {},
    xeroContactGroupsList: [],
    refreshingXeroGroups: false,
    refreshXeroGroups: vi.fn(),
    lastRefreshedAt: null,
  }),
}));
vi.mock("@/app/(admin)/admin/members/_components/member-bulk-action-bar", () => ({
  MemberBulkActionBar: () => null,
}));
vi.mock("@/app/(admin)/admin/members/_components/member-bulk-dialog", () => ({
  MemberBulkDialog: () => null,
}));
vi.mock(
  "@/app/(admin)/admin/members/_components/member-bulk-membership-dialog",
  () => ({ MemberBulkMembershipDialog: () => null }),
);
vi.mock("@/app/(admin)/admin/members/_components/member-editor-dialog", () => ({
  MemberEditorDialog: () => null,
}));
vi.mock("@/app/(admin)/admin/members/_components/member-filter-toolbar", () => ({
  MemberFilterToolbar: () => null,
}));
vi.mock("@/app/(admin)/admin/members/_components/member-import-dialog", () => ({
  MemberImportDialog: () => null,
}));
vi.mock("@/app/(admin)/admin/members/_components/member-pagination", () => ({
  MemberPagination: () => null,
}));
vi.mock(
  "@/app/(admin)/admin/members/_components/member-password-action-dialog",
  () => ({ MemberPasswordActionDialog: () => null }),
);
vi.mock("@/app/(admin)/admin/members/_components/member-table", () => ({
  MemberTable: () => null,
}));
vi.mock(
  "@/app/(admin)/admin/members/_components/xero-groups-refresh-hint",
  () => ({ XeroGroupsRefreshHint: () => null }),
);

/**
 * THE DRIFT GUARD. A page and its registry row are hand-matched, and the route
 * drops an unlisted key — so a page publishing one has published nothing. This
 * pins the match at close to zero cost.
 */
function assertFilterKeysAreAllowlisted(
  routeKey: string,
  view: { filters?: Record<string, string> } | null,
) {
  const row = getDiagnosticsPageContextRoute(routeKey);
  expect(row).toBeDefined();
  const keys = Object.keys(view?.filters ?? {});
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) expect(row?.filterKeys).toContain(key);
}

/** Reads the published state back out of the provider, as the widget does. */
function PublishedViewProbe() {
  const view = useDiagnosticsViewState();
  return (
    <div data-testid="published-view">{view === null ? "null" : JSON.stringify(view)}</div>
  );
}

function published() {
  const text = screen.getByTestId("published-view").textContent ?? "null";
  return text === "null" ? null : JSON.parse(text);
}

/**
 * One mock for the whole file, assigned rather than stubbed. A stub restored in
 * `afterEach` loses the race with an effect that re-fires as React unmounts the
 * page, and the real `fetch` then rejects on the relative URL as an unhandled
 * rejection that fails the run without failing a test.
 */
const fetchMock = vi.fn();

function respondWith(body: Record<string, unknown>, init = { ok: true, status: 200 }) {
  fetchMock.mockResolvedValue({ ...init, json: async () => body });
}

beforeEach(() => {
  routerMocks.search = "";
  routerMocks.replace.mockReset();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  respondWith({
    data: [],
    entries: [],
    members: [],
    total: 0,
    totalPages: 0,
    page: 1,
    pageSize: 25,
    summary: { totalRevenueCents: 0, refundedCents: 0, count: 0 },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("/admin/payments publishes the window it applied (#2816)", () => {
  it("publishes the DEFAULT activity window from a completely empty query string", async () => {
    // THE FLAGSHIP. Nothing is in the address; the two `useState` initialisers
    // fall back to `getPaymentsDatasetDefaults(clubToday)` and today, and
    // `buildPaymentsSearchParams` puts both into the request. Reading the
    // address would report no filtering at all on a list that is filtered to
    // the last three club-timezone months.
    const { default: PaymentsPage } = await import(
      "@/app/(admin)/admin/payments/page"
    );
    const clubToday = clubTodayForRender();
    const defaults = getPaymentsDatasetDefaults(clubToday);

    render(
      <HelpWidgetProvider>
        <PaymentsPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
    );

    await waitFor(() =>
      expect(published()).toEqual({
        filters: {
          lastUpdatedFrom: defaults.lastUpdatedFrom,
          lastUpdatedTo: clubToday,
        },
      }),
    );

    // WHAT THE ADDRESS ACTUALLY DOES, pinned rather than assumed. An earlier
    // version of this test claimed the URL sync "writes no query at all for the
    // default dataset" and asserted `defaults.lastUpdatedFrom !== clubToday`,
    // which is a non-sequitur that passes whatever the sync does. It does the
    // opposite: `buildPaymentsSearchParams` sets both bounds unconditionally, so
    // the page REWRITES a bare `/admin/payments` to name the window (correctness
    // review, 13 Aug 2026).
    const replaced = routerMocks.replace.mock.calls.at(-1)?.[0] as string;
    expect(replaced).toContain(`lastUpdatedFrom=${defaults.lastUpdatedFrom}`);
    expect(replaced).toContain(`lastUpdatedTo=${clubToday}`);
    // So the case for publishing is NOT "the address never learns the window".
    // It is that the window is applied by React state one commit BEFORE the
    // address learns it, that this is exactly the allowlisted applied set where
    // the address also carries sort/pagination/leftovers, and that a value the
    // page did not apply is never published as though it had been — the three
    // properties the rest of this file pins.
  });

  it("publishes the status, source and search it applied, and not the keys its row does not allow", async () => {
    routerMocks.search =
      "status=SUCCEEDED&source=STRIPE&search=%20ngata%20&xeroState=linked&sortBy=amount&page=4";
    const { default: PaymentsPage } = await import(
      "@/app/(admin)/admin/payments/page"
    );
    const clubToday = clubTodayForRender();
    const defaults = getPaymentsDatasetDefaults(clubToday);

    render(
      <HelpWidgetProvider>
        <PaymentsPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
    );

    await waitFor(() =>
      expect(published()).toEqual({
        status: "SUCCEEDED",
        filters: {
          source: "STRIPE",
          // Trimmed, because the trim is what reaches the request.
          search: "ngata",
          lastUpdatedFrom: defaults.lastUpdatedFrom,
          lastUpdatedTo: clubToday,
        },
      }),
    );
    // `xeroState`, `sortBy` and `page` are applied but are NOT in this row's
    // allowlist. The route would drop them; publishing to be dropped is not a
    // contract, so they never leave the page.
    expect(JSON.stringify(published())).not.toContain("xeroState");
    expect(JSON.stringify(published())).not.toContain("sortBy");
    // And the drift guard: every key really is one the row declares.
    assertFilterKeysAreAllowlisted("admin.payments", published());
  });

  it("publishes NEITHER a status the API refuses NOR a malformed date", async () => {
    // `adminPaymentsQuerySchema` is strict, so `?status=succeeded` (wrong case)
    // and `?lastUpdatedFrom=13-45-2026` each 400 the WHOLE query while
    // `fetchData` keeps whatever rows were there. Publishing them raw would tell
    // the model a filter was applied by a request that was refused.
    routerMocks.search = "status=succeeded&lastUpdatedFrom=13-45-2026";
    respondWith({ error: "Invalid query parameters" }, { ok: false, status: 400 });
    const { default: PaymentsPage } = await import(
      "@/app/(admin)/admin/payments/page"
    );
    const clubToday = clubTodayForRender();

    render(
      <HelpWidgetProvider>
        <PaymentsPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
    );

    // The load failed, so what is published is the FAILURE — not `{}`, which
    // would assert "I applied no filters" about a screen that has no list.
    await waitFor(() =>
      expect(published()).toEqual({ errorCode: "validation-failed" }),
    );
    expect(JSON.stringify(published())).not.toContain("succeeded");
    expect(JSON.stringify(published())).not.toContain("13-45-2026");
    expect(JSON.stringify(published())).not.toContain(clubToday);
  });

  it("does not publish a search longer than the one the API will accept", async () => {
    // `search` is applied on every keystroke here — no debounce, no submit — so a
    // 101st character 400s the whole query and the rows on screen belong to the
    // last request that succeeded. The mirror left the schema's `max(100)` out, so
    // that value published as applied (review finding, 14 Aug 2026). The fetch is
    // left OK on purpose: this pins the derivation, not the failure path the
    // sibling test above covers.
    const tooLong = "n".repeat(APPLIED_PAYMENTS_SEARCH_MAX_CHARS + 1);
    routerMocks.search = `search=${tooLong}`;
    const { default: PaymentsPage } = await import(
      "@/app/(admin)/admin/payments/page"
    );
    const clubToday = clubTodayForRender();
    const defaults = getPaymentsDatasetDefaults(clubToday);

    render(
      <HelpWidgetProvider>
        <PaymentsPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
    );

    // The window it DID apply still travels; only the refused search is withheld.
    await waitFor(() =>
      expect(published()).toEqual({
        filters: {
          lastUpdatedFrom: defaults.lastUpdatedFrom,
          lastUpdatedTo: clubToday,
        },
      }),
    );
    expect(JSON.stringify(published())).not.toContain(tooLong);
  });

  it("publishes a search of exactly the accepted length, so the bound is not off by one", async () => {
    const exact = "n".repeat(APPLIED_PAYMENTS_SEARCH_MAX_CHARS);
    routerMocks.search = `search=${exact}`;
    const { default: PaymentsPage } = await import(
      "@/app/(admin)/admin/payments/page"
    );

    render(
      <HelpWidgetProvider>
        <PaymentsPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
    );

    await waitFor(() => expect(published()?.filters?.search).toBe(exact));
  });

  it("publishes the failure code, not the filters, when the list could not load", async () => {
    respondWith({ error: "boom" }, { ok: false, status: 500 });
    routerMocks.search = "status=SUCCEEDED&search=ngata";
    const { default: PaymentsPage } = await import(
      "@/app/(admin)/admin/payments/page"
    );

    render(
      <HelpWidgetProvider>
        <PaymentsPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
    );

    // Without this, Diagnostics is handed a full filter set for a list that does
    // not exist, and answers "why is this payment not here?" by blaming the
    // activity window for an outage.
    await waitFor(() => expect(published()).toEqual({ errorCode: "server-error" }));
  });
  /**
   * THE DISCRIMINATING ONE (CT-4, #2870).
   *
   * Every test above renders under `CLUB_TIME_TEST_ZONE`, which is deliberately
   * `Pacific/Auckland` — the same zone `APP_TIME_ZONE` resolves to — so the
   * provider-read code and the `todayDateOnlyForTimeZone()` it replaced return
   * the identical day and the whole file passes against either.
   *
   * This window is not decoration. `lastUpdatedTo` defaults to the club's today
   * and is APPLIED from React state before the address ever names it, so a day
   * out silently drops the most recent day of activity out of the officer's
   * default view — and the diagnostics registry calls that window "the single
   * most common reason a payment an operator expects is not on screen".
   */
  it("takes the default activity window from the PERSISTED club zone, not APP_TIME_ZONE", async () => {
    const chosen = chooseDivergentClubZone({
      subject: "the club's today at the frozen instant",
      answerKey: "today",
      cases: [
        { zone: "America/Denver", today: "2026-06-30" }, // −6: still 30 June
        { zone: "Pacific/Kiritimati", today: "2026-07-01" }, // +14: already 1 July
      ],
      answerFor: dayIn,
      // NOT `["UTC"]`: a "today" assertion has very few calendar days to choose
      // between, and a third rival can leave a correct tree with no candidate.
    });
    const environmentToday = dayIn(APP_TIME_ZONE);

    const { default: PaymentsPage } = await import(
      "@/app/(admin)/admin/payments/page"
    );
    const defaults = getPaymentsDatasetDefaults(chosen.today);

    render(
      <HelpWidgetProvider>
        <PaymentsPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <ClubTimeProvider zone={chosen.zone}>{children}</ClubTimeProvider>
        ),
      },
    );

    await waitFor(() =>
      expect(published()).toEqual({
        filters: {
          lastUpdatedFrom: defaults.lastUpdatedFrom,
          lastUpdatedTo: chosen.today,
        },
      }),
    );
    // The control: the window the environment would have produced is NOT what
    // the page applied. Without this the assertion above would still pass on a
    // host whose own zone happened to agree with the chosen one.
    expect(published().filters.lastUpdatedTo).not.toBe(environmentToday);
  });
});

describe("/admin/waitlist publishes the window it applied (#2816)", () => {
  it("publishes the URL window the fetch actually used", async () => {
    routerMocks.search = "from=2026-08-01&to=2026-08-31&page=2&pageSize=50";
    const { default: AdminWaitlistPage } = await import(
      "@/app/(admin)/admin/waitlist/page"
    );

    render(
      <HelpWidgetProvider>
        <AdminWaitlistPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
    );

    await waitFor(() =>
      expect(published()).toEqual({
        filters: { from: "2026-08-01", to: "2026-08-31" },
      }),
    );
  });

  it("keeps publishing the APPLIED window while the operator edits the draft one", async () => {
    // THE DRAFT/APPLIED TEST THAT WAS MISSING. The other cases seed
    // `routerMocks.search` and the draft is initialised FROM those params, so
    // draft and applied are equal by construction and a mutation publishing the
    // draft instead of `fromParam`/`toParam` survived all six tests green
    // (review finding, 13 Aug 2026). Typing into the From box makes them
    // genuinely diverge: the two inputs only reach the list when "Apply filters"
    // writes them to the URL.
    routerMocks.search = "from=2026-08-01&to=2026-08-31";
    const { default: AdminWaitlistPage } = await import(
      "@/app/(admin)/admin/waitlist/page"
    );

    render(
      <HelpWidgetProvider>
        <AdminWaitlistPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
    );

    await waitFor(() =>
      expect(published()).toEqual({
        filters: { from: "2026-08-01", to: "2026-08-31" },
      }),
    );

    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-12-25" },
    });

    // The box now says December and the list is still the August one, so the
    // question must still carry August.
    expect(screen.getByLabelText("From")).toHaveValue("2026-12-25");
    expect(published()).toEqual({
      filters: { from: "2026-08-01", to: "2026-08-31" },
    });
    assertFilterKeysAreAllowlisted("admin.waitlist", published());
  });

  it("publishes the API's REFUSAL, not an empty view, once the window was rejected", async () => {
    // `/api/admin/waitlist` validates the window with zod and answers 400 on a
    // malformed or over-long one, so the rows on screen are then not a filtered
    // list at all — they are no list. Same total-rejection trap the bookings
    // page has, arriving over the wire instead of in a `safeParse`. `{}` would
    // assert "I applied no filters"; the code says "there is no list, and why".
    respondWith(
      { error: "Invalid query parameters" },
      { ok: false, status: 400 },
    );
    routerMocks.search = "from=13-45-2026&to=2026-08-31";
    const { default: AdminWaitlistPage } = await import(
      "@/app/(admin)/admin/waitlist/page"
    );

    render(
      <HelpWidgetProvider>
        <AdminWaitlistPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
    );

    await waitFor(() =>
      expect(published()).toEqual({ errorCode: "validation-failed" }),
    );
  });
});

describe("/admin/members publishes the search that FILTERED, not the one being typed (#2816)", () => {
  it("publishes the debounced search and the applied age tier, never the draft", async () => {
    // `search` is the raw keystroke draft in the box; only `debouncedSearch`
    // reaches `buildMembersSearchParams` and therefore the fetch, 300ms later.
    // Publishing the draft would report a search that has filtered nothing —
    // including through the whole window in which an operator types a name and
    // immediately asks why nobody is showing up.
    membersQueryState.search = "hemi-still-typing";
    membersQueryState.debouncedSearch = "ngata";
    membersQueryState.filters = { ageTier: "ADULT", role: "ADMIN" };
    const { default: MembersPage } = await import(
      "@/app/(admin)/admin/members/page"
    );

    render(
      <HelpWidgetProvider>
        <MembersPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
    );

    await waitFor(() =>
      // `role` is applied but is not in this row's allowlist, so it stays here.
      expect(published()).toEqual({ filters: { q: "ngata", ageTier: "ADULT" } }),
    );
    expect(JSON.stringify(published())).not.toContain("still-typing");
    assertFilterKeysAreAllowlisted("admin.members", published());
  });

  it("does not publish an age tier the query silently ignored", async () => {
    // `buildMembersWhere` applies `ageTier` only when it is a real `AgeTier` and
    // otherwise IGNORES it — no 400, no narrowing. A bare truthiness test here
    // published `?ageTier=<120 arbitrary characters>` as an applied filter for a
    // list it had not narrowed at all (review finding, 13 Aug 2026).
    membersQueryState.search = ""
    membersQueryState.debouncedSearch = ""
    membersQueryState.filters = { ageTier: "GROWN_UPS" }
    const { default: MembersPage } = await import(
      "@/app/(admin)/admin/members/page"
    );

    render(
      <HelpWidgetProvider>
        <MembersPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
    );

    await waitFor(() => expect(published()).toEqual({}));
  });

  it("does not publish a search the ask route would drop for length", async () => {
    // `q` is UNBOUNDED server-side (`optionalSearchParam` is a bare `z.string()`),
    // so this one really is applied and really does empty the list — and the ask
    // route drops a filter value over `filterValueMaxChars`. Publishing it tells
    // the model nothing about the narrowing that emptied the screen, which is the
    // worst available answer to "why is nobody here?" (review, 14 Aug 2026).
    const tooLong = "n".repeat(
      DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.filterValueMaxChars + 1,
    );
    membersQueryState.search = tooLong
    membersQueryState.debouncedSearch = tooLong
    membersQueryState.filters = { ageTier: "ADULT" }
    const { default: MembersPage } = await import(
      "@/app/(admin)/admin/members/page"
    );

    render(
      <HelpWidgetProvider>
        <MembersPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
    );

    // The tier it DID apply still travels.
    await waitFor(() =>
      expect(published()).toEqual({ filters: { ageTier: "ADULT" } }),
    );
    expect(JSON.stringify(published())).not.toContain(tooLong);
  });

  it("publishes the failure code, not the search, when the list could not load", async () => {
    respondWith({ error: "nope" }, { ok: false, status: 403 });
    membersQueryState.search = "ngata"
    membersQueryState.debouncedSearch = "ngata"
    membersQueryState.filters = {}
    const { default: MembersPage } = await import(
      "@/app/(admin)/admin/members/page"
    );

    render(
      <HelpWidgetProvider>
        <MembersPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
    );

    await waitFor(() => expect(published()).toEqual({ errorCode: "forbidden" }));
  });

  it("publishes an empty view when nothing is filtered, not `undefined`", async () => {
    membersQueryState.search = "";
    membersQueryState.debouncedSearch = "";
    membersQueryState.filters = {};
    const { default: MembersPage } = await import(
      "@/app/(admin)/admin/members/page"
    );

    render(
      <HelpWidgetProvider>
        <MembersPage />
        <PublishedViewProbe />
      </HelpWidgetProvider>,
    );

    await waitFor(() => expect(published()).toEqual({}));
  });
});
