import type { Metadata } from "next";
import { ClubFormatProvider } from "@/components/club-format-provider";
import { clubFormatValues } from "@/lib/club-format-server";
import { clubTimeZone } from "@/lib/club-time/server";
import { DisplayScreen } from "./display-screen";
import "./display.css";

// The lobby TV display page (fork issue #32, epic #25): a full-screen,
// read-only, non-interactive surface. Auth is the display-token cookie
// (ADR-001) — an unpaired browser sees only a pairing code. The lobbyDisplay
// module flag gates this whole route at the proxy (404 when off).

export const metadata: Metadata = {
  title: "Lobby display",
  robots: { index: false, follow: false },
};

// Must render per-request (fork issue #54): the CSP is nonce-only in
// production and Next stamps the nonce into its inline bootstrap scripts
// only during dynamic rendering. A statically prerendered /display ships
// unnonced inline scripts, the browser blocks them, and this client-shell
// page stays blank on real TVs.
export const dynamic = "force-dynamic";

/*
  THE CLUB'S TIMEZONE REACHES THE LOBBY TV AS DATA, RESOLVED HERE (CT-4, #2870;
  INV-CONFIG-002).

  The screen shows a live clock and a header date, which are real INSTANTS and
  therefore have no civil reading until a zone is chosen. It used to choose
  `APP_TIME_ZONE` — the container's environment — so on a deployment where the
  environment and the club's recorded setting disagree, the wall showed the
  machine's time.

  WHY A PROP RATHER THAN THE SHARED `ClubTimeProvider`, which is the house
  pattern everywhere else. `/display` sits outside both route-group chrome
  components on purpose: it is an unattended kiosk that shares none of the
  application's shell, and its sibling `error.tsx` is held at ZERO data
  dependencies (issue #176, ADR-003 §5) precisely so a wall screen can never
  throw from its own fallback. A provider mounted here would not cover that error
  boundary anyway — Next renders one outside the layout whose subtree threw — so
  it would make two of the three `/display` surfaces zoned and leave the third
  deliberately unzoned, which is a worse story than one explicit prop. This page
  is already `force-dynamic`, so resolving the zone costs one cached read per
  request and adds no new render mode.

  It also keeps the mount census honest: nothing under `/display` calls
  `useClubTime()`, so the row that records this surface as provider-less stays
  TRUE, and its import-graph walk goes on protecting the lobby television from a
  future edit that reaches for the hook.
*/

/*
  THE CLUB'S CURRENCY AND LOCALE REACH THE LOBBY TV THE SAME WAY, AND FOR THE
  SAME REASON (#3564, stage 2 of programme #3205; INV-CONFIG-006).

  The header's day line — "Wed, 1 Jul" — is written by an `Intl.DateTimeFormat`
  that took its locale from `APP_LOCALE`, which is `NEXT_PUBLIC_LOCALE` inlined
  at BUILD time into an image that serves every club. In the published image
  that is `undefined`, so the wall reads New Zealand no matter what the club
  recorded. Resolved here, on the server, where the setting lives.

  TWO DIFFERENCES FROM THE ZONE ABOVE, BOTH DELIBERATE.

  FIRST, IT IS THE SHARED `ClubFormatProvider`, not a copy private to this
  route. The zone travels through a context private to
  `display-header-clock.tsx`, which exists because it predates this seam and
  CT-6 (#2991) is where it collapses; minting a second private copy of a
  context introduced in this very change would be two homes for one thing on
  the day it was born, which is what `INV-SSOT` exists to refuse.

  SECOND, THE MOUNT IS HERE RATHER THAN INSIDE `DisplayScreen`. That component
  is the obvious home and sits at exactly its size budget, so wrapping it there
  cost twenty-one lines it may not have; mounting from the server page costs
  none and puts the resolve and the mount in one place. It also keeps
  `DisplayScreen`'s signature — a zone and nothing else — which is what twenty
  test call sites already pass.

  `club-format-provider-mount-census.test.tsx` records this surface as
  SELF-MOUNTING rather than provider-less, and checks both halves of that
  claim: that the mount is really here, and that something below it really does
  reach `useClubFormat()`, so the mount is load-bearing rather than decorative.

  The reason `/display` still resolves its own values rather than joining a
  chrome mount is unchanged and is stated above: its sibling `error.tsx` is
  held at zero data dependencies, and no mount on this route could ever cover
  it.

  THE READER IS `clubFormatValues()` AND NOT THE RAW `getClubFormat()` (#3565).
  Stage 2 wrote the raw reader because stage 1 cached nothing and said so; stage
  3 chose the caching contract — React `cache()` — and a `cache()` memo is per
  FUNCTION IDENTITY, so a surface still calling the unwrapped reader gets its own
  entry and reads the one-row table a second time in the same render pass. The
  values are exactly what this mount hands the provider.
*/
export default async function DisplayPage() {
  const [zone, format] = await Promise.all([clubTimeZone(), clubFormatValues()]);
  return (
    <ClubFormatProvider
      currencyCode={format.currencyCode}
      locale={format.locale}
    >
      <DisplayScreen zone={zone} />
    </ClubFormatProvider>
  );
}
