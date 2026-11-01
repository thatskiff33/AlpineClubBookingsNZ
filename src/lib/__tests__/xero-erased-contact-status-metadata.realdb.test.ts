/**
 * Real-PostgreSQL proof of #4657: the erased-member contact status check
 * stamps its observation without losing a concurrent writer's metadata keys.
 *
 * Before the fix `recordObservation` read each retired Member CONTACT link's
 * metadata with `findMany`, then wrote back a spread of what it had read. A
 * writer that merged a key into the same link between that read and that write
 * lost it. The race below holds the observation writer after its read, lets the
 * other writer merge and finish, then releases the observation's write: the
 * interleaving that lost the key. The observation now goes through the link
 * funnel's one-statement merge (#4445), so both keys survive.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4657-`
 * links (no foreign key, so no other fixture).
 */
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const PREFIX = "race-4657-";
const CONTACT_ID = `${PREFIX}contact`;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let check: typeof import("@/lib/xero-erased-member-contact-status-check");
let mergeModule: typeof import("@/lib/xero-object-link-metadata-merge");

const OBSERVATION = { contactStatus: "ARCHIVED", observedAt: "2026-07-01T00:00:00.000Z" } as const;

/** A store whose `findMany` returns its rows and then waits at `afterRead`. */
function holdingAfterRead(afterRead: () => Promise<void>): Pick<Prisma.TransactionClient, "xeroObjectLink" | "$executeRaw"> {
  const links = new Proxy(prisma.xeroObjectLink, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "findMany") {
        return async (args: Parameters<typeof target.findMany>[0]) => {
          const rows = await target.findMany(args);
          await afterRead();
          return rows;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { xeroObjectLink: links, $executeRaw: prisma.$executeRaw.bind(prisma) } as Pick<Prisma.TransactionClient, "xeroObjectLink" | "$executeRaw">;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

(RUN ? describe : describe.skip)(
  "the erased-member status check keeps a concurrent writer's link metadata - real PostgreSQL (#4657)",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { startsWith: PREFIX } } });
    }
    const createLink = (metadata: Prisma.InputJsonValue | undefined) =>
      prisma.xeroObjectLink.create({
        data: {
          localModel: "Member", localId: `${PREFIX}member`, xeroObjectType: "CONTACT", xeroObjectId: CONTACT_ID, role: "CONTACT",
          active: false, ...(metadata === undefined ? {} : { metadata }),
        },
      });
    const storedMetadata = async () =>
      (await prisma.xeroObjectLink.findFirstOrThrow({ where: { xeroObjectId: CONTACT_ID }, select: { metadata: true } })).metadata;

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Erased-member contact status metadata");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      check = await import("@/lib/xero-erased-member-contact-status-check");
      mergeModule = await import("@/lib/xero-object-link-metadata-merge");
      await deleteFixtures();
    }, 60_000);

    beforeEach(async () => {
      await deleteFixtures();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    it("another writer merging a key after the observation's read and before its write keeps both keys (race)", async () => {
      await createLink({ linkedVia: "email_match" });
      const read = deferred();
      const otherDone = deferred();

      const observing = check.recordObservation(
        CONTACT_ID,
        OBSERVATION,
        holdingAfterRead(async () => {
          read.resolve();
          await otherDone.promise;
        }),
      );
      const other = (async () => {
        await read.promise;
        const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { xeroObjectId: CONTACT_ID }, select: { id: true } });
        const merge = mergeModule.planXeroObjectLinkMetadataMerge({ refundNote: "kept" }, { refundNote: "kept" });
        await mergeModule.mergeXeroObjectLinkMetadata(prisma, link.id, merge!);
        otherDone.resolve();
      })();
      await Promise.all([observing, other]);

      expect(await storedMetadata()).toEqual({
        linkedVia: "email_match",
        refundNote: "kept",
        [check.ERASED_CONTACT_REVIEW_METADATA_KEY]: OBSERVATION,
      });
    });

    it.each([
      ["no metadata", undefined],
      ["an array", [1, 2]],
      ["a string", "legacy"],
    ] as Array<[string, Prisma.InputJsonValue | undefined]>)("stored %s: the observation is written whole, as the spread wrote it", async (_label, stored) => {
      await createLink(stored);

      await check.recordObservation(CONTACT_ID, OBSERVATION);

      expect(await storedMetadata()).toEqual({ [check.ERASED_CONTACT_REVIEW_METADATA_KEY]: OBSERVATION });
    });

    it("an active link of the same contact is not stamped", async () => {
      await prisma.xeroObjectLink.create({
        data: { localModel: "Member", localId: `${PREFIX}live`, xeroObjectType: "CONTACT", xeroObjectId: CONTACT_ID, role: "CONTACT", active: true, metadata: { linkedVia: "created" } },
      });

      await check.recordObservation(CONTACT_ID, OBSERVATION);

      expect(await storedMetadata()).toEqual({ linkedVia: "created" });
    });
  },
);
