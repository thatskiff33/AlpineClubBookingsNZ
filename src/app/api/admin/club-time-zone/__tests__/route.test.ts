import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The club-timezone maintenance API (CT-1, #2989; epic #2988), proved against the
  REAL authorisation guard.

  THIS FILE DELIBERATELY DOES NOT MOCK `@/lib/session-guards`. A mocked
  `requireAdmin` cannot tell `{ permission: false }` (Full Admin only) from an
  omitted `permission` (infer `support` from the path) or from `"any-admin"` —
  the mock answers whatever the test told it to, so every gate looks identical
  and the test passes against all three. PR #2885 shipped exactly that mistake on
  a different route: 17/17 green, and the 403 it existed to remove was still
  there. So everything below runs the real `requireAdmin`, the real
  `inferAdminAccessRequirement`, the real `getAdminRouteRequirement` and the real
  permission matrix, and asserts on the response the route produced. The mutation
  evidence is in the lane report: swapping `permission: false` for an omitted
  `permission` and for `"any-admin"` each reddens the refusal tests below.

  The headers are the ones `src/proxy.ts` really stamps on this route — its
  matcher carries `/api/admin/:path*`, and the proxy sets `x-pathname` and
  `x-request-method` on every request it runs on — which is what makes the
  inference path live here rather than hypothetical.

  The audit builder is the REAL one too, so `assertCanonicalAuditCategory` and
  `sanitizeAuditMetadata` run over the row this route writes rather than over a
  stand-in.
*/

const DELEGATES = [
  "clubTimeSettings",
  "auditLog",
  "member",
  "booking",
  "bookingBedAllocation",
  "payment",
  "memberCredit",
  "waitlistEntry",
  "clubIdentitySettings",
  "lodge",
  "subscription",
  "choreAssignment",
] as const;

const METHODS = [
  "findUnique",
  "findFirst",
  "findMany",
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
] as const;

const h = vi.hoisted(() => {
  const delegates = [
    "clubTimeSettings",
    "auditLog",
    "member",
    "booking",
    "bookingBedAllocation",
    "payment",
    "memberCredit",
    "waitlistEntry",
    "clubIdentitySettings",
    "lodge",
    "subscription",
    "choreAssignment",
  ];
  const methods = [
    "findUnique",
    "findFirst",
    "findMany",
    "create",
    "createMany",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany",
    "count",
    "aggregate",
    "groupBy",
  ];

  /**
   * A Prisma double that RECORDS which delegate and method each call touched.
   *
   * The recording is the point: "changing the timezone rewrites no temporal
   * data" is only a test if something fails when the transaction writes to a
   * booking, so the tx double carries a spy for every delegate a careless writer
   * might reach for, and the assertion is over the whole recorded set rather
   * than over a handful of hand-picked `not.toHaveBeenCalled()` lines.
   */
  function makeClient() {
    const touched: string[] = [];
    const behaviour = new Map<string, (args: unknown) => unknown>();
    const client: Record<string, Record<string, unknown>> = {};
    for (const delegate of delegates) {
      const bag: Record<string, unknown> = {};
      for (const method of methods) {
        bag[method] = vi.fn(async (args: unknown) => {
          touched.push(`${delegate}.${method}`);
          const impl = behaviour.get(`${delegate}.${method}`);
          return impl ? impl(args) : null;
        });
      }
      client[delegate] = bag;
    }
    return { client, touched, behaviour };
  }

  const root = makeClient();
  const tx = makeClient();
  const prisma = {
    ...root.client,
    // The second parameter is declared so the isolation option this route passes
    // is RECORDED. Without it `mock.calls[0][1]` does not typecheck and the
    // "Serializable" assertion below could not be written at all.
    $transaction: vi.fn<
      (
        callback: (client: unknown) => unknown,
        options?: unknown,
      ) => Promise<unknown>
    >(async (callback) => callback(tx.client)),
  };

  return {
    root,
    tx,
    prisma,
    auth: vi.fn(),
    // The verb the proxy would have stamped. Only the MUTANT guards read it —
    // which is exactly why it has to be right.
    requestMethod: { value: "GET" },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      "x-pathname": "/api/admin/club-time-zone",
      "x-request-method": h.requestMethod.value,
    }),
}));

import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import { GET, PUT } from "@/app/api/admin/club-time-zone/route";

const ACTOR = "member-full-admin";
const CHANGED_AT = new Date("2026-06-30T21:30:00.000Z");

const hostTimeZone = captureHostTimeZone();

type Grid = {
  overviewLevel?: "NONE" | "VIEW" | "EDIT";
  bookingsLevel?: "NONE" | "VIEW" | "EDIT";
  membershipLevel?: "NONE" | "VIEW" | "EDIT";
  financeLevel?: "NONE" | "VIEW" | "EDIT";
  lodgeLevel?: "NONE" | "VIEW" | "EDIT";
  contentLevel?: "NONE" | "VIEW" | "EDIT";
  supportLevel?: "NONE" | "VIEW" | "EDIT";
};

const EMPTY_GRID: Required<Grid> = {
  overviewLevel: "NONE",
  bookingsLevel: "NONE",
  membershipLevel: "NONE",
  financeLevel: "NONE",
  lodgeLevel: "NONE",
  contentLevel: "NONE",
  supportLevel: "NONE",
};

/** The member row `requireAdmin` reads, for a given set of access-role rows. */
function guardMemberWith(accessRoles: unknown[]) {
  return {
    active: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
    accessRoles,
  };
}

/** Sign in as the protected Full Admin access role. */
function signInAsFullAdmin() {
  h.auth.mockResolvedValue({
    user: { id: ACTOR, role: "ADMIN", accessRoles: ["ADMIN"] },
  });
  setGuardMember(
    guardMemberWith([
      { role: "ADMIN", roleDefinitionId: null, roleDefinition: null },
    ]),
  );
}

/**
 * Sign in with a CUSTOM access-role grid and NO `ADMIN` token.
 *
 * This is the shape the whole authorisation argument turns on. An administrator
 * can build any grid they like on the Access Roles screen — including every area
 * at `edit` — and none of those grids is Full Admin, because Full Admin is the
 * protected `ADMIN` role and not a level in the grid.
 */
function signInWithGrid(grid: Grid) {
  h.auth.mockResolvedValue({
    user: { id: "member-scoped-admin", role: "ADMIN", accessRoles: [] },
  });
  setGuardMember(
    guardMemberWith([
      {
        role: "ADMIN_CUSTOM",
        roleDefinitionId: "ardef_custom",
        roleDefinition: { ...EMPTY_GRID, ...grid },
      },
    ]),
  );
}

function signedOut() {
  h.auth.mockResolvedValue(null);
}

/**
 * `member.findUnique` serves TWO readers — the guard (which selects
 * `accessRoles`) and the route's "who changed it" lookup (which selects only the
 * name fields) — so the double discriminates on the select it was handed. That
 * also lets the name lookup's projection be asserted directly.
 */
function setGuardMember(row: unknown) {
  h.root.behaviour.set("member.findUnique", (args) => {
    const select = (args as { select?: Record<string, unknown> }).select ?? {};
    if ("accessRoles" in select) return row;
    return { firstName: "Ada", lastName: "Lovelace" };
  });
}

/** What `clubTimeSettings.findUnique` answers, on the root client and in the tx. */
function setPersisted(row: unknown) {
  h.root.behaviour.set("clubTimeSettings.findUnique", () => row);
  h.tx.behaviour.set("clubTimeSettings.findUnique", () => row);
}

const PERSISTED_ROW = {
  timeZone: "Pacific/Auckland",
  updatedByMemberId: "member-previous",
  updatedAt: CHANGED_AT,
};

function put(body: unknown, raw?: string) {
  h.requestMethod.value = "PUT";
  return PUT(
    new Request("https://club.example.com/api/admin/club-time-zone", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "user-agent": "vitest",
        "x-forwarded-for": "203.0.113.7",
      },
      body: raw ?? JSON.stringify(body),
    }),
  );
}

function get() {
  h.requestMethod.value = "GET";
  return GET();
}

/** Every delegate the tx double recorded a call on, de-duplicated. */
function txDelegatesTouched(): string[] {
  return [...new Set(h.tx.touched.map((entry) => entry.split(".")[0]))].sort();
}

function rootDelegatesTouched(): string[] {
  return [...new Set(h.root.touched.map((entry) => entry.split(".")[0]))].sort();
}

/** The single `auditLog.create` argument the tx received. */
function auditedRow(): Record<string, unknown> {
  const create = h.tx.client.auditLog.create as ReturnType<typeof vi.fn>;
  expect(create).toHaveBeenCalledTimes(1);
  return (create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.root.touched.length = 0;
  h.tx.touched.length = 0;
  h.root.behaviour.clear();
  h.tx.behaviour.clear();
  h.prisma.$transaction.mockImplementation(
    async (callback: (client: unknown) => unknown) => callback(h.tx.client),
  );
  // Pinned so the "no row persisted" provenance is the same on every machine.
  process.env.TZ = "Pacific/Auckland";
  signInAsFullAdmin();
  setPersisted(PERSISTED_ROW);
  h.tx.behaviour.set("clubTimeSettings.upsert", (args) => {
    const data = (args as { create: { timeZone: string } }).create;
    return {
      timeZone: data.timeZone,
      updatedByMemberId: ACTOR,
      updatedAt: CHANGED_AT,
    };
  });
});

afterAll(() => {
  hostTimeZone.restore();
});

describe("GET /api/admin/club-time-zone — Full Admin only", () => {
  it("answers a Full Admin with the persisted zone, its provenance and who set it", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: {
        timeZone: "Pacific/Auckland",
        source: "persisted",
        updatedAt: CHANGED_AT.toISOString(),
        updatedByName: "Ada Lovelace",
        unusableStoredValue: null,
      },
    });
  });

  it("reads the environment seed only when nothing is persisted", async () => {
    // The premise leg. A "the database wins" assertion is worthless unless the
    // same file proves the environment read is live in the first place.
    setPersisted(null);
    process.env.TZ = "Pacific/Chatham";

    const response = await get();
    expect(await response.json()).toEqual({
      state: {
        timeZone: "Pacific/Chatham",
        source: "environment",
        updatedAt: null,
        updatedByName: null,
        unusableStoredValue: null,
      },
    });
  });

  it("lets the persisted row beat the environment", async () => {
    process.env.TZ = "Pacific/Chatham";
    const response = await get();
    expect((await response.json()).state).toMatchObject({
      timeZone: "Pacific/Auckland",
      source: "persisted",
    });
  });

  it("reports an unusable stored value as its own state, and names it", async () => {
    /*
      A hand-edit, a bad restore, or an ICU that dropped the zone. The row
      EXISTS, so the boot backfill's row-level presence check will never repair
      it — which is why this cannot be reported as "environment". It was, and the
      panel then told the operator that restarting the app would record it, which
      can never work (#2989 review). The raw stored text travels so the panel can
      NAME it; making it printable is the renderer's job.
    */
    setPersisted({
      timeZone: "NZT",
      updatedByMemberId: "member-previous",
      updatedAt: CHANGED_AT,
    });
    process.env.TZ = "Pacific/Chatham";

    const response = await get();
    expect(await response.json()).toEqual({
      state: {
        // The zone actually in force, never the unusable text.
        timeZone: "Pacific/Chatham",
        source: "persisted-unusable",
        updatedAt: CHANGED_AT.toISOString(),
        updatedByName: "Ada Lovelace",
        unusableStoredValue: "NZT",
      },
    });
  });

  it("never returns the selector's option list, and never the changer's email", async () => {
    const body = await (await get()).text();
    // 418 zones on the payload would be the browser being handed the decision.
    expect(body).not.toContain("Africa/Abidjan");
    expect(body).not.toContain("@");
    const nameRead = (
      h.root.client.member.findUnique as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => call[0] as { select: Record<string, unknown> });
    const projection = nameRead.find((args) => !("accessRoles" in args.select));
    expect(projection?.select).toEqual({ firstName: true, lastName: true });
  });

  it("refuses an anonymous caller with 401 and reads nothing", async () => {
    signedOut();
    const response = await get();
    expect(response.status).toBe(401);
    expect(rootDelegatesTouched()).toEqual([]);
  });

  it("refuses an admin holding support:edit but not Full Admin", async () => {
    signInWithGrid({ overviewLevel: "VIEW", supportLevel: "EDIT" });
    const response = await get();
    expect(response.status).toBe(403);
    // The guard read the member; nothing read or wrote the setting.
    expect(rootDelegatesTouched()).toEqual(["member"]);
  });

  it("refuses an admin holding EVERY area at edit without the ADMIN role", async () => {
    signInWithGrid({
      overviewLevel: "EDIT",
      bookingsLevel: "EDIT",
      membershipLevel: "EDIT",
      financeLevel: "EDIT",
      lodgeLevel: "EDIT",
      contentLevel: "EDIT",
      supportLevel: "EDIT",
    });
    const response = await get();
    expect(response.status).toBe(403);
    expect(rootDelegatesTouched()).toEqual(["member"]);
  });
});

describe("PUT /api/admin/club-time-zone — authorisation", () => {
  const CHANGE = { timeZone: "Pacific/Chatham", confirmed: true };

  it("lets a Full Admin change the zone", async () => {
    const response = await put(CHANGE);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      changed: true,
      state: {
        timeZone: "Pacific/Chatham",
        source: "persisted",
        updatedAt: CHANGED_AT.toISOString(),
        updatedByName: "Ada Lovelace",
        unusableStoredValue: null,
      },
    });
  });

  it.each([
    ["anonymous", 401, () => signedOut()],
    [
      "support:edit without Full Admin",
      403,
      () => signInWithGrid({ overviewLevel: "VIEW", supportLevel: "EDIT" }),
    ],
    [
      "every area at edit without the ADMIN role",
      403,
      () =>
        signInWithGrid({
          overviewLevel: "EDIT",
          bookingsLevel: "EDIT",
          membershipLevel: "EDIT",
          financeLevel: "EDIT",
          lodgeLevel: "EDIT",
          contentLevel: "EDIT",
          supportLevel: "EDIT",
        }),
    ],
  ])("refuses %s with %i, writing no row and no audit row", async (
    _label,
    status,
    signIn,
  ) => {
    signIn();
    const response = await put(CHANGE);
    expect(response.status).toBe(status);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.tx.touched).toEqual([]);
    expect(h.tx.client.clubTimeSettings.upsert).not.toHaveBeenCalled();
    expect(h.tx.client.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("PUT /api/admin/club-time-zone — the confirmation gate", () => {
  it.each([
    ["omitted", { timeZone: "Pacific/Chatham" }],
    ["false", { timeZone: "Pacific/Chatham", confirmed: false }],
  ])("refuses a change with confirmed %s, writing nothing", async (_l, body) => {
    const response = await put(body);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("confirmed");
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.tx.touched).toEqual([]);
  });

  it("refuses an unknown key, so a caller cannot smuggle a field past the schema", async () => {
    const response = await put({
      timeZone: "Pacific/Chatham",
      confirmed: true,
      alsoRewriteBookings: true,
    });
    expect(response.status).toBe(400);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const response = await put(undefined, "not json");
    expect(response.status).toBe(400);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("PUT /api/admin/club-time-zone — what may be stored", () => {
  it.each([
    ["NZT", "an abbreviation"],
    ["EST", "an abbreviation Intl happily widens to America/Panama"],
    ["+12:00", "a fixed offset"],
    ["Etc/GMT+12", "a fixed offset in a spelling Intl accepts"],
    ["", "empty"],
    ["A".repeat(100), "a hundred characters of nothing"],
  ])("refuses %s (%s) with 400 and writes nothing", async (timeZone) => {
    const response = await put({ timeZone, confirmed: true });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Pacific/Auckland");
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.tx.touched).toEqual([]);
  });

  it("stores the runtime's canonical spelling of an accepted alias", async () => {
    const response = await put({ timeZone: "US/Pacific", confirmed: true });
    expect(response.status).toBe(200);
    const upsert = h.tx.client.clubTimeSettings.upsert as ReturnType<
      typeof vi.fn
    >;
    expect(upsert.mock.calls[0][0]).toMatchObject({
      create: { timeZone: "America/Los_Angeles" },
      update: { timeZone: "America/Los_Angeles" },
    });
  });
});

describe("PUT /api/admin/club-time-zone — the audit row", () => {
  it("writes exactly one row carrying the before and after zone and nothing else", async () => {
    await put({ timeZone: "Pacific/Chatham", confirmed: true });
    const row = auditedRow();

    expect(row).toMatchObject({
      action: "CLUB_TIME_ZONE_UPDATED",
      category: "admin",
      severity: "important",
      outcome: "success",
      entityType: "ClubTimeSettings",
      entityId: "default",
      actorMemberId: ACTOR,
      memberId: ACTOR,
      summary: "Club time zone updated",
    });
    // The KEY SET, not merely the two values: a later addition of a settings
    // payload or a request echo has to fail here rather than ride along.
    expect(Object.keys(row.metadata as object).sort()).toEqual([
      "after",
      "before",
    ]);
    expect(row.metadata).toEqual({
      before: "Pacific/Auckland",
      after: "Pacific/Chatham",
    });
    // The request context the writer was told to carry.
    expect(row).toMatchObject({ ipAddress: "203.0.113.7", userAgent: "vitest" });
  });

  it("records before: null when the club had never chosen a zone", async () => {
    setPersisted(null);
    await put({ timeZone: "Pacific/Chatham", confirmed: true });
    expect(auditedRow().metadata).toEqual({
      before: null,
      after: "Pacific/Chatham",
    });
  });

  it("writes NOTHING at all when the stored value is re-saved", async () => {
    const response = await put({
      timeZone: "Pacific/Auckland",
      confirmed: true,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changed: false });
    expect(h.tx.client.clubTimeSettings.upsert).not.toHaveBeenCalled();
    expect(h.tx.client.auditLog.create).not.toHaveBeenCalled();
    // The dirty gate is a READ and nothing else.
    expect(h.tx.touched).toEqual(["clubTimeSettings.findUnique"]);
  });
});

describe("PUT /api/admin/club-time-zone — a concurrent save cannot lie", () => {
  const CHANGE = { timeZone: "Pacific/Chatham", confirmed: true };

  it("runs the read and the write at Serializable isolation", async () => {
    await put(CHANGE);
    /*
      Prisma's default is READ COMMITTED, where `findUnique` takes no row lock.
      Two Full Admins saving at once would then each read Auckland and each write
      — one to Chatham, one to Denver — and the audit trail would claim two
      changes FROM Auckland. "Who changed it, and what was it before" would
      answer wrongly, and the intermediate zone would appear nowhere at all. The
      isolation level is the whole fix, so it is asserted directly rather than
      inferred from the re-read being inside the transaction (it always was, and
      that never stopped this).
    */
    expect(h.prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: "Serializable",
    });
  });

  it.each([
    ["P2034", "the serialisation failure Serializable raises"],
    ["P2028", "an exhausted transaction timeout"],
    ["P2002", "the create arm losing a first-write race"],
  ])("answers %s (%s) with a retryable 503, touching nothing", async (code) => {
    h.prisma.$transaction.mockImplementation(async () => {
      throw Object.assign(new Error("conflict"), { code });
    });

    const response = await put(CHANGE);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("try again");
    expect(h.tx.touched).toEqual([]);
  });

  it("answers 503 when the COMMIT loses the race, after the work has run", async () => {
    // The realistic shape: the callback completes, and the database refuses the
    // commit. The row and the audit row are rolled back together — which a
    // Prisma double cannot demonstrate, so what is asserted is that the caller
    // is never handed a state that would read as a successful save.
    h.prisma.$transaction.mockImplementation(
      async (callback: (client: unknown) => unknown) => {
        await callback(h.tx.client);
        throw Object.assign(new Error("could not serialize access"), {
          code: "P2034",
        });
      },
    );

    const response = await put(CHANGE);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Another update is in progress — try again shortly.",
    });
  });

  it("does not dress a failure that is NOT contention up as one", async () => {
    // A missing table or a broken connection is not "try again shortly", and
    // hiding it behind that message would hide it from whoever has to fix it.
    h.prisma.$transaction.mockImplementation(async () => {
      throw Object.assign(new Error("relation does not exist"), {
        code: "P2021",
      });
    });

    await expect(put(CHANGE)).rejects.toThrow("relation does not exist");
  });
});

describe("PUT /api/admin/club-time-zone — the write touches two tables", () => {
  it("touches ClubTimeSettings and AuditLog, and no other table at all", async () => {
    await put({ timeZone: "Pacific/Chatham", confirmed: true });

    // Changing the club timezone rewrites no historical instant and no
    // date-only value. That is the promise; this is the test of it.
    expect(txDelegatesTouched()).toEqual(["auditLog", "clubTimeSettings"]);
    expect(h.tx.touched.sort()).toEqual([
      "auditLog.create",
      "clubTimeSettings.findUnique",
      "clubTimeSettings.upsert",
    ]);
  });

  it("reaches no delegate outside the guard, the setting and the audit row", async () => {
    await put({ timeZone: "Pacific/Chatham", confirmed: true });

    // On the module client: the guard's member read, the name lookup, and the
    // transaction. Nothing else — no booking, no payment, no member dates.
    expect(rootDelegatesTouched()).toEqual(["member"]);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("enumerates enough delegates for the assertion above to be able to fail", () => {
    // A spy list that had drifted to two entries would make the two tests above
    // vacuous. Keep the double wide.
    expect(DELEGATES.length).toBeGreaterThan(10);
    expect(METHODS).toContain("upsert");
    for (const delegate of DELEGATES) {
      expect(Object.keys(h.tx.client[delegate])).toEqual([...METHODS]);
    }
  });
});
