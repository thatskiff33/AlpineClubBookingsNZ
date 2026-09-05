import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { humanizeStatus } from "@/lib/status-colors";
import type { BookingDetailRecord } from "../_lib/load-booking-detail";
import type { BoundClubTime } from "@/lib/club-time";

/**
 * WHO MADE IT AND WHAT WAS ASKED (#2958): the created-on-behalf note, the
 * admin-review notice and the change-request list. Read straight off the loaded
 * booking; no viewer gate applies to any of them and none is added. Moved
 * verbatim from `page.tsx`.
 */
export function BookingReviewNotices({
  booking,
  club,
}: {
  booking: BookingDetailRecord;
  club: BoundClubTime;
}) {
  return (
    <>
      {booking.createdBy && (
        <div className="rounded-md bg-muted border border-border px-4 py-3 text-sm text-muted-foreground">
          Created by <strong>{booking.createdBy.firstName} {booking.createdBy.lastName}</strong> (admin) on behalf of this member
        </div>
      )}

      {booking.requiresAdminReview && (
        <div className="space-y-2 rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
          <p>
            <strong>
              {booking.adminReviewStatus === "PENDING"
                ? "Awaiting admin review."
                : booking.adminReviewStatus === "APPROVED"
                  ? "Approved by admin."
                  : booking.adminReviewStatus === "REJECTED"
                    ? "Declined by admin."
                    : "Admin review required."}
            </strong>{" "}
            {booking.adminReviewReason ?? "This booking needs manual review by an admin."}
          </p>
          {booking.adminReviewStatus === "PENDING" && (
            <p>
              Payment cannot be taken until an admin approves. You can amend the
              booking to include an adult guest if you would like to clear this flag.
            </p>
          )}
          {booking.memberReviewJustification && (
            <p>
              <span className="font-medium">Your reason:</span>{" "}
              {booking.memberReviewJustification}
            </p>
          )}
          {booking.adminReviewNotes && booking.adminReviewStatus !== "PENDING" && (
            <p>
              <span className="font-medium">Admin note:</span> {booking.adminReviewNotes}
            </p>
          )}
        </div>
      )}

      {booking.changeRequests.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Change Requests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {booking.changeRequests.map((request) => {
              const requested = request.requestedChanges as {
                requested?: { summary?: string | null };
              };
              return (
                <div key={request.id} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">
                      {requested.requested?.summary ?? "Booking change request"}
                    </p>
                    <Badge variant={request.status === "REQUESTED" ? "outline" : "secondary"}>
                      {humanizeStatus(request.status)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    Submitted{" "}
                    {club.instantDate(request.createdAt)}
                  </p>
                  {request.reason ? (
                    <p className="mt-2 text-muted-foreground">{request.reason}</p>
                  ) : null}
                  {/* The officer's MEMBER-FACING explanation (#2562), labelled so
                      the member knows who wrote it and can act on it. The officer
                      panel says this field is member-visible before they submit
                      it; the internal note is a different column and is neither
                      selected above nor rendered anywhere here. */}
                  {request.adminNotes ? (
                    <div className="mt-2">
                      <p className="font-medium">What the club said</p>
                      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                        {request.adminNotes}
                      </p>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </>
  );
}
