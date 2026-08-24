import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { buildLoginPath } from "@/lib/auth-redirect";
import { hashActionToken } from "@/lib/action-tokens";
import {
  parseApplicationFamilyMembers,
} from "@/lib/nomination";
import { prisma } from "@/lib/prisma";
import { formatClubDate, parseCalendarDate } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { NominationConfirmCard } from "@/components/nomination-confirm-card";
import { CLUB_NAME } from "@/config/club-identity";

/**
 * A dependent's date of birth, rendered as the CALENDAR DAY it is (CT-4, #2870).
 *
 * A date of birth takes no zone: 21 March 1974 is 21 March 1974 in every zone on
 * earth. The pre-CT-4 spelling pushed it through `APP_TIME_ZONE`, which cancels
 * only because New Zealand sits east of Greenwich.
 *
 * `parseCalendarDate` WITH A RAW-VALUE FALLBACK, NOT `requireCalendarDate`, and
 * the reason is a measured defect rather than a preference. The first version of
 * this migration justified the throwing form by saying the value "has already
 * passed `isoDateSchema`" — but that schema is
 * `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)` (`src/lib/nomination.ts`), a SHAPE
 * check and nothing more, and the UNAUTHENTICATED `/api/applications` POST
 * validates the same field with the same bare regex. So `1990-02-31`,
 * `1990-13-01` and `1990-00-00` are all accepted on the way in and stored.
 * `requireCalendarDate` refuses them — correctly, since they name no real day —
 * and throws out of an async server component. There is no `error.tsx` under
 * `(authenticated)`, so `src/app/error.tsx` replaces the whole page: the
 * nominating member can no longer confirm OR decline, and no admin action clears
 * it. Echoing the stored text shows them something and loses nothing.
 *
 * Tightening the two write paths is the other half of this and is deliberately
 * NOT done here: it is a different surface with its own question about rows
 * already stored. Reading a value must not be able to take a page down whatever
 * was written.
 */
function formatDependentDateOfBirth(value: string): string {
  const day = parseCalendarDate(value);
  return day === null ? value : formatClubDate(day);
}

function statusLabel(status: string) {
  switch (status) {
    case "PENDING_NOMINATORS":
      return "Waiting for nominators";
    case "PENDING_ADMIN":
      return "With committee";
    case "APPROVED":
      return "Approved";
    case "REJECTED":
      return "Rejected";
    default:
      return status;
  }
}

export default async function NominationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    const { token } = await params;
    redirect(buildLoginPath(`/nominations/${token}`));
  }

  const { token } = await params;

  const nomination = await prisma.nominationToken.findUnique({
    where: { tokenHash: hashActionToken(token) },
    include: { application: true },
  });

  if (!nomination) {
    return (
      <Card className="mx-auto max-w-3xl">
        <CardHeader>
          <CardTitle>Nomination link not found</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>This nomination link is invalid or no longer exists.</p>
          <p>
            If you reached this page from an older email, the link may have
            been replaced by a newer one. Contact the club office and an
            administrator can send you a fresh nomination link.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (nomination.nominatorMemberId !== session.user.id) {
    return (
      <Card className="mx-auto max-w-3xl">
        <CardHeader>
          <CardTitle>This nomination is not assigned to your account</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Please sign in with the nominated member account that received the
          email link.
        </CardContent>
      </Card>
    );
  }

  const application = nomination.application;
  const familyMembers = parseApplicationFamilyMembers(application.familyMembers);
  // An instant-versus-instant comparison, which needs no zone at all: expiry is a
  // moment, not a civil day, and `<` on two `Date`s is zone-free by construction.
  const expired = nomination.expiresAt < new Date();
  // `createdAt` IS a moment, so the civil day it reads as comes from the club's
  // PERSISTED timezone (CT-4, #2870; INV-CONFIG-002).
  const club = await clubTime();
  const canConfirm =
    !expired &&
    !nomination.confirmedAt &&
    application.status === "PENDING_NOMINATORS";

  let initialMessage = "";
  if (nomination.confirmedAt) {
    initialMessage = "You have already confirmed this nomination.";
  } else if (expired) {
    initialMessage =
      "This nomination link has expired. Contact the club office and an administrator can send you a fresh link.";
  } else if (application.status === "PENDING_ADMIN") {
    initialMessage =
      "Both nominators have already confirmed. The application is now waiting for committee review.";
  } else if (application.status === "APPROVED") {
    initialMessage = "This application has already been approved.";
  } else if (application.status === "REJECTED") {
    initialMessage = "This application has already been rejected.";
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Card>
        <CardHeader className="space-y-3">
          <div className="inline-flex w-fit rounded-full bg-muted px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {statusLabel(application.status)}
          </div>
          <CardTitle className="text-3xl">
            Nominate {application.applicantFirstName} {application.applicantLastName}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Applicant email
              </p>
              <p className="mt-1 text-sm">{application.applicantEmail}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Submitted
              </p>
              <p className="mt-1 text-sm">
                {club.instantDate(application.createdAt)}
              </p>
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Dependent family members
            </p>
            {familyMembers.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                No dependents were included with this application.
              </p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {familyMembers.map((familyMember) => (
                  <li
                    key={`${familyMember.firstName}-${familyMember.lastName}-${familyMember.dateOfBirth}`}
                    className="rounded-md border border-border px-3 py-2"
                  >
                    <div className="font-medium">
                      {familyMember.firstName} {familyMember.lastName}
                    </div>
                    <div className="text-muted-foreground">
                      {/* A CALENDAR DATE, and fail-soft: see
                          `formatDependentDateOfBirth` for why the throwing form
                          took this page down on a stored date that names no real
                          day. */}
                      DOB {formatDependentDateOfBirth(familyMember.dateOfBirth)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-lg border border-border bg-muted p-4">
            <p className="text-sm text-muted-foreground">
              Confirming this nomination records that you support this
              application progressing to committee review. Committee approval is
              still required before any {CLUB_NAME} account is created.
            </p>
          </div>

          <NominationConfirmCard
            token={token}
            canConfirm={canConfirm}
            initialMessage={initialMessage}
          />
        </CardContent>
      </Card>
    </div>
  );
}
