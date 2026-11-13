/**
 * The Admin Dashboard's attention cards (#4962): one card per officer work
 * queue (`ADMIN_WORK_QUEUES`) with something in it, for a viewer allowed to open
 * that queue. The sidebar's Needs Attention section renders from the same list
 * with the same visibility rule and the same numbers, so the two cannot drift.
 *
 * Server-renderable: no hooks, no client state.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { FeatureFlags } from "@/config/schema";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import type { CalendarDate } from "@/lib/club-time";
import {
  ADMIN_WORK_QUEUES,
  adminWorkQueueCount,
  isAdminWorkQueueUnavailable,
  isAdminWorkQueueVisible,
  type AdminPendingCounts,
  type AdminWorkQueue,
  type AdminWorkQueueTone,
} from "@/lib/admin-work-queues";

export type AdminWorkQueueCardView = {
  key: string;
  queue: AdminWorkQueue;
  count: number;
  title: string;
  description: string;
  href: string;
};

/** A page-specific wording for one queue's card; the number stays the registry's. */
export type AdminWorkQueueCardOverride = {
  title?: string;
  describe?: (count: number) => string;
};

type QueueCardInput = {
  counts: AdminPendingCounts;
  clubToday: CalendarDate;
  features: FeatureFlags;
  permissionMatrix: AdminPermissionMatrix;
};

/** Every queue this viewer may open, in registry order. */
function visibleQueues({ clubToday, features, permissionMatrix }: QueueCardInput) {
  return ADMIN_WORK_QUEUES.filter((queue) =>
    isAdminWorkQueueVisible(queue, clubToday, features, permissionMatrix),
  );
}

/** The cards to show: visible queues with a count above zero. */
export function getAdminWorkQueueCards(
  input: QueueCardInput & {
    overrides?: Partial<Record<string, AdminWorkQueueCardOverride>>;
  },
): AdminWorkQueueCardView[] {
  return visibleQueues(input).flatMap((queue) => {
    const count = adminWorkQueueCount(queue, input.counts);
    if (count <= 0) return [];
    const override = input.overrides?.[queue.key];
    return [
      {
        key: queue.key,
        queue,
        count,
        title: override?.title ?? queue.card.title ?? queue.label,
        description:
          override?.describe?.(count) ?? queue.card.describe(input.counts),
        href:
          queue.card.href?.(input.counts, input.clubToday) ??
          queue.href(input.clubToday),
      },
    ];
  });
}

/** Labels of the visible queues whose count could not be loaded. */
export function getUnavailableAdminWorkQueueLabels(input: QueueCardInput): string[] {
  return visibleQueues(input)
    .filter((queue) => isAdminWorkQueueUnavailable(queue, input.counts))
    .map((queue) => queue.card.title ?? queue.label);
}

const TONE_CLASSES: Record<
  AdminWorkQueueTone,
  { card: string; text: string }
> = {
  warning: { card: "border-warning-6 bg-warning-3", text: "text-warning-11" },
  danger: { card: "border-danger-6 bg-danger-3", text: "text-danger-11" },
  info: { card: "border-info-6 bg-info-3", text: "text-info-11" },
};

export function AdminWorkQueueCards(
  props: QueueCardInput & {
    overrides?: Partial<Record<string, AdminWorkQueueCardOverride>>;
  },
): ReactNode {
  const cards = getAdminWorkQueueCards(props);
  const unavailable = getUnavailableAdminWorkQueueLabels(props);
  if (cards.length === 0 && unavailable.length === 0) return null;

  return (
    <div className="space-y-4" data-testid="admin-work-queue-cards">
      {unavailable.length > 0 && (
        // A count that failed must never read as "nothing to do" (#4962).
        <Card role="alert" className="border-warning-6 bg-warning-3">
          <CardContent className="flex items-start gap-3 pt-5">
            <AlertTriangle className="h-5 w-5 text-warning-11 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-warning-11">
              Couldn&apos;t load counts for {unavailable.join(", ")}. Reload the
              page to try again, or open those pages directly.
            </p>
          </CardContent>
        </Card>
      )}
      {cards.map(({ key, queue, count, title, description, href }) => {
        const tone = TONE_CLASSES[queue.tone];
        const Icon = queue.icon;
        return (
          <Link key={key} href={href} className="block" data-queue={key}>
            <Card
              className={`${tone.card} hover:shadow-md transition-shadow cursor-pointer`}
            >
              <CardContent className="flex items-start gap-3 pt-5">
                <Icon className={`h-5 w-5 ${tone.text} flex-shrink-0 mt-0.5`} />
                <div className="flex-1">
                  <p className={`font-medium ${tone.text}`}>{title}</p>
                  <p className={`text-sm ${tone.text} mt-1`}>{description}</p>
                </div>
                <span
                  className={`text-lg font-semibold ${tone.text}`}
                  aria-label={`${count} waiting`}
                  data-testid="admin-work-queue-count"
                >
                  {count}
                </span>
              </CardContent>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}
