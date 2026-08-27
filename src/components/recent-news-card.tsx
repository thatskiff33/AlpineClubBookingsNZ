import Link from "next/link";
import { ArrowRight, Newspaper, Pin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  getMemberAudienceKeys,
  getUnreadNoticeCount,
  listNoticesForMember,
} from "@/lib/notices";
import { clubTime } from "@/lib/club-time/server";

/**
 * Dashboard "Recent News" card: the member's top few visible notices (pinned
 * first, then newest). Unread notices show a dot and bold title. Renders nothing
 * when the member has no visible notices, so the dashboard stays clean for a
 * club that has not posted any. Only ever shows the member's OWN read state.
 */
export async function RecentNewsCard({ memberId }: { memberId: string }) {
  // Resolve the member's audience keys ONCE and share them across the two reads
  // below (each would otherwise re-resolve them), keeping a single `now` so the
  // season/visibility window is consistent between the list and the count.
  const now = new Date();
  /**
   * `publishedAt` is a real INSTANT, so the date beside a notice reads in the
   * club's PERSISTED timezone (CT-4, #2870; INV-CONFIG-002) rather than the
   * container's `TZ`. `now` above stays a bare instant on purpose: it is a
   * visibility-window COMPARISON, not a civil date, and comparing two instants
   * needs no zone.
   */
  const club = await clubTime();
  const keys = await getMemberAudienceKeys(memberId, { now });
  if (!keys) {
    return null;
  }

  const [notices, unreadCount] = await Promise.all([
    listNoticesForMember(memberId, { limit: 3, now, keys }),
    // True unread total across all visible notices (not just the top 3).
    getUnreadNoticeCount(memberId, { now, keys }),
  ]);
  if (notices.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Newspaper className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          Recent News
          {unreadCount > 0 ? (
            <Badge variant="secondary">{unreadCount} unread</Badge>
          ) : null}
        </CardTitle>
        <Link
          href="/notices"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          All news
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {notices.map((notice) => (
            <li key={notice.id}>
              <Link
                href={`/notices/${notice.id}`}
                className="flex items-center gap-3 py-3 hover:bg-accent -mx-2 px-2 rounded-md transition-colors"
              >
                <span
                  aria-hidden
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    notice.read ? "bg-transparent" : "bg-primary"
                  }`}
                />
                <span className="flex-1 min-w-0">
                  <span
                    className={`block truncate ${
                      notice.read
                        ? "text-foreground"
                        : "font-semibold text-foreground"
                    }`}
                  >
                    {notice.pinned ? (
                      <Pin
                        className="mr-1 inline h-3.5 w-3.5 text-muted-foreground"
                        aria-label="Pinned"
                      />
                    ) : null}
                    {notice.title}
                    {!notice.read ? (
                      <span className="sr-only"> (unread)</span>
                    ) : null}
                  </span>
                  {notice.publishedAt ? (
                    <span className="block text-xs text-muted-foreground">
                      {club.instantDate(new Date(notice.publishedAt))}
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
