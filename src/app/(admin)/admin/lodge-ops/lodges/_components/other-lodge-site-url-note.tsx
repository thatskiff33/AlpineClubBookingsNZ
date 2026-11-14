import { SAFE_HTTP_URL_MESSAGE } from "@/lib/http-url";

/** The id the booking page field points its `aria-describedby` at. */
export const SITE_URL_NOTE_ID = "other-lodge-siteUrl-note";

/**
 * Flags a booking page address that breaks the central server's stricter rule
 * (#55) when the form OPENS with it: one saved before the rule existed is
 * pointed out at once, and cannot be saved again until fixed. A new address is
 * not judged while it is being typed; Save says what is wrong with it. Empty
 * otherwise, so the field's description is only read out when there is
 * something to say. The field carries `aria-invalid` while it shows.
 */
export function OtherLodgeSiteUrlNote({ flagged }: { flagged: boolean }) {
  return (
    <p id={SITE_URL_NOTE_ID} className="text-xs text-destructive" data-testid="site-url-note">
      {flagged ? SAFE_HTTP_URL_MESSAGE : null}
    </p>
  );
}
