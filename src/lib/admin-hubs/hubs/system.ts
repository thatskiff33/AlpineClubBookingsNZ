import { defineHub } from "../define";

/**
 * Help & system. `ai-assistant` is placed here on the plan's recommendation,
 * pending the owner's answer on #4480.
 */
export const SYSTEM_HUB = defineHub({
  key: "system",
  label: "Help & system",
  prefix: "system",
  pages: [
    {
      // S1 (#4796): its integration readiness section is what was
      // `/admin/setup/integrations`, which was `support` too.
      id: "health",
      label: "System Health",
      oldPath: "/admin/health",
      area: "support",
      anchors: ["integration-readiness"],
      keywords: ["status", "diagnostics", "uptime", "monitoring"],
      moved: false,
    },
    {
      id: "issue-reports",
      label: "Issue Reports",
      oldPath: "/admin/issue-reports",
      area: "support",
      moved: false,
    },
    {
      id: "stuck-states",
      label: "Stuck States",
      oldPath: "/admin/stuck-states",
      area: "support",
      moved: false,
    },
    {
      id: "background-jobs",
      label: "Background Jobs",
      oldPath: "/admin/background-jobs",
      area: "support",
      moved: false,
    },
    {
      id: "email-deliverability",
      label: "Email Deliverability",
      oldPath: "/admin/email-deliverability",
      area: "support",
      moved: false,
    },
    {
      id: "audit-log",
      label: "Audit Log",
      oldPath: "/admin/audit-log",
      area: "support",
      keywords: ["history", "activity", "changes", "trail"],
      moved: false,
    },
    {
      id: "ai-diagnostics",
      label: "AI Diagnostics",
      oldPath: "/admin/ai-diagnostics",
      area: "overview",
      admission: "any-admin",
      flags: ["aiDiagnostics"],
      keywords: [
        "diagnose", "investigate", "why", "blocked", "evidence", "troubleshoot",
        "explain",
      ],
      moved: false,
    },
    {
      id: "ai-assistant",
      label: "AI help assistant",
      oldPath: "/admin/ai-assistant",
      area: "support",
      flags: ["aiAssistant"],
      keywords: ["ai", "assistant", "anthropic", "llm", "help", "spend cap"],
      moved: false,
    },
    {
      id: "backups",
      label: "Database Backups",
      oldPath: "/admin/backups",
      area: "support",
      keywords: ["backup", "s3", "restore", "disaster recovery", "pg_dump"],
      moved: false,
    },
    {
      id: "backups-setup",
      label: "Backup Setup",
      oldPath: "/admin/backups/setup",
      area: "support",
      moved: false,
    },
    {
      // Test-only route-error probe (#4467); 404 in production.
      id: "testing-route-error",
      label: "Route Error Probe",
      oldPath: "/admin/testing/route-error",
      area: "overview",
      kind: "test",
      moved: false,
    },
  ],
});
