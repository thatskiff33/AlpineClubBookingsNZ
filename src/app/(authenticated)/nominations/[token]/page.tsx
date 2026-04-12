import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import {
  parseApplicationFamilyMembers,
} from "@/lib/nomination";
import { prisma } from "@/lib/prisma";
import { NominationConfirmCard } from "@/components/nomination-confirm-card";

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
    redirect("/login");
  }

  const { token } = await params;

  const nomination = await prisma.nominationToken.findUnique({
    where: { token },
    include: { application: true },
  });

  if (!nomination) {
    return (
      <Card className="mx-auto max-w-3xl">
        <CardHeader>
          <CardTitle>Nomination link not found</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          This nomination link is invalid or no longer exists.
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
  const expired = nomination.expiresAt < new Date();
  const canConfirm =
    !expired &&
    !nomination.confirmedAt &&
    application.status === "PENDING_NOMINATORS";

  let initialMessage = "";
  if (nomination.confirmedAt) {
    initialMessage = "You have already confirmed this nomination.";
  } else if (expired) {
    initialMessage = "This nomination link has expired.";
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
          <div className="inline-flex w-fit rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
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
                {application.createdAt.toLocaleDateString("en-NZ", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
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
                    className="rounded-md border border-slate-200 px-3 py-2"
                  >
                    <div className="font-medium">
                      {familyMember.firstName} {familyMember.lastName}
                    </div>
                    <div className="text-muted-foreground">
                      DOB {new Date(familyMember.dateOfBirth).toLocaleDateString("en-NZ")}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-700">
              Confirming this nomination records that you support this
              application progressing to committee review. Committee approval is
              still required before any TAC account is created.
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
