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

const PENDING_WRITERS: Readonly<Record<string, string>> = {
  "src/lib/xero-outbox-pending-request.ts":
    "the one guarded write: the outbox's cooldown and busy-wait give-backs, every Retry requeue and the kept late-capture requeues go through it",
  "src/lib/xero-operation-outbox.ts":
    "releaseWaitingSupplementaryInvoiceOperations: WAITING_PAYMENT rows were never dispatched, so they hold the queued request their enqueue wrote",
  "src/lib/organiser-extra-netting.ts":
    "releaseOrganiserExtraRefundNotes: WAITING_PAYMENT rows, never dispatched, holding their enqueue's queued request",
  "src/lib/xero-operation-queue.ts":
    "an officer's REQUEUE row handed back on a busy wait: it has no queue type and the outbox never scans it",
};

/** A `data: { ... status: "PENDING" ... }` with no nested object before the status. */
const PENDING_DATA = /data:\s*\{[^{}]*?status:\s*"PENDING"/;

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(relative);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

describe("Xero operation PENDING writers (#5228)", () => {
  it("every file that writes status PENDING onto a Xero operation row is named, with why its request stays claimable", () => {
    const writers = [...sourceFiles("src"), ...sourceFiles("scripts")].filter((file) => {
      const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
      return /xeroSyncOperation/i.test(text) && PENDING_DATA.test(text);
    });
    expect(writers.sort()).toEqual(Object.keys(PENDING_WRITERS).sort());
  });
});
