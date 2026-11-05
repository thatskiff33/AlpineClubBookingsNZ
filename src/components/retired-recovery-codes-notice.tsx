import type { ReactNode } from "react";

/**
 * Tells a member their saved recovery codes no longer work (#4456, owner
 * decision of 1 Nov 2026: codes issued under the auth secret are invalidated
 * when the club moves to a data-encryption key, and the affected members are
 * told to regenerate them). One wording for the sign-in challenge and the
 * profile card; each adds what to do next where it is shown.
 */
export function RetiredRecoveryCodesNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      data-testid="retired-recovery-codes-notice"
      className="rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11"
    >
      Your saved recovery codes no longer work: the club upgraded how sign-in data is
      protected, and codes issued before the upgrade were retired. {children}
    </div>
  );
}
