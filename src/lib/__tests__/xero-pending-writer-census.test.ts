/**
 * #5228 (`INV-INT-025`): every write that puts a Xero operation row back on
 * PENDING, by file, each with why the request it leaves is one the outbox can
 * claim and send. A row the outbox cannot claim is skipped on every pass and
 * nothing alerts, so a new writer is named here - and, for an outbound row
 * with a queue type, routed through `returnOutboxRowToPending` - before it
 * lands. Enqueues (`startXeroSyncOperation` with `status: "PENDING"`) are not
 * listed: they write the queue type column from the same queued request.
 *
 * Reads source from disk, so `test:related` cannot select it; run it with
 * `pnpm run test:named` (docs/TESTING.md).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** Each file's count of PENDING writes, with why the request each leaves stays claimable. */
const PENDING_WRITERS: Readonly<Record<string, { writes: number; why: string }>> = {
  "src/lib/xero-outbox-pending-request.ts": {
    writes: 1,
    why: "the one guarded write: the outbox's cooldown and busy-wait give-backs, every Retry requeue and the kept late-capture requeues go through it",
  },
  "src/lib/xero-supplementary-invoice-revive.ts": {
    writes: 1,
    why: "a retired supplementary invoice revived CANCELLED -> PENDING, matched on its queue type column, refused when its request does not read as one",
  },
  "src/lib/xero-operation-outbox.ts": {
    writes: 1,
    why: "releaseWaitingSupplementaryInvoiceOperations: WAITING_PAYMENT rows were never dispatched, so they hold the queued request their enqueue wrote",
  },
  "src/lib/organiser-extra-netting.ts": {
    writes: 1,
    why: "releaseOrganiserExtraRefundNotes: WAITING_PAYMENT rows, never dispatched, holding their enqueue's queued request",
  },
  "src/lib/xero-operation-queue.ts": {
    writes: 1,
    why: "an officer's REQUEUE row handed back on a busy wait: it has no queue type and the outbox never scans it",
  },
};

const PENDING_STATUS = /status:\s*"PENDING"/g;
const WHERE_OR_DATA = /\b(where|data)\s*:/g;

/** The `status: "PENDING"` that sit in a write's `data` (the nearest `where:`/`data:` before each is `data:`). */
function pendingWrites(text: string): number {
  let writes = 0;
  for (const status of text.matchAll(PENDING_STATUS)) {
    const before = [...text.slice(0, status.index).matchAll(WHERE_OR_DATA)].at(-1);
    if (before?.[1] === "data") writes += 1;
  }
  return writes;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(relative);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

describe("Xero operation PENDING writers (#5228)", () => {
  it("every PENDING write onto a Xero operation row is counted per file and named, with why its request stays claimable", () => {
    const writers = Object.fromEntries(
      [...sourceFiles("src"), ...sourceFiles("scripts")].flatMap((file) => {
        const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
        const writes = /xeroSyncOperation/i.test(text) ? pendingWrites(text) : 0;
        return writes > 0 ? [[file, writes]] : [];
      }),
    );
    expect(writers).toEqual(Object.fromEntries(Object.entries(PENDING_WRITERS).map(([file, { writes }]) => [file, writes])));
  });
});
