import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DELETED_BOOKING_MESSAGE } from "@/lib/deleted-booking-refusal";

/**
 * What a page shows a signed-in person who is ENTITLED to a booking the club
 * has since removed (owner decision 20 Nov 2026, #5266; `INV-ADDPAY-034`).
 *
 * Rendered by exactly two pages, each AFTER it has decided the viewer is
 * entitled: the booking page (the owner, or a member guest on it) and the
 * delegate consent page (the consent target, or their accepted family adult).
 * Everybody else on those pages still gets the plain "nothing here", which is
 * what keeps a guessed or forwarded link from telling a stranger anything.
 *
 * The sentence is the shared one, never a page's own wording, so the page and
 * the API refusals cannot drift into saying different things about the same
 * event.
 */
export function RemovedBookingNotice({
  links,
}: {
  /** Where the reader can go next; each page offers its own. */
  links: ReadonlyArray<{ href: string; label: string }>;
}) {
  return (
    <Card data-testid="removed-booking-notice">
      <CardHeader>
        <CardTitle headingLevel={2}>This booking is no longer available</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>{DELETED_BOOKING_MESSAGE}</p>
        <div className="flex flex-wrap gap-2">
          {links.map((link) => (
            <Button key={link.href} asChild variant="outline" size="sm">
              <Link href={link.href}>{link.label}</Link>
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
