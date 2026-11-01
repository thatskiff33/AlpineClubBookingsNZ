import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

// Expected failures must come from axe, rather than an unrelated test error.
export default class AccessibilityReporter implements Reporter {
  private invalidEvidence = false;
  onTestEnd(test: TestCase, result: TestResult) {
    if (test.expectedStatus !== "failed") return;
    const report = result.attachments.find((attachment) => attachment.name === "axe-report");
    if (!report?.body?.toString().includes('"id": "image-alt"') ||
        !result.errors.some((error) => error.message?.includes("Serious/critical WCAG"))) {
      this.invalidEvidence = true;
    }
  }
  async onEnd() {
    if (this.invalidEvidence) {
      console.error("Accessibility negative control did not attach the expected axe violation");
      return { status: "failed" as const };
    }
  }
}
