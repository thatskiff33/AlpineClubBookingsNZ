import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSchoolAttendeeConfirmation } from "@/lib/school-attendee-confirmation";
import { calendarDateOfSerialisedDbDate, formatClubDate } from "@/lib/club-time";
import { SchoolAttendeeConfirmForm } from "./school-attendee-confirm-form";

// The attendee-confirmation link carries a one-time token and must never be
// indexed (#2421): keep it out of search results the same way the group-join and
// booking-request token pages are.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Permanently per-request (#2352): a dynamic segment carrying a ONE-TIME token in
 * the URL, so it sits in `(website-dynamic)` and keeps a per-request CSP nonce. It
 * is never stored. The group's layout declares the render mode too; this line is
 * the route's own reason.
 */
export const dynamic = "force-dynamic";

/**
 * Public school attendee confirmation page (#1101). Reached from the tokenized
 * email link; lets the school contact replace placeholder attendee names
 * (identity-only, price-preserving) and explicitly confirm the list.
 */
export default async function SchoolAttendeeConfirmationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const details = await getSchoolAttendeeConfirmation(token);

  return (
    <div className="mx-auto flex w-full max-w-3xl justify-center px-4 py-12 sm:py-16">
      <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Confirm Your Attendee List</CardTitle>
        {details.request?.schoolName ? (
          <CardDescription>{details.request.schoolName}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-6">
        {/*
          `checkIn`/`checkOut` are `@db.Date` LODGE NIGHTS serialised to ISO by
          `getSchoolAttendeeConfirmation`, so they are CALENDAR DATES and take no
          zone at all (INV-DATE-010): the kernel's decoder reads the day out of
          the value's first ten characters, and the formatter pins `UTC` over it,
          so the projection is provably the identity (CT-4, #2870;
          INV-DATE-019's first exact boundary with INV-DATE-026, which are the
          citation for that decode and INV-DATE-010 is not — #3080). The
          old `formatNZDate` projected them through `APP_TIME_ZONE`, which is the
          identity only for a club east of Greenwich and a day early for one that
          is not.
        */}
        {details.booking ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Check-in
              </p>
              <p className="mt-1 text-sm">
                {formatClubDate(
                  calendarDateOfSerialisedDbDate(details.booking.checkIn),
                )}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Check-out
              </p>
              <p className="mt-1 text-sm">
                {formatClubDate(
                  calendarDateOfSerialisedDbDate(details.booking.checkOut),
                )}
              </p>
            </div>
          </div>
        ) : null}

        {details.status !== "ready" ? (
          <div
            className={`rounded-md border px-4 py-3 text-sm ${
              details.status === "confirmed"
                ? "border-success-6 bg-success-3 text-success-11"
                : "border-warning-6 bg-warning-3 text-warning-11"
            }`}
          >
            {details.message}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{details.message}</p>
        )}

        {details.booking && details.status === "ready" ? (
          <SchoolAttendeeConfirmForm
            token={token}
            guests={details.booking.guests}
          />
        ) : details.booking && details.status === "confirmed" ? (
          <div className="divide-y divide-border rounded-md border border-border">
            {details.booking.guests.map((guest) => (
              <div className="flex items-center justify-between p-3 text-sm" key={guest.id}>
                <span className="font-medium">
                  {guest.firstName} {guest.lastName}
                </span>
                <span className="text-xs text-muted-foreground">{guest.ageTier}</span>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
      </Card>
    </div>
  );
}
