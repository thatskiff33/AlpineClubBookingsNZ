import {
  buildBookingMessageGlobalData,
  loadPublicBookingMessages,
} from "@/lib/booking-message-settings";
import { BOOKING_MESSAGES_CONNECTION_SHAPE } from "@/lib/connection-shapes";
import { connectionJson } from "@/lib/mcp-connection-request";

/**
 * The effective booking-message bodies, plus the club-level values their merge
 * tokens resolve to (#2919 review).
 *
 * The bodies are templates: every message declares every token as insertable,
 * so a body an operator has edited can contain `{{CLUB_LODGE_NAME}}` or
 * `{{SUPPORT_EMAIL}}`. The client surfaces that read this endpoint used to
 * substitute at most `{{paymentReference}}` by hand and printed the rest as
 * literal braces. `tokens` is what lets them render the same substitution the
 * admin preview shows; a surface that knows its own lodge overrides
 * CLUB_LODGE_NAME with it. All four values are already public — the club name,
 * its default lodge, the public URL and the support address.
 */
export async function GET(request: Request) {
  const [messages, tokens] = await Promise.all([
    loadPublicBookingMessages(),
    buildBookingMessageGlobalData(),
  ]);
  return connectionJson(request, { messages, tokens }, BOOKING_MESSAGES_CONNECTION_SHAPE);
}
