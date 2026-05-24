import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MembershipCancellationConfirmCard } from "@/components/membership-cancellation-confirm-card";
import { auth } from "@/lib/auth";
import { buildLoginPath } from "@/lib/auth-redirect";
import { getMembershipCancellationConfirmationDetails } from "@/lib/membership-cancellation-requests";
import { participantStatusLabel } from "@/lib/membership-cancellation-status-labels";
import { formatNZDate } from "@/lib/nzst-date";

const statusLabel = participantStatusLabel;

function formatDate(value: string) {
  return formatNZDate(new Date(value));
}

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
                  {formatDate(details.request.submittedAt)}
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
              <div className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
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

        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          Your membership remains active unless you confirm inclusion and an
          administrator later approves and processes the cancellation.
        </div>

        <MembershipCancellationConfirmCard details={details} token={token} />
      </CardContent>
    </Card>
  );
}
