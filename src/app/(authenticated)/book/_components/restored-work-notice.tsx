"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { RestoredWorkNotice as Notice } from "../_hooks/use-wizard-work-persistence";

/**
 * Tells the member the wizard brought back work kept in this tab, after a
 * profile detour or a refresh (#4950), and offers the way to throw it away.
 */
export function RestoredWorkNotice({
  notice,
  onStartAgain,
}: {
  notice: Notice;
  onStartAgain: () => void;
}) {
  return (
    <Alert variant="info" data-testid="restored-booking-work">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p>
          {notice === "datesDropped"
            ? "We kept your party from the booking you were working on, but its dates can no longer be booked. Choose new dates."
            : "We kept the booking you were working on in this tab."}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onStartAgain}
        >
          Start again
        </Button>
      </div>
    </Alert>
  );
}
