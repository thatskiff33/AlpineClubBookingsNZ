import "server-only";

import type { SiteBannerPriority } from "@prisma/client";
import { formatDateOnly } from "@/lib/date-only";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { prisma } from "@/lib/prisma";

// Display order for stacked banners: most severe first.
const PRIORITY_RANK: Record<SiteBannerPriority, number> = {
  URGENT: 0,
  WARNING: 1,
  NOTIFY: 2,
};

// Past banners kept visible on the admin page. Older history stays in the
// database (and the audit log) but is not listed.
const PAST_BANNER_LIMIT = 50;

export type CurrentSiteBanner = {
  id: string;
  message: string;
  priority: SiteBannerPriority;
  /** ISO timestamp used by the client to invalidate stale dismissals. */
  updatedAt: string;
};

export type AdminSiteBanner = {
  id: string;
  message: string;
  priority: SiteBannerPriority;
  startDate: string;
  endDate: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AdminSiteBannerGroups = {
  current: AdminSiteBanner[];
  upcoming: AdminSiteBanner[];
  past: AdminSiteBanner[];
};

type SiteBannerRow = {
  id: string;
  message: string;
  priority: SiteBannerPriority;
  startDate: Date;
  endDate: Date;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function sortByPriorityThenStartDateDesc<
  T extends { priority: SiteBannerPriority; startDate: Date },
>(banners: T[]): T[] {
  return [...banners].sort((a, b) => {
    const rankDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return b.startDate.getTime() - a.startDate.getTime();
  });
}

/**
 * Snapshot shape recorded in audit metadata for banner create/update/delete
 * events. Dates are captured as NZ date-only strings.
 */
export function siteBannerAuditSnapshot(banner: {
  message: string;
  priority: SiteBannerPriority;
  startDate: Date;
  endDate: Date;
  active: boolean;
}) {
  return {
    message: banner.message,
    priority: banner.priority,
    startDate: formatDateOnly(banner.startDate),
    endDate: formatDateOnly(banner.endDate),
    active: banner.active,
  };
}

export function serializeAdminSiteBanner(banner: SiteBannerRow): AdminSiteBanner {
  return {
    id: banner.id,
    message: banner.message,
    priority: banner.priority,
    startDate: formatDateOnly(banner.startDate),
    endDate: formatDateOnly(banner.endDate),
    active: banner.active,
    createdAt: banner.createdAt.toISOString(),
    updatedAt: banner.updatedAt.toISOString(),
  };
}

/**
 * Banners to display right now: active, with today's NZ date-only value
 * inside the inclusive startDate..endDate window. Sorted URGENT first, then
 * newest start date, so the most severe notice sits at the top of the stack.
 */
export async function getCurrentSiteBanners(): Promise<CurrentSiteBanner[]> {
  const today = await clubTodayDateOnlyInstant();

  const banners = await prisma.siteBanner.findMany({
    where: {
      active: true,
      startDate: { lte: today },
      endDate: { gte: today },
    },
    select: {
      id: true,
      message: true,
      priority: true,
      startDate: true,
      updatedAt: true,
    },
  });

  return sortByPriorityThenStartDateDesc(banners).map((banner) => ({
    id: banner.id,
    message: banner.message,
    priority: banner.priority,
    updatedAt: banner.updatedAt.toISOString(),
  }));
}

/**
 * All banners for the admin page, split into current / upcoming / past by
 * NZ date-only comparison. Inactive banners stay in their date-derived group
 * so admins can re-enable them in place. Past output is capped to the most
 * recently ended banners.
 */
export async function listSiteBannersForAdmin(): Promise<AdminSiteBannerGroups> {
  const today = await clubTodayDateOnlyInstant();

  const banners = await prisma.siteBanner.findMany({
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
  });

  const current: SiteBannerRow[] = [];
  const upcoming: SiteBannerRow[] = [];
  const past: SiteBannerRow[] = [];

  for (const banner of banners) {
    if (banner.endDate.getTime() < today.getTime()) {
      past.push(banner);
    } else if (banner.startDate.getTime() > today.getTime()) {
      upcoming.push(banner);
    } else {
      current.push(banner);
    }
  }

  past.sort((a, b) => b.endDate.getTime() - a.endDate.getTime());

  return {
    current: sortByPriorityThenStartDateDesc(current).map(serializeAdminSiteBanner),
    upcoming: [...upcoming]
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())
      .map(serializeAdminSiteBanner),
    past: past.slice(0, PAST_BANNER_LIMIT).map(serializeAdminSiteBanner),
  };
}
