/**
 * The credential-store WRITE CONTRACT, exercised (#2723).
 *
 * Four behavioural claims, one describe block each. The census beside this file
 * proves the tree OBEYS the contract; this file proves the contract is worth
 * obeying — that the store really does refuse an unattributable write, really
 * does roll the secret back when its audit row fails, really does make a stale
 * writer lose, and really does keep the plaintext out of everything it emits.
 *
 * ON THE LAST ONE, AND HOW STRONGLY IT HOLDS. A redaction rule that lives in the
 * logger is blind to every door that never calls the logger, so this does not
 * test a redactor. It drives the real store with a sentinel plaintext and reads
 * back everything the store EMITS — the audit rows it wrote, every logger call,
 * and the errors it threw — asserting the sentinel appears in none of them.
 *
 * That is a claim about the store's own doors on the paths exercised here. It
 * is NOT a claim that no plaintext can reach a log anywhere in the application:
 * a caller that catches a value and logs it itself is outside this boundary, and
 * outside what any test in this file could see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE TRANSACTION CLIENT IS A DIFFERENT DOUBLE FROM THE MODULE CLIENT, and that
 * is load-bearing rather than tidy. The first draft of this file handed the
 * `$transaction` callback the same object, which made "the audit row and the
 * secret went through one client" untestable: swapping `tx` for `prisma` inside
 * the store passed all nineteen tests. It was caught by mutating exactly that
 * line, which is the only way that class of hole ever shows up.
 */
const mocks = vi.hoisted(() => {
  const credentialDelegate = () => ({
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  });
  const tx = {
    integrationCredential: credentialDelegate(),
    auditLog: { create: vi.fn() },
  };
  const prisma = {
    integrationCredential: credentialDelegate(),
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (callback: (client: typeof tx) => unknown) => callback(tx),
  );
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return { prisma, tx, logger };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/logger", () => ({ default: mocks.logger, logger: mocks.logger }));

import { sanitizeAuditMetadata } from "@/lib/audit";
import {
  encryptCredential,
  INTEGRATION_CREDENTIAL_LABEL,
} from "@/lib/integration-crypto";
import {
  CredentialActorError,
  CredentialExpectationError,
  StaleCredentialWriteError,
  credentialVersionOf,
  type CredentialActor,
  type CredentialDeleteExpectation,
} from "@/lib/integration-credential-actor";
import {
  deleteIntegrationCredential,
  resetIntegrationCredentialCacheForTests,
  setIntegrationCredential,
} from "@/lib/integration-credentials";

const STRONG_SECRET = "a".repeat(48);
const originalEnv = { ...process.env };

const ADMIN: CredentialActor = { kind: "admin", memberId: "member-42" };
const SYSTEM: CredentialActor = {
  kind: "system",
  actor: "stripe-webhook-verify",
};

/**
 * The sentinel. Distinctive enough that a substring search over everything the
 * store emitted cannot match it by accident, and shaped like a real secret so
 * nothing treats it as obviously inert.
 */
const SECRET = "sk_test_SENTINEL_9f2a7c41b0e84d6fa3c5PLAINTEXT";

function storedRow(provider: string, key: string, value: string) {
  const enc = encryptCredential({
    provider,
    key,
    plaintext: value,
    label: INTEGRATION_CREDENTIAL_LABEL,
  });
  return {
    id: `${provider}-${key}`,
    provider,
    key,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    authTag: enc.authTag,
    secretSource: enc.secretSource,
    labelVersion: enc.labelVersion,
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedByUserId: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(
    async (callback: (client: unknown) => unknown) => callback(mocks.tx),
  );
  mocks.tx.auditLog.create.mockResolvedValue({});
  mocks.prisma.auditLog.create.mockResolvedValue({});
  mocks.prisma.integrationCredential.findMany.mockResolvedValue([]);
  mocks.tx.integrationCredential.findUnique.mockResolvedValue(null);
  mocks.tx.integrationCredential.upsert.mockResolvedValue({
    provider: "stripe",
    key: "secret_key",
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  mocks.tx.integrationCredential.deleteMany.mockResolvedValue({ count: 1 });
  resetIntegrationCredentialCacheForTests();
  delete process.env.NEXTAUTH_SECRET;
  process.env.AUTH_SECRET = STRONG_SECRET;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

// ---------------------------------------------------------------------------

describe("credential writes carry distinguishable actor evidence (#2723)", () => {
  it("records a human write against the member, on the row AND in the audit", async () => {
    await setIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      value: SECRET,
      actor: ADMIN,
      expect: { expect: "any" },
    });

    expect(mocks.tx.integrationCredential.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ updatedByUserId: "member-42" }),
      }),
    );
    const audited = mocks.tx.auditLog.create.mock.calls[0]?.[0]?.data;
    expect(audited).toMatchObject({
      action: "integration.credential.set",
      category: "security",
      actorMemberId: "member-42",
      entityId: "stripe:secret_key",
    });
    expect(audited?.metadata).toMatchObject({
      actorKind: "admin",
      systemActor: null,
    });
  });

  it("records a system write against a NAMED actor, never a bare null", async () => {
    // This is the distinction the old `updatedByUserId?: string | null` could
    // not express: a background write and an omitted argument both stored null.
    await setIntegrationCredential({
      provider: "stripe",
      key: "webhook_verified_at",
      value: "2026-07-01T00:00:00.000Z",
      actor: SYSTEM,
      expect: { expect: "any" },
    });

    expect(mocks.tx.integrationCredential.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ updatedByUserId: null }),
      }),
    );
    const audited = mocks.tx.auditLog.create.mock.calls[0]?.[0]?.data;
    expect(audited?.metadata).toMatchObject({
      actorKind: "system",
      systemActor: "stripe-webhook-verify",
    });
    expect(audited?.actorMemberId ?? null).toBeNull();
  });

  it("refuses a value that is not an actor, and writes nothing", async () => {
    // The runtime half of the contract, for the holes a type always has: an
    // `as never` cast in a test double, untyped JavaScript, a forwarded value.
    await expect(
      setIntegrationCredential({
        provider: "stripe",
        key: "secret_key",
        value: SECRET,
        actor: { kind: "system", actor: "not-a-known-actor" } as never,
        expect: { expect: "any" },
      }),
    ).rejects.toBeInstanceOf(CredentialActorError);

    expect(mocks.tx.integrationCredential.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses an admin actor with an empty member id", async () => {
    // Otherwise `memberId: ""` stores as a human write attributable to nobody —
    // the original defect wearing a different column value.
    await expect(
      setIntegrationCredential({
        provider: "stripe",
        key: "secret_key",
        value: SECRET,
        actor: { kind: "admin", memberId: "  " },
        expect: { expect: "any" },
      }),
    ).rejects.toBeInstanceOf(CredentialActorError);
    expect(mocks.tx.integrationCredential.upsert).not.toHaveBeenCalled();
  });

  it("refuses a delete that expects the row to be absent", async () => {
    // `{ expect: "absent" }` on a delete means "remove a row I believe is not
    // there", which is not a thing anybody means. The TYPE forbids it; this is
    // the runtime half.
    await expect(
      deleteIntegrationCredential({
        provider: "stripe",
        key: "secret_key",
        actor: ADMIN,
        expect: { expect: "absent" } as never,
      }),
    ).rejects.toBeInstanceOf(CredentialExpectationError);
    expect(mocks.tx.integrationCredential.deleteMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("the secret and its audit row are one local action (#2723)", () => {
  it("writes both through the SAME client, inside one transaction", async () => {
    await setIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      value: SECRET,
      actor: ADMIN,
      expect: { expect: "any" },
    });

    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.tx.integrationCredential.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.tx.auditLog.create).toHaveBeenCalledTimes(1);
    // And NOT through the module client, which would commit on its own and
    // survive a rollback of the secret. This is the assertion the same-double
    // draft could not make.
    expect(mocks.prisma.auditLog.create).not.toHaveBeenCalled();
    expect(mocks.prisma.integrationCredential.upsert).not.toHaveBeenCalled();
  });

  it("rolls the secret back when the audit row cannot be written", async () => {
    // The failure mode this contract exists for. Before #2723 the credential
    // landed in one statement and its audit row in another module two awaits
    // later, so this sequence left a rewritten secret with no evidence.
    mocks.tx.auditLog.create.mockRejectedValueOnce(new Error("audit down"));
    let committed = true;
    mocks.prisma.$transaction.mockImplementationOnce(
      async (callback: (client: unknown) => unknown) => {
        try {
          return await callback(mocks.tx);
        } catch (error) {
          committed = false; // what a real ROLLBACK does to the upsert above
          throw error;
        }
      },
    );

    await expect(
      setIntegrationCredential({
        provider: "stripe",
        key: "secret_key",
        value: SECRET,
        actor: ADMIN,
        expect: { expect: "any" },
      }),
    ).rejects.toThrow("audit down");

    expect(committed).toBe(false);
  });

  it("audits a delete only when a row was actually removed", async () => {
    // Verify-reset fires on every credential write whether or not a marker was
    // ever stamped. A row per no-op would bury the real deletions — and a read
    // that changes nothing must make no mutation audit noise at all.
    mocks.tx.integrationCredential.deleteMany.mockResolvedValueOnce({
      count: 0,
    });

    await deleteIntegrationCredential({
      provider: "google",
      key: "verified_at",
      actor: ADMIN,
      expect: { expect: "any" },
    });

    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("a stale concurrent write loses deterministically (#2723)", () => {
  it("refuses a create-only write when a row is already there", async () => {
    const winner = storedRow("stripe", "secret_key", "winner-value");
    mocks.tx.integrationCredential.create.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    mocks.tx.integrationCredential.findUnique.mockResolvedValue(winner);

    const error = await setIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      value: SECRET,
      actor: ADMIN,
      expect: { expect: "absent" },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(StaleCredentialWriteError);
    expect((error as StaleCredentialWriteError).observedVersion).toBe(
      credentialVersionOf(winner),
    );
    // The loser wrote nothing, so it recorded nothing.
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("loses a true create race without reading from the aborted transaction", async () => {
    // The row appears BETWEEN the pre-check and the insert, so the unique
    // violation fires. A failed statement aborts the PostgreSQL transaction, and
    // reading the winner from inside it would replace this writer's clean
    // "you lost" with a 25P02 about a transaction it can no longer use — so the
    // version is reported as unknown and the caller re-reads instead.
    mocks.tx.integrationCredential.findUnique.mockResolvedValue(null);
    mocks.tx.integrationCredential.create.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const error = await setIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      value: SECRET,
      actor: ADMIN,
      expect: { expect: "absent" },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(StaleCredentialWriteError);
    expect((error as StaleCredentialWriteError).observedVersion).toBeNull();
    // Exactly one read: the pre-check. None after the failed insert.
    expect(mocks.tx.integrationCredential.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses a compare-and-set whose version has moved", async () => {
    const moved = storedRow("stripe", "secret_key", "somebody-elses-value");
    mocks.tx.integrationCredential.findUnique.mockResolvedValue(moved);

    const error = await setIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      value: SECRET,
      actor: ADMIN,
      expect: { expect: "version", version: "a-version-that-is-no-longer-stored" },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(StaleCredentialWriteError);
    expect((error as StaleCredentialWriteError).observedVersion).toBe(
      credentialVersionOf(moved),
    );
    expect(mocks.tx.integrationCredential.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("applies a matching compare-and-set, claiming the exact tuple it read", async () => {
    const current = storedRow("stripe", "secret_key", "current-value");
    mocks.tx.integrationCredential.findUnique.mockResolvedValue(current);
    mocks.tx.integrationCredential.updateMany.mockResolvedValue({ count: 1 });

    await setIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      value: SECRET,
      actor: ADMIN,
      expect: { expect: "version", version: credentialVersionOf(current) },
    });

    expect(mocks.tx.integrationCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider: "stripe",
          key: "secret_key",
          ciphertext: current.ciphertext,
          iv: current.iv,
          authTag: current.authTag,
        }),
      }),
    );
    expect(mocks.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("loses when the claim matches nothing, even though the version agreed", async () => {
    // The window between reading the row and claiming it. Postgres re-evaluates
    // the predicate after taking the row lock, so of two writers holding the
    // same token exactly one sees `count: 1`.
    const current = storedRow("stripe", "secret_key", "current-value");
    mocks.tx.integrationCredential.findUnique.mockResolvedValue(current);
    mocks.tx.integrationCredential.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      setIntegrationCredential({
        provider: "stripe",
        key: "secret_key",
        value: SECRET,
        actor: ADMIN,
        expect: { expect: "version", version: credentialVersionOf(current) },
      }),
    ).rejects.toBeInstanceOf(StaleCredentialWriteError);
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses a versioned delete whose row was replaced under it", async () => {
    // Removing nothing means two different things. Under `any` it is the common
    // no-op (see the verify-reset case above); under `version` the row was there
    // a statement ago and somebody replaced it since, so the delete LOST and
    // says so rather than returning as though it had succeeded.
    const current = storedRow("stripe", "secret_key", "current-value");
    const winner = storedRow("stripe", "secret_key", "winners-value");
    mocks.tx.integrationCredential.findUnique
      .mockResolvedValueOnce(current)
      .mockResolvedValue(winner);
    mocks.tx.integrationCredential.deleteMany.mockResolvedValueOnce({ count: 0 });

    const error = await deleteIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      actor: ADMIN,
      expect: { expect: "version", version: credentialVersionOf(current) },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(StaleCredentialWriteError);
    expect((error as StaleCredentialWriteError).observedVersion).toBe(
      credentialVersionOf(winner),
    );
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("CLAIMS the whole stored tuple in the delete's own `where`", async () => {
    // The delete's claim clause had no test at all. Its two outcomes were
    // driven entirely by the mocked row count, so the predicate could have been
    // deleted outright and every test in this file still passed — which is
    // exactly how it went unnoticed that it named the ciphertext alone.
    const current = storedRow("stripe", "secret_key", "current-value");
    mocks.tx.integrationCredential.findUnique.mockResolvedValue(current);
    mocks.tx.integrationCredential.deleteMany.mockResolvedValue({ count: 1 });

    await deleteIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      actor: ADMIN,
      expect: { expect: "version", version: credentialVersionOf(current) },
    });

    // ALL THREE ENCRYPTED COLUMNS, the same tuple `applyCredentialWrite`
    // claims. AES-GCM over an EMPTY plaintext produces an empty ciphertext
    // whatever the IV, so a ciphertext-only claim is vacuous for a credential
    // holding "" — the stale writer would match the winner's row, delete it,
    // and report success. The iv and authTag are fresh on every encrypt.
    expect(mocks.tx.integrationCredential.deleteMany).toHaveBeenCalledWith({
      where: {
        provider: "stripe",
        key: "secret_key",
        ciphertext: current.ciphertext,
        iv: current.iv,
        authTag: current.authTag,
      },
    });
    expect(mocks.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("claims NOTHING beyond the identity when the delete is unconditional", async () => {
    // The other half of the discrimination: under `any` there is no version to
    // be stale against, so adding the tuple to the predicate would turn a
    // deliberate unconditional delete into a compare-and-set nobody asked for.
    mocks.tx.integrationCredential.deleteMany.mockResolvedValue({ count: 1 });

    await deleteIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      actor: ADMIN,
      expect: { expect: "any" },
    });

    expect(mocks.tx.integrationCredential.deleteMany).toHaveBeenCalledWith({
      where: { provider: "stripe", key: "secret_key" },
    });
  });

  it("AES-GCM over an empty plaintext really does produce an empty ciphertext", () => {
    // The measurement the claim above exists for, pinned rather than asserted
    // in a comment. If a future cipher or envelope change makes an empty value
    // produce distinguishing ciphertext, this fails and the reasoning written
    // across the store, the invariant and the attack-surface page can be
    // re-read rather than silently believed.
    const first = encryptCredential({
      provider: "stripe",
      key: "secret_key",
      plaintext: "",
      label: INTEGRATION_CREDENTIAL_LABEL,
    });
    const second = encryptCredential({
      provider: "stripe",
      key: "secret_key",
      plaintext: "",
      label: INTEGRATION_CREDENTIAL_LABEL,
    });
    expect(first.ciphertext).toBe("");
    expect(second.ciphertext).toBe("");
    // ...and the two columns that DO discriminate it.
    expect(first.iv).not.toBe(second.iv);
    expect(first.authTag).not.toBe(second.authTag);
  });

  it("types a delete-path error so it cannot claim the expectation a delete forbids", () => {
    // A COMPILE-TIME claim, exercised at runtime only so it is not dead code.
    // `StaleCredentialWriteError` is generic over its expectation, and the
    // delete path instantiates it at `CredentialDeleteExpectation`. This
    // exhaustive switch has no `default` and a non-optional return type, so it
    // compiles ONLY while that field really is the two-case union: widen the
    // error's expectation back to `CredentialWriteExpectation` and `npm run
    // typecheck` fails here, which is how this stays true.
    function describeDeleteOutcome(
      error: StaleCredentialWriteError<CredentialDeleteExpectation>,
    ): string {
      switch (error.expectation.expect) {
        case "version":
          return "the row moved under a writer holding a token";
        case "any":
          return "the row was gone";
      }
    }

    expect(
      describeDeleteOutcome(
        new StaleCredentialWriteError({
          provider: "stripe",
          key: "secret_key",
          expectation: { expect: "any" },
          observedVersion: null,
        }),
      ),
    ).toBe("the row was gone");
  });

  it("mints a different version for the same plaintext written twice", async () => {
    // What makes the tuple a usable version at all: a fresh random IV per
    // encrypt, so re-saving an unchanged value still invalidates a held token.
    const first = storedRow("stripe", "secret_key", "same-value");
    const second = storedRow("stripe", "secret_key", "same-value");
    expect(credentialVersionOf(first)).not.toBe(credentialVersionOf(second));
  });

  it("does not leak the stored tuple through the version token", async () => {
    // The store's exposure contract (#2079) keeps ciphertext, iv and authTag on
    // the server, and a version token is exactly the sort of value a future
    // route hands a browser as an `If-Match`.
    const row = storedRow("stripe", "secret_key", "value");
    const version = credentialVersionOf(row);
    expect(version).toMatch(/^[0-9a-f]{64}$/);
    expect(version).not.toContain(row.ciphertext);
    expect(version).not.toContain(row.iv);
    expect(version).not.toContain(row.authTag);
  });
});

// ---------------------------------------------------------------------------

describe("no plaintext reaches audit, log or error output (#2723)", () => {
  /**
   * Everything the store emitted this test, as one searchable string.
   *
   * AN ERROR IS SERIALISED THE WAY THE LOGGER WOULD SERIALISE IT, own
   * enumerable properties and all. `JSON.stringify` alone renders an Error as
   * `{}`, so the first draft picked out name, message and stack by hand — and
   * that is a narrower view than anything downstream actually takes. Every
   * error this module throws carries extra own fields (`provider`, `key`,
   * `expectation`, `observedVersion`, `operation`, `received`), and a standard
   * pino-style `err` serialiser emits exactly those. None can hold a credential
   * value today; the point is that this proof would not have FAILED if one
   * started to — an error attaching its caller's params object would have slid
   * straight past. The spread is what closes that, and the self-test below
   * proves the spread is doing something.
   */
  function everythingEmitted(extra: unknown[] = []): string {
    return JSON.stringify([
      mocks.tx.auditLog.create.mock.calls,
      mocks.prisma.auditLog.create.mock.calls,
      mocks.logger.error.mock.calls,
      mocks.logger.warn.mock.calls,
      mocks.logger.info.mock.calls,
      mocks.logger.debug.mock.calls,
      extra.map((value) =>
        value instanceof Error
          ? {
              // The spread FIRST, so the three non-enumerable fields below win
              // over anything of the same name an error happens to carry.
              ...value,
              name: value.name,
              message: value.message,
              stack: value.stack,
            }
          : value,
      ),
    ]);
  }

  it("SEES a value parked in an error's own property, not just its message", () => {
    // The instrument's own discrimination test. Against the hand-picked
    // name/message/stack view this fails, which is the whole finding: the proof
    // below could not have caught a plaintext travelling as an error field.
    const error = Object.assign(new Error("nothing to see here"), {
      params: { value: SECRET },
    });
    expect(everythingEmitted([error])).toContain(SECRET);
  });

  it("reads the fields the store's own errors really carry", () => {
    // Not a hypothetical shape: this is what a caught StaleCredentialWriteError
    // hands a logger, and every one of these fields is now inside the search.
    const error = new StaleCredentialWriteError({
      provider: "stripe",
      key: "secret_key",
      expectation: { expect: "any" },
      observedVersion: "abc123",
    });
    const emitted = everythingEmitted([error]);
    expect(emitted).toContain("abc123");
    expect(emitted).toContain("secret_key");
  });

  it("keeps the value out of a successful write's audit row", async () => {
    const result = await setIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      value: SECRET,
      actor: ADMIN,
      expect: { expect: "any" },
    });

    expect(mocks.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(everythingEmitted([result])).not.toContain(SECRET);
    // And the metadata is the small typed evidence set, not an echo of the call.
    expect(
      Object.keys(
        mocks.tx.auditLog.create.mock.calls[0]?.[0]?.data?.metadata ?? {},
      ).sort(),
    ).toEqual([
      "actorKind",
      "expectation",
      "key",
      "labelVersion",
      "provider",
      "systemActor",
      // NOT `secretSource`: `sanitizeAuditMetadata` redacts any key whose
      // normalised form contains "secret", so that spelling stored [REDACTED]
      // on every row and threw away the one field an operator planning an
      // auth-secret rotation reads. The value is an env var name, not a secret.
      "wrappingKeySource",
    ]);
  });

  it("names the wrapping key source in a form the audit redactor keeps", async () => {
    await setIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      value: SECRET,
      actor: ADMIN,
      expect: { expect: "any" },
    });

    const metadata = mocks.tx.auditLog.create.mock.calls[0]?.[0]?.data
      ?.metadata as Record<string, unknown>;
    expect(metadata.wrappingKeySource).toBe("AUTH_SECRET");
    expect(sanitizeAuditMetadata(metadata)).toMatchObject({
      wrappingKeySource: "AUTH_SECRET",
    });
  });

  it("stores NO wrapping-key field on a delete, rather than a redaction marker", async () => {
    // A delete wraps nothing, so there is no wrapping key to name. The field
    // used to be written as null under a name the redactor swallowed, which
    // stored `[REDACTED]` where the truth is "not applicable" — a reader would
    // take that as a value deliberately hidden from them.
    mocks.tx.integrationCredential.deleteMany.mockResolvedValue({ count: 1 });
    await deleteIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      actor: ADMIN,
      expect: { expect: "any" },
    });

    const metadata = mocks.tx.auditLog.create.mock.calls[0]?.[0]?.data
      ?.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      "actorKind",
      "expectation",
      "key",
      "provider",
      "systemActor",
    ]);
    expect(JSON.stringify(sanitizeAuditMetadata(metadata))).not.toContain(
      "REDACTED",
    );
  });

  it("keeps the value out of a database failure", async () => {
    mocks.tx.integrationCredential.upsert.mockRejectedValueOnce(
      new Error("could not connect to server"),
    );
    const error = await setIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      value: SECRET,
      actor: ADMIN,
      expect: { expect: "any" },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(everythingEmitted([error])).not.toContain(SECRET);
  });

  it("keeps the value out of a lost concurrency race", async () => {
    const moved = storedRow("stripe", "secret_key", "somebody-elses-value");
    mocks.tx.integrationCredential.findUnique.mockResolvedValue(moved);
    const error = await setIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      value: SECRET,
      actor: ADMIN,
      expect: { expect: "version", version: "stale" },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(StaleCredentialWriteError);
    expect(everythingEmitted([error])).not.toContain(SECRET);
  });

  it("keeps the value out of a refused actor's error, which echoes the actor", async () => {
    // `CredentialActorError` deliberately quotes what it was handed, so this is
    // the one error in the module that echoes a caller's data at all. What it
    // echoes is the ACTOR, which by construction holds no secret.
    const error = await setIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      value: SECRET,
      actor: { kind: "nonsense" } as never,
      expect: { expect: "any" },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CredentialActorError);
    expect((error as CredentialActorError).message).toContain("nonsense");
    expect(everythingEmitted([error])).not.toContain(SECRET);
  });

  it("emits nothing at all through the logger", async () => {
    // The store has no logger call, which is the point: a redaction rule living
    // in the logger is blind to every door that never calls it, so the store
    // opens no such door rather than relying on one being watched.
    await setIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      value: SECRET,
      actor: ADMIN,
      expect: { expect: "any" },
    });
    await deleteIntegrationCredential({
      provider: "stripe",
      key: "secret_key",
      actor: ADMIN,
      expect: { expect: "any" },
    });

    expect(mocks.logger.error).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();
    expect(mocks.logger.debug).not.toHaveBeenCalled();
  });
});
