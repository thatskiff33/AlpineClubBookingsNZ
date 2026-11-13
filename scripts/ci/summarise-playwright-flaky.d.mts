// Types for summarise-playwright-flaky.test.ts, which imports this CI helper (#4991).
export interface FlakyTest {
  file: string;
  title: string;
  project: string;
  failedAttempts: number;
  attempts: number;
}
/** The report is Playwright's JSON reporter output; its shape is checked at runtime. */
export declare function collectFlakyTests(report: unknown, workspace?: string): FlakyTest[];
export declare function renderFlakySummary(tests: readonly FlakyTest[]): string;
