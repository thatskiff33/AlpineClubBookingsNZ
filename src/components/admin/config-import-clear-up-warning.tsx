/**
 * #5190: shown after a configuration import that committed but whose
 * post-commit liability clear-up (`clearStaleNotRequiredRows`) did not finish.
 * The import stands; the next membership lockout settings save re-runs the
 * clear-up.
 */
export function ConfigImportClearUpWarning() {
  return (
    <p role="alert" className="rounded-md bg-warning-3 p-2 text-sm text-warning-11">
      The import was applied, but clearing stale &ldquo;Not required&rdquo;
      subscription records afterwards did not finish. Save the membership
      lockout settings once to run it again.
    </p>
  );
}
