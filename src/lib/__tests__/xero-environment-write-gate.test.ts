import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * INV-CONFIG-005: an installation that has not declared itself writes NOTHING to
 * Xero (ENV-SAFETY 3, #3036; epic #2986).
 *
 * WHY A GATE AND NOT A CENSUS. Seven surfaces of this product asserted that an
 * undeclared installation writes nothing to Xero, and that was false: the
 * contact funnel refused, and every writer that does not go through the funnel
 * carried on — a membership-cancellation credit note, contact-group membership
 * from `/api/profile`, archiving a contact, voiding an invoice, recording a
 * payment, deallocating applied credit, re-pricing a booking invoice. A census
 * of those would have closed the ones that exist today; a gate inside
 * `callXeroApi` closes the one somebody writes next month, which is the whole
 * argument `INV-CONFIG-004` made for putting the delivery boundary inside
 * `sendEmail` rather than at eighty-seven callers.
 *
 * READS ARE DELIBERATELY ALLOWED. A read changes nothing in the club's books and
 * cannot make Xero email anybody, and an operator diagnosing "why has this
 * installation stopped writing to Xero" needs the Xero screens here to keep
 * loading. So the operator copy says "written", never "reached", and this suite
 * pins both halves.
 */

const mocks = vi.hoisted(() => ({
  environmentSafetySettings: { findUnique: vi.fn() },
  recordXeroApiUsage: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { environmentSafetySettings: mocks.environmentSafetySettings },
}));
vi.mock("@/lib/xero-api-usage", () => ({
  recordXeroApiUsage: mocks.recordXeroApiUsage,
}));

import { callXeroApi } from "@/lib/xero-api-client";
import {
  assertXeroProviderWriteAllowed,
  isXeroProviderMutation,
  XeroContactEnvironmentUnknownError,
} from "@/lib/xero-environment-write-gate";
import {
  declareEnvironmentRole,
  expectEnvironmentRolePremise,
  undeclareEnvironmentRole,
} from "@/lib/__tests__/helpers/environment-role";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.environmentSafetySettings.findUnique.mockResolvedValue(null);
  mocks.recordXeroApiUsage.mockResolvedValue(undefined);
});

describe("classifying a Xero operation", () => {
  it("treats every get* operation as a read", () => {
    for (const operation of [
      "getContact",
      "getContacts",
      "getInvoice",
      "getInvoices",
      "getCreditNote",
      "getPayment",
      "getItems",
      "getAccounts",
      "getOrganisations",
      "getOnlineInvoice",
      "getContactGroup",
      "getContactGroups",
      "getReportProfitAndLoss",
      "getReportBalanceSheet",
      "getReportBankSummary",
    ]) {
      expect(isXeroProviderMutation(operation), operation).toBe(false);
    }
  });

  it("treats everything else as a mutation, including a name nobody has written yet", () => {
    for (const operation of [
      "createContacts",
      "updateContact",
      "updateOrCreateContacts",
      "createInvoices",
      "updateInvoice",
      "createCreditNotes",
      "createCreditNoteAllocation",
      "deleteCreditNoteAllocations",
      "createPayment",
      "createPayments",
      "createContactGroupContacts",
      "deleteContactGroupContact",
      "emailInvoice",
      // The point of the fail-closed direction: none of these exists in this
      // repository today, and an allowlist of known write verbs would have let
      // every one of them through.
      "postInvoices",
      "putContact",
      "createInvoicez",
      "getawayFromTheGate",
      "GETINVOICES",
    ]) {
      expect(isXeroProviderMutation(operation), operation).toBe(true);
    }
  });
});

describe("the gate itself", () => {
  it("refuses a mutation while the role is UNKNOWN, naming the variable to set", async () => {
    undeclareEnvironmentRole();
    await expectEnvironmentRolePremise("UNKNOWN");
    await expect(
      assertXeroProviderWriteAllowed("createInvoices"),
    ).rejects.toThrow(XeroContactEnvironmentUnknownError);
    await expect(
      assertXeroProviderWriteAllowed("createInvoices"),
    ).rejects.toThrow(/APP_ENVIRONMENT_ROLE/);
  });

  it("says WRITTEN rather than reached, because reading still works", async () => {
    undeclareEnvironmentRole();
    let message = "";
    try {
      await assertXeroProviderWriteAllowed("createInvoices");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Nothing was written to Xero");
    expect(message).toContain("Reading from Xero is unaffected");
  });

  it("allows a read while the role is UNKNOWN, and spends no role read on it", async () => {
    undeclareEnvironmentRole();
    await expect(
      assertXeroProviderWriteAllowed("getInvoices"),
    ).resolves.toBeUndefined();
    expect(
      mocks.environmentSafetySettings.findUnique,
      "a read must not even ask the resolver: the answer cannot change its outcome",
    ).not.toHaveBeenCalled();
  });

  for (const role of ["production", "non-production"] as const) {
    it(`allows a mutation on a declared ${role} installation`, async () => {
      declareEnvironmentRole(role);
      await expectEnvironmentRolePremise(
        role === "production" ? "PRODUCTION" : "NON_PRODUCTION",
      );
      await expect(
        assertXeroProviderWriteAllowed("createInvoices"),
      ).resolves.toBeUndefined();
    });
  }
});

describe("callXeroApi is where it runs", () => {
  it("refuses the call, never invokes the request, and meters nothing", async () => {
    undeclareEnvironmentRole();
    await expectEnvironmentRolePremise("UNKNOWN");
    const request = vi.fn();
    await expect(
      callXeroApi(request, {
        operation: "createInvoices",
        resourceType: "INVOICE",
        workflow: "test",
      }),
    ).rejects.toThrow(XeroContactEnvironmentUnknownError);
    expect(request).not.toHaveBeenCalled();
    /*
      Nothing was attempted, so nothing belongs in the quota ledger. A refused
      call recorded as a failed API call would make the usage surface report
      provider trouble where there is none, and would count against the daily
      budget an operator is looking at.
    */
    expect(mocks.recordXeroApiUsage).not.toHaveBeenCalled();
  });

  it("still runs a read on an undeclared installation", async () => {
    undeclareEnvironmentRole();
    const request = vi.fn().mockResolvedValue("contacts");
    await expect(
      callXeroApi(request, {
        operation: "getContacts",
        resourceType: "CONTACT",
        workflow: "test",
      }),
    ).resolves.toBe("contacts");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("runs a mutation once the role is declared", async () => {
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    const request = vi.fn().mockResolvedValue("created");
    await expect(
      callXeroApi(request, {
        operation: "createInvoices",
        resourceType: "INVOICE",
        workflow: "test",
      }),
    ).resolves.toBe("created");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

/**
 * The classifier is only as good as the names it is fed, so the names are
 * censused.
 *
 * `test:related` CANNOT select this block: it reads the repository from disk, so
 * it has no import edge to the files it scans. Run it explicitly, and expect CI
 * to be the backstop (`docs/TESTING.md`).
 */
describe("every operation name this repository passes to callXeroApi", () => {
  const SCAN_ROOTS = ["src", "scripts"].map((root) =>
    path.resolve(process.cwd(), root),
  );
  const EXTENSIONS = new Set([".ts", ".tsx", ".mjs"]);

  function walk(dir: string, out: string[] = []): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".next") continue;
      // Test helper: walks fixed repository roots; `entry` comes from readdir.
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (EXTENSIONS.has(path.extname(full))) out.push(full);
    }
    return out;
  }

  const files = SCAN_ROOTS.flatMap((root) => walk(root)).filter(
    (file) =>
      !file.split(path.sep).includes("__tests__") &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
  );
  const operations = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const [, name] of source.matchAll(/\boperation:\s*"([^"]+)"/g)) {
      operations.add(name);
    }
  }

  it("scans a real tree, so nothing below is an empty-list tautology", () => {
    expect(files.length).toBeGreaterThan(1000);
    // Measured on the tree this shipped with: about thirty distinct names.
    expect(operations.size).toBeGreaterThan(20);
    expect(operations).toContain("createInvoices");
    expect(operations).toContain("getInvoices");
  });

  it("classifies every one of them the way the Xero SDK names it", () => {
    /*
      The classifier is fail-closed: anything not beginning with `get` is a
      mutation. That is the safe direction, and it has one cost — a READER whose
      name does not begin with `get` would be refused in production on an
      undeclared installation while doing nothing that needed refusing. So every
      name is listed here as one or the other, and adding a `list`-prefixed
      reader fails this case rather than a customer's Xero screen.
    */
    const KNOWN_READS = [
      "getAccounts",
      "getAuthenticatedXeroClient",
      "getContact",
      "getContactGroup",
      "getContactGroups",
      "getContacts",
      "getCreditNote",
      "getInvoice",
      "getInvoices",
      "getItems",
      "getOnlineInvoice",
      "getOrganisations",
      "getPayment",
      "getReportBalanceSheet",
      "getReportBankSummary",
      "getReportProfitAndLoss",
    ];
    const KNOWN_WRITES = [
      "createContactGroupContacts",
      "createContacts",
      "createCreditNoteAllocation",
      "createCreditNotes",
      "createInvoices",
      "createPayment",
      "createPayments",
      "createXeroMembershipCancellationCreditNote",
      "deleteContactGroupContact",
      "deleteCreditNoteAllocations",
      "emailInvoice",
      "updateContact",
      "updateInvoice",
    ];
    const unclassified = [...operations].filter(
      (name) => !KNOWN_READS.includes(name) && !KNOWN_WRITES.includes(name),
    );
    expect(
      unclassified,
      "A new Xero operation name has appeared. Add it to KNOWN_READS or " +
        "KNOWN_WRITES above, and check isXeroProviderMutation agrees: the gate " +
        "treats anything not beginning with `get` as a write, so a READER named " +
        "otherwise would be refused on an undeclared installation for no reason " +
        "(INV-CONFIG-005).",
    ).toEqual([]);
    for (const name of KNOWN_READS) {
      expect(isXeroProviderMutation(name), name).toBe(false);
    }
    for (const name of KNOWN_WRITES) {
      expect(isXeroProviderMutation(name), name).toBe(true);
    }
  });

  it("keeps the gate inside callXeroApi, ahead of the retry ladder and the meter", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/xero-api-client.ts"),
      "utf8",
    );
    const start = source.indexOf("export async function callXeroApi<T>(");
    expect(start, "callXeroApi must still be defined here").toBeGreaterThan(-1);
    const rest = source.slice(start);
    const body = rest.slice(0, rest.indexOf("\n}\n"));
    expect(body.length, "its body must be bounded, not a signature").toBeGreaterThan(
      400,
    );
    const gateAt = body.indexOf("assertXeroProviderWriteAllowed(");
    const retryAt = body.indexOf("withXeroRetry(");
    const meterAt = body.indexOf("persistMeteredXeroApiUsage(");
    expect(gateAt, "the gate must be inside callXeroApi").toBeGreaterThan(-1);
    expect(retryAt).toBeGreaterThan(-1);
    expect(meterAt).toBeGreaterThan(-1);
    expect(
      gateAt,
      "the gate must run BEFORE the retry ladder: a refused call was never sent",
    ).toBeLessThan(retryAt);
    expect(
      gateAt,
      "and before the usage row: nothing was attempted, so nothing is metered",
    ).toBeLessThan(meterAt);
  });
});
