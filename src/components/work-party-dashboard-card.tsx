import Link from "next/link";
import { Hammer } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatClubDayMonth,
  requireCalendarDate,
  type ClubDateFormat,
} from "@/lib/club-time";
import type { MemberWorkPartyDTO } from "@/lib/work-party-member";
import { memberWorkPartyHref } from "@/lib/work-party-rules";

/** How many upcoming work parties the dashboard card lists. */
export const WORK_PARTY_DASHBOARD_CARD_LIMIT = 5;

/**
 * The dashboard's Work Parties card (#5148): upcoming open work parties,
 * soonest first, each opening its `/dashboard/work-parties/{id}` page. The
 * dashboard renders it only while the `workParties` module is on and only for
 * members (`canViewWorkParties`, owner decision 7).
 *
 * With no upcoming work party the card renders nothing (owner decision,
 * 20 Nov 2026): the module is on by default, so an empty card
 * would otherwise sit on every member's dashboard at a club that never runs a
 * working bee. Each entry is its own link, so the card is not one big link the
 * way the summary cards are.
 */
export function WorkPartyDashboardCard({
  workParties,
  format,
}: {
  workParties: MemberWorkPartyDTO[];
  format: ClubDateFormat;
}) {
  if (workParties.length === 0) return null;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle headingLevel={2} className="text-sm font-medium">
          Work Parties
        </CardTitle>
        <Hammer aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {workParties.map((workParty) => (
            <li key={workParty.id}>
              <Link
                href={memberWorkPartyHref(workParty.id)}
                className="flex items-baseline gap-2 rounded text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  {formatWindow(workParty, format)}
                </span>
                <span className="min-w-0 flex-1 break-words text-foreground">
                  {workParty.name}
                  {workParty.lodgeName && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      · {workParty.lodgeName}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function formatWindow(
  workParty: Pick<MemberWorkPartyDTO, "startDate" | "endDate">,
  format: ClubDateFormat,
): string {
  const start = formatClubDayMonth(
    requireCalendarDate(workParty.startDate),
    format,
  );
  if (workParty.startDate === workParty.endDate) return start;
  const end = formatClubDayMonth(requireCalendarDate(workParty.endDate), format);
  return `${start} – ${end}`;
}
