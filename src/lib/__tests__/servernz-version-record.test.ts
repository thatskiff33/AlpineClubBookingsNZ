import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { stripComments } from "./support/strip-comments";

/**
 * The REAL connection fence (#4366, #4436; the Other lodges download since the
 * #4262 review): `serverNzAnswerWriter` and `recordServerVersionIfCurrent`
 * run through one transaction that locks the settings row, re-reads the stored
 * address and API-key credential version, and runs the write only while both
 * are the request's. The sync suite mocks this module, so the fence itself is
 * pinned here; servernz-version-record-race.realdb.test.ts and
 * servernz-connection-race.realdb.test.ts force it against PostgreSQL.
 */

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  baseUrl: "https://central.test" as string | null,
  credentialVersion: "v-1" as string | null,
  invalidate: vi.fn(),
  record: vi.fn(),
  transactionOptions: [] as unknown[],
}));

const tx = {
  serverNzSettings: {
    findUnique: vi.fn(async () => {
      mocks.order.push("read address");
      return mocks.baseUrl === null ? null : { baseUrl: mocks.baseUrl };
    }),
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (fn: (client: unknown) => Promise<unknown>, options: unknown) => {
      mocks.transactionOptions.push(options);
      return fn(tx);
    },
  },
}));
vi.mock("@/lib/servernz-settings", () => ({
  SERVERNZ_SETTINGS_ID: "default",
  SERVERNZ_TRANSACTION_OPTIONS: { timeout: 150_000, maxWait: 10_000 },
  lockServerNzSettings: async () => {
    mocks.order.push("lock settings");
  },
  recordServerVersionCheck: async (...args: unknown[]) => {
    mocks.order.push("record");
    mocks.record(...args);
  },
}));
vi.mock("@/lib/servernz-config", () => ({
  SERVERNZ_PROVIDER: "servernz",
  readServerNzCredentialVersion: async () => {
    mocks.order.push("read credential version");
    return mocks.credentialVersion;
  },
}));
vi.mock("@/lib/integration-credentials", () => ({
  invalidateProviderCredentialCache: (...args: unknown[]) => mocks.invalidate(...args),
}));

import {
  ServerNzConnectionChangedError,
  recordServerVersionIfCurrent,
  serverNzAnswerWriter,
} from "@/lib/servernz-version-record";

const SENT_ON = { baseUrl: "https://central.test", credentialVersion: "v-1" };

beforeEach(() => {
  mocks.order.length = 0;
  mocks.transactionOptions.length = 0;
  mocks.baseUrl = "https://central.test";
  mocks.credentialVersion = "v-1";
  mocks.invalidate.mockReset();
  mocks.record.mockReset();
});

describe("serverNzAnswerWriter (the connection fence)", () => {
  it("locks, re-reads the connection, and only then runs the write, in one bounded transaction", async () => {
    const write = serverNzAnswerWriter(SENT_ON);
    const work = vi.fn(async (client: unknown) => {
      mocks.order.push("write");
      expect(client).toBe(tx);
      return "written";
    });

    await expect(write(work)).resolves.toBe("written");

    expect(mocks.order).toEqual(["lock settings", "read address", "read credential version", "write"]);
    expect(mocks.transactionOptions).toEqual([{ timeout: 150_000, maxWait: 10_000 }]);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it.each([
    ["the address moved", () => { mocks.baseUrl = "https://other.test"; }],
    ["the address was removed", () => { mocks.baseUrl = null; }],
    ["the key was replaced (a new credential version)", () => { mocks.credentialVersion = "v-2"; }],
    ["the key was removed", () => { mocks.credentialVersion = null; }],
  ])("refuses when %s: throws, never runs the write, and drops the cached credential", async (_case, change) => {
    change();
    const work = vi.fn();

    await expect(serverNzAnswerWriter(SENT_ON)(work)).rejects.toBeInstanceOf(ServerNzConnectionChangedError);

    expect(work).not.toHaveBeenCalled();
    expect(mocks.order[0]).toBe("lock settings");
    expect(mocks.invalidate).toHaveBeenCalledWith("servernz");
  });
});

describe("recordServerVersionIfCurrent (the same fence)", () => {
  it("records the version for the stored connection", async () => {
    await expect(recordServerVersionIfCurrent(SENT_ON, "2.6")).resolves.toBe(true);
    expect(mocks.record).toHaveBeenCalledWith("2.6", expect.any(Date), tx);
  });

  it("records nothing, and says so, once the connection changed", async () => {
    mocks.credentialVersion = "v-2";
    await expect(recordServerVersionIfCurrent(SENT_ON, "2.6")).resolves.toBe(false);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledWith("servernz");
  });
});

/**
 * A light census (#4262 review): the Other lodges download and merge reach the
 * global client for READS only. Every write they make from a central-server
 * answer goes through the fenced writer's transaction client, so a future
 * unfenced write on `prisma.` fails here.
 */
describe("the download and merge write only through the fence (reads on the global client; every audit row on a passed client)", () => {
  const READS = new Set(["findUnique", "findMany", "findFirst", "count", "$queryRaw"]);

  it.each(["src/lib/servernz-other-lodges-sync.ts", "src/lib/servernz-other-lodges-merge.ts"])(
    "%s calls the global prisma client for reads only",
    (file) => {
      const source = stripComments(readFileSync(path.join(process.cwd(), file), "utf8"));
      const calls = [...source.matchAll(/\bprisma\.(\$?\w+)(?:\.(\w+))?/g)].map(([, first, second]) =>
        first.startsWith("$") ? first : (second ?? first),
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter((call) => !READS.has(call))).toEqual([]);
    },
  );

  // A helper whose client DEFAULTS to the global one is a write the census
  // above cannot see. `recordOtherLodgesDownload` has no default (a missing
  // client does not compile); `createAuditLog` does, so every call here must
  // pass one: the fenced transaction's.
  it.each(["src/lib/servernz-other-lodges-sync.ts", "src/lib/servernz-other-lodges-merge.ts"])(
    "%s passes a client to every createAuditLog call",
    (file) => {
      const source = stripComments(readFileSync(path.join(process.cwd(), file), "utf8"));
      const unfenced: string[] = [];
      let calls = 0;
      let index = source.indexOf("createAuditLog(");
      while (index !== -1) {
        calls++;
        // The call's own arguments, split at its top-level commas.
        const args: string[] = [];
        let depth = 0;
        let current = "";
        let end = index + "createAuditLog".length;
        for (; end < source.length; end++) {
          const character = source[end];
          if (character === "(" || character === "{" || character === "[") {
            depth++;
            if (depth === 1) continue;
          } else if (character === ")" || character === "}" || character === "]") {
            depth--;
            if (depth === 0) break;
          } else if (character === "," && depth === 1) {
            args.push(current.trim());
            current = "";
            continue;
          }
          current += character;
        }
        args.push(current.trim());
        if (args.filter((arg) => arg !== "").length < 2) unfenced.push(source.slice(index, index + 60));
        index = source.indexOf("createAuditLog(", end);
      }
      expect(unfenced).toEqual([]);
      if (file.endsWith("merge.ts")) expect(calls).toBeGreaterThan(0);
    },
  );
});
