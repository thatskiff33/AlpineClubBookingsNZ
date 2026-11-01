/**
 * #4374 (`INV-INT-029`, `INV-INT-025`): a Xero success that lands on an
 * operation row an officer already resolved in Xero keeps landing, links and
 * all, keeps the mark, and warns and alerts the officers once per operation -
 * after the completion's transaction commits, never inside it or on rollback.
 *
 * Driven through the real `completeXeroSyncOperation` and its outcome guard,
 * on an in-memory row the guard's `where` is evaluated against
 * (`matchesWhere`). The once-ever claim is a fake that holds keys in a set, so
 * a repeat is refused as `sendAdminAlertOnceEver` would refuse it.
 *
 * The census at the end pins every caller that hands the writer its own
 * transaction (`store`, in any spelling, the shorthand `{ store }` included):
 * each either runs the returned `deferredPostCommit` after its commit or writes
 * no SUCCEEDED outcome. It refuses options it cannot read as text - a
 * variable, a call, a spread of a name - since those could carry `store` unseen.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { XeroSyncOperation } from "@prisma/client";
import { matchesWhere } from "./support/prisma-where";
import { blankLiterals, stripComments } from "./support/strip-comments";
import { balancedBrackets } from "./support/balanced-brackets";
import { xeroClaim } from "./helpers/xero-claim";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(),
  upsert: vi.fn(), claim: vi.fn(), send: vi.fn(), warn: vi.fn(), repeatedFailure: vi.fn(),
}));
const store = {
  xeroSyncOperation: { updateMany: mocks.updateMany, findUnique: mocks.findUnique, findUniqueOrThrow: mocks.findUniqueOrThrow },
  xeroObjectLink: { upsert: mocks.upsert },
};
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/alert-cooldown", () => ({
  ALERT_ONCE_EVER_WINDOW_MS: 1_000_000,
  ALERT_NOBODY_ELIGIBLE_RETRY_MS: 1000,
  claimAlertCooldown: mocks.claim,
  deferAlertCooldown: vi.fn(async () => undefined), releaseAlertCooldown: vi.fn(async () => undefined),
}));
vi.mock("@/lib/email", () => ({ sendAdminXeroSyncErrorAlert: mocks.send }));
vi.mock("@/lib/logger", () => ({ default: { warn: mocks.warn, error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/xero-hardening", () => ({ maybeNotifyXeroRepeatedFailure: mocks.repeatedFailure }));

import { completeXeroSyncOperation } from "@/lib/xero-sync";
import { xeroSuccessAfterResolutionAlertKey } from "@/lib/xero-success-after-resolution-alert";
import { CREDIT_SPENT_OUTSIDE_APP_RESOLUTION_REASON } from "@/lib/xero-applied-credit-spent-outside-app";

const OPERATION_ID = "op-late";
const link = { localModel: "Payment", localId: "payment-late", xeroObjectType: "PAYMENT", xeroObjectId: "pay-late", role: "STRIPE_PAYMENT" };
const completion = { xeroObjectType: "PAYMENT", xeroObjectId: "pay-late", extraLinks: [link] };

describe("#4374: a success landing after an officer resolved the operation in Xero", () => {
  let row: XeroSyncOperation;
  let committed: boolean;
  const held = new Set<string>();

  beforeEach(() => {
    vi.clearAllMocks();
    held.clear();
    row = {
      id: OPERATION_ID, status: "FAILED", startedAt: null, lastErrorCode: null,
      operationType: "CREATE", entityType: "PAYMENT", localModel: "Payment", localId: "payment-late",
      xeroObjectType: null, xeroObjectId: null, xeroObjectNumber: null,
      manuallyResolvedAt: new Date("2026-07-01T00:00:00.000Z"), manuallyResolvedById: "officer-1", manuallyResolvedReason: "Raised by hand",
    } as XeroSyncOperation;
    committed = false;
    mocks.updateMany.mockImplementation(async ({ where, data }) => {
      if (!matchesWhere(row, where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    });
    mocks.findUnique.mockImplementation(async () => ({ ...row }));
    mocks.findUniqueOrThrow.mockImplementation(async () => ({ ...row }));
    mocks.transaction.mockImplementation(async (fn) => {
      const result = await fn(store);
      committed = true;
      return result;
    });
    // Delivery is only ever after commit: a claim or send inside the transaction fails the test.
    mocks.claim.mockImplementation(async ({ key }) => {
      expect(committed).toBe(true);
      if (held.has(key)) return false;
      held.add(key);
      return true;
    });
    mocks.send.mockImplementation(async () => {
      expect(committed).toBe(true);
      return { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0 };
    });
  });

  it.each(["FAILED", "PARTIAL"])(
    "lands on a resolved %s row, keeps its links and the mark, and alerts once across repeats",
    async (status) => {
      row.status = status;
      await expect(completeXeroSyncOperation(xeroClaim(OPERATION_ID), completion)).resolves.toMatchObject({
        status: "SUCCEEDED", xeroObjectId: "pay-late", manuallyResolvedReason: "Raised by hand",
      });
      await completeXeroSyncOperation(xeroClaim(OPERATION_ID), completion);

      expect(mocks.upsert).toHaveBeenCalledTimes(2);
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining(link) }));
      expect(row.manuallyResolvedAt).toEqual(new Date("2026-07-01T00:00:00.000Z"));
      expect(mocks.warn).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: OPERATION_ID, xeroObjectId: "pay-late" }),
        expect.stringContaining("hold the item twice"),
      );
      expect(mocks.claim).toHaveBeenCalledTimes(2);
      expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ key: xeroSuccessAfterResolutionAlertKey(OPERATION_ID) }));
      expect(mocks.send).toHaveBeenCalledTimes(1);
      expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
        errorType: "XERO_SUCCESS_AFTER_RESOLUTION",
        operation: "CREATE PAYMENT for Payment payment-late (outbox operation op-late)",
        errorMessage: expect.stringMatching(/"Resolved in Xero".*PAYMENT pay-late.*made by hand.*check Xero before voiding/),
      }));
    },
  );

  it("names the adoption case and never claims the mark stays", async () => {
    await completeXeroSyncOperation(xeroClaim(OPERATION_ID), completion);
    const { errorMessage } = mocks.send.mock.calls[0]![0] as { errorMessage: string };
    // The late call may have found and used the officer's own document by its reference: one document, not two.
    expect(errorMessage).toContain("found and used the one made by hand (same reference)");
    expect(errorMessage).toContain("may now hold it twice");
    // The resolve route can withdraw a mark it has just written (retry overlap), so the alert never promises it stays.
    expect(errorMessage).not.toMatch(/stays marked/);
  });

  // An applied-credit run allocates through child operations and a deallocation
  // records nothing, so a success with no object id can still have changed Xero.
  it("still alerts when the success recorded no Xero object, and names no earlier object", async () => {
    const result = await completeXeroSyncOperation(xeroClaim(OPERATION_ID), { responsePayload: { skipped: true } });
    expect(result).toMatchObject({ status: "SUCCEEDED", xeroObjectId: null, manuallyResolvedReason: "Raised by hand" });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: OPERATION_ID, xeroObjectId: null }),
      expect.stringContaining("hold the item twice"),
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const { errorMessage } = mocks.send.mock.calls[0]![0] as { errorMessage: string };
    expect(errorMessage).toContain("it recorded no Xero object id, but it may still have made or changed items in Xero");
  });

  it("hands an injected transaction's owner the alert when the success recorded no Xero object", async () => {
    const result = await completeXeroSyncOperation(xeroClaim(OPERATION_ID), {}, { store: store as never });
    expect(result?.status).toBe("SUCCEEDED");
    expect(result?.deferredPostCommit).toBeTypeOf("function");
  });

  it("says the credit ledger and Xero may disagree, not that anything was made by hand, on a row the app closed (#4219)", async () => {
    Object.assign(row, {
      manuallyResolvedById: null,
      manuallyResolvedReason: CREDIT_SPENT_OUTSIDE_APP_RESOLUTION_REASON,
    });
    await completeXeroSyncOperation(xeroClaim(OPERATION_ID), completion);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const { errorMessage } = mocks.send.mock.calls[0]![0] as { errorMessage: string };
    expect(errorMessage).toMatch(/^The app closed this Xero operation \("Closed: credit used outside the app"\)/);
    expect(errorMessage).toContain("PAYMENT pay-late");
    expect(errorMessage).toContain("The credit ledger and Xero may now disagree");
    expect(errorMessage).not.toMatch(/by hand|twice|void/);
  });

  it("keeps the made-by-hand wording for an officer's mark that quotes the credit-spent prefix", async () => {
    // `isClosedByCreditSpentOutsideApp` needs no officer on the mark; an officer's reason alone is still an officer's mark.
    row.manuallyResolvedReason = CREDIT_SPENT_OUTSIDE_APP_RESOLUTION_REASON;
    await completeXeroSyncOperation(xeroClaim(OPERATION_ID), completion);
    const { errorMessage } = mocks.send.mock.calls[0]![0] as { errorMessage: string };
    expect(errorMessage).toContain("made by hand");
  });

  it("raises nothing for an ordinary success on an unresolved row", async () => {
    row.manuallyResolvedAt = null;
    row.manuallyResolvedById = null;
    row.manuallyResolvedReason = null;
    const result = await completeXeroSyncOperation(xeroClaim(OPERATION_ID), completion);
    expect(result?.status).toBe("SUCCEEDED");
    expect(result).not.toHaveProperty("deferredPostCommit");
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("raises nothing for a PARTIAL outcome on a resolved row", async () => {
    await completeXeroSyncOperation(xeroClaim(OPERATION_ID), { status: "PARTIAL" });
    expect(row.status).toBe("PARTIAL");
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("raises nothing when the success is refused for a later claim's RUNNING row", async () => {
    Object.assign(row, { status: "RUNNING", startedAt: new Date("2026-07-01T00:05:00.000Z") });
    await expect(completeXeroSyncOperation(xeroClaim(OPERATION_ID), completion)).resolves.toBeNull();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("hands an injected transaction's owner the alert, run only when the owner calls it", async () => {
    const result = await completeXeroSyncOperation(xeroClaim(OPERATION_ID), completion, { store: store as never });
    expect(result?.status).toBe("SUCCEEDED");
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(result?.deferredPostCommit).toBeTypeOf("function");
    committed = true;
    await result?.deferredPostCommit?.();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("raises nothing when the completion's transaction rolls back", async () => {
    mocks.upsert.mockRejectedValueOnce(new Error("link write failed"));
    await expect(completeXeroSyncOperation(xeroClaim(OPERATION_ID), completion)).rejects.toThrow("link write failed");
    expect(committed).toBe(false);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("never throws into the caller when the alert cannot be sent", async () => {
    mocks.send.mockRejectedValueOnce(new Error("mail down"));
    await expect(completeXeroSyncOperation(xeroClaim(OPERATION_ID), completion)).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});

interface CompletionSite {
  file: string;
  /** The third argument, trimmed, or "" when there is none. */
  options: string;
  /** The whole argument list, to tell a CANCELLED-only completion. */
  args: string;
  after: string;
  returned: boolean;
}

/**
 * The options argument is read as text, so it must be one the census can read: an object literal with no spread of
 * a name, or a conditional choosing between such literals and `undefined`. Anything else - a variable, a call, a
 * spread of a name - could carry `store` unseen, so the census refuses it.
 */
const OPTIONS_LITERAL = String.raw`(?:\{[^{}]*\}|undefined)`;
const READABLE_OPTIONS = new RegExp(String.raw`^(?:\{[^{}]*\}|[\w.!\s]+\?\s*${OPTIONS_LITERAL}\s*:\s*${OPTIONS_LITERAL})$`);
function optionsAreReadable(options: string): boolean {
  return options === "" || (READABLE_OPTIONS.test(options) && !/\.\.\.\s*[\w$]/.test(options));
}

function callArguments(
  source: string,
  open: number,
  structure: string,
): { args: string[]; close: number } {
  const { parts: args, end: close } = balancedBrackets(source, open, structure);
  return { args, close };
}

/** Every `completeXeroSyncOperation(...)` call under `src/`, outside tests. */
function completionSites(): CompletionSite[] {
  const root = join(process.cwd(), "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(root);
  const sites: CompletionSite[] = [];
  for (const full of files) {
    const source = stripComments(readFileSync(full, "utf8"));
    if (!source.includes("completeXeroSyncOperation")) continue;
    // Calls are found over masked text: one named in a string is not a call.
    const structure = blankLiterals(source);
    for (const match of structure.matchAll(/\bcompleteXeroSyncOperation\s*\(/g)) {
      if (/function\s+$/.test(source.slice(0, match.index))) continue;
      const open = match.index + match[0].length - 1;
      const { args, close } = callArguments(source, open, structure);
      // To the end of the enclosing top-level function.
      const end = source.indexOf("\n}\n", close);
      sites.push({
        file: relative(process.cwd(), full).split("\\").join("/"),
        options: args[2] ?? "",
        args: args.join(", "),
        after: source.slice(close, end < 0 ? undefined : end),
        returned: /\breturn\s+$/.test(source.slice(0, match.index)),
      });
    }
  }
  return sites;
}

describe("#4374 census: a completion inside its caller's transaction delivers the alert after commit", () => {
  const sites = completionSites();
  // `\bstore\b`, not `store:`: the shorthand `{ store }` and `store ? { store } : undefined` pass it too.
  const storeSites = sites.filter((site) => /\bstore\b/.test(site.options));

  it("finds the writer's callers at all", () => {
    expect(sites.length).toBeGreaterThan(20);
  });

  it("reads every caller's options: a literal, never a variable, call or spread that could carry store unseen", () => {
    const opaque = sites.filter((site) => !optionsAreReadable(site.options));
    expect(opaque.map((site) => `${site.file}: ${site.options}`)).toEqual([]);
  });

  it("pins the files that complete a Xero operation inside their own transaction", () => {
    expect([...new Set(storeSites.map((site) => site.file))].sort()).toEqual([
      "src/lib/xero-contact-create-recovery.ts",
      "src/lib/xero-contacts.ts",
      "src/lib/xero-kept-late-capture-invoice.ts",
    ]);
  });

  it("each such caller writes no success, or returns the writer's answer and runs deferredPostCommit after commit", () => {
    const unhandled = storeSites.filter(
      (site) =>
        !/\bstatus\s*:\s*"CANCELLED"/.test(site.args) &&
        !(site.returned && /\?\.deferredPostCommit\?\.\(\)/.test(site.after)),
    );
    expect(unhandled.map((site) => site.file)).toEqual([]);
  });

  it("tells readable options from opaque ones", () => {
    expect(["", "{ store: tx }", "{ store }", "{ retryClaim: true, alert: false }", "store ? { store } : undefined",
      "input.retryClaim ? { retryClaim: true } : undefined"].filter((options) => !optionsAreReadable(options))).toEqual([]);
    expect(["options", "opts ?? undefined", "{ ...options }", "{ ...options, alert: false }", "buildOptions(tx)",
      "flag ? options : undefined"].filter(optionsAreReadable)).toEqual([]);
  });
});
