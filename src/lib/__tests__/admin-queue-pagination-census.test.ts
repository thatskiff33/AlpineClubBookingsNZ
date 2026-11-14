/**
 * Every officer queue that reads a row-capped admin route pages through it
 * (INV-OPS-019, #4960).
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

import { escapeRegExp } from "@/lib/escape-regexp";

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
};

/** Client files that read a capped queue route without listing its rows. */
const NOT_A_QUEUE_LIST: Record<string, string> = {
  "src/app/(admin)/admin/booking-requests/page.tsx":
    "reads `total` with pageSize=1 for the tab badges; the panels list the rows",
  "src/app/(admin)/admin/deletion-requests/deletion-requests-client.tsx":
    "the deletion queue already pages with its own pager; outside #4960's scope",
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
    new RegExp(`${escapeRegExp(route)}(?=[?"'\`])`).test(code),
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

describe("row-capped officer queues page through every row (INV-OPS-019)", () => {
  const readers = queueReaders();

  it("finds a reader for every capped route, so an empty walk cannot pass", () => {
    const covered = new Set([...readers.values()].flat());
    expect([...covered].sort()).toEqual(Object.keys(CAPPED_QUEUE_ROUTES).sort());
  });

  it("enumerates the queue lists it polices", () => {
    const lists = [...readers.keys()].filter((file) => !(file in NOT_A_QUEUE_LIST)).sort();
    expect(lists).toEqual([
      "src/app/(admin)/admin/finance/refund-requests/page.tsx",
      "src/app/(admin)/admin/membership/member-applications/page.tsx",
      "src/app/(admin)/admin/membership/membership-cancellations/page.tsx",
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
