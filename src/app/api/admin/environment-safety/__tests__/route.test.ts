import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The environment-safety API (ENV-SAFETY 1, #3034; epic #2986), proved against
  the REAL authorisation guard.

  THIS FILE DELIBERATELY DOES NOT MOCK `@/lib/session-guards`. A mocked
  `requireAdmin` cannot tell `{ permission: false }` (Full Admin only) from an
  omitted `permission` (infer `support` from the path) or from `"any-admin"` —
  the mock answers whatever the test told it to, so every gate looks identical
  and the test passes against all three. PR #2885 shipped exactly that mistake
  on a different route: 17/17 green, and the 403 it existed to remove was still
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
  "environmentSafetySettings",
  "auditLog",
  "member",
  "booking",
  "bookingBedAllocation",
  "payment",
  "memberCredit",
  "waitlistEntry",
  "clubIdentitySettings",
  "clubTimeSettings",
  "lodge",
  "subscription",
  "emailMessage",
] as const;

const h = vi.hoisted(() => {
  const delegates = [
    "environmentSafetySettings",
    "auditLog",
    "member",
    "booking",
    "bookingBedAllocation",
    "payment",
    "memberCredit",
    "waitlistEntry",
    "clubIdentitySettings",
    "clubTimeSettings",
    "lodge",
    "subscription",
    "emailMessage",
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
   * The recording is the point: "switching the safer override rewrites no
   * booking, payment or member" is only a test if something FAILS when the
   * transaction writes to one, so the tx double carries a spy for every delegate
   * a careless writer might reach for, and the assertion is over the whole
   * recorded set rather than over a handful of hand-picked
   * `not.toHaveBeenCalled()` lines.
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
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    /** The verb the proxy would have stamped. Only the MUTANT guards read it. */
    requestMethod: { value: "GET" },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/logger", () => ({ default: h.logger }));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      "x-pathname": "/api/admin/environment-safety",
      "x-request-method": h.requestMethod.value,
    }),
}));

import { GET, PATCH } from "@/app/api/admin/environment-safety/route";
import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";

const ACTOR = "member-full-admin";
const CHANGED_AT = new Date("2026-06-15T09:30:00.000Z");

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
 * `accessRoles`) and the "who changed it" lookup (which selects only the name
 * fields) — so the double discriminates on the select it was handed. That also
 * lets the name lookup's projection be asserted directly.
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

/** What `environmentSafetySettings.findUnique` answers, on the root and in the tx. */
function setPersisted(row: unknown) {
  h.root.behaviour.set("environmentSafetySettings.findUnique", () => row);
  h.tx.behaviour.set("environmentSafetySettings.findUnique", () => row);
}

/**
 * Make the ROOT settings read answer DIFFERENTLY on each successive call.
 *
 * A GET does two of them — the resolver's, then the payload builder's display
 * read — and `setPersisted` gives both the same answer, which is exactly why the
 * contradiction below was invisible until somebody read the code (#3034 review).
 * Each entry is one call, in order; the last is reused if more arrive. A thrown
 * value is thrown rather than returned, so an "unreadable then readable" sequence
 * can be expressed.
 */
function setPersistedSequence(...answers: unknown[]) {
  let call = 0;
  h.root.behaviour.set("environmentSafetySettings.findUnique", () => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

function row(forceNonProduction: boolean) {
  return {
    forceNonProduction,
    updatedByMemberId: "member-previous",
    updatedAt: CHANGED_AT,
  };
}

function patch(body: unknown, raw?: string) {
  h.requestMethod.value = "PATCH";
  return PATCH(
    new Request("https://club.example.com/api/admin/environment-safety", {
      method: "PATCH",
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

const savedDeclaration = { value: process.env[ENVIRONMENT_ROLE_ENV_VAR] };

function declare(value: string | undefined) {
  if (value === undefined) delete process.env[ENVIRONMENT_ROLE_ENV_VAR];
  else process.env[ENVIRONMENT_ROLE_ENV_VAR] = value;
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
  declare("production");
  signInAsFullAdmin();
  setPersisted(null);
  h.tx.behaviour.set("environmentSafetySettings.upsert", (args) => {
    const data = (args as { create: { forceNonProduction: boolean } }).create;
    return {
      forceNonProduction: data.forceNonProduction,
      updatedByMemberId: ACTOR,
      updatedAt: CHANGED_AT,
    };
  });
});

afterEach(() => {
  declare(savedDeclaration.value);
});

describe("the double covers the delegates a careless writer would reach for", () => {
  it("has a spy for each, so the two-table assertion cannot be vacuous", () => {
    for (const delegate of DELEGATES) {
      expect(h.tx.client[delegate]).toBeDefined();
      expect(h.tx.client[delegate].update).toBeDefined();
    }
  });
});

describe("GET /api/admin/environment-safety — Full Admin only", () => {
  it("answers a Full Admin with the role, its source and both sources' state", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: {
        role: "PRODUCTION",
        decidedBy: "deployment-declaration",
        declaration: { kind: "production", raw: null },
        override: {
          on: false,
          readable: true,
          updatedAt: null,
          updatedByName: null,
        },
        /*
          NOT COUNTED YET, and typed as its own state rather than as a zero
          (#3034, owner decision 23 Aug 2026). The rows this counts are the
          safety-suppressed email records #3035 creates. A fabricated `count: 0`
          would read as "this copy has held nothing back", which is exactly the
          reassurance an operator must not be given on a live site that has been
          wrongly declared a copy.
        */
        withheldEmail: { available: false },
        /*
          Also its own state rather than a zero, and for the sharper version of
          the same reason (#3036). This counts the Xero contacts a COPY has
          proved can no longer reach a member. `available: false` here means the
          count could not be read at all — usually an unapplied migration —
          while a fabricated `containedContacts: 0` would tell the operator of a
          copy that it has not touched the club's accounting when nobody knows
          whether it has. This double supplies no
          `xeroSandboxContactContainment` delegate, so unreadable is the honest
          answer for it.
        */
        xeroContactContainment: { available: false },
        notes: [expect.stringContaining("APP_ENVIRONMENT_ROLE=production")],
      },
    });
  });

  it("reports an undeclared installation as UNKNOWN, never as production", async () => {
    declare(undefined);
    const state = (await (await get()).json()).state;
    expect(state.role).toBe("UNKNOWN");
    expect(state.decidedBy).toBe("unresolved");
    expect(state.declaration).toEqual({ kind: "absent", raw: null });
  });

  it("NAMES a refused declaration so the operator can see their own typo", async () => {
    declare("staging");
    const state = (await (await get()).json()).state;
    expect(state.role).toBe("UNKNOWN");
    expect(state.declaration).toEqual({ kind: "invalid", raw: "staging" });
  });

  it("reports the override, who set it and when", async () => {
    setPersisted(row(true));
    const state = (await (await get()).json()).state;
    expect(state.role).toBe("NON_PRODUCTION");
    expect(state.decidedBy).toBe("database-safer-override");
    expect(state.override).toEqual({
      on: true,
      readable: true,
      updatedAt: CHANGED_AT.toISOString(),
      updatedByName: "Ada Lovelace",
    });
  });

  it("reports 'who last changed it' even when the override is OFF", async () => {
    // The second read this payload does exists for exactly this: an operator
    // wants to know who switched it off, not only who switched it on.
    setPersisted(row(false));
    const state = (await (await get()).json()).state;
    expect(state.override).toEqual({
      on: false,
      readable: true,
      updatedAt: CHANGED_AT.toISOString(),
      updatedByName: "Ada Lovelace",
    });
  });

  it("distinguishes 'the override is off' from 'we could not ask'", async () => {
    h.root.behaviour.set("environmentSafetySettings.findUnique", () => {
      throw new Error("relation does not exist");
    });
    const state = (await (await get()).json()).state;
    expect(state.role).toBe("UNKNOWN");
    expect(state.override.readable).toBe(false);
    expect(state.override.on).toBe(false);
  });

  /*
    ONE COHERENT ANSWER EVEN WHEN THE TWO READS DISAGREE (#3034 review).

    A GET reads the settings row twice: once through `resolveEnvironmentRole()`,
    which is what every safety decision in the platform is made from, and once in
    `stateFromResolution` for the display fields the resolution deliberately
    omits. An administrator flipping the override between them — or a transient
    database fault on one of them — used to produce a payload that contradicted
    itself, because `on` / `readable` were built from the SECOND read while `role`
    and `decidedBy` came from the first.

    The tests below drive that window directly. The route suite could not see it
    before because `setPersisted` fed both reads the same value.
  */
  it("never says PRODUCTION beside an override that is ON", async () => {
    // Read one: no override, so the declaration decides and the role is
    // PRODUCTION. Read two: an administrator has just switched it on.
    setPersistedSequence(null, row(true));

    const state = (await (await get()).json()).state;

    expect(state.role).toBe("PRODUCTION");
    expect(state.decidedBy).toBe("deployment-declaration");
    // The panel renders these side by side. "Production — the club's live site"
    // above "Safer override: ON" is not a state this installation can be in.
    expect(state.override.on).toBe(false);
  });

  it("never says NON_PRODUCTION beside an override that is OFF", async () => {
    // The mirror image: the resolver saw the override on, the display read saw it
    // off. The role must still be explained by an override the payload admits to.
    setPersistedSequence(row(true), null);

    const state = (await (await get()).json()).state;

    expect(state.role).toBe("NON_PRODUCTION");
    expect(state.decidedBy).toBe("database-safer-override");
    expect(state.override.on).toBe(true);
  });

  it("keeps 'we could not read it' when only the second read succeeded", async () => {
    /*
      The worse-shaped half. A transient failure on read one and a success on read
      two gave `role: UNKNOWN` with `override.readable: true` — so the panel
      dropped its "the setting cannot be read, so it cannot be changed" line and
      re-enabled the Save button, while the notes beside it still said the
      override could not be read.
    */
    setPersistedSequence(new Error("connection reset"), row(false));

    const state = (await (await get()).json()).state;

    expect(state.role).toBe("UNKNOWN");
    expect(state.override.readable).toBe(false);
    expect(state.override.on).toBe(false);
    // And it does not name a last-changed date for a row it has just said it
    // cannot read.
    expect(state.override.updatedAt).toBeNull();
    expect(state.override.updatedByName).toBeNull();
  });

  it("still shows who last changed it when only the display read failed", async () => {
    // The resolution is sound — the override is off — and only the display read
    // failed. That loses the "who and when", never the answer.
    setPersistedSequence(row(false), new Error("connection reset"));

    const state = (await (await get()).json()).state;

    expect(state.role).toBe("PRODUCTION");
    expect(state.override).toEqual({
      on: false,
      readable: true,
      updatedAt: null,
      updatedByName: null,
    });
  });

  it("never returns an email, a connection string or a secret", async () => {
    setPersisted(row(true));
    const body = await (await get()).text();
    expect(body).not.toContain("@");
    expect(body).not.toContain("postgresql://");
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
    // The guard read the member; nothing read the setting.
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
    expect((await get()).status).toBe(403);
  });
});

describe("PATCH — the safer override, confirmed and audited", () => {
  it("refuses an anonymous caller and writes nothing", async () => {
    signedOut();
    const response = await patch({ forceNonProduction: true, confirmed: true });
    expect(response.status).toBe(401);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses an admin holding every area at edit without the ADMIN role", async () => {
    signInWithGrid({
      overviewLevel: "EDIT",
      bookingsLevel: "EDIT",
      membershipLevel: "EDIT",
      financeLevel: "EDIT",
      lodgeLevel: "EDIT",
      contentLevel: "EDIT",
      supportLevel: "EDIT",
    });
    const response = await patch({ forceNonProduction: true, confirmed: true });
    expect(response.status).toBe(403);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses malformed JSON", async () => {
    expect((await patch(undefined, "{")).status).toBe(400);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["an absent confirmation", { forceNonProduction: true }],
    ["an explicit false confirmation", { forceNonProduction: true, confirmed: false }],
  ])("refuses %s server-side, whatever the panel did", async (_label, body) => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("confirmed");
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a body that tries to name a role at all", async () => {
    /*
      `.strict()` is the enforcement. An unknown key must be a 400 and not a
      silently ignored field, because a caller that sent `forceProduction: true`
      and got a 200 would reasonably believe it had been honoured.
    */
    for (const body of [
      { forceNonProduction: false, confirmed: true, role: "PRODUCTION" },
      { forceNonProduction: false, confirmed: true, forceProduction: true },
      { forceNonProduction: false, confirmed: true, isProduction: true },
      { role: "PRODUCTION", confirmed: true },
      { forceProduction: true, confirmed: true },
    ]) {
      const response = await patch(body);
      expect(response.status).toBe(400);
    }
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([["a string", "true"], ["a number", 1], ["null", null]])(
    "refuses a non-boolean forceNonProduction (%s)",
    async (_label, value) => {
      const response = await patch({
        forceNonProduction: value,
        confirmed: true,
      });
      expect(response.status).toBe(400);
    },
  );

  it("switches the override ON, in a Serializable transaction touching two tables", async () => {
    const response = await patch({ forceNonProduction: true, confirmed: true });
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.changed).toBe(true);
    expect(payload.state.role).toBe("NON_PRODUCTION");
    expect(payload.state.decidedBy).toBe("database-safer-override");
    expect(payload.state.override.on).toBe(true);

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: "Serializable",
    });
    // The contract: this setting, and the trail of changing it. Nothing else.
    expect(txDelegatesTouched()).toEqual([
      "auditLog",
      "environmentSafetySettings",
    ]);
  });

  it("audits the change with the actor and the value before and after", async () => {
    setPersisted(row(false));
    await patch({ forceNonProduction: true, confirmed: true });

    const audited = auditedRow();
    expect(audited).toMatchObject({
      action: "ENVIRONMENT_SAFETY_OVERRIDE_UPDATED",
      category: "admin",
      severity: "important",
      actorMemberId: ACTOR,
      entityType: "EnvironmentSafetySettings",
      entityId: "default",
    });
    expect(audited.metadata).toEqual({ before: false, after: true });
  });

  it("audits `before: null` when nothing was stored yet", async () => {
    setPersisted(null);
    await patch({ forceNonProduction: true, confirmed: true });
    expect(auditedRow().metadata).toEqual({ before: null, after: true });
  });

  it("audits the change and the request, and NOT the environment", async () => {
    /*
      The metadata is the before/after flag and nothing else. In particular it
      does NOT copy the deployment declaration: that is configuration the
      resolver reads live, and a snapshot of it in an audit row would be a second
      stale authority for exactly the question this epic exists to settle.

      The request CONTEXT (ip, user agent) is a different thing and is meant to be
      there — it is `getAuditRequestContext`, the house shape every audited admin
      write uses to say who made the request from where.
    */
    declare("production");
    setPersisted(null);
    await patch({ forceNonProduction: true, confirmed: true });

    const audited = auditedRow();
    expect(audited.metadata).toEqual({ before: null, after: true });
    expect(JSON.stringify(audited.metadata)).not.toContain(
      "APP_ENVIRONMENT_ROLE",
    );
    expect(JSON.stringify(audited.metadata)).not.toContain("production");
    // Request provenance, deliberately present.
    expect(audited).toMatchObject({
      ipAddress: "203.0.113.7",
      userAgent: "vitest",
    });
  });

  it("switching the override OFF is equally privileged and equally audited", async () => {
    setPersisted(row(true));
    const response = await patch({
      forceNonProduction: false,
      confirmed: true,
    });
    expect(response.status).toBe(200);
    expect(auditedRow().metadata).toEqual({ before: true, after: false });
  });

  it("switching the override OFF is NOT an elevation — an undeclared install goes to UNKNOWN", async () => {
    /*
      The property the whole safer-only rule rests on. With the override off the
      DEPLOYMENT decides, and a deployment that declares nothing gives UNKNOWN.
      Nothing an administrator can do through this route makes an installation
      claim to be production.
    */
    declare(undefined);
    setPersisted(row(true));
    const payload = await (
      await patch({ forceNonProduction: false, confirmed: true })
    ).json();
    expect(payload.state.role).toBe("UNKNOWN");
    expect(payload.state.role).not.toBe("PRODUCTION");
    expect(payload.state.decidedBy).toBe("unresolved");
  });

  it("switching the override OFF leaves a declared non-production non-production", async () => {
    declare("non-production");
    setPersisted(row(true));
    const payload = await (
      await patch({ forceNonProduction: false, confirmed: true })
    ).json();
    expect(payload.state.role).toBe("NON_PRODUCTION");
    expect(payload.state.decidedBy).toBe("deployment-declaration");
  });

  it("switching the override OFF restores production only where the deployment says so", async () => {
    declare("production");
    setPersisted(row(true));
    const payload = await (
      await patch({ forceNonProduction: false, confirmed: true })
    ).json();
    expect(payload.state.role).toBe("PRODUCTION");
    expect(payload.state.decidedBy).toBe("deployment-declaration");
  });

  it("writes nothing at all when the stored value already matches", async () => {
    setPersisted(row(true));
    const response = await patch({ forceNonProduction: true, confirmed: true });
    expect(response.status).toBe(200);
    expect((await response.json()).changed).toBe(false);
    // No upsert, and — the point of the dirty gate — no audit row claiming a
    // change that never happened.
    expect(txDelegatesTouched()).toEqual(["environmentSafetySettings"]);
    expect(h.tx.client.auditLog.create).not.toHaveBeenCalled();
  });

  it("writes NOTHING when no row exists and the override is saved off", async () => {
    /*
      #3034 review. `before` is null here, so the first version's `before &&`
      gate did not fire: it created a row and audited "switched off" for an
      override that had never been on. Absent and `false` are the same answer —
      that is what the schema default and the un-seeded migration rest on — so
      this is a no-op and must leave no trace.
    */
    setPersisted(null);
    const response = await patch({
      forceNonProduction: false,
      confirmed: true,
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.changed).toBe(false);
    // No upsert, and no audit row claiming a switch-off that never happened.
    expect(txDelegatesTouched()).toEqual(["environmentSafetySettings"]);
    expect(h.tx.client.auditLog.create).not.toHaveBeenCalled();
    expect(
      h.tx.client.environmentSafetySettings.upsert,
    ).not.toHaveBeenCalled();
  });

  it("still describes the state honestly when that no-op happens", async () => {
    // There is no row to describe, so the payload has to say what a READ would.
    declare("production");
    setPersisted(null);
    const payload = await (
      await patch({ forceNonProduction: false, confirmed: true })
    ).json();

    expect(payload.state.role).toBe("PRODUCTION");
    expect(payload.state.override).toEqual({
      on: false,
      readable: true,
      updatedAt: null,
      updatedByName: null,
    });
  });

  it("still writes when no row exists and the override is saved ON", async () => {
    // The mirror of the case above: absent -> true IS a change.
    setPersisted(null);
    const response = await patch({ forceNonProduction: true, confirmed: true });
    expect((await response.json()).changed).toBe(true);
    expect(auditedRow().metadata).toEqual({ before: null, after: true });
  });

  it("records the acting administrator as the last writer", async () => {
    await patch({ forceNonProduction: true, confirmed: true });
    const upsert = h.tx.client.environmentSafetySettings.upsert as ReturnType<
      typeof vi.fn
    >;
    const args = upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    };
    expect(args.update).toEqual({
      forceNonProduction: true,
      updatedByMemberId: ACTOR,
    });
    expect(args.create).toEqual({
      id: "default",
      forceNonProduction: true,
      updatedByMemberId: ACTOR,
    });
  });

  it.each(["P2002", "P2028", "P2034"])(
    "answers a retryable %s with 503 rather than 500",
    async (code) => {
      h.prisma.$transaction.mockRejectedValue(Object.assign(new Error(code), { code }));
      const response = await patch({
        forceNonProduction: true,
        confirmed: true,
      });
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain("try again");
    },
  );

  it("rethrows anything else rather than dressing it up as 'try again'", async () => {
    h.prisma.$transaction.mockRejectedValue(
      Object.assign(new Error("column does not exist"), { code: "P2022" }),
    );
    await expect(
      patch({ forceNonProduction: true, confirmed: true }),
    ).rejects.toThrow("column does not exist");
  });
});
