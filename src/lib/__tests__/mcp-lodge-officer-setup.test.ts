/**
 * ALP-722 (`INV-MCP-006`): the Lodge Operations setup actions an officer's AI
 * app connection may run: the club's lodges, a lodge's central-server link
 * and roster name detail (read only: the save is website-only,
 * `privacy-posture`), the lodge settings, and the Other lodges registry.
 * Each route answers the browser as before; the connection gets exactly the
 * action's `returns` fields (`expectActionContract`). Every handler runs
 * twice (connection, then browser), so the write mocks answer both runs.
 *
 * What a connection must never be sent here: a lodge's door code, another
 * club's booking officer's email address or phone, the central server's push
 * secret.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    lodge: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    otherLodge: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    prisma,
    requireAdmin: vi.fn(),
    createAuditLog: vi.fn(),
    slug: vi.fn(),
    configLock: vi.fn(),
    capacityLock: vi.fn(),
    createLodgeSettings: vi.fn(),
    loadLodgeSettings: vi.fn(),
    updateLodgeSettings: vi.fn(),
    capacityStatus: vi.fn(),
    deactivationRefusal: vi.fn(),
    clubToday: vi.fn(),
    revalidateContent: vi.fn(),
    revalidateSite: vi.fn(),
    invalidateIdentity: vi.fn(),
    primeIdentity: vi.fn(),
    centralLinkStatus: vi.fn(),
    labelOwnedLodges: vi.fn(),
    saveCentralLodgeLinks: vi.fn(),
    credential: vi.fn(),
    serverNzSettings: vi.fn(),
    moduleFlags: vi.fn(),
    syncFromFees: vi.fn(),
    feesProblem: vi.fn(),
    storedVersion: vi.fn(),
    upload: vi.fn(),
    hide: vi.fn(),
  };
});

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  createAuditLog: h.createAuditLog,
}));
vi.mock("@/lib/lodges", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodges")),
  buildUniqueLodgeSlug: h.slug,
}));
vi.mock("@/lib/config-transfer-lock", () => ({ acquireConfigImportLock: h.configLock }));
vi.mock("@/lib/lodge-capacity-lock", () => ({ acquireLodgeCapacityLock: h.capacityLock }));
vi.mock("@/lib/lodge-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodge-settings")),
  createNewLodgeSettings: h.createLodgeSettings,
  loadLodgeSettings: h.loadLodgeSettings,
  updateLodgeSettings: h.updateLodgeSettings,
}));
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodge-capacity")),
  getLodgeCapacityStatus: h.capacityStatus,
}));
vi.mock("@/lib/lodge-deactivation-guard", () => ({ findLodgeDeactivationRefusal: h.deactivationRefusal }));
vi.mock("@/lib/club-time/server", () => ({ clubTodayDateOnlyInstant: h.clubToday }));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: h.revalidateContent,
  revalidatePublicSite: h.revalidateSite,
}));
vi.mock("@/lib/public-layout-cache", () => ({ invalidatePublicClubIdentity: h.invalidateIdentity }));
vi.mock("@/lib/club-identity-settings", () => ({ primeClubIdentitySync: h.primeIdentity }));
vi.mock("@/lib/central-lodge-link", () => ({
  centralLinkStatus: h.centralLinkStatus,
  labelOwnedLodges: h.labelOwnedLodges,
  saveCentralLodgeLinks: h.saveCentralLodgeLinks,
}));
vi.mock("@/lib/integration-credentials", () => ({ getIntegrationCredentialValue: h.credential }));
vi.mock("@/lib/servernz-settings", () => ({ loadServerNzSettings: h.serverNzSettings }));
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadEffectiveModuleFlags: h.moduleFlags,
}));
vi.mock("@/lib/other-lodge-fees-sync", () => ({
  syncOwnOtherLodgesFromFees: h.syncFromFees,
  otherLodgeFeesProblem: h.feesProblem,
  FEES_FILL_PROBLEM_TEXT: { "no-local-lodge": "Not filled: not linked." },
}));
vi.mock("@/lib/servernz-version-check", () => ({ readStoredServerVersion: h.storedVersion }));
vi.mock("@/lib/servernz-upload-after-save", () => ({ uploadOtherClubsAfterSave: h.upload }));
vi.mock("@/lib/other-lodge-hide", () => ({ hideUnlistedOtherLodge: h.hide }));

import { GET as getCentralLink, PUT as putCentralLink } from "@/app/api/admin/lodges/[id]/central-lodge/route";
import { GET as getRosterSettings } from "@/app/api/admin/lodges/[id]/roster-settings/route";
import { PATCH as patchLodge } from "@/app/api/admin/lodges/[id]/route";
import { GET as listLodges, POST as createLodge } from "@/app/api/admin/lodges/route";
import { GET as getLodgeSettings, PUT as putLodgeSettings } from "@/app/api/admin/lodge-settings/route";
import { POST as hideOtherLodge } from "@/app/api/admin/other-lodges/[id]/hide/route";
import { PATCH as patchOtherLodge } from "@/app/api/admin/other-lodges/[id]/route";
import { GET as listOtherLodges } from "@/app/api/admin/other-lodges/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { findMcpAction, mcpActionInputSchema, splitMcpActionArguments } from "@/lib/mcp/catalogue";
import { LODGE_SETUP_MCP_ACTIONS } from "@/lib/mcp/catalogue/lodge-setup";

/** What the browser receives: the fixture after a JSON round trip. */
function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

const STAMP = new Date("2026-05-01T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession() });
  // Interactive transactions run against the same doubles.
  h.prisma.$transaction.mockImplementation(async (fn: (tx: typeof h.prisma) => unknown) => fn(h.prisma));
  h.prisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  h.createAuditLog.mockResolvedValue(undefined);
  h.clubToday.mockResolvedValue(new Date("2026-07-01T00:00:00.000Z"));
  h.deactivationRefusal.mockResolvedValue(null);
  h.slug.mockResolvedValue("whakapapa-lodge");
});

describe("the lodge setup entries", () => {
  it("are officer actions: reads for GET, destructive otherwise, none core", () => {
    for (const action of LODGE_SETUP_MCP_ACTIONS) {
      expect(action.summary.startsWith("Officer: "), action.id).toBe(true);
      expect(action.kind, action.id).toBe(action.method === "GET" ? "read" : "destructive");
      expect(action.core, action.id).toBe(false);
    }
  });

  it("never offers or answers a door code", () => {
    for (const action of LODGE_SETUP_MCP_ACTIONS) {
      expect(Object.keys(mcpActionInputSchema(action).shape), action.id).not.toContain("doorCode");
      expect(JSON.stringify(action.returns), action.id).not.toContain("doorCode");
    }
    // A door code the app sends anyway never reaches the route.
    for (const id of ["create_lodge", "update_lodge"]) {
      const { body } = splitMcpActionArguments(findMcpAction(id)!, { id: "lodge-1", name: "Lodge", doorCode: "4321" });
      expect(body, id).not.toHaveProperty("doorCode");
    }
  });

  it("never lets an app replace the booking officer's contact details it is never shown", () => {
    const action = findMcpAction("update_other_lodge")!;
    const offered = Object.keys(mcpActionInputSchema(action).shape);
    expect(offered).not.toContain("bookingOfficerEmail");
    expect(offered).not.toContain("bookingOfficerPhone");
    expect(JSON.stringify(action.returns)).not.toMatch(/bookingOfficer(Email|Phone)/);
    // Sent anyway, they never reach the route (which publishes them to every club).
    const { body } = splitMcpActionArguments(action, {
      id: "other-1",
      bookingOfficerEmail: "attacker@example.test",
      bookingOfficerPhone: "000",
    });
    expect(body).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Lodges
// ---------------------------------------------------------------------------

function lodgeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "lodge-1",
    name: "Whakapapa Lodge",
    slug: "whakapapa-lodge",
    active: true,
    address: "1 Bruce Road",
    doorCode: "4321",
    travelNote: "Chains required in winter.",
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

const PROJECTED_LODGE = {
  id: "lodge-1",
  name: "Whakapapa Lodge",
  slug: "whakapapa-lodge",
  active: true,
  address: "1 Bruce Road",
  travelNote: "Chains required in winter.",
};

describe("list_lodges_for_officers", () => {
  it("sends a connection every lodge without the door code; the browser keeps it", async () => {
    h.prisma.lodge.findMany.mockResolvedValue([lodgeRow()]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_lodges_for_officers",
      handler: listLodges,
    });

    expect(connection).toEqual({ lodges: [PROJECTED_LODGE] });
    expect(browser).toEqual({ lodges: [asJson({ ...lodgeRow() })] });
    expect(JSON.stringify(connection)).not.toContain("4321");
  });
});

describe("create_lodge", () => {
  it("creates the lodge with its settings row, sets no door code, and answers it", async () => {
    h.prisma.lodge.create.mockResolvedValue(lodgeRow({ doorCode: null }));

    const { connection, browser } = await expectActionContract({
      actionId: "create_lodge",
      handler: createLodge,
      args: { name: "Whakapapa Lodge", address: "1 Bruce Road", travelNote: "Chains required in winter.", capacity: 30 },
    });

    expect(h.prisma.lodge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Whakapapa Lodge", slug: "whakapapa-lodge", doorCode: null }),
      }),
    );
    expect(h.createLodgeSettings).toHaveBeenCalledWith(h.prisma, {
      lodgeId: "lodge-1",
      capacity: 30,
      updatedByMemberId: "officer-1",
    });
    expect(connection).toEqual({ lodge: PROJECTED_LODGE });
    expect(browser).toEqual({ lodge: asJson(lodgeRow({ doorCode: null })) });
  });
});

describe("update_lodge", () => {
  it("changes the lodge under the locks and answers it without the door code", async () => {
    h.prisma.lodge.findUnique.mockResolvedValue(lodgeRow());
    h.prisma.lodge.update.mockResolvedValue(lodgeRow({ travelNote: "Road open." }));

    const { connection, browser } = await expectActionContract({
      actionId: "update_lodge",
      handler: patchLodge,
      args: { id: "lodge-1", travelNote: "Road open." },
    });

    expect(h.capacityLock).toHaveBeenCalledWith(h.prisma, "lodge-1");
    expect(h.prisma.lodge.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "lodge-1" }, data: { travelNote: "Road open." } }),
    );
    expect(connection).toEqual({ lodge: { ...PROJECTED_LODGE, travelNote: "Road open." } });
    expect(browser).toEqual({ lodge: asJson(lodgeRow({ travelNote: "Road open." })) });
  });
});

// ---------------------------------------------------------------------------
// Central-server link
// ---------------------------------------------------------------------------

const OWNED = [{ id: "c-1", name: "Whakapapa Lodge" }];

function centralLinkMocks() {
  h.prisma.lodge.findUnique.mockResolvedValue({
    id: "lodge-1",
    name: "Whakapapa Lodge",
    active: true,
    centralLodgeId: "c-1",
  });
  h.serverNzSettings.mockResolvedValue({ otherLodgesOwnedLodges: OWNED, otherLodgesEnabled: true });
  h.credential.mockResolvedValue("push-secret-value");
  h.centralLinkStatus.mockResolvedValue({ answersFor: "c-1", heldBy: "Old Lodge", suggested: "c-1" });
  h.labelOwnedLodges.mockResolvedValue([{ id: "c-1", name: "Whakapapa Lodge", label: "Whakapapa Lodge" }]);
}

const CENTRAL_LINK = {
  lodgeId: "lodge-1",
  lodgeName: "Whakapapa Lodge",
  lodgeActive: true,
  centralLodgeId: "c-1",
  ownedLodges: [{ id: "c-1", name: "Whakapapa Lodge", label: "Whakapapa Lodge" }],
  answersForCentralLodgeId: "c-1",
  linkHeldBy: "Old Lodge",
  suggestedCentralLodgeId: "c-1",
  otherLodgesEnabled: true,
  registeredWithCentralServer: true,
};

describe("get_lodge_central_link", () => {
  it("answers the link and the owned central lodges, never the push secret", async () => {
    centralLinkMocks();

    const { connection, browser } = await expectActionContract({
      actionId: "get_lodge_central_link",
      handler: getCentralLink,
      args: { id: "lodge-1" },
    });

    expect(connection).toEqual(CENTRAL_LINK);
    expect(browser).toEqual(CENTRAL_LINK);
    expect(JSON.stringify(connection)).not.toContain("push-secret-value");
  });
});

describe("set_lodge_central_link", () => {
  it("saves the link through the one writer and answers it", async () => {
    centralLinkMocks();
    h.saveCentralLodgeLinks.mockResolvedValue({ ok: true, before: [{ lodgeId: "lodge-1", centralLodgeId: null }] });

    const { connection, browser } = await expectActionContract({
      actionId: "set_lodge_central_link",
      handler: putCentralLink,
      args: { id: "lodge-1", centralLodgeId: "c-1" },
    });

    expect(h.saveCentralLodgeLinks).toHaveBeenCalledWith(
      [{ lodgeId: "lodge-1", centralLodgeId: "c-1" }],
      expect.any(Function),
    );
    expect(h.syncFromFees).toHaveBeenCalledWith("central lodge linked", "officer-1");
    expect(connection).toEqual(CENTRAL_LINK);
    expect(browser).toEqual(CENTRAL_LINK);
  });
});

// ---------------------------------------------------------------------------
// Member roster name detail
// ---------------------------------------------------------------------------

describe("get_lodge_roster_settings", () => {
  it("answers the lodge's choice, the default and whether the roster is on", async () => {
    h.prisma.lodge.findUnique.mockResolvedValue({
      id: "lodge-1",
      name: "Whakapapa Lodge",
      rosterNameGranularity: "FIRST_NAME_ONLY",
    });
    h.moduleFlags.mockResolvedValue({ memberLodgeRoster: true });

    const { connection, browser } = await expectActionContract({
      actionId: "get_lodge_roster_settings",
      handler: getRosterSettings,
      args: { id: "lodge-1" },
    });

    expect(connection).toEqual({
      lodgeId: "lodge-1",
      lodgeName: "Whakapapa Lodge",
      rosterNameGranularity: "FIRST_NAME_ONLY",
      defaultRosterNameGranularity: expect.any(String),
      memberLodgeRosterEnabled: true,
    });
    expect(browser).toEqual(connection);
  });
});

// ---------------------------------------------------------------------------
// Lodge settings
// ---------------------------------------------------------------------------

const LODGE_SETTINGS = { capacity: 30, hutLeaderLookaheadDays: 14, schoolGroupSoftCap: 40 };

describe("get_lodge_settings", () => {
  it("answers one lodge's settings with whether it can take bookings", async () => {
    h.prisma.lodge.findUnique.mockResolvedValue({ active: true });
    h.loadLodgeSettings.mockResolvedValue(LODGE_SETTINGS);
    h.capacityStatus.mockResolvedValue({ capacity: 30 });

    const { connection, browser } = await expectActionContract({
      actionId: "get_lodge_settings",
      handler: getLodgeSettings,
      args: { lodgeId: "lodge-1" },
    });

    expect(h.loadLodgeSettings).toHaveBeenCalledWith(h.prisma, "lodge-1");
    expect(connection).toEqual({
      ...LODGE_SETTINGS,
      clubConfigCapacity: expect.any(Number),
      setUpForBookings: true,
      resolvedCapacity: 30,
    });
    expect(browser).toEqual(connection);
  });

  it("reads the club-wide row without a lodge, as the browser always has", async () => {
    h.loadLodgeSettings.mockResolvedValue(LODGE_SETTINGS);

    const { connection, browser } = await expectActionContract({
      actionId: "get_lodge_settings",
      handler: getLodgeSettings,
      oneOfSeveralAnswers: true,
    });

    expect(h.loadLodgeSettings).toHaveBeenCalledWith(h.prisma, null);
    expect(h.capacityStatus).not.toHaveBeenCalled();
    expect(connection).toEqual({ ...LODGE_SETTINGS, clubConfigCapacity: expect.any(Number) });
    expect(browser).toEqual(connection);
  });
});

describe("update_lodge_settings", () => {
  it("saves the lodge's capacity as the officer and answers the saved settings", async () => {
    h.prisma.lodge.findUnique.mockResolvedValue({ active: true });
    h.loadLodgeSettings.mockResolvedValue(LODGE_SETTINGS);
    h.updateLodgeSettings.mockResolvedValue({ ...LODGE_SETTINGS, capacity: 32 });

    const { connection, browser } = await expectActionContract({
      actionId: "update_lodge_settings",
      handler: putLodgeSettings,
      args: { lodgeId: "lodge-1", capacity: 32 },
    });

    expect(h.updateLodgeSettings).toHaveBeenCalledWith({
      capacity: 32,
      hutLeaderLookaheadDays: 14,
      schoolGroupSoftCap: 40,
      updatedByMemberId: "officer-1",
      lodgeId: "lodge-1",
    });
    expect(connection).toEqual({ ...LODGE_SETTINGS, capacity: 32, clubConfigCapacity: expect.any(Number) });
    expect(browser).toEqual(connection);
  });
});

// ---------------------------------------------------------------------------
// Other lodges
// ---------------------------------------------------------------------------

function otherLodgeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ol-1",
    name: "Our Lodge",
    centralId: "c-1",
    ratesFromFees: false,
    location: "Whakapapa",
    bookingOfficerName: "Jo Officer",
    bookingOfficerEmail: "jo@example.com",
    bookingOfficerPhone: "021 555 0000",
    siteUrl: "https://our-lodge.test",
    cancellationPeriod: "7 days",
    bedCapacity: 40,
    doubleBeds: 2,
    singleBeds: 36,
    minutesWalkToLodge: 5,
    roomType: "DORMITORY",
    requiresLodgeCustodian: false,
    freeWifi: true,
    quietRoom: false,
    dryingRoom: true,
    sharedKitchen: true,
    wheelchairAccessible: false,
    breakfastIncluded: false,
    lunchIncluded: false,
    dinnerIncluded: false,
    skiWorkshopArea: true,
    gamesRoom: false,
    // `@db.Date` columns read back as UTC midnight.
    winterSeasonStart: new Date("2026-06-01T00:00:00.000Z"),
    winterSeasonEnd: new Date("2026-10-01T00:00:00.000Z"),
    summerSeasonStart: new Date("2026-12-01T00:00:00.000Z"),
    summerSeasonEnd: new Date("2027-03-31T00:00:00.000Z"),
    winterRateUnder5Cents: 0,
    winterRate5To11Cents: 2500,
    winterRate12To17Cents: 3500,
    winterRateAdultCents: 5000,
    summerRateUnder5Cents: 0,
    summerRate5To11Cents: 2000,
    summerRate12To17Cents: 3000,
    summerRateAdultCents: 4000,
    amenities: [{ name: "Sauna", description: "Wood fired" }],
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

const PROJECTED_OTHER_LODGE_DATA = {
  name: "Our Lodge",
  location: "Whakapapa",
  bookingOfficerName: "Jo Officer",
  siteUrl: "https://our-lodge.test",
  cancellationPeriod: "7 days",
  bedCapacity: 40,
  doubleBeds: 2,
  singleBeds: 36,
  minutesWalkToLodge: 5,
  roomType: "DORMITORY",
  requiresLodgeCustodian: false,
  freeWifi: true,
  quietRoom: false,
  dryingRoom: true,
  sharedKitchen: true,
  wheelchairAccessible: false,
  breakfastIncluded: false,
  lunchIncluded: false,
  dinnerIncluded: false,
  skiWorkshopArea: true,
  gamesRoom: false,
  winterSeasonStart: "2026-06-01",
  winterSeasonEnd: "2026-10-01",
  summerSeasonStart: "2026-12-01",
  summerSeasonEnd: "2027-03-31",
  winterRateUnder5Cents: 0,
  winterRate5To11Cents: 2500,
  winterRate12To17Cents: 3500,
  winterRateAdultCents: 5000,
  summerRateUnder5Cents: 0,
  summerRate5To11Cents: 2000,
  summerRate12To17Cents: 3000,
  summerRateAdultCents: 4000,
  amenities: [{ name: "Sauna", description: "Wood fired" }],
};

describe("list_other_lodges", () => {
  beforeEach(() => {
    h.storedVersion.mockResolvedValue({ status: "match" });
  });

  it("answers the club's own row with its Fees problem, without the officer's email or phone", async () => {
    h.prisma.otherLodge.findMany.mockResolvedValue([otherLodgeRow()]);
    h.serverNzSettings.mockResolvedValue({ otherLodgesOwnedLodges: OWNED, otherLodgesKeyedAt: null });
    h.feesProblem.mockResolvedValue("Not filled: not linked.");

    const { connection, browser } = await expectActionContract({
      actionId: "list_other_lodges",
      handler: listOtherLodges,
      oneOfSeveralAnswers: true,
    });

    expect(connection).toEqual({
      otherLodges: [
        {
          id: "ol-1",
          ...PROJECTED_OTHER_LODGE_DATA,
          owned: true,
          renamable: true,
          ratesFromFees: false,
          feesProblem: "Not filled: not linked.",
        },
      ],
      ownedLodgeNames: ["Whakapapa Lodge"],
      serverVersionStatus: "match",
    });
    expect(JSON.stringify(connection)).not.toMatch(/jo@example\.com|021 555 0000/);
    expect(browser).toMatchObject({
      otherLodges: [{ bookingOfficerEmail: "jo@example.com", bookingOfficerPhone: "021 555 0000" }],
    });
  });

  it("answers a row the server no longer lists with what still cites it", async () => {
    h.prisma.otherLodge.findMany
      .mockResolvedValueOnce([otherLodgeRow({ id: "ol-2", centralId: null })])
      .mockResolvedValueOnce([{ id: "ol-2", _count: { bookings: 2, bookingRequests: 1 } }])
      .mockResolvedValueOnce([otherLodgeRow({ id: "ol-2", centralId: null })])
      .mockResolvedValueOnce([{ id: "ol-2", _count: { bookings: 2, bookingRequests: 1 } }]);
    h.serverNzSettings.mockResolvedValue({
      otherLodgesOwnedLodges: OWNED,
      otherLodgesKeyedAt: "2026-06-01T00:00:00.000Z",
    });

    const { connection, browser } = await expectActionContract({
      actionId: "list_other_lodges",
      handler: listOtherLodges,
      oneOfSeveralAnswers: true,
    });

    expect(connection).toEqual({
      otherLodges: [
        {
          id: "ol-2",
          ...PROJECTED_OTHER_LODGE_DATA,
          owned: false,
          renamable: false,
          notOnCentralServer: { bookings: 2, bookingRequests: 1 },
        },
      ],
      ownedLodgeNames: ["Whakapapa Lodge"],
      serverVersionStatus: "match",
    });
    expect(JSON.stringify(connection)).not.toContain("jo@example.com");
    expect(browser).toMatchObject({ otherLodges: [{ bookingOfficerEmail: "jo@example.com" }] });
  });
});

describe("update_other_lodge", () => {
  it("saves the club's own row, uploads it, and answers the row without contact details", async () => {
    h.serverNzSettings.mockResolvedValue({ otherLodgesOwnedLodges: OWNED });
    h.prisma.otherLodge.findFirst.mockResolvedValue(otherLodgeRow());
    h.prisma.otherLodge.update.mockResolvedValue(otherLodgeRow({ location: "Whakapapa Village" }));
    h.upload.mockResolvedValue({ status: "uploaded", sent: 1, accepted: 1 });

    const { connection, browser } = await expectActionContract({
      actionId: "update_other_lodge",
      handler: patchOtherLodge,
      args: { id: "ol-1", location: "Whakapapa Village" },
      oneOfSeveralAnswers: true,
    });

    expect(h.prisma.otherLodge.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ol-1" }, data: { location: "Whakapapa Village" } }),
    );
    expect(connection).toEqual({
      otherLodge: {
        id: "ol-1",
        ...PROJECTED_OTHER_LODGE_DATA,
        location: "Whakapapa Village",
        owned: true,
        renamable: true,
        ratesFromFees: false,
      },
      upload: { status: "uploaded", sent: 1, accepted: 1 },
    });
    expect(browser).toMatchObject({
      otherLodge: { bookingOfficerEmail: "jo@example.com", bookingOfficerPhone: "021 555 0000" },
      upload: { status: "uploaded" },
    });
  });
});

describe("hide_other_lodge", () => {
  it("hides the unlisted row, audits it and answers ok", async () => {
    h.hide.mockResolvedValue({ ok: true, hidden: { id: "ol-2", name: "Old Lodge" } });

    const { connection, browser } = await expectActionContract({
      actionId: "hide_other_lodge",
      handler: hideOtherLodge,
      args: { id: "ol-2" },
    });

    expect(h.hide).toHaveBeenCalledWith("ol-2");
    expect(h.prisma.auditLog.create).toHaveBeenCalled();
    expect(connection).toEqual({ ok: true });
    expect(browser).toEqual({ ok: true });
  });
});
