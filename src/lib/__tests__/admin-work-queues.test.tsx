import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import { getRenderedAdminNavSections } from "@/components/admin-sidebar";
import {
  AdminWorkQueueCards,
  getAdminWorkQueueCards,
} from "@/components/admin/admin-work-queue-cards";
import { adminHref } from "@/lib/admin-hubs";
import { NEEDS_ATTENTION_LABEL } from "@/lib/admin-nav-panels";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionArea,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import {
  ADMIN_PENDING_COUNT_KEYS,
  ADMIN_WORK_QUEUES,
  ZERO_ADMIN_PENDING_COUNTS,
  adminWorkQueueBadges,
  adminWorkQueueCount,
  adminWorkQueuesByHref,
  type AdminPendingCounts,
  type AdminWorkQueue,
} from "@/lib/admin-work-queues";
import { requireCalendarDate } from "@/lib/club-time";

/*
  The officer work queue registry (#4962): the dashboard's attention cards and
  the sidebar's Needs Attention section are two renderings of one list, so for
  any counts, modules and permissions they show the same queues with the same
  numbers.
*/

const CLUB_DAY = requireCalendarDate("2026-07-01");

const allOn = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;
const allOff = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, false]),
) as FeatureFlags;

/** Every count set, each to a different number so sums are distinguishable. */
const EVERY_COUNT: AdminPendingCounts = {
  ...(Object.fromEntries(
    ADMIN_PENDING_COUNT_KEYS.map((key, index) => [key, index + 1]),
  ) as Record<(typeof ADMIN_PENDING_COUNT_KEYS)[number], number>),
  unavailable: [],
};

function matrix(
  levels: Partial<Record<AdminPermissionArea, "view" | "edit">>,
): AdminPermissionMatrix {
  return { ...emptyAdminPermissionMatrix(), ...levels };
}

function queue(key: string): AdminWorkQueue {
  const found = ADMIN_WORK_QUEUES.find((item) => item.key === key);
  if (!found) throw new Error(`no work queue ${key}`);
  return found;
}

/** The queues the dashboard shows as cards, by key, with their numbers. */
function dashboardQueues(
  counts: AdminPendingCounts,
  features: FeatureFlags,
  permissionMatrix: AdminPermissionMatrix,
) {
  return getAdminWorkQueueCards({
    counts,
    clubToday: CLUB_DAY,
    features,
    permissionMatrix,
  }).map((card) => [card.key, card.count] as const);
}

/** The queues the sidebar lists under Needs Attention, with their badges. */
function sidebarQueues(
  counts: AdminPendingCounts,
  features: FeatureFlags,
  permissionMatrix: AdminPermissionMatrix,
) {
  const badges = adminWorkQueueBadges(CLUB_DAY, counts);
  const byHref = adminWorkQueuesByHref(CLUB_DAY);
  const section = getRenderedAdminNavSections(
    CLUB_DAY,
    features,
    badges,
    permissionMatrix,
  ).find((item) => item.label === NEEDS_ATTENTION_LABEL);
  return (section?.items ?? []).map(
    (item) => [byHref.get(item.href)?.key ?? item.href, badges[item.href]] as const,
  );
}

describe("the officer work queue registry", () => {
  it("gives every queue a distinct key and href, and every count a queue", () => {
    const keys = ADMIN_WORK_QUEUES.map((item) => item.key);
    const hrefs = ADMIN_WORK_QUEUES.map((item) => item.href(CLUB_DAY));
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    // A count no queue reads would be computed and then shown nowhere.
    const read = new Set(ADMIN_WORK_QUEUES.flatMap((item) => item.counts));
    expect([...ADMIN_PENDING_COUNT_KEYS].filter((key) => !read.has(key))).toEqual([]);
  });

  it("sums all four Booking Requests terms and opens the first tab with work", () => {
    const bookingRequests = queue("booking-requests");
    const counts = {
      ...ZERO_ADMIN_PENDING_COUNTS,
      bookingReviews: 1,
      bookingChangeRequests: 2,
      newBookingPolicyExceptionRequests: 4,
      publicBookingRequests: 8,
    };
    expect(adminWorkQueueCount(bookingRequests, counts)).toBe(15);

    const onlyExceptions = {
      ...ZERO_ADMIN_PENDING_COUNTS,
      newBookingPolicyExceptionRequests: 1,
    };
    const [card] = getAdminWorkQueueCards({
      counts: onlyExceptions,
      clubToday: CLUB_DAY,
      features: allOn,
      permissionMatrix: matrix({ bookings: "view" }),
    });
    expect(card?.key).toBe("booking-requests");
    expect(card?.count).toBe(1);
    expect(card?.href).toContain("tab=exceptions");
    expect(card?.description).toBe(
      "1 policy exception request waiting for an officer's decision.",
    );
  });

  it("counts both deletion flows on one queue", () => {
    expect(
      adminWorkQueueCount(queue("deletion-requests"), {
        ...ZERO_ADMIN_PENDING_COUNTS,
        deletionRequests: 2,
        memberDeleteRequests: 3,
      }),
    ).toBe(5);
  });

  it("lists manual refund tasks as a Payments entry", () => {
    const tasks = queue("manual-refund-tasks");
    expect(tasks.href(CLUB_DAY)).toBe(adminHref("payments"));
    expect(tasks.counts).toEqual(["manualRefundTasks"]);
  });

  it("shows the Stuck States headline only to an officer with support access", () => {
    const counts = { ...ZERO_ADMIN_PENDING_COUNTS, stuckStatesAffected: 3 };
    for (const view of [dashboardQueues, sidebarQueues]) {
      expect(view(counts, allOn, matrix({ support: "view" }))).toEqual([
        ["stuck-states", 3],
      ]);
      expect(
        view(counts, allOn, matrix({ overview: "edit", finance: "edit" })),
      ).toEqual([]);
    }
  });

  it("names a queue whose count failed instead of hiding it", () => {
    const html = renderToStaticMarkup(
      <AdminWorkQueueCards
        counts={{ ...ZERO_ADMIN_PENDING_COUNTS, unavailable: ["issueReports"] }}
        clubToday={CLUB_DAY}
        features={allOn}
        permissionMatrix={matrix({ support: "view" })}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn&#x27;t load counts for Issue Reports");
  });
});

describe("dashboard and sidebar parity", () => {
  const viewers: Array<[string, AdminPermissionMatrix]> = [
    [
      "a full admin",
      matrix({
        overview: "edit",
        bookings: "edit",
        membership: "edit",
        finance: "edit",
        lodge: "edit",
        content: "edit",
        support: "edit",
      }),
    ],
    ["a bookings officer", matrix({ overview: "view", bookings: "edit" })],
    ["a membership officer", matrix({ overview: "view", membership: "edit" })],
    ["a treasurer", matrix({ overview: "view", finance: "edit" })],
    ["a lodge officer", matrix({ overview: "view", lodge: "edit" })],
    ["a support officer", matrix({ overview: "view", support: "view" })],
    ["an overview-only officer", matrix({ overview: "view" })],
  ];

  for (const [who, permissionMatrix] of viewers) {
    for (const [modules, features] of [
      ["every module on", allOn],
      ["every module off", allOff],
    ] as const) {
      it(`shows ${who} the same queues and numbers with ${modules}`, () => {
        const dashboard = dashboardQueues(EVERY_COUNT, features, permissionMatrix);
        expect(sidebarQueues(EVERY_COUNT, features, permissionMatrix)).toEqual(
          dashboard,
        );
        if (who === "a full admin" && features === allOn) {
          // With everything on and every queue non-empty, every queue shows.
          expect(dashboard.map(([key]) => key)).toEqual(
            ADMIN_WORK_QUEUES.map((item) => item.key),
          );
        }
      });
    }
  }

  it("hides an empty queue on both surfaces", () => {
    const counts = { ...ZERO_ADMIN_PENDING_COUNTS, issueReports: 1 };
    const fullAdmin = viewers[0]![1];
    expect(dashboardQueues(counts, allOn, fullAdmin)).toEqual([["issue-reports", 1]]);
    expect(sidebarQueues(counts, allOn, fullAdmin)).toEqual([["issue-reports", 1]]);
  });
});
