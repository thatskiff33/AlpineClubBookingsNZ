import type {
  InductionBaselineReport,
  InductionBaselineSafeDatabaseTarget,
} from "@/lib/induction-baseline";

export interface InductionBaselineCliOptions {
  apply: boolean;
  actorMemberId: string;
  baselineDate: string;
  provenanceNote: string;
  confirmClubName?: string;
  confirmDatabaseHost?: string;
  confirmDatabaseName?: string;
  confirmPlanDigest?: string;
  json: boolean;
  help: boolean;
}

export type SafeDatabaseTarget = InductionBaselineSafeDatabaseTarget;

type InductionBaselineOutcome = "success" | "blocked" | "plan-mismatch";

export class InductionBaselineCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InductionBaselineCliError";
  }
}

export const INDUCTION_BASELINE_JSON_BEGIN =
  "---BEGIN SAFE INDUCTION BASELINE JSON---";
export const INDUCTION_BASELINE_JSON_END =
  "---END SAFE INDUCTION BASELINE JSON---";

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new InductionBaselineCliError(`${flag} requires a value.`);
  }
  return value;
}

export function parseInductionBaselineArgs(
  argv: string[],
): InductionBaselineCliOptions {
  let apply = false;
  let explicitMode: "apply" | "dry-run" | null = null;
  let actorMemberId: string | undefined;
  let baselineDate: string | undefined;
  let provenanceNote: string | undefined;
  let confirmClubName: string | undefined;
  let confirmDatabaseHost: string | undefined;
  let confirmDatabaseName: string | undefined;
  let confirmPlanDigest: string | undefined;
  let json = false;
  let help = false;
  const seenValueFlags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // Unreachable: the loop condition already guarantees `index < argv.length`.
    if (arg === undefined) break;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--apply" || arg === "--dry-run") {
      const mode = arg === "--apply" ? "apply" : "dry-run";
      if (explicitMode) {
        throw new InductionBaselineCliError(
          "Specify exactly one mode flag; --apply and --dry-run cannot be repeated or combined.",
        );
      }
      explicitMode = mode;
      apply = mode === "apply";
      continue;
    }

    const valueFlags: Record<string, (value: string) => void> = {
      "--actor-member-id": (value) => {
        actorMemberId = value;
      },
      "--baseline-date": (value) => {
        baselineDate = value;
      },
      "--provenance-note": (value) => {
        provenanceNote = value;
      },
      "--confirm-club-name": (value) => {
        // Do not trim: apply confirmation is deliberately exact.
        confirmClubName = value;
      },
      "--confirm-db-host": (value) => {
        confirmDatabaseHost = value;
      },
      "--confirm-db-name": (value) => {
        confirmDatabaseName = value;
      },
      "--confirm-plan-digest": (value) => {
        // Do not trim: apply confirmation is deliberately exact.
        confirmPlanDigest = value;
      },
    };
    const assign = valueFlags[arg];
    if (assign) {
      if (seenValueFlags.has(arg)) {
        throw new InductionBaselineCliError(
          `The ${arg} option may be supplied only once.`,
        );
      }
      seenValueFlags.add(arg);
      assign(readValue(argv, index, arg));
      index += 1;
      continue;
    }

    throw new InductionBaselineCliError(
      "Unknown argument. Run with --help to see the supported options.",
    );
  }

  if (help) {
    return {
      apply,
      actorMemberId: actorMemberId ?? "",
      baselineDate: baselineDate ?? "",
      provenanceNote: provenanceNote ?? "",
      confirmClubName,
      confirmDatabaseHost,
      confirmDatabaseName,
      confirmPlanDigest,
      json,
      help,
    };
  }

  if (!actorMemberId?.trim()) {
    throw new InductionBaselineCliError("--actor-member-id is required.");
  }
  if (!baselineDate) {
    throw new InductionBaselineCliError("--baseline-date is required.");
  }
  if (!provenanceNote?.trim()) {
    throw new InductionBaselineCliError("--provenance-note is required.");
  }
  if (apply && confirmClubName === undefined) {
    throw new InductionBaselineCliError(
      "--confirm-club-name is required with --apply.",
    );
  }
  if (apply && !confirmDatabaseHost) {
    throw new InductionBaselineCliError(
      "--confirm-db-host is required with --apply.",
    );
  }
  if (apply && !confirmDatabaseName) {
    throw new InductionBaselineCliError(
      "--confirm-db-name is required with --apply.",
    );
  }
  if (apply && confirmPlanDigest === undefined) {
    throw new InductionBaselineCliError(
      "--confirm-plan-digest is required with --apply.",
    );
  }

  return {
    apply,
    actorMemberId: actorMemberId.trim(),
    baselineDate,
    provenanceNote: provenanceNote.trim(),
    confirmClubName,
    confirmDatabaseHost,
    confirmDatabaseName,
    confirmPlanDigest,
    json,
    help,
  };
}

/**
 * Parse only the non-secret database target fields. The raw URL and its
 * username/password are never returned, formatted or included in an error.
 */
export function parseSafeDatabaseTarget(
  databaseUrl: string | undefined,
): SafeDatabaseTarget {
  if (!databaseUrl?.trim()) {
    throw new InductionBaselineCliError("DATABASE_URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new InductionBaselineCliError(
      "DATABASE_URL is not a valid PostgreSQL URL.",
    );
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new InductionBaselineCliError(
      "DATABASE_URL must use the postgresql:// or postgres:// protocol.",
    );
  }
  if (!parsed.host) {
    throw new InductionBaselineCliError(
      "DATABASE_URL must include a database host.",
    );
  }

  const encodedName = parsed.pathname.replace(/^\/+/, "");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(encodedName);
  } catch {
    throw new InductionBaselineCliError(
      "DATABASE_URL contains an invalid encoded database name.",
    );
  }
  if (!databaseName) {
    throw new InductionBaselineCliError(
      "DATABASE_URL must include a database name.",
    );
  }

  return { host: parsed.host, databaseName };
}

export function assertDatabaseTargetConfirmation(params: {
  apply: boolean;
  target: SafeDatabaseTarget;
  confirmHost?: string;
  confirmDatabaseName?: string;
}): void {
  if (!params.apply) return;
  if (params.confirmHost !== params.target.host) {
    throw new InductionBaselineCliError(
      "Database-host confirmation does not exactly match the parsed DATABASE_URL host.",
    );
  }
  if (params.confirmDatabaseName !== params.target.databaseName) {
    throw new InductionBaselineCliError(
      "Database-name confirmation does not exactly match the parsed DATABASE_URL database name.",
    );
  }
}

function memberIds(
  rows: Array<{ memberId: string }>,
  emptyMessage: string,
): string {
  return rows.length > 0
    ? rows.map((row) => `  - ${row.memberId}`).join("\n")
    : `  ${emptyMessage}`;
}

export function formatInductionBaselineReport(
  report: InductionBaselineReport,
  target: SafeDatabaseTarget,
  outcome: InductionBaselineOutcome = "success",
): string {
  const lines = [
    `Trusted legacy induction baseline (${report.mode})`,
    `PLAN DIGEST: ${report.planDigest}`,
    `Club: ${report.clubName}`,
    `Database target: host=${target.host} name=${target.databaseName}`,
    `Actor member ID: ${report.actorMemberId}`,
    `NZ baseline date: ${report.baselineDate}`,
    `Template: ${report.template.name} / ${report.template.version} (${report.template.id})`,
    `Provenance: ${report.provenance}`,
    "",
    "Deterministic category counts:",
    `  Eligible population: ${report.counts.eligiblePopulation}`,
    `  CREATE: ${report.counts.toCreate}`,
    `  ALREADY_COMPLETED: ${report.counts.alreadyCompleted}`,
    `  OPEN_WORKFLOW (apply blocker): ${report.counts.openWorkflow}`,
    `  NOT_APPLICABLE (reported only): ${report.counts.notApplicable}`,
    "",
    "Configured age-tier counts:",
    ...report.tierCounts.map(
      (tier) =>
        `  ${tier.tier} (${tier.label}): population=${tier.eligiblePopulation} ` +
        `create=${tier.toCreate} completed=${tier.alreadyCompleted} open=${tier.openWorkflow}`,
    ),
    "",
    `CREATE (${report.toCreate.length}):`,
    memberIds(report.toCreate, "none"),
    "",
    `ALREADY_COMPLETED (${report.alreadyCompleted.length}):`,
    memberIds(report.alreadyCompleted, "none"),
    "",
    `OPEN_WORKFLOW (${report.openWorkflows.length}):`,
    memberIds(report.openWorkflows, "none"),
    "",
    `NOT_APPLICABLE (${report.notApplicable.length}):`,
    memberIds(report.notApplicable, "none"),
  ];

  if (outcome === "plan-mismatch") {
    lines.push(
      "",
      "Apply stopped: plan digest did not match; no changes written. Review this refreshed report, then start again with a fresh dry run.",
    );
  } else if (report.mode === "dry-run") {
    lines.push(
      "",
      "Dry run: no changes written. Review this report, resolve every OPEN_WORKFLOW row, then re-run with --apply and all exact confirmations.",
    );
  } else if (report.counts.openWorkflow > 0) {
    lines.push(
      "",
      "Apply blocked: no changes written. Resolve every OPEN_WORKFLOW row and start again with a fresh dry run.",
    );
  } else if (report.appliedCount > 0) {
    lines.push("", `Applied ${report.appliedCount} completed baseline row(s).`);
  } else {
    lines.push("", "Apply was a no-op: no baseline rows needed creation.");
  }

  return lines.join("\n");
}

export function safeInductionBaselineJson(
  report: InductionBaselineReport,
  target: SafeDatabaseTarget,
): string {
  return JSON.stringify(
    {
      databaseTarget: target,
      report,
    },
    null,
    2,
  );
}

export function formatInductionBaselineOutput(
  report: InductionBaselineReport,
  target: SafeDatabaseTarget,
  includeJson: boolean,
  outcome: InductionBaselineOutcome = "success",
): string {
  const parts = [formatInductionBaselineReport(report, target, outcome)];
  if (includeJson) {
    parts.push(
      [
        INDUCTION_BASELINE_JSON_BEGIN,
        safeInductionBaselineJson(report, target),
        INDUCTION_BASELINE_JSON_END,
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

export function buildBlockedInductionBaselineResult(
  report: InductionBaselineReport,
  target: SafeDatabaseTarget,
  includeJson: boolean,
): { output: string; exitCode: 1 } {
  return {
    output: formatInductionBaselineOutput(
      report,
      target,
      includeJson,
      "blocked",
    ),
    exitCode: 1,
  };
}

export function buildPlanMismatchInductionBaselineResult(
  report: InductionBaselineReport,
  target: SafeDatabaseTarget,
  includeJson: boolean,
): { output: string; exitCode: 1 } {
  return {
    output: formatInductionBaselineOutput(
      report,
      target,
      includeJson,
      "plan-mismatch",
    ),
    exitCode: 1,
  };
}
