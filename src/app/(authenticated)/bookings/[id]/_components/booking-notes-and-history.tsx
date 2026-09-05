import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BookingNotesEditor } from "@/components/booking-notes-editor";
import type { BookingHistoryTone } from "@/lib/booking-history";
import type { BookingDetailRecord } from "../_lib/load-booking-detail";
import type { BoundClubTime } from "@/lib/club-time";
import type { BookingDetailEditAccess } from "../_lib/booking-detail-edit-access";
import type { BookingDetailHistory } from "../_lib/booking-detail-history";

const historyToneClasses: Record<BookingHistoryTone, string> = {
  default: "border-border bg-muted text-muted-foreground",
  success: "border-success-6 bg-success-3 text-success-11",
  warning: "border-warning-6 bg-warning-3 text-warning-11",
  danger: "border-danger-6 bg-danger-3 text-danger-11",
};

/**
 * NOTES AND THE TIMELINE (#2958): the notes editor (editable on the same
 * predicate as cancel) and the transaction history built in
 * `_lib/booking-detail-history.ts`. Moved verbatim from `page.tsx`.
 */
export function BookingNotesAndHistory({
  booking,
  club,
  access,
  history,
}: {
  booking: BookingDetailRecord;
  club: BoundClubTime;
  access: BookingDetailEditAccess;
  history: BookingDetailHistory;
}) {
  const { canCancel } = access;
  const { bookingHistory } = history;
  return (
    <>
      <Card id="notes" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <BookingNotesEditor
            bookingId={booking.id}
            initialNotes={booking.notes ?? ""}
            canEdit={canCancel}
          />
        </CardContent>
      </Card>

      <Card id="transaction-history" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Transaction History</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {bookingHistory.map((item) => (
              <div
                key={item.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={historyToneClasses[item.tone]}
                    >
                      {item.category}
                    </Badge>
                    <span className="text-sm font-medium text-foreground">
                      {item.title}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {club.instantDateTime(item.occurredAt)}
                    </span>
                  </div>
                  {item.detail ? (
                    <p className="text-sm text-muted-foreground">{item.detail}</p>
                  ) : null}
                </div>
                {item.amountDisplay ? (
                  <span
                    className={`text-sm font-medium ${
                      item.tone === "danger"
                        ? "text-danger-11"
                        : item.tone === "success"
                          ? "text-success-11"
                          : item.tone === "warning"
                            ? "text-warning-11"
                            : "text-muted-foreground"
                    }`}
                  >
                    {item.amountDisplay}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
