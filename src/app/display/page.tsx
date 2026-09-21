import type { Metadata } from "next";
import { getClubFormat } from "@/lib/club-format-settings";
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

  ONE DIFFERENCE FROM THE ZONE ABOVE, AND IT IS DELIBERATE: this hands the
  values to the SHARED `ClubFormatProvider`, which `DisplayScreen` mounts, where
  the zone travels through a context private to `display-header-clock.tsx`. The
  private one exists because it predates this seam and CT-6 (#2991) is where it
  collapses; minting a second private copy of a context introduced in this very
  change would be two homes for one thing on the day it was born, which is what
  `INV-SSOT` exists to refuse. The mount census handles it exactly as it handles
  `skifield-whakapapa-embed.tsx` under the root 404: the import-graph walk from
  this page stops at the component that mounts its own provider, and reports it
  as a boundary rather than a violation.

  The reason `/display` still takes a PROP rather than joining a chrome mount is
  unchanged and is stated above: its sibling `error.tsx` is held at zero data
  dependencies, and no mount on this route could ever cover it.
*/
export default async function DisplayPage() {
  const [zone, format] = await Promise.all([clubTimeZone(), getClubFormat()]);
  return <DisplayScreen zone={zone} format={format} />;
}
