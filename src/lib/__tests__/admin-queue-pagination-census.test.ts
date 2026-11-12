/**
 * Every officer queue that reads a row-capped admin route pages through it
 * (INV-OPS-017, #4960).
 *
 * #297 capped these routes at one page; the screens kept reading only the
 * first page with no total, so the oldest requests were silently out of
 * reach. This census walks every client file under `src/`, finds each one
 * that fetches a capped queue route, and requires it to page through the
 * shared hook and render the shared `Pagination`. A file reading one of these
 * routes for something other than its list must be named in `NOT_A_QUEUE_LIST`
 * with the reason. The routes themselves must answer through `adminListPage`
 * so every client reads the same keys.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

/**
 * Each capped officer queue route, and the source files that build its
 * response: the route itself or the lib function it hands the read to.
 */
const CAPPED_QUEUE_ROUTES: Record<string, readonly string[]> = {
  "/api/admin/member-applications": ["src/app/api/admin/member-applications/route.ts"],
  "/api/admin/refund-requests": ["src/app/api/admin/refund-requests/route.ts"],
  "/api/admin/booking-reviews": ["src/app/api/admin/booking-reviews/route.ts"],
  "/api/admin/booking-change-requests": ["src/app/api/admin/booking-change-requests/route.ts"],
  "/api/admin/booking-requests": ["src/app/api/admin/booking-requests/route.ts"],
  "/api/admin/membership-cancellation-requests": ["src/lib/membership-cancellation-admin.ts"],
  "/api/admin/member-lifecycle-action-requests": ["src/lib/member-lifecycle-actions.ts"],
  "/api/admin/booking-exception-requests": ["src/lib/booking-exception-request-service.ts"],
  "/api/admin/deletion-requests": ["src/app/api/admin/deletion-requests/route.ts"],
};

/** Client files that read a capped queue route without listing its rows. */
const NOT_A_QUEUE_LIST: Record<string, string> = {
  "src/app/(admin)/admin/booking-requests/page.tsx":
    "reads `total` with pageSize=1 for the tab badges; the panels list the rows",
};

const SHARED_HOOK = "@/components/admin/use-admin-queue-page";
const SHARED_PAGER = "@/components/admin/admin-pagination";

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      files.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function isClientFile(source: string): boolean {
  return /^\s*["']use client["']/.test(source);
}

/** The capped routes a file names as a fetch target (the collection, not a record). */
function cappedRoutesRead(code: string): string[] {
  return Object.keys(CAPPED_QUEUE_ROUTES).filter((route) =>
    new RegExp(`${route.replace(/[/-]/g, "\\$&")}(?=[?"'\`])`).test(code),
  );
}

function queueReaders(): Map<string, string[]> {
  const readers = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    if (!isClientFile(source)) continue;
    const routes = cappedRoutesRead(stripComments(source));
    if (routes.length > 0) readers.set(relative(file), routes);
  }
  return readers;
}

/** What a queue list must do to reach every row; empty when it does. */
function queuePagingGaps(code: string): string[] {
  const gaps: string[] = [];
  if (!code.includes(`"${SHARED_HOOK}"`) || !/\buseAdminQueuePage\s*\(/.test(code)) {
    gaps.push("pages through useAdminQueuePage");
  }
  if (!code.includes(`"${SHARED_PAGER}"`) || !/<Pagination\b/.test(code)) {
    gaps.push("renders the shared Pagination");
  }
  return gaps;
}

describe("row-capped officer queues page through every row (INV-OPS-017)", () => {
  const readers = queueReaders();

  it("finds a reader for every capped route, so an empty walk cannot pass", () => {
    const covered = new Set([...readers.values()].flat());
    expect([...covered].sort()).toEqual(Object.keys(CAPPED_QUEUE_ROUTES).sort());
  });

  it("enumerates the queue lists it polices", () => {
    const lists = [...readers.keys()].filter((file) => !(file in NOT_A_QUEUE_LIST)).sort();
    expect(lists).toEqual([
      "src/app/(admin)/admin/deletion-requests/deletion-requests-client.tsx",
      "src/app/(admin)/admin/finance/refund-requests/page.tsx",
      "src/app/(admin)/admin/member-applications/page.tsx",
      "src/app/(admin)/admin/membership-cancellations/page.tsx",
      "src/components/admin/booking-requests/booking-approvals-panel.tsx",
      "src/components/admin/booking-requests/booking-change-requests-panel.tsx",
      "src/components/admin/booking-requests/policy-exception-requests-panel.tsx",
      "src/components/admin/booking-requests/public-booking-requests-panel.tsx",
    ]);
  });

  it("every queue list pages through the shared hook and renders Pagination", () => {
    const failures = [...readers.keys()]
      .filter((file) => !(file in NOT_A_QUEUE_LIST))
      .flatMap((file) => {
        const code = stripComments(readFileSync(path.join(ROOT, file), "utf8"));
        return queuePagingGaps(code).map((gap) => `${file}: ${gap}`);
      });
    expect(failures).toEqual([]);
  });

  it("each exemption still reads a capped route and gives a reason", () => {
    for (const [file, reason] of Object.entries(NOT_A_QUEUE_LIST)) {
      expect(existsSync(path.join(ROOT, file)), `${file} is gone; drop its exemption`).toBe(true);
      expect(readers.has(file), `${file} no longer reads a capped route; drop its exemption`).toBe(true);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("every capped route answers through adminListPage", () => {
    const failures = Object.entries(CAPPED_QUEUE_ROUTES).flatMap(([route, files]) => {
      const answers = files.some((file) =>
        /\badminListPage\s*\(/.test(stripComments(readFileSync(path.join(ROOT, file), "utf8"))),
      );
      return answers ? [] : [route];
    });
    expect(failures).toEqual([]);
  });

  it("the gap check fails a list with no pager (mutation canary)", () => {
    const panel = stripComments(
      readFileSync(
        path.join(SRC, "components/admin/booking-requests/booking-approvals-panel.tsx"),
        "utf8",
      ),
    );
    expect(queuePagingGaps(panel)).toEqual([]);
    expect(queuePagingGaps(panel.replace(/<Pagination\b/g, "<Paginatio"))).toEqual([
      "renders the shared Pagination",
    ]);
    expect(queuePagingGaps(panel.replace(/\buseAdminQueuePage\s*\(/g, "useState("))).toEqual([
      "pages through useAdminQueuePage",
    ]);
  });
});

/** The one module allowed to compute a range or read a raw page number. */
const LIST_PAGE_HELPER = "src/lib/admin-list-page.ts";

/** Hand-rolled first-row arithmetic: `(page - 1) * pageSize + 1`. */
const RANGE_START = /\(\s*[\w.]*[pP]age\s*-\s*1\s*\)\s*\*\s*[\w.]+\s*\+\s*1/;

/** A client read of a list page from the URL. */
const PAGE_PARAM_READ = /\.get\(\s*["'](?:page|archivePage|inPage|opPage)["']\s*\)/g;

/** A hand-rolled page-URL write: `if (page > 1) params.set("page", ...)`. */
const PAGE_PARAM_WRITE = /if\s*\(\s*[\w.]+\s*>\s*1\s*\)\s*[\w.]+\.set\(\s*["'](?:page|archivePage|inPage|opPage)["']/;

/** Files that read a page key without parsing it, with the reason. */
const RAW_PAGE_READS: Record<string, string> = {
  "src/components/admin/booking-filters.tsx":
    "carries the URL's page value through a filter change verbatim; the bookings page parses it",
};

/** Raw page-key reads in a file that `parseAdminListPageParam` does not wrap. */
function unparsedPageReads(code: string): string[] {
  return [...code.matchAll(PAGE_PARAM_READ)]
    .filter((match) => !/parseAdminListPageParam\(\s*[\w.]+$/.test(code.slice(0, match.index)))
    .map((match) => match[0]);
}

describe("admin lists share the page parser and range text (INV-OPS-017)", () => {
  // API routes read `page` through their zod schema (`adminListPageQueryFields`).
  const files = sourceFiles(SRC)
    .map(relative)
    .filter((file) => file !== LIST_PAGE_HELPER && !file.startsWith("src/app/api/"));
  const code = new Map(files.map((file) => [file, stripComments(readFileSync(path.join(ROOT, file), "utf8"))]));

  it("no list computes its own first-row number; formatAdminListRange does", () => {
    expect(files.filter((file) => RANGE_START.test(code.get(file)!))).toEqual([]);
  });

  it("every page number read from the URL goes through parseAdminListPageParam", () => {
    const failures = files
      .filter((file) => !(file in RAW_PAGE_READS))
      .flatMap((file) => unparsedPageReads(code.get(file)!).map((read) => `${file}: ${read}`));
    expect(failures).toEqual([]);
  });

  it("every page written into a URL goes through setAdminListPageParam", () => {
    expect(files.filter((file) => PAGE_PARAM_WRITE.test(code.get(file)!))).toEqual([]);
  });

  it("enumerates the lists that parse a page key, so an empty walk cannot pass", () => {
    const parsing = files.filter((file) => /\bparseAdminListPageParam\(/.test(code.get(file)!)).sort();
    expect(parsing).toEqual([
      "src/app/(admin)/admin/finance/payments/page.tsx",
      "src/app/(admin)/admin/finance/refund-requests/page.tsx",
      "src/app/(admin)/admin/finance/subscriptions/page.tsx",
      "src/app/(admin)/admin/finance/xero/_components/inbound-events-panel.tsx",
      "src/app/(admin)/admin/finance/xero/_components/operations-panel.tsx",
      "src/app/(admin)/admin/member-applications/page.tsx",
      "src/app/(admin)/admin/members/_hooks/use-members-query-state.ts",
      "src/app/(admin)/admin/membership-cancellations/page.tsx",
      "src/app/(admin)/admin/system/audit-log/page.tsx",
      "src/app/(admin)/admin/waitlist/page.tsx",
      "src/components/admin/booking-requests/booking-approvals-panel.tsx",
      "src/components/admin/booking-requests/booking-change-requests-panel.tsx",
      "src/components/admin/booking-requests/public-booking-requests-panel.tsx",
    ]);
  });

  it("each raw-read exemption still reads a page key and gives a reason", () => {
    for (const [file, reason] of Object.entries(RAW_PAGE_READS)) {
      expect(code.has(file), `${file} is gone; drop its exemption`).toBe(true);
      expect(unparsedPageReads(code.get(file)!).length, `${file} parses its page now; drop its exemption`).toBeGreaterThan(0);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("the checks fail a hand-rolled range and an unparsed read (mutation canary)", () => {
    expect(RANGE_START.test("const start = (page - 1) * pageSize + 1")).toBe(true);
    expect(RANGE_START.test("const start = (pagination.page - 1) * pagination.pageSize + 1")).toBe(true);
    expect(unparsedPageReads('parseAdminListPageParam(searchParams.get("opPage"))')).toEqual([]);
    expect(unparsedPageReads('Number(searchParams.get("opPage"))')).toEqual(['.get("opPage")']);
    expect(PAGE_PARAM_WRITE.test('if (page > 1) params.set("page", String(page))')).toBe(true);
    expect(PAGE_PARAM_WRITE.test('if (archivePageNumber > 1) queueParams.set("archivePage", "2")')).toBe(true);
  });
});
