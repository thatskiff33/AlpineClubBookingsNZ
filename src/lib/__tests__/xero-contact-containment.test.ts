import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    environmentSafetySettings: { findUnique: vi.fn() },
    xeroSandboxContactContainment: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
  getAuthenticatedXeroClient: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/xero-api-client")>();
  return {
    ...actual,
    // The metering wrapper is exercised by its own suites; here it must simply
    // not swallow or retry, so the assertions below are about the containment
    // decisions rather than about the retry ladder.
    callXeroApi: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  };
});

import {
  applyXeroContactEmailPolicy,
  decideXeroContactEmailPolicy,
  resolveXeroContactEmailPolicy,
  XeroContactEmailPolicyError,
  type XeroContactEmailPolicy,
} from "@/lib/xero-contact-containment";
import {
  ensureXeroContactContained,
  XERO_CONTAINMENT_PROOF_MAX_AGE_MS,
  XeroContactContainmentError,
} from "@/lib/xero-contact-containment-proof";
import { XeroContactEnvironmentUnknownError } from "@/lib/xero-environment-write-gate";
import {
  toXeroSandboxContactEmail,
  xeroSandboxContainmentTarget,
} from "@/lib/xero-sandbox-contact-email";
import {
  declareEnvironmentRole,
  expectEnvironmentRolePremise,
  undeclareEnvironmentRole,
} from "@/lib/__tests__/helpers/environment-role";

const REAL = "member@example.com";
/*
  A REAL 36-CHARACTER XERO GUID, not "contact-1". The shorter fixture made one
  assertion below pass for the wrong reason: the idempotency key is truncated to
  a provider-safe length, so `expect(key).toContain(CONTACT)` held only because
  the id was nine characters and everything fitted. With a real GUID the key
  cannot contain both the id and the address, and the assertion has to check the
  property it means (the key is DERIVED from both, so a different address is a
  different key) rather than a coincidence of the fixture (#3036 review P1-8c).
*/
const CONTACT = "8f4d2c1a-9b3e-4f57-8a26-1d0c7e5b9a34";

/** The frozen clock all unit tests run at: 2026-07-01T00:00:00.000Z. */
const NOW_MS = Date.parse("2026-07-01T00:00:00.000Z");

/**
 * A containment proof row, `ageMs` old.
 *
 * The age is explicit at every call site because it is now load-bearing: the
 * fast path requires the proof to be BOTH a fingerprint match and younger than
 * `XERO_CONTAINMENT_PROOF_MAX_AGE_MS`.
 */
function proofRow(containedEmail: string, ageMs = 0) {
  return { containedEmail, updatedAt: new Date(NOW_MS - ageMs) };
}

function xeroClient(storedEmail: string | undefined) {
  const getContact = vi
    .fn()
    .mockImplementation(async (_tenantId: string, contactId: string) => ({
      body: { contacts: [{ contactID: contactId, emailAddress: storedEmail }] },
    }));
  const updateContact = vi.fn().mockResolvedValue({ body: {} });
  return { accountingApi: { getContact, updateContact } };
}

/** A production policy, obtained the only way a policy can be obtained. */
async function productionPolicy(): Promise<XeroContactEmailPolicy> {
  declareEnvironmentRole("production");
  mocks.prisma.environmentSafetySettings.findUnique.mockResolvedValue(null);
  await expectEnvironmentRolePremise("PRODUCTION");
  return (await resolveXeroContactEmailPolicy()).policy;
}

/** A confirmed-copy policy. */
async function copyPolicy(): Promise<XeroContactEmailPolicy> {
  declareEnvironmentRole("non-production");
  await expectEnvironmentRolePremise("NON_PRODUCTION");
  return (await resolveXeroContactEmailPolicy()).policy;
}

/**
 * The idempotency key containment would send for this contact and this member
 * address, obtained by running the real code path rather than by re-deriving it
 * here — a test that spells the key formula a second time cannot notice the
 * formula changing.
 */
async function keyForContainment(
  xeroContactId: string,
  sourceEmail: string,
): Promise<unknown> {
  const policy = await copyPolicy();
  const xero = xeroClient(sourceEmail);
  mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(null);
  await ensureXeroContactContained({
    policy,
    xeroContactId,
    sourceEmail,
    workflow: "test",
    xero,
    tenantId: "tenant-1",
  });
  return xero.accountingApi.updateContact.mock.calls[0][3];
}

/**
 * INV-CONFIG-005: Xero contact containment (ENV-SAFETY 3, #3036; epic #2986).
 *
 * The role resolver answers UNKNOWN by default in this suite — the declaration
 * is unset and `prisma.environmentSafetySettings` is a mock whose `findUnique`
 * returns `undefined` until a test says otherwise — so every test declares the
 * installation it means to be, and `expectEnvironmentRolePremise` fails with a
 * sentence rather than letting an assertion pass for the wrong reason.
 */
describe("Xero contact containment (INV-CONFIG-005)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.prisma.environmentSafetySettings.findUnique.mockResolvedValue(null);
    mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(null);
    mocks.prisma.xeroSandboxContactContainment.upsert.mockResolvedValue({});
  });

  describe("the pure decision", () => {
    it("maps each role to exactly one answer", () => {
      expect(decideXeroContactEmailPolicy("PRODUCTION")).toEqual({
        kind: "verbatim",
      });
      expect(decideXeroContactEmailPolicy("NON_PRODUCTION")).toEqual({
        kind: "contain",
      });
      expect(decideXeroContactEmailPolicy("UNKNOWN")).toEqual({
        kind: "block_environment_unknown",
      });
    });

    it("mints nothing, so nobody can ask it for a token", async () => {
      // It takes caller-supplied input. #3035's review found a pure function
      // that minted was a function anybody could hand `{ role: "PRODUCTION" }`
      // to and receive a genuine token from. The shape assertion is that the
      // returned object carries NO usable policy: handing it to the applier
      // must be refused.
      const outcome = decideXeroContactEmailPolicy("PRODUCTION");
      expect(Object.keys(outcome)).toEqual(["kind"]);
      expect(() =>
        applyXeroContactEmailPolicy(
          outcome as unknown as XeroContactEmailPolicy,
          REAL,
        ),
      ).toThrow(XeroContactEmailPolicyError);
    });
  });

  describe("PRODUCTION is behaviourally unchanged", () => {
    it("passes the address through untouched", async () => {
      const policy = await productionPolicy();
      expect(applyXeroContactEmailPolicy(policy, REAL)).toBe(REAL);
      expect(applyXeroContactEmailPolicy(policy, "")).toBe("");
      // Even an address that already looks contained is passed through, because
      // on the live site this function has no opinion at all.
      const contained = toXeroSandboxContactEmail(REAL);
      expect(applyXeroContactEmailPolicy(policy, contained)).toBe(contained);
    });

    it("does no containment work: no evidence read, no provider call, no row", async () => {
      const policy = await productionPolicy();
      const xero = xeroClient(REAL);
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      expect(
        mocks.prisma.xeroSandboxContactContainment.findUnique,
      ).not.toHaveBeenCalled();
      expect(xero.accountingApi.getContact).not.toHaveBeenCalled();
      expect(xero.accountingApi.updateContact).not.toHaveBeenCalled();
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).not.toHaveBeenCalled();
    });
  });

  describe("UNKNOWN refuses, and transforms nothing", () => {
    it("throws a named error naming the variable to set", async () => {
      undeclareEnvironmentRole();
      await expectEnvironmentRolePremise("UNKNOWN");
      await expect(resolveXeroContactEmailPolicy()).rejects.toThrow(
        XeroContactEnvironmentUnknownError,
      );
      await expect(resolveXeroContactEmailPolicy()).rejects.toThrow(
        /APP_ENVIRONMENT_ROLE/,
      );
    });

    it("refuses under an UNREADABLE override even with production declared", async () => {
      // The half a suite forgets. A declared production plus an unreadable
      // override resolves UNKNOWN (#3034), and Xero writing must fail closed
      // there too.
      declareEnvironmentRole("production");
      mocks.prisma.environmentSafetySettings.findUnique.mockRejectedValue(
        new Error("boom"),
      );
      await expectEnvironmentRolePremise("UNKNOWN");
      await expect(resolveXeroContactEmailPolicy()).rejects.toThrow(
        XeroContactEnvironmentUnknownError,
      );
    });

    it("mints no policy at all, so no caller can transform or contain", async () => {
      undeclareEnvironmentRole();
      await expectEnvironmentRolePremise("UNKNOWN");
      const thrown = await resolveXeroContactEmailPolicy().catch((error) => error);
      expect(thrown).toBeInstanceOf(XeroContactEnvironmentUnknownError);
      // There is no third variant to ignore: the only way past this function is
      // a policy, and on UNKNOWN it does not return one.
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).not.toHaveBeenCalled();
    });
  });

  describe("a forged policy fails closed", () => {
    it("refuses a cast object at runtime", () => {
      const forged = {} as unknown as XeroContactEmailPolicy;
      expect(() => applyXeroContactEmailPolicy(forged, REAL)).toThrow(
        XeroContactEmailPolicyError,
      );
    });

    it("refuses an object that merely names the mode", () => {
      // A forged token that guesses the shape must not work either — the witness
      // is a module-private Symbol, which nothing outside the module can spell
      // and nothing can deserialize.
      const forged = { mode: "verbatim" } as unknown as XeroContactEmailPolicy;
      expect(() => applyXeroContactEmailPolicy(forged, REAL)).toThrow(
        XeroContactEmailPolicyError,
      );
      const serialized = JSON.parse(
        JSON.stringify({ verbatim: true }),
      ) as XeroContactEmailPolicy;
      expect(() => applyXeroContactEmailPolicy(serialized, REAL)).toThrow(
        XeroContactEmailPolicyError,
      );
    });
  });

  describe("a confirmed copy contains", () => {
    it("replaces the address in a payload", async () => {
      const policy = await copyPolicy();
      expect(applyXeroContactEmailPolicy(policy, REAL)).toBe(
        toXeroSandboxContactEmail(REAL),
      );
      expect(applyXeroContactEmailPolicy(policy, "")).toBe("");
    });

    it("contains regardless of transport mode: a capture mailbox is no exemption", async () => {
      // The one thing that must NOT be reused here. #3035's delivery policy lets
      // a confirmed copy with USE_LOCAL_CAPTURE transmit, because a capture
      // catches everything this application sends. Xero emails an invoice from
      // its own servers, so a capture catches nothing — and a copy with a
      // capture declared still needs every contact contained.
      declareEnvironmentRole("non-production");
      vi.stubEnv("USE_LOCAL_CAPTURE", "true");
      vi.stubEnv("EMAIL_SERVER_HOST", "mailpit");
      await expectEnvironmentRolePremise("NON_PRODUCTION");
      const { kind, policy } = await resolveXeroContactEmailPolicy();
      expect(kind).toBe("contain");
      expect(applyXeroContactEmailPolicy(policy, REAL)).toBe(
        toXeroSandboxContactEmail(REAL),
      );
    });

    it("rewrites a contact that is holding a real address, and records the proof", async () => {
      const policy = await copyPolicy();
      const xero = xeroClient(REAL);
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      expect(xero.accountingApi.getContact).toHaveBeenCalledWith(
        "tenant-1",
        CONTACT,
      );
      expect(xero.accountingApi.updateContact).toHaveBeenCalledTimes(1);
      const [tenantId, contactId, payload, idempotencyKey] =
        xero.accountingApi.updateContact.mock.calls[0];
      expect(tenantId).toBe("tenant-1");
      expect(contactId).toBe(CONTACT);
      expect(payload).toEqual({
        contacts: [
          {
            contactID: CONTACT,
            emailAddress: toXeroSandboxContactEmail(REAL),
          },
        ],
      });
      /*
        THE KEY IS A FUNCTION OF BOTH INPUTS, which is the property that makes a
        retry of the same containment idempotent and a re-containment against a
        MOVED address a different write. Asserting `toContain(CONTACT)` looked
        like it checked that and did not: the key is truncated to a provider-safe
        length, so with a real 36-character GUID neither input survives verbatim.
        So the property is checked by varying each input in turn.
      */
      expect(typeof idempotencyKey).toBe("string");
      expect((idempotencyKey as string).length).toBeGreaterThan(16);
      const otherContactKey = await keyForContainment(
        "11111111-2222-3333-4444-555555555555",
        REAL,
      );
      const otherAddressKey = await keyForContainment(CONTACT, "moved@example.com");
      expect(otherContactKey).not.toBe(idempotencyKey);
      expect(otherAddressKey).not.toBe(idempotencyKey);
      // And it is stable: the same contact and the same address, again.
      expect(await keyForContainment(CONTACT, REAL)).toBe(idempotencyKey);
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).toHaveBeenCalledWith({
        where: { xeroContactId: CONTACT },
        create: {
          xeroContactId: CONTACT,
          containedEmail: xeroSandboxContainmentTarget(REAL),
          rewroteAddress: true,
          rewrittenAt: expect.any(Date),
        },
        update: {
          containedEmail: xeroSandboxContainmentTarget(REAL),
          rewroteAddress: true,
          rewrittenAt: expect.any(Date),
        },
      });
    });

    it("sends NO name, phone or address on the containment write", async () => {
      // Xero merges the fields present. Sending an empty `phones: []` or
      // `addresses: []` here would WIPE the contact's real phone and address on
      // a copy, which is a destructive edit nobody asked for.
      const policy = await copyPolicy();
      const xero = xeroClient(REAL);
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      const contact = (
        xero.accountingApi.updateContact.mock.calls[0][2] as {
          contacts: Record<string, unknown>[];
        }
      ).contacts[0];
      expect(Object.keys(contact).sort()).toEqual([
        "contactID",
        "emailAddress",
      ]);
    });

    it("writes nothing to the provider when the contact is already unreachable", async () => {
      const policy = await copyPolicy();
      for (const stored of [
        undefined,
        "",
        "walk-in-abc@no-email.invalid",
        toXeroSandboxContactEmail(REAL),
      ]) {
        vi.clearAllMocks();
        mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(
          null,
        );
        mocks.prisma.xeroSandboxContactContainment.upsert.mockResolvedValue({});
        const xero = xeroClient(stored);
        await ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        });
        expect(xero.accountingApi.getContact).toHaveBeenCalledTimes(1);
        expect(xero.accountingApi.updateContact).not.toHaveBeenCalled();
        expect(
          mocks.prisma.xeroSandboxContactContainment.upsert,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({ rewroteAddress: false }),
          }),
        );
      }
    });

    it("contains what XERO is holding, not what the member holds", async () => {
      // A linked contact can carry somebody else's address — matched by email or
      // exact name, or linked wholesale by the member import. Containing the
      // member's address instead would leave the real one on the contact.
      const policy = await copyPolicy();
      const xero = xeroClient("someone.else@example.com");
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      const contact = (
        xero.accountingApi.updateContact.mock.calls[0][2] as {
          contacts: { emailAddress: string }[];
        }
      ).contacts[0];
      expect(contact.emailAddress).toBe(
        toXeroSandboxContactEmail("someone.else@example.com"),
      );
      // …while the PROOF is fingerprinted on the member's address, because that
      // is what the fast path compares against next time.
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            containedEmail: xeroSandboxContainmentTarget(REAL),
          }),
        }),
      );
    });
  });

  describe("the steady state costs no provider call", () => {
    it("returns on the evidence alone when the proof still matches", async () => {
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(
        proofRow(xeroSandboxContainmentTarget(REAL)),
      );
      const xero = xeroClient(REAL);
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      expect(xero.accountingApi.getContact).not.toHaveBeenCalled();
      expect(xero.accountingApi.updateContact).not.toHaveBeenCalled();
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).not.toHaveBeenCalled();
    });

    it("takes no Xero client at all on the fast path, so no token is refreshed", async () => {
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(
        proofRow(xeroSandboxContainmentTarget(REAL)),
      );
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
      });
      expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    });

    it("re-verifies when the member's address has moved", async () => {
      // The proof describes the address this application WOULD write. When the
      // member's address changes, the proof no longer describes it, so the
      // contact is read from Xero again rather than trusted on a claim made
      // before the change.
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(
        proofRow(xeroSandboxContainmentTarget("old@example.com")),
      );
      const xero = xeroClient(toXeroSandboxContactEmail("old@example.com"));
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      expect(xero.accountingApi.getContact).toHaveBeenCalledTimes(1);
      // Already unreachable, so no provider write — but the proof is refreshed
      // so the next document writer takes the fast path again.
      expect(xero.accountingApi.updateContact).not.toHaveBeenCalled();
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            containedEmail: xeroSandboxContainmentTarget(REAL),
          }),
        }),
      );
    });

    it("is one indexed read per contact, so a batch of many is not an N+1", async () => {
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.findUnique.mockImplementation(
        async ({ where }: { where: { xeroContactId: string } }) =>
          proofRow(
            xeroSandboxContainmentTarget(`${where.xeroContactId}@example.com`),
          ),
      );
      const xero = xeroClient(REAL);
      for (let index = 0; index < 25; index += 1) {
        await ensureXeroContactContained({
          policy,
          xeroContactId: `contact-${index}`,
          sourceEmail: `contact-${index}@example.com`,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        });
      }
      expect(
        mocks.prisma.xeroSandboxContactContainment.findUnique,
      ).toHaveBeenCalledTimes(25);
      expect(xero.accountingApi.getContact).not.toHaveBeenCalled();
      expect(xero.accountingApi.updateContact).not.toHaveBeenCalled();
    });
  });

  describe("a proof about Xero expires, because only Xero can invalidate it", () => {
    /*
      INV-CONFIG-005, and the hole the first version of this module had. The
      fingerprint invalidates a proof when the MEMBER's address moves. Nothing
      invalidated it when the PROVIDER side moved — and the provider side is what
      the proof is a claim about. The reachable chain, using this product's own
      operator guide: a copy connected to the club's real Xero organisation
      contains contact X, somebody repairs the damage from the live site (where
      addresses are written verbatim), X holds the member's real address again,
      the member's local address never moved, and the next document write took
      the fast path and raised an AUTHORISED invoice against a contact Xero would
      email reminders to.
    */
    it("re-reads the contact once the proof is older than the freshness bound", async () => {
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(
        proofRow(
          xeroSandboxContainmentTarget(REAL),
          XERO_CONTAINMENT_PROOF_MAX_AGE_MS + 1,
        ),
      );
      // Xero is holding the member's REAL address again: exactly the state the
      // stale proof asserts cannot happen.
      const xero = xeroClient(REAL);
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      expect(xero.accountingApi.getContact).toHaveBeenCalledTimes(1);
      expect(xero.accountingApi.updateContact).toHaveBeenCalledTimes(1);
    });

    it("treats a FUTURE-dated proof as stale rather than trusting it for ever", async () => {
      /*
        `updatedAt` is written by whichever process wrote the row, so a clock
        that has since moved backwards — a container with a skewed clock, or a
        restore carrying rows from a machine ahead of this one — leaves a
        future-dated proof. `now - updatedAt` is then NEGATIVE, which is
        arithmetically "inside" any window, so the proof would be trusted for
        ever: the one state this bound exists to prevent. Fail closed.
      */
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue({
        containedEmail: xeroSandboxContainmentTarget(REAL),
        updatedAt: new Date(NOW_MS + 60 * 60 * 1000),
      });
      const xero = xeroClient(REAL);
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      expect(xero.accountingApi.getContact).toHaveBeenCalledTimes(1);
      expect(xero.accountingApi.updateContact).toHaveBeenCalledTimes(1);
    });

    it("still trusts a proof inside the bound, so the steady state stays free", async () => {
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(
        proofRow(
          xeroSandboxContainmentTarget(REAL),
          XERO_CONTAINMENT_PROOF_MAX_AGE_MS - 1000,
        ),
      );
      const xero = xeroClient(REAL);
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      expect(xero.accountingApi.getContact).not.toHaveBeenCalled();
    });
  });

  describe("the record of a real overwrite is never retracted", () => {
    /*
      The reassuring-false-record shape, and it needed no concurrency to reach.
      Re-verifying a contact this copy already contained necessarily finds the
      CONTAINED address in place, so `rewroteAddress` recomputes as false — and
      writing that unconditionally erased the record of a real address this
      installation really had overwritten. The operator surface then positively
      asserted "none was holding a real address ... so nothing was overwritten".
    */
    it("omits rewroteAddress on a re-verification instead of writing false", async () => {
      const policy = await copyPolicy();
      // Stale by age, so the contact is re-read; Xero holds the CONTAINED
      // address, so nothing needs rewriting this time round.
      mocks.prisma.xeroSandboxContactContainment.findUnique.mockResolvedValue(
        proofRow(
          xeroSandboxContainmentTarget(REAL),
          XERO_CONTAINMENT_PROOF_MAX_AGE_MS + 1,
        ),
      );
      const xero = xeroClient(toXeroSandboxContactEmail(REAL));
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      expect(xero.accountingApi.updateContact).not.toHaveBeenCalled();
      const [args] = mocks.prisma.xeroSandboxContactContainment.upsert.mock
        .calls[0] as [
        {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        },
      ];
      expect(
        Object.keys(args.update).sort(),
        "a re-verification must not carry rewroteAddress at all: writing false " +
          "retracts a fact about the past that the operator surface reports",
      ).toEqual(["containedEmail"]);
      // The create half still records the truth for a first-ever containment.
      expect(args.create.rewroteAddress).toBe(false);
      expect(args.create.rewrittenAt).toBeNull();
    });

    it("records the instant a deliverable address was replaced", async () => {
      const policy = await copyPolicy();
      const xero = xeroClient(REAL);
      await ensureXeroContactContained({
        policy,
        xeroContactId: CONTACT,
        sourceEmail: REAL,
        workflow: "test",
        xero,
        tenantId: "tenant-1",
      });
      const [args] = mocks.prisma.xeroSandboxContactContainment.upsert.mock
        .calls[0] as [{ update: { rewrittenAt?: Date } }];
      expect(args.update.rewrittenAt).toBeInstanceOf(Date);
      expect(args.update.rewrittenAt?.getTime()).toBe(NOW_MS);
    });
  });

  describe("a rewrite that could not be recorded says so", () => {
    /*
      The one direction this feature's numbers can be wrong in. The provider
      write has already replaced a deliverable address on a real Xero contact
      when the upsert fails, so the caller refuses (correctly) and the operator
      count is one short of what actually happened. There is no repair available
      — the address is replaced and the database is refusing writes — so the
      honest handling is to say it in both places somebody will look.
    */
    it("logs the contact id and names the under-count in the refusal", async () => {
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.upsert.mockRejectedValue(
        new Error("deadlock detected"),
      );
      const xero = xeroClient(REAL);
      await expect(
        ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        }),
      ).rejects.toThrow(/count on Admin -> Environment will not include it/);
      // The provider write really did happen, which is what makes the count wrong.
      expect(xero.accountingApi.updateContact).toHaveBeenCalledTimes(1);
      expect(mocks.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ xeroContactId: CONTACT }),
        expect.stringContaining("one short of what really happened"),
      );
    });

    it("says nothing about a count when nothing was overwritten", async () => {
      // A contact that was already unreachable had no address replaced, so the
      // refusal must not claim an uncounted overwrite that did not occur.
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.upsert.mockRejectedValue(
        new Error("deadlock detected"),
      );
      const xero = xeroClient("");
      await expect(
        ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        }),
      ).rejects.toThrow(/the proof could not be recorded/);
      expect(xero.accountingApi.updateContact).not.toHaveBeenCalled();
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });
  });

  describe("a refusal that never reached Xero keeps its own identity", () => {
    /*
      #2423 F2 on a new path. The outbox decides whether a FAILED operation may
      be returned to PENDING by asking whether the error is a pre-HTTP cool-down
      refusal — `error.name` plus `preHttp`. Wrapping such a refusal in a
      containment error makes it unrecognisable, so an operation that was NEVER
      ATTEMPTED is failed terminally and nothing auto-recovers it. The window is
      real: `getAuthenticatedXeroClient` gates only the DAILY limit, while
      `withXeroRetry` also gates the transient-outage breaker, so the first
      pre-HTTP refusal a run meets can land inside containment's own getContact.
    */
    for (const name of [
      "XeroDailyLimitError",
      "XeroTransientOutageError",
      "XeroReconnectRequiredError",
      /*
        #3036 third review round. `XeroTokenDecryptError` is name-keyed in FOUR
        places that all treat it exactly like `XeroReconnectRequiredError`
        (`xero-api-errors`, `xero-connection-probe`, `xero-organisation`,
        `membership-cancellation-invoice-blockers`), so relabelling it turned the
        admin's "reconnect Xero" message into an opaque 500 — and it bites
        hardest on this module's own population, a copy restored with a different
        AUTH_SECRET that cannot decrypt the tokens it inherited.
      */
      "XeroTokenDecryptError",
      /*
        And our OWN gate refusal, which containment's provider calls pass
        through. Wrapping it destroys the `preHttp` marker the outbox keys its
        never-attempted re-drive on, which is the whole reason that class carries
        one.
      */
      "XeroContactEnvironmentUnknownError",
    ]) {
      it(`rethrows ${name} unchanged from the contact read`, async () => {
        const policy = await copyPolicy();
        const refusal = Object.assign(new Error("refused before any request"), {
          name,
          preHttp: true,
        });
        const xero = xeroClient(REAL);
        xero.accountingApi.getContact.mockRejectedValue(refusal);
        await expect(
          ensureXeroContactContained({
            policy,
            xeroContactId: CONTACT,
            sourceEmail: REAL,
            workflow: "test",
            xero,
            tenantId: "tenant-1",
          }),
        ).rejects.toBe(refusal);
      });

      it(`rethrows ${name} unchanged from the containment write`, async () => {
        const policy = await copyPolicy();
        const refusal = Object.assign(new Error("refused before any request"), {
          name,
          preHttp: true,
        });
        const xero = xeroClient(REAL);
        xero.accountingApi.updateContact.mockRejectedValue(refusal);
        await expect(
          ensureXeroContactContained({
            policy,
            xeroContactId: CONTACT,
            sourceEmail: REAL,
            workflow: "test",
            xero,
            tenantId: "tenant-1",
          }),
        ).rejects.toBe(refusal);
      });
    }

    it("rethrows a cool-down refusal from authentication unchanged", async () => {
      const policy = await copyPolicy();
      const refusal = Object.assign(new Error("daily limit"), {
        name: "XeroDailyLimitError",
        preHttp: true,
      });
      mocks.getAuthenticatedXeroClient.mockRejectedValue(refusal);
      await expect(
        ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
        }),
      ).rejects.toBe(refusal);
    });

    it("still wraps an ordinary provider failure, so the refusal is explained", async () => {
      const policy = await copyPolicy();
      const xero = xeroClient(REAL);
      xero.accountingApi.getContact.mockRejectedValue(new Error("503 boom"));
      await expect(
        ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        }),
      ).rejects.toThrow(XeroContactContainmentError);
    });
  });

  describe("containment that cannot be established is a refusal", () => {
    it("throws when the containment table cannot be read", async () => {
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.findUnique.mockRejectedValue(
        new Error("relation does not exist"),
      );
      const xero = xeroClient(REAL);
      await expect(
        ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        }),
      ).rejects.toThrow(XeroContactContainmentError);
      expect(xero.accountingApi.updateContact).not.toHaveBeenCalled();
    });

    it("throws when the contact cannot be read from Xero", async () => {
      const policy = await copyPolicy();
      const xero = xeroClient(REAL);
      xero.accountingApi.getContact.mockRejectedValue(new Error("503"));
      await expect(
        ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        }),
      ).rejects.toThrow(XeroContactContainmentError);
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).not.toHaveBeenCalled();
    });

    it("throws when the containment write to Xero fails, and records no proof", async () => {
      const policy = await copyPolicy();
      const xero = xeroClient(REAL);
      xero.accountingApi.updateContact.mockRejectedValue(new Error("400"));
      await expect(
        ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        }),
      ).rejects.toThrow(XeroContactContainmentError);
      expect(
        mocks.prisma.xeroSandboxContactContainment.upsert,
      ).not.toHaveBeenCalled();
    });

    it("throws when the proof cannot be written", async () => {
      const policy = await copyPolicy();
      mocks.prisma.xeroSandboxContactContainment.upsert.mockRejectedValue(
        new Error("read only"),
      );
      const xero = xeroClient(REAL);
      await expect(
        ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
          xero,
          tenantId: "tenant-1",
        }),
      ).rejects.toThrow(XeroContactContainmentError);
    });

    it("throws when the containment table does not exist on this database", async () => {
      // An un-migrated copy. A missing delegate must be a refusal, not a
      // silently skipped containment — the direction this module is never
      // allowed to guess in.
      const policy = await copyPolicy();
      const withoutDelegate = mocks.prisma
        .xeroSandboxContactContainment as unknown;
      try {
        (
          mocks.prisma as unknown as Record<string, unknown>
        ).xeroSandboxContactContainment = undefined;
        await expect(
          ensureXeroContactContained({
            policy,
            xeroContactId: CONTACT,
            sourceEmail: REAL,
            workflow: "test",
            xero: xeroClient(REAL),
            tenantId: "tenant-1",
          }),
        ).rejects.toThrow(/prisma migrate deploy/);
      } finally {
        (
          mocks.prisma as unknown as Record<string, unknown>
        ).xeroSandboxContactContainment = withoutDelegate;
      }
    });

    it("throws when Xero cannot be authenticated at all", async () => {
      const policy = await copyPolicy();
      mocks.getAuthenticatedXeroClient.mockRejectedValue(
        new Error("no connection"),
      );
      await expect(
        ensureXeroContactContained({
          policy,
          xeroContactId: CONTACT,
          sourceEmail: REAL,
          workflow: "test",
        }),
      ).rejects.toThrow(XeroContactContainmentError);
    });
  });
});
