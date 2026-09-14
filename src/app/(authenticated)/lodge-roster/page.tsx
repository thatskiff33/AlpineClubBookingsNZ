import { notFound } from "next/navigation";
import { Users } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import {
  addCalendarDays,
  requireCalendarDate,
} from "@/lib/club-time/calendar-date";
import { formatClubDate } from "@/lib/club-time/format";
import {
  buildMemberLodgeRoster,
  type LodgeRoster,
} from "@/lib/member-lodge-roster";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

export const metadata = {
  title: "Who's at the lodge",
};

/**
 * The member lodge roster (#2942).
 *
 * ENFORCES INV-PRIV-017 at the surface. Everything this page renders was
 * already reduced by `buildMemberLodgeRoster`: the names arrive at the lodge's
 * configured granularity, a booking that may not be named individually arrives
 * as a label and a count, and no private field is in the payload to render by
 * accident. This file therefore does NO filtering and NO name formatting of
 * its own — adding either here would be a second copy of a rule whose whole
 * point is that it has one home.
 *
 * It is a SERVER component end to end, with no client island and no API route
 * of its own. That is a privacy decision rather than a performance one: there
 * is no endpoint to call directly, no props object crossing into the browser
 * carrying more than is drawn, and nothing a client component could be handed
 * and forget to render.
 *
 * The module flag is re-checked here even though `FEATURE_ROUTE_RULES` already
 * gates the path in middleware. A module gate that lived only in middleware
 * shipped bypassed once already (#2780), so the surface asks for itself.
 */
export default async function LodgeRosterPage() {
  const session = await auth();
  if (!session?.user?.id) {
    return null;
  }

  const modules = await loadEffectiveModuleFlags();
  if (!modules.memberLodgeRoster) {
    notFound();
  }

  const roster = await buildMemberLodgeRoster(session.user.id);

  const hasAnyone = roster.lodges.some(
    (lodge) => lodge.people.length > 0 || lodge.groups.length > 0
  );

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Users className="h-6 w-6" aria-hidden="true" />
          Who&rsquo;s at the lodge
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Everyone staying over the next 30 nights, at the lodges you can book.
          Names and nights only.
        </p>
      </header>

      {!hasAnyone ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Nobody is booked in over the next 30 nights.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {roster.lodges.map((lodge) => (
            <LodgeSection key={lodge.lodgeId} lodge={lodge} />
          ))}
        </div>
      )}
    </div>
  );
}

function LodgeSection({ lodge }: { lodge: LodgeRoster }) {
  const empty = lodge.people.length === 0 && lodge.groups.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{lodge.lodgeName}</CardTitle>
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="text-sm text-muted-foreground">
            Nobody is booked in over the next 30 nights.
          </p>
        ) : (
          <ul className="divide-y">
            {lodge.groups.map((group) => (
              <li
                key={`group-${group.label}-${group.nights[0] ?? ""}`}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
              >
                <span className="font-medium">
                  {group.label}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {group.count === 1 ? "1 person" : `${group.count} people`}
                  </span>
                </span>
                <Nights nights={group.nights} />
              </li>
            ))}
            {lodge.people.map((person) => (
              <li
                key={`person-${person.name}-${person.nights[0] ?? ""}`}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
              >
                <span className="font-medium">{person.name}</span>
                <Nights nights={person.nights} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The nights somebody is here, as a plain readable range.
 *
 * A contiguous run reads as "Mon 6 - Wed 8 Jul" and a broken one lists its
 * runs, because a gap is a real absence in this data model and collapsing it
 * to an envelope would say somebody was here on a night they were not.
 */
function Nights({ nights }: { nights: string[] }) {
  const runs = groupIntoRuns(nights);
  return (
    <span className="text-sm text-muted-foreground">
      {runs
        .map((run) =>
          run.length === 1
            ? formatNight(run[0]!)
            : `${formatNight(run[0]!)} - ${formatNight(run[run.length - 1]!)}`
        )
        .join(", ")}
    </span>
  );
}

/** Split an ascending list of `YYYY-MM-DD` nights into consecutive runs. */
function groupIntoRuns(nights: string[]): string[][] {
  const runs: string[][] = [];
  for (const night of nights) {
    const current = runs[runs.length - 1];
    if (current && isNextDay(current[current.length - 1]!, night)) {
      current.push(night);
    } else {
      runs.push([night]);
    }
  }
  return runs;
}

/**
 * Step a lodge night with the kernel's own operation rather than by adding
 * 24 hours to an instant. A lodge night is a calendar date and has no zone;
 * arithmetic on a parsed instant is the single most repeated defect in this
 * codebase's history (INV-DATE-019), so it is not done here even where the
 * values happen to be UTC-anchored.
 */
function isNextDay(previous: string, next: string): boolean {
  return addCalendarDays(requireCalendarDate(previous), 1) === next;
}

function formatNight(night: string): string {
  return formatClubDate(requireCalendarDate(night));
}
