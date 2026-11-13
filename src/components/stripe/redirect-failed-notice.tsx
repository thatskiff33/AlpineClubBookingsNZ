import { AlertTriangle } from "lucide-react";

/** #4955: a redirect method came back declined or cancelled; shown above the pay options. */
export function RedirectFailedNotice() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
      <AlertTriangle className="h-5 w-5 shrink-0" />
      <p>Your payment did not go through. You have not been charged. You can try again below.</p>
    </div>
  );
}
