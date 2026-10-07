/**
 * WHAT THE BOOKING-LEDGER BACK-POST REPORTS (#3583 PR 2): the outcome of each
 * booking, the run, the operator's report lines and the wrong-database fence.
 * Pure: `booking-ledger-back-post.ts` runs the back-post; this says what it found.
 */

/** Why a booking was not posted. Each is listed with its detail; none is ever guessed past. */
export const BACK_POST_REFUSALS = [
  /** A strand has a night with no stored price (an open review): nothing is evidence of its amount (`INV-MOD-028`). */
  "UNPRICED_NIGHT",
  /** The night rows and promotion do not come to the booking's final price, so the confirmation cannot be stated. */
  "CONFIRMATION_DOES_NOT_RECONCILE",
  /** An old edit's stored lines do not come to its own price difference. */
  "PRICE_LINES_DISAGREE",
  /** A closure's re-price row whose recorded movement cannot be read. */
  "REBASE_MOVEMENT_UNREADABLE",
  /** A live night line at a grain an edit cannot reverse, so no edit can be re-derived. */
  "LIVE_LINE_NOT_ONE_NIGHT",
  /** The edit planner refused (its reason follows): sum or nothing, as live. */
  "EDIT_NOT_DERIVABLE",
  /** A group settlement's paid children's payments do not add up to what it collected (#3854): no share is guessed. */
  "GROUP_SHARES_DO_NOT_RECONCILE",
  /** What was posted would leave the census disagreeing, gapped or finding a line wrong. */
  "CENSUS_WOULD_NOT_PASS",
  /** Another writer held one of the booking's locks past `lock_timeout`; re-run to retry it. */
  "LOCK_TIMEOUT",
  /** Anything else that went wrong for this booking alone (its message follows); the run goes on. */
  "UNEXPECTED_ERROR",
] as const;
export type BackPostRefusal = (typeof BACK_POST_REFUSALS)[number];

/** One identity the census would still disagree on, with both figures. */
export type BackPostDisagreement = {
  identity: string;
  columnCents: number;
  ledgerCents: number;
  deltaCents: number;
};

/** Why a booking was rolled back, with what the census would still say of it. */
type BackPostRefused = {
  bookingId: string;
  reason: BackPostRefusal;
  detail: string;
  disagreements: BackPostDisagreement[];
  coverage: string[];
  integrity: string[];
};

export type BookingBackPostOutcome =
  | { bookingId: string; kind: "NOTHING_TO_POST"; classes: string[] }
  | {
      bookingId: string;
      kind: "POSTED";
      lines: number;
      /** The ids of the lines this booking's transaction inserted (empty on a dry run, which commits none). */
      lineIds: string[];
      steps: string[];
      classes: string[];
    }
  | (BackPostRefused & { kind: "CANNOT_POST" });

export type BookingLedgerBackPostRun = {
  mode: "dry-run" | "apply";
  /** One id per run, and its window, so the lines a run posted can be found again (`lineIds` per booking). */
  runId: string;
  startedAt: string;
  finishedAt: string;
  outcomes: BookingBackPostOutcome[];
  totals: { bookings: number; posted: number; lines: number; nothingToPost: number; cannotPost: number };
};

/** One booking's report line(s); nothing for a booking with nothing to post. */
export function formatBookingLedgerBackPostOutcome(
  outcome: BookingBackPostOutcome,
  mode: BookingLedgerBackPostRun["mode"],
  money: (cents: number) => string,
): string[] {
  const verb = mode === "apply" ? "POSTED" : "WOULD POST";
  if (outcome.kind === "POSTED") {
    return [
      `${verb}  ${outcome.bookingId}  ${outcome.lines} line(s): ${outcome.steps.join("; ") || "settlement and credit lines"}${outcome.classes.length > 0 ? `  [census classes: ${outcome.classes.join(", ")}]` : ""}`,
    ];
  }
  if (outcome.kind === "CANNOT_POST") {
    return [
      `CANNOT POST  ${outcome.bookingId}  ${outcome.reason}: ${outcome.detail}`,
      ...outcome.disagreements.map((row) => `    ${row.identity}: column ${money(row.columnCents)}, ledger ${money(row.ledgerCents)}, delta ${money(row.deltaCents)}`),
      ...outcome.coverage.map((kind) => `    coverage: ${kind}`),
      ...outcome.integrity.map((finding) => `    integrity: ${finding}`),
    ];
  }
  return [];
}

/** The run's summary line. */
export function formatBookingLedgerBackPostSummary(run: BookingLedgerBackPostRun): string {
  const verb = run.mode === "apply" ? "posted" : "would post";
  return [
    `Booking ledger back-post (#3583) — ${run.mode === "apply" ? "APPLIED" : "DRY RUN, nothing was committed"}. Run ${run.runId}, ${run.startedAt} to ${run.finishedAt}.`,
    `Bookings: ${run.totals.bookings}   ${verb}: ${run.totals.posted} (${run.totals.lines} line(s))   nothing to post: ${run.totals.nothingToPost}   cannot post: ${run.totals.cannotPost}`,
  ].join("\n");
}

/** The whole report: every booking posted and every one that could not be, then the summary. */
export function formatBookingLedgerBackPostReport(run: BookingLedgerBackPostRun, money: (cents: number) => string): string {
  return [...run.outcomes.flatMap((outcome) => formatBookingLedgerBackPostOutcome(outcome, run.mode, money)), "", formatBookingLedgerBackPostSummary(run)].join("\n");
}

/**
 * The wrong-database fence for `--apply` (#3583's review, L2): the operator
 * names the database they mean, and the run refuses unless `DATABASE_URL`
 * names the same one. Returns what to print, or throws.
 */
export function describeBackPostTarget(databaseUrl: string, options: { apply: boolean; confirmDatabase: string | null }): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a database URL.");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const target = `Target: host ${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}, database ${database}`;
  if (options.apply && options.confirmDatabase !== database) {
    throw new Error(
      options.confirmDatabase === null
        ? `${target}. --apply needs --confirm-database ${database} to say this is the database you mean.`
        : `${target}. --confirm-database ${options.confirmDatabase} does not name it; nothing was posted.`,
    );
  }
  return target;
}
