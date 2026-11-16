// The plain-text form of a setup readiness report, as `pnpm run setup:check`
// prints it. The report itself is built in `setup-readiness.ts`.
import type { SetupReadiness } from "@/lib/setup-readiness";

export function renderSetupCheckReport(readiness: SetupReadiness): string {
  const lines = [
    `Setup readiness: ${readiness.status}`,
    `Complete ${readiness.summary.complete}/${readiness.summary.total}, warnings ${readiness.summary.warning}, blocked ${readiness.summary.blocked}, skipped ${readiness.summary.skipped}`,
    "",
  ];

  for (const category of readiness.categories) {
    lines.push(`${category.title} (${category.status})`);
    for (const check of category.checks) {
      const progressLabel =
        check.progress === "open" ? "" : `, ${check.progress}`;
      lines.push(
        `- ${check.title}: ${check.status}${progressLabel} - ${check.message}`,
      );
      for (const detail of check.details) {
        lines.push(`  ${detail}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
