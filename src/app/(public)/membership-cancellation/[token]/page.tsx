import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MembershipCancellationConfirmCard } from "@/components/membership-cancellation-confirm-card";
import { auth } from "@/lib/auth";
import { buildLoginPath } from "@/lib/auth-redirect";
import { getMembershipCancellationConfirmationDetails } from "@/lib/membership-cancellation-requests";
import { participantStatusLabel } from "@/lib/membership-cancellation-status-labels";
import { clubTime } from "@/lib/club-time/server";

const statusLabel = participantStatusLabel;

export default async function MembershipCancellationConfirmationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await auth();

  if (!session?.user?.id) {
    redirect(buildLoginPath(`/membership-cancellation/${encodeURIComponent(token)}`));
  }

  const details = await getMembershipCancellationConfirmationDetails(
    token,
    session.user.id,
  );

  // `submittedAt` is a real INSTANT (a `DateTime`, serialised to ISO), so the
  // civil day it reads as comes from the club's PERSISTED timezone rather than
  // the container's (CT-4, #2870; INV-CONFIG-002).
  const club = await clubTime();

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Membership Cancellation Request</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {details.request ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Requested by
                </p>
                <p className="mt-1 text-sm">
                  {details.request.requestedBy?.name ?? "Unknown member"}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Submitted
                </p>
                <p className="mt-1 text-sm">
                  {club.instantDate(new Date(details.request.submittedAt))}
                </p>
              </div>
            </div>

            {details.request.reason ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Reason
                </p>
                <p className="mt-1 text-sm">{details.request.reason}</p>
              </div>
            ) : null}

            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Participants
              </p>
              <div className="mt-2 divide-y divide-border rounded-md border border-border">
                {details.request.participants.map((participant) => (
                  <div
                    className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                    key={participant.id}
                  >
                    <span className="font-medium">{participant.name}</span>
                    <Badge variant="secondary">
                      {statusLabel(participant.status)}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : null}

        <div className="rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
          Your membership remains active unless you confirm inclusion and an
          administrator later approves and processes the cancellation.
        </div>

        <MembershipCancellationConfirmCard details={details} token={token} />
      </CardContent>
    </Card>
  );
}
