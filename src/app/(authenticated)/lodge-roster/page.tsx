import { notFound } from "next/navigation";
import { Users } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { requireCalendarDate } from "@/lib/club-time/calendar-date";
import { formatClubDate } from "@/lib/club-time/format";
import { collapseNightRuns } from "@/lib/bed-allocation-board-window";
import {
  buildMemberLodgeRoster,
  ROSTER_WINDOW_DAYS,
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

  // ADR-002 presentation rule: with exactly one active lodge, its name is
  // redundant everywhere it would otherwise be repeated, so the per-lodge card
  // chrome comes off and the list stands on its own.
  const singleLodge = roster.lodges.length === 1;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Users className="h-6 w-6" aria-hidden="true" />
          Who&rsquo;s at the lodge
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Everyone staying over the next {ROSTER_WINDOW_DAYS} nights, at the{" "}
          {singleLodge ? "lodge" : "lodges"} you can book. Names and nights
          only.
        </p>
        {/*
          Said on the page itself, not only in the guide and the help panel.
          This is the one surface every member of an enabled club actually
          reaches, and a page that shows other people's stays while staying
          quiet about your own has the disclosure the wrong way round. There is
          no opt-out to offer (owner decision D3), so the honest thing is to be
          plain about it rather than leave it to be discovered.
        */}
        <p className="mt-1 text-sm text-muted-foreground">
          Your own stays appear here too, for every other member who can book
          that {singleLodge ? "lodge" : "lodge"} to see.
        </p>
      </header>

      {!hasAnyone ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Nobody is booked in over the next {ROSTER_WINDOW_DAYS} nights.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {roster.lodges.map((lodge) => (
            <LodgeSection
              key={lodge.lodgeId}
              lodge={lodge}
              showLodgeName={!singleLodge}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LodgeSection({
  lodge,
  showLodgeName,
}: {
  lodge: LodgeRoster;
  showLodgeName: boolean;
}) {
  const empty = lodge.people.length === 0 && lodge.groups.length === 0;

  return (
    <Card>
      {showLodgeName ? (
        <CardHeader>
          {/*
            `CardTitle` renders a bare div, so the level is said at the call
            site (#2796). Everything below the page h1 is one of these, so
            without it a screen-reader heading list holds a single entry for
            the whole page and no way to move between lodges.
          */}
          <CardTitle headingLevel={2}>{lodge.lodgeName}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent>
        {empty ? (
          <p className="text-sm text-muted-foreground">
            Nobody is booked in over the next {ROSTER_WINDOW_DAYS} nights.
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
                    {/*
                      "up to", because `count` is the busiest single night of
                      this booking, not a total across the range beside it. A
                      bare number here would claim everyone was present
                      throughout.
                    */}
                    {group.count === 1 ? "1 person" : `up to ${group.count} people`}
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
  // `collapseNightRuns` is the tree's existing answer to "turn sorted nights
  // into contiguous runs" and it sorts and de-duplicates on the way, which a
  // local version would only do by accident of its caller (INV-SSOT).
  const runs = collapseNightRuns(nights);
  return (
    <span className="text-sm text-muted-foreground">
      {runs
        .map((run) =>
          run.firstNight === run.lastNight
            ? formatNight(run.firstNight)
            : `${formatNight(run.firstNight)} - ${formatNight(run.lastNight)}`
        )
        .join(", ")}
    </span>
  );
}

function formatNight(night: string): string {
  return formatClubDate(requireCalendarDate(night));
}
