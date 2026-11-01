// Types for check-realdb-ran.mjs (#4458).
export declare function unexercisedRealdbFiles(
  report: { testResults?: Array<{ name: string; assertionResults?: Array<{ status: string }> }> },
  files: string[],
  repoRoot?: string,
): string[];
