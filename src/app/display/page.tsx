import type { Metadata } from "next";
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
export default async function DisplayPage() {
  return <DisplayScreen zone={await clubTimeZone()} />;
}
