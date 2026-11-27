/**
 * The mid-stay edit audit's report and command-line flags (#5242). The rules
 * and their limits live in `mid-stay-edit-history-audit.ts`; this module only
 * presents a result. `--summary` is the one part safe for the public issue: the
 * list carries booking and member ids.
 */
import type { ClubFormat } from "@/lib/club-format";
import { parseInstant } from "@/lib/club-time";
import {
  FIX_2743_MERGED_AT,
  FIX_2744_MERGED_AT,
  MID_STAY_EDIT_SHAPE_ORDER,
  MID_STAY_EDIT_SHAPES,
  MID_STAY_FIX_MARKER_MIGRATION,
  type MidStayEditAuditResult,
  type MidStayEditFinding,
  type MidStayEditShape,
} from "@/lib/mid-stay-edit-history-audit";
import { formatCents } from "@/lib/utils";

export interface MidStayEditShapeTotal {
  shape: MidStayEditShape;
  count: number;
  /** Known amounts summed, read as the shape's `amount` says. */
  atStakeCents: number;
  /** Findings whose amount the history cannot give. */
  unknownAmountCount: number;
}

export function summariseMidStayEditAudit(result: MidStayEditAuditResult): {
  shapes: MidStayEditShapeTotal[];
  listedEdits: number;
  clearEdits: number;
} {
  const shapes = MID_STAY_EDIT_SHAPE_ORDER.map((shape) => {
    const findings = result.examined.flatMap((edit) => edit.findings.filter((finding) => finding.shape === shape));
    return {
      shape,
      count: findings.length,
      atStakeCents: findings.reduce((sum, finding) => sum + (finding.atStakeCents ?? 0), 0),
      unknownAmountCount: findings.filter((finding) => finding.atStakeCents === null).length,
    };
  });
  const listedEdits = result.examined.filter((edit) => edit.findings.length > 0).length;
  return { shapes, listedEdits, clearEdits: result.examined.length - listedEdits };
}

function amountWithKind(shape: MidStayEditShape, cents: number, format: ClubFormat): string {
  const kind = MID_STAY_EDIT_SHAPES[shape].amount;
  return `${kind === "exact" ? "" : `${kind} `}${formatCents(cents, format)}`;
}

function describeAmount(finding: MidStayEditFinding, format: ClubFormat): string {
  if (finding.atStakeCents === null) return "amount unknown";
  return amountWithKind(finding.shape, finding.atStakeCents, format);
}

function describeShapeTotal(total: MidStayEditShapeTotal, format: ClubFormat): string {
  const meta = MID_STAY_EDIT_SHAPES[total.shape];
  const tag = [meta.issue, meta.certainty].filter(Boolean).join(", ");
  if (total.shape === "unreadable") return `  ${meta.label}: ${total.count}`;
  const parts = [`${total.count}`];
  if (total.unknownAmountCount < total.count || total.count === 0) {
    parts.push(amountWithKind(total.shape, total.atStakeCents, format));
  }
  if (total.unknownAmountCount > 0) parts.push(`${total.unknownAmountCount} amount unknown`);
  return `  ${meta.label} (${tag}): ${parts.join(", ")}`;
}

/**
 * The report. `summaryOnly` prints the header and counts alone - the only part
 * safe to post on the public issue; the list carries booking and member ids.
 */
export function formatMidStayEditAuditReport(
  result: MidStayEditAuditResult,
  format: ClubFormat,
  options: { summaryOnly?: boolean } = {},
): string {
  const { cutOff } = result;
  const marker = !cutOff.migrationHistory
    ? "no migration history on this database"
    : cutOff.markerFinishedAt
      ? cutOff.markerFinishedAt.toISOString()
      : "no finish recorded";
  const derivation =
    cutOff.source === "migration" ? "the marker migration's finish plus 24 hours" : "set with --before";
  const summary = summariseMidStayEditAudit(result);
  const lines = [
    "Mid-stay edit history audit (#5242: #2743, #2744, INV-MOD-025) - read only",
    "",
    `Fix for #2743 merged on main:       ${FIX_2743_MERGED_AT} (PR #2757)`,
    `Fix for #2744 merged on main:       ${FIX_2744_MERGED_AT} (PR #2758)`,
    `Marker migration finished here:     ${marker} (${MID_STAY_FIX_MARKER_MIGRATION})`,
    `Cut-off used:                       ${cutOff.instant.toISOString()} (${derivation})`,
    `Mid-stay edits after the cut-off:   ${result.midStayAfterCutOff} (made under the fixes, not examined)`,
    "",
    "## Summary",
    `${result.examined.length} mid-stay edit(s) before the cut-off examined: ${summary.listedEdits} listed, ${summary.clearEdits} clear.`,
    ...summary.shapes.map((total) => describeShapeTotal(total, format)),
    "Certain: the history shows the error and its amount. Possible: a person checks; \"up to\" is a limit, not a finding;",
    "an officer re-price's \"net change\" bounds nothing, since nights may have moved both ways.",
  ];
  if (options.summaryOnly) return lines.join("\n");

  const listed = result.examined.filter((edit) => edit.findings.length > 0);
  if (listed.length > 0) {
    lines.push(
      "",
      "## Listed edits - booking and member ids: keep this off the public repository and issue",
      "  booking | member | modification | edited on | shape | certainty | at stake | reason",
    );
    for (const edit of listed) {
      for (const finding of edit.findings) {
        const meta = MID_STAY_EDIT_SHAPES[finding.shape];
        lines.push(
          `  ${edit.bookingId} | ${edit.memberId ?? "(organisation-owned)"} | ${edit.modificationId} | ${edit.editedOn ?? "unknown"} | ${finding.shape} | ${meta.certainty} | ${describeAmount(finding, format)} | ${finding.reason}`,
        );
      }
    }
    lines.push("", "Nothing here is adjusted. A person decides, on #5242's follow-up.");
  }
  return lines.join("\n");
}

export interface MidStayEditAuditArgs {
  help: boolean;
  json: boolean;
  summary: boolean;
  before?: Date;
}

/**
 * The CLI's flags. Anything else throws, `--apply` included: this audit has no
 * write path to switch on.
 */
export function parseMidStayEditAuditArgs(argv: readonly string[]): MidStayEditAuditArgs {
  const args: MidStayEditAuditArgs = { help: false, json: false, summary: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // A POSIX shell forwards a literal `--` if somebody writes one.
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--summary") args.summary = true;
    else if (arg === "--before" || arg.startsWith("--before=")) {
      const value = arg === "--before" ? argv[(i += 1)] : arg.slice("--before=".length);
      // The kernel's parser: a zone is required, so a cut-off never takes the
      // host's local time, and an impossible date is refused, never rolled.
      const instant = value ? parseInstant(value) : null;
      if (!instant) {
        throw new Error(`--before needs an ISO instant with its zone, such as 2026-08-11T00:00:00Z; got ${value ?? "nothing"}`);
      }
      args.before = instant;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.json && args.summary) {
    throw new Error("--summary prints counts only; --json carries every edit's ids. Choose one.");
  }
  return args;
}
