import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { adminHref, type AdminPageId } from "@/lib/admin-hubs";
import {
  ADMIN_PENDING_COUNT_KEYS,
  ADMIN_WORK_QUEUES,
} from "@/lib/admin-work-queues";
import { requireCalendarDate } from "@/lib/club-time";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

/*
  INV-SSOT-008 (#4962): the Admin Dashboard's attention cards and the sidebar's
  Needs Attention section render officer work queues ONLY from
  `ADMIN_WORK_QUEUES`, and read their numbers ONLY from `getAdminPendingCounts`.

  Before the registry each surface counted and linked its queues by hand and
  they drifted: the dashboard missed seven queues the sidebar showed, and
  counted Booking Requests with two terms where the sidebar used three. This
  census reads both files and fails on a queue wired around the registry: a
  queue table counted directly, a queue helper imported, a count read off the
  payload by name, or a queue page linked from the dashboard outside its card.
*/

const ROOT = process.cwd();
const DASHBOARD = "src/app/(admin)/admin/dashboard/page.tsx";
const SIDEBAR = "src/components/admin-sidebar.tsx";
const COUNTER = "src/lib/admin-pending-counts.ts";

/** The source without comments, so prose naming a queue is not a finding. */
function code(file: string): string {
  return stripComments(readFileSync(path.join(ROOT, file), "utf8"));
}

/** The Prisma models the counter counts queues in. */
function queueModels(): string[] {
  return [...code(COUNTER).matchAll(/prisma\.(\w+)\.count\(/g)].map(
    ([, model]) => model!,
  );
}

/**
 * The queue helpers the counter imports: everything it imports bar the
 * plumbing every server file shares.
 */
function queueHelpers(): string[] {
  const plumbing = new Set([
    "@/lib/logger",
    "@/lib/prisma",
    "@/lib/club-time/server",
    "@/lib/admin-work-queues",
  ]);
  return [...code(COUNTER).matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)]
    .filter(([, , from]) => !plumbing.has(from!))
    .flatMap(([, names]) =>
      names!
        .split(",")
        .map((name) => name.trim().replace(/^type\s+/, ""))
        .filter(Boolean),
    );
}

/**
 * Dashboard links to a queue's page that are NOT that queue's attention card,
 * and why. Anything else linking a queue page is a hand-wired card.
 */
const DASHBOARD_QUEUE_LINKS_ALLOWED: Record<string, string> = {
  "/admin/hut-leaders":
    "the Hut Leader officer card and the handovers card, not the coverage queue's card",
  [adminHref("payments")]:
    "the Net Collected revenue card, not the manual refund queue's card",
};

describe("officer work queue census (INV-SSOT-008)", () => {
  it("finds the counter's queue models and helpers to check against", () => {
    // A rename that empties these lists would pass every check below vacuously.
    expect(queueModels()).toEqual(
      expect.arrayContaining(["refundRequest", "deletionRequest", "issueReport"]),
    );
    expect(queueHelpers()).toEqual(
      expect.arrayContaining(["getStuckStateAffectedCount", "buildUnpaidFinishedStaysWhere"]),
    );
  });

  for (const file of [DASHBOARD, SIDEBAR]) {
    it(`${file} counts no queue table itself`, () => {
      // `booking` also backs the dashboard's own totals; its queue counts are
      // caught by the helper check below (the where-clause builders).
      const counted = queueModels().filter(
        (model) =>
          model !== "booking" && new RegExp(`prisma\\.${model}\\.count\\(`).test(code(file)),
      );
      expect(counted).toEqual([]);
    });

    it(`${file} uses no queue counter helper`, () => {
      const used = queueHelpers().filter((name) =>
        new RegExp(`\\b${name}\\b`).test(code(file)),
      );
      expect(used).toEqual([]);
    });

    it(`${file} reads no queue count by name`, () => {
      const keys = ADMIN_PENDING_COUNT_KEYS.join("|");
      const reads = [
        ...code(file).matchAll(new RegExp(`[cC]ounts\\??\\.(${keys})\\b`, "g")),
      ].map(([read]) => read);
      expect(reads).toEqual([]);
    });
  }

  it("builds the sidebar's Needs Attention items from the registry alone", () => {
    const source = code(SIDEBAR);
    const start = source.indexOf("label: NEEDS_ATTENTION_LABEL,");
    expect(start).toBeGreaterThan(-1);
    // The section runs to the next section's label.
    const end = source.indexOf("label:", start + 1);
    const section = source.slice(start, end);
    expect(section).toContain("ADMIN_WORK_QUEUES.map(");
    expect(section).not.toMatch(/href:\s*["'`]|adminLink\(|adminHref\(/);
  });

  it("links no queue page from the dashboard outside its attention card", () => {
    const clubDay = requireCalendarDate("2026-07-01");
    // A pre-filtered view (`paletteView`) lives on another page's path, so
    // only a page-of-its-own queue is matched by path; the views' href
    // builders are caught by the import check below.
    const queuePaths = new Set(
      ADMIN_WORK_QUEUES.filter((queue) => !queue.paletteView).map(
        (queue) => queue.href(clubDay).split("?")[0]!,
      ),
    );
    const source = code(DASHBOARD);
    const linked = [
      // The dashboard links parameterless pages only.
      ...[...source.matchAll(/adminHref\("([\w-]+)"\)/g)].map(([, id]) =>
        (adminHref as (page: AdminPageId) => string)(id as AdminPageId),
      ),
      ...[...source.matchAll(/["'`](\/admin\/[\w/-]+)/g)].map(([, href]) => href!),
    ];
    const strays = [...new Set(linked)].filter(
      (href) => queuePaths.has(href) && !(href in DASHBOARD_QUEUE_LINKS_ALLOWED),
    );
    expect(strays).toEqual([]);
  });

  it("builds no queue deep link outside the registry", () => {
    // The modules the registry builds its dated and tabbed queue links with.
    const builders = /from\s+"@\/lib\/(unpaid-finished-stays-hrefs|admin-booking-requests-path)"/;
    for (const file of [DASHBOARD, SIDEBAR]) {
      expect(code(file), file).not.toMatch(builders);
    }
  });
});
