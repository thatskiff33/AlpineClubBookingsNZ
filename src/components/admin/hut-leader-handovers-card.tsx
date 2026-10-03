import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatClubDayMonth,
  requireCalendarDate,
  type ClubDateFormat,
} from "@/lib/club-time";
import { coverageLodgeLabel } from "@/lib/hut-leader-coverage";
import { joinHutLeaderNames } from "@/lib/hut-leader-handover";
import type { HutLeaderHandover } from "@/lib/hut-leader-night-cover";

/**
 * "Handovers this week" on the admin dashboard (#3818): each day in the coming
 * week on which a hut leader finishes at midday and another is on duty from
 * midday (`from` names only who finishes). The handovers
 * come from the presence-aware cover (`INV-DATE-031`), so a leader who is not
 * staying is never shown handing over. Renders nothing when there are none.
 *
 * `nameLodges` is the dashboard's ADR-002 Presentation Rule answer
 * (`coverageNeedsLodgeContext`), so a one-lodge club never sees a lodge name.
 */
export function HutLeaderHandoversCard({
  handovers,
  nameLodges,
  format,
}: {
  handovers: readonly HutLeaderHandover[];
  nameLodges: boolean;
  format: ClubDateFormat;
}) {
  if (handovers.length === 0) return null;
  return (
    <Link href="/admin/hut-leaders">
      <Card className="hover:shadow-md transition-shadow cursor-pointer">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Handovers this week</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {handovers.map((handover) => {
              const lodgeLabel = nameLodges ? coverageLodgeLabel(handover) : null;
              return (
                <li key={`${handover.date}:${handover.lodgeId ?? ""}`}>
                  <span className="font-medium">
                    {formatClubDayMonth(requireCalendarDate(handover.date), format)}
                  </span>
                  {` · ${joinHutLeaderNames(handover.from)} `}
                  {/* The arrow is drawn, and "to" is what a screen reader says. */}
                  <span aria-hidden="true">→</span>
                  <span className="sr-only">to</span>
                  {` ${joinHutLeaderNames(handover.to)} at midday`}
                  {lodgeLabel ? ` (${lodgeLabel})` : ""}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </Link>
  );
}
