/**
 * Real-PostgreSQL proof of #4445: two writers merging metadata onto one Xero
 * link both keep their keys.
 *
 * Before the fix the link funnel read the stored metadata with no row lock,
 * spread the incoming record over it and wrote the result, so two writers that
 * both read before either wrote ended with only the later writer's keys. The
 * merge is now one statement over the stored row. Each race below holds both
 * writers at the funnel's upsert until both have arrived, which is after the
 * old read and before either write: the interleaving that lost a key.
 *
 * It also pins the merge's meaning against the old spread, value for value,
 * across stored and incoming shapes the callers send.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4445-`
 * links (no foreign key, so no other fixture).
 */
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const PREFIX = "race-4445-";

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let xeroSync: typeof import("@/lib/xero-sync");

type LinkInput = import("@/lib/xero-sync").XeroObjectLinkInput;

/** The two non-refund writers that merge: neither takes a row lock before the funnel's own write. */
const LINKS = {
  "a school's Xero contact (linkedVia, then the contact-persons fingerprint)": {
    localModel: "Organisation", localId: `${PREFIX}school`, xeroObjectType: "CONTACT", xeroObjectId: `${PREFIX}contact`, role: "CONTACT",
    stored: { linkedVia: "created" },
    first: { contactPersonsFingerprint: "fp-1" },
    second: { organisationShapeApplied: true },
  },
  "a payment's primary invoice (the inbound cash-allocation count over the outbound keys)": {
    localModel: "Payment", localId: `${PREFIX}payment`, xeroObjectType: "INVOICE", xeroObjectId: `${PREFIX}invoice`, role: "PRIMARY_INVOICE",
    stored: { amountCents: 20_000 },
    first: { cashAllocationCount: 1 },
    second: { recountedAt: "2026-06-30T12:00:00.000Z" },
  },
} as const;
type LinkCase = (typeof LINKS)[keyof typeof LINKS];

function identity(link: LinkCase): Omit<LinkInput, "metadata" | "mergeMetadata"> {
  return { localModel: link.localModel, localId: link.localId, xeroObjectType: link.xeroObjectType, xeroObjectId: link.xeroObjectId, role: link.role };
}

/** Both writers wait here until both have arrived. */
function arrivalBarrier(parties: number) {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return async () => {
    arrived += 1;
    if (arrived === parties) open();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        opened,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("the other writer never reached the link upsert")), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The writer's own transaction client, its link upsert held at `arrive`. */
function holdingUpsert(tx: Prisma.TransactionClient, arrive: () => Promise<void>): Prisma.TransactionClient {
  const links = tx.xeroObjectLink;
  const heldLinks = new Proxy(links, {
    get(target, prop) {
      if (prop === "upsert") {
        return async (args: Parameters<typeof links.upsert>[0]) => {
          await arrive();
          return links.upsert(args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === "xeroObjectLink") return heldLinks;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function concurrentMerges(link: LinkCase, metadatas: Array<Record<string, unknown>>) {
  const arrive = arrivalBarrier(metadatas.length);
  return Promise.all(
    metadatas.map((metadata) =>
      prisma.$transaction(
        (tx) => xeroSync.upsertXeroObjectLink({ ...identity(link), metadata, mergeMetadata: true }, { store: holdingUpsert(tx, arrive) }),
        { timeout: 30_000 },
      ),
    ),
  );
}

async function storedMetadata(link: LinkCase) {
  const row = await prisma.xeroObjectLink.findUniqueOrThrow({
    where: { localModel_localId_xeroObjectType_xeroObjectId_role: identity(link) as never },
    select: { metadata: true },
  });
  return row.metadata;
}

/** The funnel's merge before #4445, kept here as the meaning the statement must reproduce. */
function preFixMerge(stored: unknown, incoming: unknown): unknown {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const storedRecord = isRecord(stored) ? stored : null;
  const incomingRecord = isRecord(incoming) ? incoming : null;
  const next = storedRecord || incomingRecord ? { ...(storedRecord ?? {}), ...(incomingRecord ?? {}) } : incoming;
  // Prisma leaves the column alone when the value is undefined.
  return next === undefined ? stored : xeroSync.sanitizeForJson(next);
}

(RUN ? describe : describe.skip)(
  "two writers merging metadata onto one Xero link both keep their keys - real PostgreSQL (#4445)",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { startsWith: PREFIX } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Xero link metadata merge");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      xeroSync = await import("@/lib/xero-sync");
      await deleteFixtures();
    }, 60_000);

    beforeEach(async () => {
      await deleteFixtures();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    it.each(Object.entries(LINKS))("%s: two merges that both started before either wrote keep every key (race)", async (_label, link) => {
      await prisma.xeroObjectLink.create({ data: { ...identity(link), active: true, metadata: link.stored } });

      const written = await concurrentMerges(link, [link.first, link.second]);

      const expected = { ...link.stored, ...link.first, ...link.second };
      expect(await storedMetadata(link)).toEqual(expected);
      // Each writer returns the row as it left it: the later one carries both.
      expect(written.map((row) => row.metadata)).toContainEqual(expected);
    });

    it.each(Object.entries(LINKS))("%s: two first writers of a missing link keep both keys (race)", async (_label, link) => {
      await concurrentMerges(link, [link.first, link.second]);

      expect(await storedMetadata(link)).toEqual({ ...link.first, ...link.second });
      expect(await prisma.xeroObjectLink.count({ where: { localId: link.localId } })).toBe(1);
    });

    it("a merge that rolls back with its caller leaves the stored metadata as it was", async () => {
      const link = LINKS["a school's Xero contact (linkedVia, then the contact-persons fingerprint)"];
      await prisma.xeroObjectLink.create({ data: { ...identity(link), active: true, metadata: link.stored } });

      await expect(prisma.$transaction(async (tx) => {
        await xeroSync.upsertXeroObjectLink({ ...identity(link), metadata: link.first, mergeMetadata: true }, { store: tx });
        throw new Error("rollback merge");
      })).rejects.toThrow("rollback merge");

      expect(await storedMetadata(link)).toEqual(link.stored);
    });

    const STORED: Array<[string, Prisma.InputJsonValue | undefined]> = [
      ["no metadata", undefined],
      ["an object", { kept: 1, nested: { x: 1 }, overridden: "old", cleared: "old", status: "VOIDED" }],
      ["an array", [1, 2]],
      ["a string", "legacy"],
    ];
    const INCOMING: Array<[string, unknown]> = [
      ["new keys over old, nested replaced whole, an explicit null", { overridden: "new", nested: { y: 2 }, added: null }],
      ["a key sent as undefined (the canonical-link heal's status)", { status: undefined, overridden: "new" }],
      ["a redacted key", { password: "not-a-real-password", total: 50 }],
      ["an empty record", {}],
      ["no metadata", undefined],
      ["an array", [3]],
    ];

    it.each(STORED.flatMap(([storedLabel, stored]) => INCOMING.map(([incomingLabel, incoming]) => [storedLabel, incomingLabel, stored, incoming] as const)))(
      "stored %s, incoming %s: the merge writes what the pre-#4445 spread wrote",
      async (_storedLabel, _incomingLabel, stored, incoming) => {
        const link = LINKS["a payment's primary invoice (the inbound cash-allocation count over the outbound keys)"];
        await prisma.xeroObjectLink.create({ data: { ...identity(link), active: true, ...(stored === undefined ? {} : { metadata: stored }) } });
        const before = await storedMetadata(link);

        const written = await xeroSync.upsertXeroObjectLink({ ...identity(link), metadata: incoming, mergeMetadata: true });

        const expected = preFixMerge(before, incoming) ?? null;
        expect(await storedMetadata(link)).toEqual(expected);
        expect(written.metadata).toEqual(expected);
      },
    );
  },
);
