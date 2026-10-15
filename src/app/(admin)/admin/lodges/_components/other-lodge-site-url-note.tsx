import { isSafeHttpUrl, SAFE_HTTP_URL_MESSAGE } from "@/lib/http-url";

/** The id the booking page field points its `aria-describedby` at. */
export const SITE_URL_NOTE_ID = "other-lodge-siteUrl-note";

/**
 * Flags a booking page address that breaks the central server's stricter rule
 * (#55) as soon as the form shows it: an address saved before the rule existed
 * is pointed out when the form opens, and cannot be saved again until fixed.
 * Empty while the field is blank or the address is fine, so the field's
 * description is only read out when there is something to say.
 */
export function OtherLodgeSiteUrlNote({ value }: { value: string }) {
  const address = value.trim();
  const broken = address !== "" && !isSafeHttpUrl(address);
  return (
    <p id={SITE_URL_NOTE_ID} className="text-xs text-destructive" data-testid="site-url-note">
      {broken ? SAFE_HTTP_URL_MESSAGE : null}
    </p>
  );
}
