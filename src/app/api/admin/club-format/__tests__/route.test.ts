import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  The club currency and locale maintenance API (#3563, stage 1 of programme
  #3205; INV-CONFIG-006), proved against the REAL authorisation guard. Since
  #3596 the two verbs carry DIFFERENT gates — any admitted admin reads, only a
  Full Admin writes — and the matrix below proves each verb against each kind
  of caller.

  THIS FILE DELIBERATELY DOES NOT MOCK `@/lib/session-guards`, for the reason
  the club-timezone route's test records: a mocked `requireAdmin` cannot tell
  `{ permission: false }` (Full Admin only) from an omitted `permission` (infer
  `support` from the path) or from `"any-admin"` (anybody admitted to the admin
  portal) — the mock answers whatever the
  test told it to, so all three gates look identical and the test passes against
  every one. PR #2885 shipped exactly that mistake: 17/17 green, and the 403 it
  existed to remove was still there. So everything below runs the real
  `requireAdmin`, the real `inferAdminAccessRequirement`, the real
  `getAdminRouteRequirement` and the real permission matrix.

  The headers are the ones `src/proxy.ts` really stamps on this route — its
  matcher carries `/api/admin/:path*` — which is what makes the inference path
  live here rather than hypothetical. The audit builder is the REAL one too, so
  `assertCanonicalAuditCategory` and `sanitizeAuditMetadata` run over the row
  this route writes rather than over a stand-in.
*/

const h = vi.hoisted(() => {
  const delegates = [
    "clubFormatSettings",
    "auditLog",
    "aiSpendCurrencySettings",
    "member",
    "booking",
    "payment",
    "paymentTransaction",
    "memberCredit",
    "subscription",
    "clubTimeSettings",
    "lodge",
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
   * The recording is the point: "changing the currency rewrites no stored
   * amount" is only a test if something FAILS when the transaction writes to a
   * payment, so the tx double carries a spy for every delegate a careless
   * writer might reach for and the assertion is over the whole recorded set
   * rather than over a handful of hand-picked `not.toHaveBeenCalled()` lines.
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
    // The second parameter is declared so the isolation option this route
    // passes is RECORDED. Without it `mock.calls[0][1]` does not typecheck and
    // the "Serializable" assertion below could not be written at all.
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
    requestMethod: { value: "GET" },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
// #3566: a saved change re-primes the email seam's cached locale after commit.
const primeEmail = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/email-templates-club-time", () => ({
  primeEmailClubTimeZone: primeEmail,
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      "x-pathname": "/api/admin/club-format",
      "x-request-method": h.requestMethod.value,
    }),
}));

import { GET, PUT } from "@/app/api/admin/club-format/route";

const ACTOR = "member-full-admin";
const CHANGED_AT = new Date("2026-06-30T21:30:00.000Z");

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

function guardMemberWith(accessRoles: unknown[]) {
  return {
    active: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
    accessRoles,
  };
}

/**
 * `member.findUnique` serves TWO readers — the guard (which selects
 * `accessRoles`) and the route's "who changed it" lookup (which selects only
 * the name fields) — so the double discriminates on the select it was handed.
 */
function setGuardMember(row: unknown) {
  h.root.behaviour.set("member.findUnique", (args) => {
    const select = (args as { select?: Record<string, unknown> }).select ?? {};
    if ("accessRoles" in select) return row;
    return { firstName: "Ada", lastName: "Lovelace" };
  });
}

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
 * can build any grid they like on the Access Roles screen — including every
 * area at `edit` — and none of those grids is Full Admin, because Full Admin is
 * the protected `ADMIN` role and not a level in the grid.
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

/**
 * A signed-in MEMBER with no admin standing at all — the plain `USER` role, the
 * way an ordinary club member's session looks.
 */
function signInAsMember() {
  h.auth.mockResolvedValue({
    user: { id: "member-plain", role: "USER", accessRoles: ["USER"] },
  });
  setGuardMember(
    guardMemberWith([
      { role: "USER", roleDefinitionId: null, roleDefinition: null },
    ]),
  );
}

function setPersisted(row: unknown) {
  h.root.behaviour.set("clubFormatSettings.findUnique", () => row);
  h.tx.behaviour.set("clubFormatSettings.findUnique", () => row);
}

const PERSISTED_ROW = {
  currencyCode: "NZD",
  locale: "en-NZ",
  updatedByMemberId: "member-previous",
  updatedAt: CHANGED_AT,
};

function put(body: unknown, raw?: string) {
  h.requestMethod.value = "PUT";
  return PUT(
    new Request("https://club.example.com/api/admin/club-format", {
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

function txDelegatesTouched(): string[] {
  return [...new Set(h.tx.touched.map((entry) => entry.split(".")[0]))].sort();
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
  process.env.CURRENCY = "AUD";
  process.env.LOCALE = "en-AU";
  delete process.env.NEXT_PUBLIC_CURRENCY;
  delete process.env.NEXT_PUBLIC_LOCALE;
  signInAsFullAdmin();
  setPersisted(PERSISTED_ROW);
  h.tx.behaviour.set("clubFormatSettings.upsert", (args) => {
    const data = (args as { create: { currencyCode: string; locale: string } })
      .create;
    return {
      currencyCode: data.currencyCode,
      locale: data.locale,
      updatedByMemberId: ACTOR,
      updatedAt: CHANGED_AT,
    };
  });
});

/*
  THE ACCESS MATRIX (#3596): four callers x two verbs, each cell a real request
  through the real guard. The decision is "any admin may view the club's
  currency and locale; only a Full Admin may change them", so the non-Full-Admin
  admin is the row that matters — it is the one cell where the two verbs must
  disagree. The grid chosen for it is the SHIPPED "Finance Viewer" shape
  (finance at view, every other area none): the narrowest admin standing there
  is, holding neither `support` (the area this path resolves to, so an omitted
  `permission` would refuse it the read) nor `overview`.
*/
const VALID_CHANGE = { currencyCode: "CHF", locale: "de-CH", confirmed: true };

describe("who may read and who may change (#3596)", () => {
  it("a Full Admin: reads 200, changes 200", async () => {
    expect((await get()).status).toBe(200);
    expect((await put(VALID_CHANGE)).status).toBe(200);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("an admin who is not a Full Admin: reads 200 with the values, changes 403", async () => {
    signInWithGrid({ financeLevel: "VIEW" });
    const read = await get();
    expect(read.status).toBe(200);
    const body = (await read.json()) as { state: Record<string, unknown> };
    expect(body.state.currencyCode).toBe("NZD");
    expect(body.state.locale).toBe("en-NZ");

    expect((await put(VALID_CHANGE)).status).toBe(403);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("a member with no admin standing: reads 403, changes 403", async () => {
    signInAsMember();
    expect((await get()).status).toBe(403);
    expect((await put(VALID_CHANGE)).status).toBe(403);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("a signed-out caller: reads 401, changes 401", async () => {
    h.auth.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect((await put(VALID_CHANGE)).status).toBe(401);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("an admin holding every area at edit: reads 200, still cannot change", async () => {
    // Every area at `edit` is still not Full Admin — Full Admin is the
    // protected `ADMIN` role, not a level in the grid — so the write refuses
    // them exactly as it refuses the finance viewer above.
    signInWithGrid({
      overviewLevel: "EDIT",
      bookingsLevel: "EDIT",
      membershipLevel: "EDIT",
      financeLevel: "EDIT",
      lodgeLevel: "EDIT",
      contentLevel: "EDIT",
      supportLevel: "EDIT",
    });
    expect((await get()).status).toBe(200);
    expect((await put(VALID_CHANGE)).status).toBe(403);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/club-format — the read", () => {
  it("answers a Full Admin with the persisted pair, its provenance and who set it", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: {
        currencyCode: "NZD",
        locale: "en-NZ",
        currencySource: "persisted",
        localeSource: "persisted",
        updatedAt: CHANGED_AT.toISOString(),
        updatedByName: "Ada Lovelace",
        unusableStoredCurrency: null,
        unusableStoredLocale: null,
      },
    });
  });

  it("reports the environment when nothing is persisted", async () => {
    setPersisted(null);
    const response = await get();
    expect(await response.json()).toEqual({
      state: {
        currencyCode: "AUD",
        locale: "en-AU",
        currencySource: "environment",
        localeSource: "environment",
        updatedAt: null,
        updatedByName: null,
        unusableStoredCurrency: null,
        unusableStoredLocale: null,
      },
    });
  });

  it("names an unusable stored value rather than calling it 'from the environment'", async () => {
    /*
      A row whose value does not validate is NOT the same state as no row: the
      boot backfill's presence check is row-level, so the bad row counts as
      present and a restart will never repair it. Reporting it as "from the
      environment" tells the reader that restarting will record it, which
      cannot work — the defect #2989's review found on the timezone's identical
      shape. It must also NAME the value, because "the stored currency is not
      usable" is unactionable without saying which one.
    */
    setPersisted({ ...PERSISTED_ROW, currencyCode: "!!" });
    const body = (await (await get()).json()) as {
      state: Record<string, unknown>;
    };
    expect(body.state.currencySource).toBe("persisted-unusable");
    expect(body.state.unusableStoredCurrency).toBe("!!");
    // The value in force is the fallback, never the unusable text.
    expect(body.state.currencyCode).toBe("AUD");
    // And the good half of the row is untouched.
    expect(body.state.localeSource).toBe("persisted");
    expect(body.state.locale).toBe("en-NZ");
  });

});

describe("PUT /api/admin/club-format — the write", () => {
  it("refuses a support editor, who the path map alone would admit", async () => {
    signInWithGrid({ supportLevel: "EDIT" });
    expect(
      (await put({ currencyCode: "CHF", locale: "de-CH", confirmed: true }))
        .status,
    ).toBe(403);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses an unconfirmed change, so the checkbox is not a UI-only gate", async () => {
    const response = await put({ currencyCode: "CHF", locale: "de-CH" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /has to be confirmed/i,
    );
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses an invalid currency, and says what one looks like", async () => {
    const response = await put({
      currencyCode: "dollars",
      locale: "de-CH",
      confirmed: true,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /three-letter currency code/i,
    );
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses an invalid locale BEFORE writing the valid currency beside it", async () => {
    // A save that stored one field and refused the other would leave the
    // operator looking at a half-applied form with no way to tell which landed.
    const response = await put({
      currencyCode: "CHF",
      locale: "English",
      confirmed: true,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /language tag/i,
    );
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses an unknown key rather than ignoring it", async () => {
    expect(
      (
        await put({
          currencyCode: "CHF",
          locale: "de-CH",
          confirmed: true,
          stripeCurrency: "usd",
        })
      ).status,
    ).toBe(400);
  });

  it("saves a change, canonicalising what it stores", async () => {
    const response = await put({
      currencyCode: "chf",
      locale: "DE-ch",
      confirmed: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      changed: true,
      state: {
        currencyCode: "CHF",
        locale: "de-CH",
        currencySource: "persisted",
        localeSource: "persisted",
        updatedAt: CHANGED_AT.toISOString(),
        updatedByName: "Ada Lovelace",
        unusableStoredCurrency: null,
        unusableStoredLocale: null,
      },
    });
    const upsert = h.tx.client.clubFormatSettings.upsert as ReturnType<
      typeof vi.fn
    >;
    expect(upsert.mock.calls[0][0]).toMatchObject({
      where: { id: "default" },
      update: {
        currencyCode: "CHF",
        locale: "de-CH",
        updatedByMemberId: ACTOR,
      },
    });
  });

  it("runs Serializable, because the recorded BEFORE value has to be true", async () => {
    await put({ currencyCode: "CHF", locale: "de-CH", confirmed: true });
    expect(h.prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: "Serializable",
    });
  });

  it("writes NOTHING when the pair is already what is stored", async () => {
    // A trail recording changes that never happened is worse than no trail,
    // because the next reader cannot tell the difference.
    const response = await put({
      currencyCode: "NZD",
      locale: "en-NZ",
      confirmed: true,
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { changed: boolean }).changed).toBe(
      false,
    );
    expect(
      h.tx.client.clubFormatSettings.upsert as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
    expect(
      h.tx.client.auditLog.create as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
  });

  it("touches EXACTLY the three tables it names, so no stored amount can be rewritten", async () => {
    /*
      THE CONTRACT THIS ROUTE MAKES. Changing the club's currency re-denominates
      nothing: every amount stays the integer cents it was. A write here
      reaching a payment, a booking or a member would be that promise broken,
      so the assertion is over the whole recorded delegate set rather than over
      a hand-picked list of things not to call. The third table is the AI spend
      rate, which a currency change CLEARS (#3566) — a clear, not a conversion.
    */
    await put({ currencyCode: "CHF", locale: "de-CH", confirmed: true });
    expect(txDelegatesTouched()).toEqual([
      "aiSpendCurrencySettings",
      "auditLog",
      "clubFormatSettings",
    ]);
  });

  it("a locale-only change touches only the two tables, and leaves the AI rate", async () => {
    await put({ currencyCode: "NZD", locale: "en-AU", confirmed: true });
    expect(txDelegatesTouched()).toEqual(["auditLog", "clubFormatSettings"]);
  });

  it("audits the before and after pair, and nothing else", async () => {
    await put({ currencyCode: "CHF", locale: "de-CH", confirmed: true });
    const row = auditedRow();
    expect(row).toMatchObject({
      action: "CLUB_FORMAT_UPDATED",
      category: "admin",
      entityType: "ClubFormatSettings",
      entityId: "default",
    });
    /*
      WHO DID IT, asserted separately because the row above does not cover it
      and the settings row's own `updatedByMemberId` is a DIFFERENT fact that
      happens to hold the same value today (#3563 review). Without this, an
      actor read from `before.updatedByMemberId` -- the plausible copy-paste,
      which names the LAST person to change it rather than this one -- leaves
      every test in this file green. The whole accountability claim for a
      Full-Admin configuration change is that the log names the person, so it
      is asserted where it is made.
    */
    expect(row.actorMemberId).toBe(ACTOR);
    expect(row.severity).toBe("important");
    expect(row.outcome).toBe("success");
    /*
      `toEqual`, NOT `toMatchObject`, and that is the assertion rather than a
      style preference. The rule this pins is "the before and after pair, and
      NOTHING else" — no request echo, no settings blob, nothing about the
      actor beyond the id the row already carries. A partial match is satisfied
      by a payload that also carries the whole parsed request body, which is
      precisely the shape the rule exists to refuse.
    */
    expect(row.metadata).toEqual({
      before: { currencyCode: "NZD", locale: "en-NZ" },
      after: { currencyCode: "CHF", locale: "de-CH" },
    });
  });

  it("records a null BEFORE when nothing was persisted", async () => {
    setPersisted(null);
    await put({ currencyCode: "CHF", locale: "de-CH", confirmed: true });
    expect(auditedRow().metadata).toEqual({
      before: null,
      after: { currencyCode: "CHF", locale: "de-CH" },
    });
  });

  it("answers a serialisation loser 503, not 500, because it wrote nothing", async () => {
    h.prisma.$transaction.mockRejectedValueOnce(
      Object.assign(new Error("could not serialize access"), { code: "P2034" }),
    );
    const response = await put({
      currencyCode: "CHF",
      locale: "de-CH",
      confirmed: true,
    });
    expect(response.status).toBe(503);
  });

  it("rethrows anything that is not contention", async () => {
    h.prisma.$transaction.mockRejectedValueOnce(
      Object.assign(new Error("relation does not exist"), { code: "P2021" }),
    );
    await expect(
      put({ currencyCode: "CHF", locale: "de-CH", confirmed: true }),
    ).rejects.toThrow(/relation does not exist/);
  });
});

/*
  #3566, owner decision 4: a stored AI spend rate is "how many of the club's
  currency one NZ dollar buys" and records no currency, so a currency change
  clears it in this same transaction and records that it did.
*/
describe("PUT /api/admin/club-format — a currency change clears the AI spend rate", () => {
  const STORED_RATE = { clubUnitsPerNzdMicros: 920_000 };

  function auditRows(): Array<Record<string, unknown>> {
    const create = h.tx.client.auditLog.create as ReturnType<typeof vi.fn>;
    return create.mock.calls.map(
      (call) => (call[0] as { data: Record<string, unknown> }).data,
    );
  }

  it("deletes the stored rate and audits the clear beside the currency change", async () => {
    h.tx.behaviour.set("aiSpendCurrencySettings.findUnique", () => STORED_RATE);
    const response = await put({ currencyCode: "CHF", locale: "de-CH", confirmed: true });
    expect(response.status).toBe(200);
    const deleteMany = h.tx.client.aiSpendCurrencySettings.deleteMany as ReturnType<
      typeof vi.fn
    >;
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "default" } });
    const rows = auditRows();
    expect(rows.map((row) => row.action)).toEqual([
      "AI_SPEND_CURRENCY_RATE_CLEARED",
      "CLUB_FORMAT_UPDATED",
    ]);
    expect(rows[0]).toMatchObject({
      category: "admin",
      entityType: "AiSpendCurrencySettings",
      entityId: "default",
      actorMemberId: ACTOR,
    });
    expect(rows[0].metadata).toEqual({
      previousCurrency: "NZD",
      newCurrency: "CHF",
      previousClubUnitsPerNzdMicros: 920_000,
    });
  });

  it("writes no clear and no extra audit row when no rate was stored", async () => {
    await put({ currencyCode: "CHF", locale: "de-CH", confirmed: true });
    expect(
      h.tx.client.aiSpendCurrencySettings.deleteMany as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
    expect(auditRows().map((row) => row.action)).toEqual(["CLUB_FORMAT_UPDATED"]);
  });

  it("leaves the rate alone on a locale-only change", async () => {
    h.tx.behaviour.set("aiSpendCurrencySettings.findUnique", () => STORED_RATE);
    await put({ currencyCode: "NZD", locale: "en-AU", confirmed: true });
    expect(
      h.tx.client.aiSpendCurrencySettings.deleteMany as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
  });

  it("judges the change against the ENVIRONMENT seed when nothing was persisted", async () => {
    // The seed is AUD (pinned in beforeEach). Recording AUD for the first time
    // is not a currency change, so a rate set against it survives.
    setPersisted(null);
    h.tx.behaviour.set("aiSpendCurrencySettings.findUnique", () => STORED_RATE);
    await put({ currencyCode: "AUD", locale: "en-AU", confirmed: true });
    expect(
      h.tx.client.aiSpendCurrencySettings.deleteMany as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
    // And a first save of a DIFFERENT currency does clear it.
    await put({ currencyCode: "CHF", locale: "de-CH", confirmed: true });
    expect(
      h.tx.client.aiSpendCurrencySettings.deleteMany as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledTimes(1);
  });
});

describe("PUT /api/admin/club-format — emails follow a change at once (#3566)", () => {
  it("re-primes the email cache AFTER the transaction commits, on a real change", async () => {
    const response = await put({ currencyCode: "CHF", locale: "de-CH", confirmed: true });
    expect(response.status).toBe(200);
    expect(primeEmail).toHaveBeenCalledTimes(1);
    // After the transaction, never inside it: a read on the module client under
    // the Serializable transaction would be a second connection mid-save.
    expect(primeEmail.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.prisma.$transaction.mock.invocationCallOrder[0],
    );
    const auditCreate = h.tx.client.auditLog.create as ReturnType<typeof vi.fn>;
    expect(primeEmail.mock.invocationCallOrder[0]).toBeGreaterThan(
      auditCreate.mock.invocationCallOrder.at(-1) ?? Infinity,
    );
  });

  it("does not re-prime when nothing changed, or when the save lost a race", async () => {
    await put({ currencyCode: "NZD", locale: "en-NZ", confirmed: true });
    expect(primeEmail).not.toHaveBeenCalled();
    h.prisma.$transaction.mockRejectedValueOnce(
      Object.assign(new Error("could not serialize access"), { code: "P2034" }),
    );
    await put({ currencyCode: "CHF", locale: "de-CH", confirmed: true });
    expect(primeEmail).not.toHaveBeenCalled();
  });
});
