// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { APP_TIME_ZONE } from "@/config/operational";
import { chooseDivergentClubZone } from "@/lib/__tests__/helpers/club-time-zone";

/**
 * The club's day at the frozen instant (`2026-07-01T00:00:00.000Z`, midday NZ)
 * under the suite's default provider zone, `Pacific/Auckland`.
 *
 * IT PROVES NOTHING ABOUT ZONE AUTHORITY on its own: that zone is also what
 * `APP_TIME_ZONE` resolves to under test, so the migrated code and the
 * `getTodayDateOnly()` it replaced agree. The zone-authority test further down
 * chooses a zone the environment is not on, and is the one that can tell them
 * apart (CT-4, #2870).
 */
const CLUB_TODAY = "2026-07-01";

/**
 * The `yyyy-MM-dd` day a given zone is on at the frozen instant, computed
 * independently of the kernel under test — an oracle, so that one defect inside
 * `@/lib/club-time` cannot satisfy both sides of a comparison at once.
 */
const todayIn = (zone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const mocks = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn(), scrollToError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/hooks/use-scroll-to-feedback", () => ({
  useScrollToFeedback: () => ({ scrollToError: mocks.scrollToError, scrollToTop: vi.fn() }),
}));

// The finance fee sections moved to the consolidated /admin/fees console (#1933,
// E7); /admin/fee-configuration now redirects there. Behaviour is unchanged, so
// this suite exercises the moved component directly.
let FeeConfigurationPage: typeof import("@/app/(admin)/admin/fees/_components/finance-fees-sections").FinanceFeesSections;

const editableData = {
  canEdit: true,
  familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER",
  // Resolved default income account for empty component Account fields (#2068).
  defaultInvoiceAccountCode: "203",
  membershipTypes: [{
    id: "type-1", key: "FULL", name: "Full", isActive: true,
    annualFees: [{ id: "fee-1", ageTier: null, amountCents: 10000, effectiveFrom: "2026-01-01", effectiveTo: null, billingBasis: "PER_MEMBER", prorationRule: "NONE" }],
    joiningFees: [{ id: "joining-1", ageTier: "ADULT", amountCents: 5000, effectiveFrom: "2026-01-01", effectiveTo: null }],
  }],
  familyGroups: [{
    id: "family-1", name: "Example family", billingMemberId: "member-1", billingException: false,
    members: [{ id: "member-1", firstName: "Alex", lastName: "Example", email: "alex@example.test", active: true }],
  }],
};

// Fee with saved invoice-line components, exercising the proration-display fix
// (#2068, finding 7): a NONE-rule fee whose component is stored prorate=true
// must still read "full", while a prorating fee reads "prorated".
const componentFeeData = {
  ...editableData,
  membershipTypes: [{
    id: "type-1", key: "FULL", name: "Full", isActive: true,
    annualFees: [
      {
        id: "fee-none", ageTier: null, amountCents: 10000, effectiveFrom: "2026-01-01", effectiveTo: null,
        billingBasis: "PER_MEMBER", prorationRule: "NONE",
        components: [{ id: "c1", label: "Base membership", amountCents: 10000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 }],
      },
      {
        id: "fee-rem", ageTier: "YOUTH", amountCents: 6000, effectiveFrom: "2026-01-01", effectiveTo: null,
        billingBasis: "PER_MEMBER", prorationRule: "REMAINING_MONTHS_INCLUSIVE",
        components: [{ id: "c2", label: "Youth base", amountCents: 6000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 }],
      },
    ],
    joiningFees: [],
  }],
};

// Three membered families exercise the multi-family Save loop. Each family has
// two active members so a billing member can be switched to the second one.
const multiFamilyData = {
  canEdit: true,
  familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER",
  membershipTypes: editableData.membershipTypes,
  familyGroups: [
    {
      id: "family-1", name: "Alpha family", billingMemberId: "m1a", billingException: false,
      members: [
        { id: "m1a", firstName: "Amy", lastName: "Alpha", email: "amy@alpha.test", active: true },
        { id: "m1b", firstName: "Aaron", lastName: "Alpha", email: "aaron@alpha.test", active: true },
      ],
    },
    {
      id: "family-2", name: "Beta family", billingMemberId: "m2a", billingException: false,
      members: [
        { id: "m2a", firstName: "Ben", lastName: "Beta", email: "ben@beta.test", active: true },
        { id: "m2b", firstName: "Bella", lastName: "Beta", email: "bella@beta.test", active: true },
      ],
    },
    {
      id: "family-3", name: "Gamma family", billingMemberId: "m3a", billingException: false,
      members: [
        { id: "m3a", firstName: "Gina", lastName: "Gamma", email: "gina@gamma.test", active: true },
        { id: "m3b", firstName: "Greg", lastName: "Gamma", email: "greg@gamma.test", active: true },
      ],
    },
  ],
};

// Xero reference fixtures for the component Account/Item pickers (#2068). The
// account picker filters to REVENUE class; 203 is the resolved default.
const xeroAccounts = [
  { code: "200", name: "Hut Fees Income", type: "REVENUE", class: "REVENUE" },
  { code: "203", name: "Subscriptions Income", type: "REVENUE", class: "REVENUE" },
  { code: "260", name: "Other Revenue", type: "REVENUE", class: "REVENUE" },
  { code: "090", name: "Bank", type: "BANK", class: "ASSET" },
];
const xeroItems = [
  { itemID: "i1", code: "MEMBER", name: "Membership", description: "" },
  { itemID: "i2", code: "WORKPARTY", name: "Work Party", description: "" },
];

function response(ok: boolean, body: unknown) {
  return { ok, json: async () => body } as Response;
}

// A fetch stub that serves the two admin-gated Xero proxy endpoints from static
// fixtures and routes fee-configuration GET/POST through `config` (#2068). The
// component now loads accounts + items on mount, so every mock must be
// URL-aware. `config` may be a single Response, a queue (consumed in order, the
// last entry repeating), or a function called per fee-configuration request.
function stubFetch(
  config: Response | Response[] | ((init?: RequestInit) => Response),
  opts: { accountsOk?: boolean; itemsOk?: boolean } = {},
) {
  const { accountsOk = true, itemsOk = true } = opts;
  const queue = Array.isArray(config) ? [...config] : null;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("chart-of-accounts")) {
      return accountsOk ? response(true, { accounts: xeroAccounts }) : response(false, { error: "Xero disconnected" });
    }
    if (u.includes("/admin/xero/items")) {
      return itemsOk ? response(true, { items: xeroItems }) : response(false, { error: "Xero disconnected" });
    }
    if (typeof config === "function") return config(init);
    if (queue) {
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      return next;
    }
    return config;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Stage a billing member on the Nth family Select (0-based, DOM order matches
// the fixture). Same keyboard-driven Radix open as selectRadixOption, but
// targets one of several identically-named "Billing member" comboboxes.
function stageFamilyBilling(index: number, optionName: RegExp | string) {
  const triggers = screen.getAllByRole("combobox", { name: "Billing member" });
  fireEvent.keyDown(triggers[index], { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

// Post bodies for SET_FAMILY_BILLING_MEMBER, in call order.
function familyBillingPosts(fetchMock: ReturnType<typeof vi.fn>) {
  return postCalls(fetchMock)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
    .filter((body) => body.action === "SET_FAMILY_BILLING_MEMBER");
}

// The only POSTs are mutation calls; the initial loads are bodyless GETs.
function postCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
}
function postBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = postCalls(fetchMock).at(-1);
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : null;
}

// Radix Select needs these DOM APIs jsdom does not implement to open its listbox.
// Keyboard opening (ArrowDown on the trigger) is the reliable path in jsdom.
function selectRadixOption(triggerName: string, optionName: RegExp | string) {
  const trigger = screen.getByRole("combobox", { name: triggerName });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

beforeAll(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  // The clock-pinning dance that used to sit here is gone with the defect it
  // worked around (CT-4, #2870). The "effective from" default was a MODULE-LEVEL
  // constant computed at import, so this suite had to pin a fake clock across
  // the dynamic import to control it — and in the product that meant a tab left
  // open across midnight kept yesterday's date. It is read per render now, from
  // the club's persisted zone, so the frozen test clock is enough.
  FeeConfigurationPage = (await import("@/app/(admin)/admin/fees/_components/finance-fees-sections")).FinanceFeesSections;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("fee configuration page", () => {
  it("shows a friendly read-only notice (not a fetch-failed error) when the finance read is cross-area 403 (E7 Lens-A F1)", async () => {
    // A bookings-only operator on the shared /admin/fees console gets a 403 from
    // the finance-gated /api/admin/fee-configuration read.
    stubFetch({ ok: false, status: 403, json: async () => ({ error: "Forbidden" }) } as Response);
    render(<FeeConfigurationPage />);
    expect(await screen.findByText(/don't have permission to view this section/i)).toBeTruthy();
    // The raw fetch-failed error must NOT surface.
    expect(screen.queryByText(/failed to load fee configuration/i)).toBeNull();
    expect(screen.queryByText(/^Forbidden$/)).toBeNull();
  });

  it("renders finance viewers read-only with no edit affordances", async () => {
    stubFetch(response(true, { ...editableData, canEdit: false }));
    render(<FeeConfigurationPage />);
    expect(await screen.findByText(/finance view access is read-only/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit membership fees" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit joining fees" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit family billing" })).toBeNull();
    // No forms, no per-row controls, no billing Select while read-only.
    expect(screen.queryByLabelText("Annual amount (NZD)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Full Flat (all ages) fee" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Billing member" })).toBeNull();
    // Saved values still render (fee schedule + billing member as static text).
    expect(screen.getByText("$100.00")).toBeTruthy();
    expect(screen.getByText(/Alex Example/)).toBeTruthy();
  });

  it("gates the membership form and row controls behind Edit", async () => {
    stubFetch(response(true, editableData));
    render(<FeeConfigurationPage />);
    await screen.findByRole("button", { name: "Edit membership fees" });
    // Read-only on load: schedule shown, but no form and no pencil.
    expect(screen.getByText("$100.00")).toBeTruthy();
    expect(screen.queryByLabelText("Annual amount (NZD)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Full Flat (all ages) fee" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit membership fees" }));
    expect(screen.getByLabelText("Annual amount (NZD)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Full Flat (all ages) fee" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add annual fee" })).toBeTruthy();
  });

  it("offers an age-tier select and sends ageTier null when creating a flat fee (#2067)", async () => {
    const fetchMock = stubFetch([response(true, editableData), response(true, editableData)]);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    // The per-tier select (#2067) is present and defaults to Flat (all ages).
    expect(document.querySelector("#membership-tier")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Annual amount (NZD)"), { target: { value: "150.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add annual fee" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Fee schedule saved"));
    expect(postBody(fetchMock)).toMatchObject({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", ageTier: null,
      amountCents: 15000, billingBasis: "PER_MEMBER",
    });
  });

  it("uses the club's date and discards membership form edits on cancel with no API call", async () => {
    const fetchMock = stubFetch(response(true, editableData));
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    expect((document.querySelector("#membership-from") as HTMLInputElement).value).toBe(CLUB_TODAY);
    fireEvent.click(screen.getByRole("button", { name: "Edit Full Flat (all ages) fee" }));
    expect((screen.getByLabelText("Annual amount (NZD)") as HTMLInputElement).value).toBe("100.00");
    fireEvent.click(screen.getByRole("button", { name: "Close section" }));
    // Close section leaves edit mode; re-entering shows a fresh add form.
    expect(screen.queryByLabelText("Annual amount (NZD)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit membership fees" }));
    expect((screen.getByLabelText("Annual amount (NZD)") as HTMLInputElement).value).toBe("");
    expect((document.querySelector("#membership-from") as HTMLInputElement).value).toBe(CLUB_TODAY);
    expect(postCalls(fetchMock)).toHaveLength(0);
  });

  /**
   * THE DISCRIMINATING ONE (CT-4, #2870).
   *
   * The test above asserts the shape but cannot assert the AUTHORITY: it renders
   * under `Pacific/Auckland`, which is also what `APP_TIME_ZONE` resolves to in
   * this suite, so the migrated code and the `getTodayDateOnly()` it replaced
   * return the identical string. It would pass against either.
   *
   * A fee's "effective from" is money — it decides which annual amount a
   * member is charged from which day — so which day it defaults to has to come
   * from the club's PERSISTED zone (`INV-CONFIG-002`) and nothing else. A club
   * zone the environment is NOT on is what shows that: at the frozen instant a
   * club six hours behind UTC is still on 30 June while one fourteen hours ahead
   * has reached 1 July.
   *
   * ## Why the zone is CHOSEN rather than written down
   *
   * The premise here used to be `expect(DENVER_TODAY).not.toBe(CLUB_TODAY)` —
   * two of this file's own constants, which can never disagree. So it could not
   * fail, and MEASURED on this branch: with `TZ=America/Denver` the environment
   * became Denver, this assertion stopped telling the persisted zone from the
   * environment, and nothing went red. A premise that never consults the
   * environment is not a premise about the environment.
   */
  it("defaults the effective-from date to the club's PERSISTED zone, not APP_TIME_ZONE or the host", async () => {
    const chosen = chooseDivergentClubZone({
      subject: "the club's today at the frozen instant",
      answerKey: "today",
      cases: [
        { zone: "America/Denver", today: "2026-06-30" }, // −6: still 30 June
        { zone: "Pacific/Kiritimati", today: "2026-07-01" }, // +14: already 1 July
      ],
      // An INDEPENDENT oracle, not `clubToday`: reading "what this zone would
      // say" through the kernel under test would let one defect satisfy both
      // sides. `en-CA` numeric is `yyyy-MM-dd`, the shape this field holds.
      answerFor: (zone) => todayIn(zone),
      // NOT `["UTC"]`. At THIS instant there are exactly two calendar days on
      // earth, both already taken by the two candidates, so a second rival
      // would leave nothing to choose and the chooser would refuse a correct
      // tree. Two is a fact about this fixture, not the world: the inhabited
      // span is 25 hours (-11 to +14), so at UTC hour 10 there are THREE. This
      // fixture is at UTC hour 0; re-derive the count if you move it. It is not needed either: `clubToday` consults only the zone it is
      // handed, so "read the machine's clock" is not a reachable mutation — the
      // reachable one is "read APP_TIME_ZONE", which the environment excludes.
    });
    const environmentToday = todayIn(APP_TIME_ZONE);
    expect(chosen.today).not.toBe(environmentToday);

    stubFetch(response(true, editableData));
    render(<FeeConfigurationPage />, {
      wrapper: ({ children }) => (
        <ClubTimeProvider zone={chosen.zone}>{children}</ClubTimeProvider>
      ),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    expect((document.querySelector("#membership-from") as HTMLInputElement).value).toBe(chosen.today);

    // The joining-fee default is a SEPARATE piece of state seeded from the same
    // club day, and its field only exists once its own section is in edit mode.
    // Asserting it behind `?.value ?? chosen.today` — as this line did until the
    // CT-4 review — made it `expect(x).toBe(x)` for an element that was never
    // rendered, so the joining fee, which is money a new member is charged, had
    // no zone coverage at all. Open the section and assert unconditionally.
    fireEvent.click(screen.getByRole("button", { name: "Edit joining fees" }));
    const joiningFrom = document.querySelector("#entrance-from") as HTMLInputElement | null;
    expect(joiningFrom).not.toBeNull();
    expect(joiningFrom?.value).toBe(chosen.today);
  });

  it("commits an unchanged membership fee payload from edit mode", async () => {
    const fetchMock = stubFetch([response(true, editableData), response(true, editableData)]);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Full Flat (all ages) fee" }));
    fireEvent.click(screen.getByRole("button", { name: "Update annual fee" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Fee schedule saved"));
    // Stays in edit mode after commit, back in add-mode.
    expect(screen.getByRole("button", { name: "Add annual fee" })).toBeTruthy();
    expect(postBody(fetchMock)).toEqual({
      action: "UPDATE_MEMBERSHIP_FEE", id: "fee-1", amountCents: 10000,
      billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-01-01", effectiveTo: null,
      // A fee with no stored components defaults to the single reconciled
      // component (#1932, E6); editing always sends the reconciled array.
      components: [{ label: "Annual membership fee", amountCents: 10000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 }],
    });
  });

  it("retains membership edit mode and surfaces feedback when an update fails", async () => {
    const fetchMock = stubFetch([response(true, editableData), response(false, { error: "Overlapping schedule" })]);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Full Flat (all ages) fee" }));
    fireEvent.click(screen.getByRole("button", { name: "Update annual fee" }));
    expect(await screen.findByText("Overlapping schedule")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update annual fee" })).toBeTruthy();
    expect(mocks.toastError).toHaveBeenCalledWith("Overlapping schedule");
    await waitFor(() => expect(mocks.scrollToError).toHaveBeenCalled());
    void fetchMock;
  });

  it("keeps failed delete confirmation context inside membership edit mode", async () => {
    stubFetch([response(true, editableData), response(false, { error: "Delete failed" })]);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Full Flat (all ages) fee" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete fee" }));
    expect(await screen.findByText("Delete failed")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/Full Flat \(all ages\) annual fee from 2026-01-01/)).toBeTruthy();
  });

  it("gates the entrance fee form and row controls behind Edit", async () => {
    stubFetch(response(true, editableData));
    render(<FeeConfigurationPage />);
    await screen.findByRole("button", { name: "Edit joining fees" });
    expect(screen.queryByLabelText("Amount (NZD)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Full Adult joining fee" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit joining fees" }));
    expect(screen.getByLabelText("Amount (NZD)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Full Adult joining fee" })).toBeTruthy();
  });

  it("does not call SET_FAMILY_BILLING_MEMBER until the family section Save", async () => {
    const fetchMock = stubFetch([response(true, editableData), response(true, editableData)]);
    render(<FeeConfigurationPage />);
    await screen.findByRole("button", { name: "Edit family billing" });
    // Read-only: billing member is static text, no Select yet.
    expect(screen.queryByRole("combobox", { name: "Billing member" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit family billing" }));
    // Staging a change must not fire the API.
    selectRadixOption("Billing member", /No billing member/);
    expect(postCalls(fetchMock)).toHaveLength(0);
    // Save commits the staged selection with the unchanged payload shape.
    fireEvent.click(screen.getByRole("button", { name: "Save billing members" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Billing members updated"));
    expect(postBody(fetchMock)).toEqual({
      action: "SET_FAMILY_BILLING_MEMBER", familyGroupId: "family-1", billingMemberId: null,
    });
  });

  it("reverts staged family billing changes on Cancel with no API call", async () => {
    const fetchMock = stubFetch(response(true, editableData));
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit family billing" }));
    selectRadixOption("Billing member", /No billing member/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Back to read-only showing the original saved member; nothing persisted.
    expect(screen.getByText(/Alex Example/)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Billing member" })).toBeNull();
    expect(postCalls(fetchMock)).toHaveLength(0);
  });

  it("posts only changed families on Save, one SET_FAMILY_BILLING_MEMBER call each", async () => {
    const fetchMock = stubFetch(response(true, multiFamilyData));
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit family billing" }));
    // Change families 1 and 3; leave family 2 (index 1) on its saved member.
    stageFamilyBilling(0, /Aaron Alpha/);
    stageFamilyBilling(2, /Greg Gamma/);
    fireEvent.click(screen.getByRole("button", { name: "Save billing members" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Billing members updated"));
    // Exactly one call per changed family, correct body, unchanged family never sent.
    const posts = familyBillingPosts(fetchMock);
    expect(posts).toEqual([
      { action: "SET_FAMILY_BILLING_MEMBER", familyGroupId: "family-1", billingMemberId: "m1b" },
      { action: "SET_FAMILY_BILLING_MEMBER", familyGroupId: "family-3", billingMemberId: "m3b" },
    ]);
    expect(posts.filter((body) => body.familyGroupId === "family-2")).toHaveLength(0);
    // One summary toast, not one per changed family.
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("stops the family Save loop on first failure and resumes without re-sending saved families", async () => {
    // Stateful server: successful saves update billing member so a retry no
    // longer treats that family as changed. Family 2 fails on its first attempt.
    const families = JSON.parse(JSON.stringify(multiFamilyData.familyGroups)) as typeof multiFamilyData.familyGroups;
    let family2Attempts = 0;
    const fetchMock = stubFetch((init?: RequestInit) => {
      if (init?.method !== "POST") return response(true, { ...multiFamilyData, familyGroups: families });
      const body = JSON.parse(String(init.body));
      if (body.familyGroupId === "family-2") {
        family2Attempts += 1;
        if (family2Attempts === 1) return response(false, { error: "Billing member must be active" });
      }
      const target = families.find((group) => group.id === body.familyGroupId);
      if (target) target.billingMemberId = body.billingMemberId;
      return response(true, { ...multiFamilyData, familyGroups: families });
    });
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit family billing" }));
    // Stage a change on all three families.
    stageFamilyBilling(0, /Aaron Alpha/);
    stageFamilyBilling(1, /Bella Beta/);
    stageFamilyBilling(2, /Greg Gamma/);
    fireEvent.click(screen.getByRole("button", { name: "Save billing members" }));
    // Loop stops on family 2's failure: family 1 saved, family 3 never attempted.
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Billing member must be active"));
    const firstRun = familyBillingPosts(fetchMock);
    expect(firstRun.map((body) => body.familyGroupId)).toEqual(["family-1", "family-2"]);
    // No success summary while the loop failed part way.
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    // Edit mode stays open and staged edits survive.
    expect(screen.getByRole("button", { name: "Save billing members" })).toBeTruthy();
    expect(screen.getAllByRole("combobox", { name: "Billing member" })).toHaveLength(3);

    // Retry: already-saved family 1 is not re-sent; family 2 (now succeeding) and 3 are.
    fireEvent.click(screen.getByRole("button", { name: "Save billing members" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Billing members updated"));
    const allPosts = familyBillingPosts(fetchMock);
    expect(allPosts.filter((body) => body.familyGroupId === "family-1")).toHaveLength(1);
    expect(allPosts.filter((body) => body.familyGroupId === "family-2")).toHaveLength(2);
    expect(allPosts.filter((body) => body.familyGroupId === "family-3")).toHaveLength(1);
    // Retry only re-sent the still-unsaved families, in order.
    expect(allPosts.slice(2).map((body) => body.familyGroupId)).toEqual(["family-2", "family-3"]);
  });

  it("hides the family billing card and per-family basis when the club bills members individually", async () => {
    const individualData = { ...editableData, familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" };
    stubFetch(response(true, individualData));
    render(<FeeConfigurationPage />);
    // Membership section still loads; family card is gone entirely.
    await screen.findByRole("button", { name: "Edit membership fees" });
    expect(screen.queryByRole("button", { name: "Edit family billing" })).toBeNull();
    expect(screen.queryByText("Family billing members")).toBeNull();
    expect(screen.queryByText("Billing exception")).toBeNull();
    // Per-family is not offered in the membership billing basis Select.
    fireEvent.click(screen.getByRole("button", { name: "Edit membership fees" }));
    selectRadixOption("Billing basis", /Per member/);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Billing basis" }), { key: "ArrowDown" });
    expect(screen.queryByRole("option", { name: "Per family" })).toBeNull();
    expect(screen.getByRole("option", { name: "No invoice" })).toBeTruthy();
  });

  it("warns about stale per-family schedules under individual billing", async () => {
    const staleData = {
      ...editableData,
      familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY",
      membershipTypes: [{
        id: "type-1", key: "FULL", name: "Full", isActive: true,
        annualFees: [{ id: "fee-1", amountCents: 10000, effectiveFrom: "2026-01-01", effectiveTo: null, billingBasis: "PER_FAMILY", prorationRule: "NONE" }],
        joiningFees: [],
      }],
    };
    stubFetch(response(true, staleData));
    render(<FeeConfigurationPage />);
    expect(await screen.findByText(/one or more schedules still use the per-family basis/i)).toBeTruthy();
  });

  // --- #2068: Xero pickers, surfaced default, proration display ---

  it("replaces the free-text Account/Item fields with pickers surfacing the resolved default (#2068)", async () => {
    stubFetch(response(true, editableData));
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    // The account picker trigger surfaces the resolved default income account
    // (code from the GET payload, name from the live chart of accounts).
    const accountTrigger = screen.getByRole("button", { name: "Account (optional) for component 1" });
    await waitFor(() => expect(accountTrigger.textContent).toContain("Subscriptions Income"));
    expect(accountTrigger.textContent).toContain("Default: 203");
    // Items have no default mapping; the empty state says so accurately.
    expect(screen.getByRole("button", { name: "Item (optional) for component 1" }).textContent).toContain("Default: no item");
  });

  it("says the default is not configured when no subscriptionIncome mapping is surfaced (#2068, F1)", async () => {
    // The route returns null when subscriptionIncome is not explicitly
    // configured; the editor must not advertise a code billing would refuse.
    stubFetch(response(true, { ...editableData, defaultInvoiceAccountCode: null }));
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    const accountTrigger = screen.getByRole("button", { name: "Account (optional) for component 1" });
    expect(accountTrigger.textContent).toContain("Default: not configured");
  });

  it("saves the account and item codes chosen from the pickers (#2068)", async () => {
    const fetchMock = stubFetch([response(true, editableData), response(true, editableData)]);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    fireEvent.change(screen.getByLabelText("Annual amount (NZD)"), { target: { value: "150.00" } });
    // Wait for the live lists to load, then pick a revenue account + a sales item.
    await waitFor(() => expect(screen.getByRole("button", { name: "Account (optional) for component 1" }).textContent).toContain("Subscriptions Income"));
    fireEvent.click(screen.getByRole("button", { name: "Account (optional) for component 1" }));
    fireEvent.click(screen.getByRole("button", { name: /260.*Other Revenue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Item (optional) for component 1" }));
    fireEvent.click(screen.getByRole("button", { name: /WORKPARTY.*Work Party/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add annual fee" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Fee schedule saved"));
    expect(postBody(fetchMock).components).toEqual([
      { label: "Annual membership fee", amountCents: 15000, prorate: true, xeroAccountCode: "260", xeroItemCode: "WORKPARTY", sortOrder: 0 },
    ]);
  });

  it("only lists ACTIVE revenue accounts in the account picker (#2068)", async () => {
    stubFetch(response(true, editableData));
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Account (optional) for component 1" }).textContent).toContain("Subscriptions Income"));
    fireEvent.click(screen.getByRole("button", { name: "Account (optional) for component 1" }));
    // Revenue accounts are offered; the ASSET/BANK account (090) is filtered out.
    expect(screen.getByRole("button", { name: /260.*Other Revenue/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /090.*Bank/ })).toBeNull();
  });

  it("keeps manual code entry working with an amber notice when the Xero lists fail to load (#2068)", async () => {
    const fetchMock = stubFetch([response(true, editableData), response(true, editableData)], { accountsOk: false, itemsOk: false });
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    fireEvent.change(screen.getByLabelText("Annual amount (NZD)"), { target: { value: "150.00" } });
    // Amber notice, never a hard block.
    expect(await screen.findByText(/Could not load the Xero/)).toBeTruthy();
    // Manual code entry via the picker's disconnected fallback.
    fireEvent.click(screen.getByRole("button", { name: "Account (optional) for component 1" }));
    fireEvent.change(screen.getByPlaceholderText(/Search account code/), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: /Use code/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add annual fee" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Fee schedule saved"));
    expect(postBody(fetchMock).components[0].xeroAccountCode).toBe("250");
  });

  it("renders the fee-level proration rule and never labels a Full-annual-fee component as prorated (#2068)", async () => {
    stubFetch(response(true, componentFeeData));
    render(<FeeConfigurationPage />);
    await screen.findByRole("button", { name: "Edit membership fees" });
    // Each saved fee shows its rule label, in the editor's own words.
    expect(screen.getByText("Full annual fee")).toBeTruthy();
    expect(screen.getByText("Remaining months, including decision month")).toBeTruthy();
    // The NONE fee's component reads "full" despite its stored prorate=true.
    const baseLi = screen.getByText((content) => content.startsWith("Base membership"));
    expect(baseLi.textContent).toMatch(/·\s*full$/);
    expect(baseLi.textContent).not.toContain("prorated");
    // The prorating fee's component reads "prorated".
    const youthLi = screen.getByText((content) => content.startsWith("Youth base"));
    expect(youthLi.textContent).toContain("prorated");
  });

  it("hides the per-component Prorate checkbox for a Full annual fee and shows it once the rule prorates (#2068)", async () => {
    stubFetch(response(true, editableData));
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    // Add-mode defaults the rule to Full annual fee (NONE) -> no Prorate checkbox.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("Prorate n/a")).toBeTruthy();
    // Switching the rule to prorating reveals the per-component opt-in.
    selectRadixOption("Proration", /Remaining months/);
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.queryByText("Prorate n/a")).toBeNull();
  });
});
