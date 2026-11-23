import { loadMemberGuestFindGate } from "@/lib/member-guest-find-service";
import { requireActiveSession } from "@/lib/session-guards";
import { connectionJson } from "@/lib/mcp-connection-request";
import { MEMBER_GUEST_OPTIONS_CONNECTION_SHAPE } from "@/lib/connection-shapes";

/**
 * `GET /api/members/guest-candidates` — the one server-computed object the
 * booking wizard needs to draw the "+ Add Member Guest" surface (#2308 §5.1).
 *
 * WHY A ROUTE AND NOT A SERVER-RENDERED PROP. The plan asked for the flag to be
 * threaded from the `/book` page's server component; `/book` is a `"use client"`
 * page and has been since the wizard was extracted (#1209), so there is no
 * server component to thread from. This follows the shape the wizard already
 * uses for every other piece of server policy it draws — `/api/payments/options`
 * for group bookings and internet banking, `/api/bookings/rooms` for room
 * requests — rather than inventing a second mechanism for one flag.
 *
 * THE CLIENT VALUE IS NEVER THE GATE. Everything here is decoration: the two
 * find routes re-read the module flag and the settings singleton themselves, so
 * a client that flips `openSearchEnabled` in its own memory still gets a 404
 * from the route it then calls. This object decides what is DRAWN, never what is
 * ALLOWED.
 *
 * Module off answers `{ enabled: false }` rather than 404. Unlike the find
 * routes there is nothing to hide: the absence of the button already tells the
 * member the club does not use the feature, and a definite answer is what lets
 * the wizard avoid rendering a button it then has to take away.
 *
 * Also the AI app action `get_member_guest_options` (ALP-795), so an app
 * knows which of the two find actions the club offers.
 */
export async function GET(request: Request) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  const gate = await loadMemberGuestFindGate({ requiresOpenSearch: false });
  if (!gate.ok) {
    return connectionJson(request, { enabled: false }, MEMBER_GUEST_OPTIONS_CONNECTION_SHAPE);
  }

  return connectionJson(
    request,
    {
      enabled: true,
      openSearchEnabled: gate.settings.openMemberSearchEnabled,
      approvalRequired: gate.settings.approvalRequired,
      pendingHoldExpiryDays: gate.settings.pendingHoldExpiryDays,
    },
    MEMBER_GUEST_OPTIONS_CONNECTION_SHAPE,
  );
}
