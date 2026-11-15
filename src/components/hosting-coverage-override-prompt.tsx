"use client";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { HostingCoverageOverridePromptData } from "@/lib/hosting-coverage-override-client";

/**
 * The id of the prompt's reason field for a given `idPrefix`. A caller that
 * moves focus to the field after a refusal (the cancel flow, #4949) asks for it
 * here rather than rebuilding the string, so renaming the field is one edit.
 */
export function hostingOverrideReasonId(idPrefix: string) {
  return `${idPrefix}-reason`;
}

export function HostingCoverageOverridePrompt({
  prompt,
  confirmed,
  reason,
  disabled = false,
  busy = false,
  idPrefix,
  onConfirmedChange,
  onReasonChange,
}: {
  prompt: HostingCoverageOverridePromptData | null;
  confirmed: boolean;
  reason: string;
  disabled?: boolean;
  busy?: boolean;
  idPrefix: string;
  onConfirmedChange: (confirmed: boolean) => void;
  onReasonChange: (reason: string) => void;
}) {
  // Permanently mounted live region: inserting an already-populated role=alert is
  // missed by some screen-reader/browser pairs. Keep the form controls outside
  // the assertive, implicitly atomic region so typing does not re-announce the
  // complete warning and evidence on every controlled-field update.
  const reasonHintId = `${idPrefix}-reason-hint`;

  return (
    <div
      className={
        prompt
          ? "space-y-3 rounded-md border border-warning-7 bg-warning-2 p-3 text-sm"
          : undefined
      }
    >
      <div role="alert" aria-atomic="true" aria-busy={busy}>
        {prompt ? (
          <>
            <div className="space-y-1">
              <p className="font-semibold text-warning-11">
                Separate hosting coverage override required
              </p>
              <p>{prompt.message}</p>
            </div>
            <ul className="mt-3 space-y-2">
              {prompt.strandedBookings.map((booking) => (
                <li
                  key={booking.bookingId}
                  className="rounded border border-warning-6 bg-background p-2"
                >
                  <span className="font-semibold">{booking.reference}</span>
                  {` at ${booking.lodgeName}`}
                  <div className="text-xs text-muted-foreground">
                    Nights: {booking.nights.join(", ")}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      {prompt ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={hostingOverrideReasonId(idPrefix)}>
              Private hosting override reason (required)
            </Label>
            <p id={reasonHintId} className="text-xs text-muted-foreground">
              Only admins see this operational reason. It must be at least 10
              characters and is separate from member-facing notes.
            </p>
            <Textarea
              id={hostingOverrideReasonId(idPrefix)}
              aria-describedby={reasonHintId}
              value={reason}
              disabled={disabled}
              minLength={10}
              maxLength={500}
              onChange={(event) => onReasonChange(event.target.value)}
              placeholder="Why it is safe to proceed despite these uncovered nights."
            />
          </div>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmed}
              disabled={disabled}
              onChange={(event) => onConfirmedChange(event.target.checked)}
            />
            <span>
              I confirm these exact affected bookings and nights remain confirmed,
              that beds and payments are unchanged, and that this creates an urgent
              hosting coverage incident.
            </span>
          </label>
        </div>
      ) : null}
    </div>
  );
}
