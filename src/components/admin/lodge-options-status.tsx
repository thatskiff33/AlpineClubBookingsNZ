"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SettledLodgeOptionScope } from "@/lib/lodge-option-scope";

/**
 * The ONE way a lodge-scoped surface says its lodge list did not load (#2701).
 *
 * Every admin lodge selector draws its options from `useLodgeOptions`, and
 * until #2701 a failed request produced `lodges: []` — indistinguishable from a
 * club that genuinely has no lodges. `LodgeSelect` renders nothing below two
 * lodges (ADR-002), so the selector simply vanished and the page read as a
 * single-lodge club. That is not a cosmetic problem: the selection normalises
 * to `null`, and a `null` lodge is resolved server-side to the club's DEFAULT
 * lodge, so the next thing the operator saved landed on a lodge they were never
 * shown.
 *
 * This exists so every surface that must stop shares one explanation and one
 * retry rather than inventing another empty-dropdown state. Deliberately small:
 * it says what is missing and offers the retry. Deciding what ELSE to suppress
 * — which is the half that actually prevents the wrong write — belongs to each
 * page, because only the page knows which of its controls are lodge-scoped.
 *
 * `forbidden` is not an error and must never be dressed up as one: it is a
 * permissions answer, and a retry could only refuse again.
 *
 * Since #2925 it is a NARROWER population than the two shipped presets this
 * notice was written for. `GET /api/admin/lodges` admits any admitted admin
 * (`overview:view`) and narrows its payload instead, so `ADMIN_MEMBERSHIP` and
 * `FINANCE_ADMIN` now get the lodge names. A club-edited or custom role holding
 * `bookings: "view"` with `overview: "none"` is still refused, which is why this
 * state and its copy remain.
 */
/**
 * The label on the one retry button this notice offers.
 *
 * Exported because a lodge-scoped card that DEFERS to this retry rather than
 * growing a second button has to name it in its own copy — "Use Try again
 * above" — and a sentence quoting a button's words is a cross-component
 * reference whether or not it is written as one. Renaming the button here now
 * moves those sentences with it, instead of leaving them quietly describing a
 * control that no longer exists (#2937).
 */
export const LODGE_OPTIONS_RETRY_LABEL = "Try again";

export function LodgeOptionsUnavailableNotice({
  failed,
  forbidden,
  onRetry,
  what,
  className,
}: {
  /** The lodge list request failed — transport, 500, anything but a 403. */
  failed: boolean;
  /** The lodge list was refused (403). A permissions fact, not an outage. */
  forbidden?: boolean;
  onRetry: () => void;
  /**
   * What this surface cannot show or change without a lodge, in the operator's
   * own words and lower case — "chore assignments", "this lodge's rooms and
   * beds". Written into both messages so the notice explains THIS page rather
   * than lodges in the abstract.
   */
  what: string;
  className?: string;
}) {
  if (forbidden) {
    return (
      <Alert variant="info" title="Your role cannot choose a lodge" className={className}>
        Viewing lodges needs lodge access, which your admin role does not have,
        so {what} cannot be shown per lodge here. Ask for lodge access if you
        need it — nothing has failed.
      </Alert>
    );
  }

  if (!failed) return null;

  return (
    <Alert
      variant="error"
      title="The lodge list could not be loaded"
      className={className}
    >
      <p className="mb-3">
        {what} cannot be shown or changed, because we do not know which lodge
        they belong to. This is a failure to load, <strong>not</strong> a club
        with no lodges — nothing has been deleted, and nothing here is safe to
        save until the list returns.
      </p>
      <Button variant="outline" onClick={onRetry}>
        {LODGE_OPTIONS_RETRY_LABEL}
      </Button>
    </Alert>
  );
}

/**
 * Status half of the settled-scope gate. The caller still owns suppression of
 * its data transport and actions, but every ordinary editor explains the same
 * unresolved states in the same words.
 */
export function LodgeScopeStatusNotice({
  scope,
  onRetry,
  what,
  className,
}: {
  scope: SettledLodgeOptionScope;
  onRetry: () => void;
  what: string;
  className?: string;
}) {
  if (scope.kind === "failed" || scope.kind === "forbidden") {
    return (
      <LodgeOptionsUnavailableNotice
        failed={scope.kind === "failed"}
        forbidden={scope.kind === "forbidden"}
        onRetry={onRetry}
        what={what}
        className={className}
      />
    );
  }
  if (scope.kind === "empty") {
    return (
      <Alert variant="info" title="No active lodges" className={className}>
        {what} cannot be shown or changed until an active lodge exists.
      </Alert>
    );
  }
  if (scope.kind === "loading") {
    return (
      <p className={className ?? "text-sm text-muted-foreground"}>
        Loading lodge options...
      </p>
    );
  }
  return null;
}
