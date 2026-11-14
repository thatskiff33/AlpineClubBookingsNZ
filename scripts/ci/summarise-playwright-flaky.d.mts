// Types for summarise-playwright-flaky.test.ts and playwright.config.ts, which import this CI helper (#4991).
export interface FlakyTest {
  file: string;
  title: string;
  project: string;
  failedAttempts: number;
  attempts: number;
}
/** Where the CI-only JSON reporter writes and the summariser reads. */
export declare const PLAYWRIGHT_RESULTS_FILE: string;
/** The report is Playwright's JSON reporter output; its shape is checked at runtime. */
export declare function collectFlakyTests(report: unknown, workspace?: string): FlakyTest[];
export declare function renderFlakySummary(tests: readonly FlakyTest[]): string;
