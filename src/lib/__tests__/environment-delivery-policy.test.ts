import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The delivery policy itself (ENV-SAFETY 2, #3035; epic #2986; INV-CONFIG-004).
 *
 * FIVE answers over TWO declarations — the environment role and the transport
 * kind — and the whole issue is that they stay five. Everything downstream (the
 * EmailLog status, the retry cron's behaviour, whether a Xero sync operation
 * reports PARTIAL, whether the browser suite can read its own mail back out of
 * mailpit) is keyed on which one this module returns, so this is where the whole
 * table is pinned.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { environmentSafetySettings: { findUnique: mocks.findUnique } },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import {
  assertDeliveryClearanceWitness,
  decideDeliveryPolicy,
  describeDeliveryDecision,
  DeliveryClearanceError,
  requireDeliveryClearance,
  resolveDeliveryPolicy,
  type DeliveryClearance,
  type DeliveryOutcome,
  type LiveProviderClearance,
} from "@/lib/environment-delivery-policy";
import { decideEnvironmentRole } from "@/lib/environment-role";
import { environmentRoleDeclaration } from "@/lib/__tests__/helpers/environment-role";

const NO_OVERRIDE = { kind: "none" } as const;
const UNREADABLE_OVERRIDE = { kind: "unreadable" } as const;
const FORCED_OVERRIDE = {
  kind: "force-non-production",
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedByMemberId: "m_1",
} as const;

/** One row of the decision table, spelled as the policy sees it. */
function decide(
  declaration: keyof typeof environmentRoleDeclaration,
  override: typeof NO_OVERRIDE | typeof UNREADABLE_OVERRIDE | typeof FORCED_OVERRIDE,
  transport: "live-provider" | "local-capture" | "unresolved",
): DeliveryOutcome {
  return decideDeliveryPolicy(
    decideEnvironmentRole(environmentRoleDeclaration[declaration], override),
    transport,
  );
}

/** Provider-flag environment for the live-resolution cases below. */
function stubTransport(kind: "live-provider" | "local-capture") {
  vi.stubEnv("EMAIL_FROM", "club@club.test");
  if (kind === "live-provider") {
    vi.stubEnv("USE_AWS_SES", "true");
    vi.stubEnv("USE_LOCAL_CAPTURE", "");
    vi.stubEnv("AWS_SES_ACCESS_KEY_ID", "key");
    vi.stubEnv("AWS_SES_SECRET_ACCESS_KEY", "secret");
    return;
  }
  vi.stubEnv("USE_AWS_SES", "");
  vi.stubEnv("USE_LOCAL_CAPTURE", "true");
  vi.stubEnv("EMAIL_SERVER_HOST", "mailpit");
  vi.stubEnv("EMAIL_SERVER_PORT", "1025");
  vi.stubEnv("EMAIL_SERVER_USER", "e2e");
  vi.stubEnv("EMAIL_SERVER_PASSWORD", "e2e");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.findUnique.mockResolvedValue(null);
});

describe("decideDeliveryPolicy (INV-CONFIG-004)", () => {
  it("allows delivery for a declared production installation, and mints NOTHING", async () => {
    /*
      THE PURE FUNCTION HANDS OUT NO CLEARANCE, and that is a security boundary
      rather than tidiness (#3035 review). It takes an `EnvironmentRoleResolution`
      from its CALLER, so while it minted the real token anybody could pass
      `{ role: "PRODUCTION" }` and receive a genuine `LiveProviderClearance`
      stamped with the module-private witness. No cast is involved, so the cast
      census does not fire — and a review lens used exactly that to drive
      `accountingApi.emailInvoice` to a real call on an installation whose real
      declaration was `non-production`, because `sendXeroInvoiceEmail` checks the
      witness only.

      The decision table is still fully assertable here. The token is not.
    */
    const decision = decide("production", NO_OVERRIDE, "live-provider");
    expect(decision).toEqual({ kind: "allow", grounds: "production" });
    expect(decision).not.toHaveProperty("clearance");

    // The mint lives in `resolveDeliveryPolicy`, which reads the real sources
    // itself, and the token it produces is a real value rather than a type-level
    // fiction: the runtime witness check has to accept it.
    vi.stubEnv("APP_ENVIRONMENT_ROLE", "production");
    stubTransport("live-provider");
    const resolved = await resolveDeliveryPolicy();
    if (resolved.kind !== "allow") throw new Error("unreachable");
    expect(() =>
      assertDeliveryClearanceWitness(resolved.clearance, "production"),
    ).not.toThrow();
  });

  it("suppresses for a declared copy pointed at a live provider, and says the DEPLOYMENT decided", () => {
    expect(decide("nonProduction", NO_OVERRIDE, "live-provider")).toEqual({
      kind: "suppress_non_production",
      decidedBy: "deployment-declaration",
    });
  });

  it("suppresses for an administrator-forced copy, and says the DATABASE decided", () => {
    /*
      The two suppression sources are kept apart because the remedy differs: a
      declared copy is behaving as its deployment says, while a forced one has a
      switch somebody can turn off on the admin screen. The operator sentence
      names that screen only in this case.
    */
    const decision = decide("production", FORCED_OVERRIDE, "live-provider");
    expect(decision).toEqual({
      kind: "suppress_non_production",
      decidedBy: "database-safer-override",
    });
    expect(describeDeliveryDecision(decision)).toContain("safer override");
  });

  it("blocks an unreadable override BEFORE it reads the declaration, even a production one", () => {
    /*
      Branch order, and it is load-bearing rather than cosmetic. An unreadable
      override resolves UNKNOWN even under a declared `production`, so if this
      module checked the declaration first it would tell an operator who has set
      the variable correctly to go and set the variable — sending them to fix the
      one thing that is already right, while the database is the real fault.
    */
    expect(decide("production", UNREADABLE_OVERRIDE, "live-provider")).toEqual({
      kind: "block_environment_unknown",
      reason: "override_unreadable",
    });
  });

  it("tells a missing declaration apart from one it refuses to interpret", () => {
    expect(decide("absent", NO_OVERRIDE, "live-provider")).toEqual({
      kind: "block_environment_unknown",
      reason: "declaration_missing",
    });
    expect(decide("invalid", NO_OVERRIDE, "live-provider")).toEqual({
      kind: "block_environment_unknown",
      reason: "declaration_invalid",
    });
  });
});

describe("the declared local capture mailbox", () => {
  it("lets a confirmed copy transmit, on grounds that say WHY", () => {
    /*
      The one exemption, and the issue asks for it in as many words: "explicit
      local/capture transports remain valid". It is safe because a capture cannot
      deliver onward — and it is what lets the browser suite read a two-factor
      code back out of mailpit instead of every email spec failing.
    */
    const decision = decide("nonProduction", NO_OVERRIDE, "local-capture");
    expect(decision).toMatchObject({
      kind: "allow",
      grounds: "non-production-capture",
    });
    expect(describeDeliveryDecision(decision)).toContain("capture");
  });

  it("applies to an administrator-forced copy too, not just a declared one", () => {
    expect(decide("production", FORCED_OVERRIDE, "local-capture")).toMatchObject(
      { kind: "allow", grounds: "non-production-capture" },
    );
  });

  it("is REFUSED on the club's live site, because a live site in capture mode delivers nothing", () => {
    /*
      The symmetric hazard to the whole epic, arriving from the other direction. A
      wrongly-declared copy silently withholds mail; a live site in capture mode
      silently swallows it — accepting every message, reporting every one as sent,
      and delivering none. Both are total mail outages an operator cannot see, so
      both are refused loudly.
    */
    const decision = decide("production", NO_OVERRIDE, "local-capture");
    expect(decision).toEqual({ kind: "block_capture_in_production" });
    const sentence = describeDeliveryDecision(decision);
    expect(sentence).toContain("APP_ENVIRONMENT_ROLE=production");
    expect(sentence).toContain("USE_LOCAL_CAPTURE=true");
    expect(sentence).toContain("no provider was contacted");
  });

  it("earns an UNKNOWN installation nothing at all", () => {
    /*
      The deliberate asymmetry with the non-production case. A capture declaration
      is a claim by the very deployment configuration that has failed to say what
      this installation is; an installation that cannot answer the first question
      has not earned an exemption on the strength of its answer to the second, and
      UNKNOWN failing closed is this issue's rule with no carve-outs.
    */
    expect(decide("absent", NO_OVERRIDE, "local-capture")).toEqual({
      kind: "block_environment_unknown",
      reason: "declaration_missing",
    });
    expect(decide("invalid", NO_OVERRIDE, "local-capture")).toEqual({
      kind: "block_environment_unknown",
      reason: "declaration_invalid",
    });
    expect(decide("production", UNREADABLE_OVERRIDE, "local-capture")).toEqual({
      kind: "block_environment_unknown",
      reason: "override_unreadable",
    });
  });

  it("is not inferred from an unusable configuration either", () => {
    // `unresolved` must never be read as an exemption: a broken transport
    // configuration is not evidence that mail is being captured.
    expect(decide("nonProduction", NO_OVERRIDE, "unresolved")).toEqual({
      kind: "suppress_non_production",
      decidedBy: "deployment-declaration",
    });
    expect(decide("production", NO_OVERRIDE, "unresolved")).toMatchObject({
      kind: "allow",
      grounds: "production",
    });
  });
});

describe("describeDeliveryDecision", () => {
  it("gives each outcome its own operator sentence, and repeats no reused wording", () => {
    const sentences = [
      describeDeliveryDecision(decide("nonProduction", NO_OVERRIDE, "live-provider")),
      describeDeliveryDecision(decide("production", UNREADABLE_OVERRIDE, "live-provider")),
      describeDeliveryDecision(decide("absent", NO_OVERRIDE, "live-provider")),
      describeDeliveryDecision(decide("invalid", NO_OVERRIDE, "live-provider")),
      describeDeliveryDecision(decide("production", NO_OVERRIDE, "local-capture")),
    ];
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) {
      // Every one says what did NOT happen, so a reader of an old log row is not
      // left wondering whether a member got the message.
      expect(sentence).toContain("no provider was contacted");
    }
    // The repair for a missing declaration names the variable, and names the
    // one an operator will otherwise reach for by mistake.
    expect(sentences[2]).toContain("APP_ENVIRONMENT_ROLE");
    expect(sentences[2]).toContain("APP_RUNTIME_ROLE");
    // A refused VALUE is never echoed into an operator sentence from here — the
    // declaration parser has its own capped, sanitized display for that.
    expect(sentences[3]).not.toContain("staging");
  });
});

describe("the clearance tokens", () => {
  it("refuses a forged or cast token, so the type escape hatch fails closed", async () => {
    /*
      `{} as unknown as DeliveryClearance` type-checks — TypeScript's brand is
      erased at runtime. This is the check that makes the cast useless, and it is
      the reason the source census over `as ... DeliveryClearance` is a second
      line of defence rather than the only one.
    */
    for (const forged of [
      {} as unknown as DeliveryClearance,
      null as unknown as DeliveryClearance,
      "production-confirmed" as unknown as DeliveryClearance,
      { "production-confirmed": true } as unknown as DeliveryClearance,
    ]) {
      expect(() => assertDeliveryClearanceWitness(forged)).toThrow(
        DeliveryClearanceError,
      );
      await expect(requireDeliveryClearance(forged)).rejects.toThrow(
        DeliveryClearanceError,
      );
    }
  });

  it("does not survive a round trip through JSON", async () => {
    // The witness is a symbol, so a clearance cannot be smuggled through a queue
    // payload, a cache or a request body and re-presented later.
    vi.stubEnv("APP_ENVIRONMENT_ROLE", "production");
    stubTransport("live-provider");
    const decision = await resolveDeliveryPolicy();
    if (decision.kind !== "allow") throw new Error("unreachable");
    const revived = JSON.parse(
      JSON.stringify(decision.clearance),
    ) as DeliveryClearance;
    expect(() => assertDeliveryClearanceWitness(revived)).toThrow(
      DeliveryClearanceError,
    );
  });

  it("refuses a CAPTURE clearance wherever production is required", async () => {
    /*
      What stops a capture copy asking Xero to email an invoice. A capture mailbox
      intercepts the mail this application sends itself; Xero sends an invoice from
      its own servers to the member's real address, which no capture container
      ever sees. The type already forbids it — `LiveProviderClearance` is the
      narrower brand — and this is the runtime half, so a cast cannot buy what the
      type refuses.
    */
    vi.stubEnv("APP_ENVIRONMENT_ROLE", "non-production");
    stubTransport("local-capture");
    const capture = await resolveDeliveryPolicy();
    if (capture.kind !== "allow") throw new Error("unreachable");
    expect(() =>
      assertDeliveryClearanceWitness(capture.clearance, "any"),
    ).not.toThrow();
    expect(() =>
      assertDeliveryClearanceWitness(capture.clearance, "production"),
    ).toThrow(/local capture mailbox/);
  });

  it("refuses a genuine clearance once an administrator forces the copy mid-flight", async () => {
    /*
      The case the second half of the runtime check exists for. A batch can hold a
      clearance minted minutes ago; the click that switches the safer override on
      is the one somebody makes when they have just realised a copy is about to
      email real members, and it has to take effect on the messages still in
      flight.
    */
    vi.stubEnv("APP_ENVIRONMENT_ROLE", "production");
    stubTransport("live-provider");
    const allowed = await resolveDeliveryPolicy();
    expect(allowed.kind).toBe("allow");
    if (allowed.kind !== "allow") throw new Error("unreachable");
    await expect(requireDeliveryClearance(allowed.clearance)).resolves.toBe(
      "production",
    );

    mocks.findUnique.mockResolvedValue({
      forceNonProduction: true,
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedByMemberId: "m_1",
    });
    await expect(
      requireDeliveryClearance(allowed.clearance),
    ).rejects.toThrow(/may no longer send/);
  });

  it("refuses a production clearance once the installation has become a capture copy", async () => {
    /*
      Both re-resolving to an allow is not enough: the GROUNDS have to match.
      Otherwise a production token would carry production's licence — including
      the legacy implicit AWS SES fallback — onto a copy.
    */
    vi.stubEnv("APP_ENVIRONMENT_ROLE", "production");
    stubTransport("live-provider");
    const allowed = await resolveDeliveryPolicy();
    // Narrowing on `grounds` is what turns the union into the narrower brand —
    // the compile-time half of the same rule this test exercises at runtime.
    if (allowed.kind !== "allow" || allowed.grounds !== "production") {
      throw new Error("unreachable");
    }
    const productionClearance: LiveProviderClearance = allowed.clearance;

    vi.stubEnv("APP_ENVIRONMENT_ROLE", "non-production");
    stubTransport("local-capture");
    expect((await resolveDeliveryPolicy()).kind).toBe("allow");
    await expect(
      requireDeliveryClearance(productionClearance),
    ).rejects.toThrow(/minted for a production installation/);
  });
});

describe("resolveDeliveryPolicy over the live resolution", () => {
  it("fails closed when nothing has declared this installation", async () => {
    stubTransport("live-provider");
    expect(await resolveDeliveryPolicy()).toEqual({
      kind: "block_environment_unknown",
      reason: "declaration_missing",
    });
  });

  it("fails closed when the override cannot be read at all", async () => {
    vi.stubEnv("APP_ENVIRONMENT_ROLE", "production");
    stubTransport("live-provider");
    mocks.findUnique.mockRejectedValue(new Error("relation does not exist"));
    expect(await resolveDeliveryPolicy()).toEqual({
      kind: "block_environment_unknown",
      reason: "override_unreadable",
    });
  });

  it("suppresses on a declared copy without needing the database at all", async () => {
    /*
      A declared copy is already the safest answer, so a database blip cannot move
      it — which matters because a copy is exactly where somebody is likely to be
      running against a half-migrated database.
    */
    vi.stubEnv("APP_ENVIRONMENT_ROLE", "non-production");
    stubTransport("live-provider");
    mocks.findUnique.mockRejectedValue(new Error("relation does not exist"));
    expect(await resolveDeliveryPolicy()).toEqual({
      kind: "suppress_non_production",
      decidedBy: "deployment-declaration",
    });
  });

  it("reads the transport declaration from the environment, not from a host name", async () => {
    // A relay pointed at a host literally called mailpit is still a LIVE provider
    // as far as this policy is concerned: only USE_LOCAL_CAPTURE says otherwise.
    vi.stubEnv("APP_ENVIRONMENT_ROLE", "non-production");
    vi.stubEnv("EMAIL_FROM", "club@club.test");
    vi.stubEnv("USE_AWS_SES", "");
    vi.stubEnv("USE_SMTP_RELAY", "true");
    vi.stubEnv("EMAIL_SERVER_HOST", "mailpit");
    vi.stubEnv("EMAIL_SERVER_PORT", "1025");
    vi.stubEnv("EMAIL_SERVER_USER", "e2e");
    vi.stubEnv("EMAIL_SERVER_PASSWORD", "e2e");

    expect(await resolveDeliveryPolicy()).toEqual({
      kind: "suppress_non_production",
      decidedBy: "deployment-declaration",
    });
  });
});
