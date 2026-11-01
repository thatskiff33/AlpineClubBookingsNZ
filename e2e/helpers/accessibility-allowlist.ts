// Keep exceptions page- and rule-specific. Never disable an axe rule globally.
// Before adding one, review the report and record why the fix needs separate
// work. followUp may be a filed issue URL or an explicit TODO(issue) placeholder.
export const accessibilityAllowlist: ReadonlyArray<{
  rule: string;
  page: string; // Exact pathname; query strings and booking ids are not wildcards.
  reason: string;
  followUp: string;
}> = [];
