"use client";

import { useId, useState } from "react";
import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";

import type { DiagnosticsAskProvenance } from "@/lib/diagnostics/answer/contract";
import { useClubTime } from "@/components/club-time-provider";

/**
 * WHERE THIS ANSWER CAME FROM — one line, expandable (AID-7, #2378; owner decision
 * D10, 12 Aug 2026).
 *
 * D10 chose this over two rejected alternatives, and the reasons shape the markup:
 *
 *  - NOT everything inline. In a 24rem column the metadata can be taller than the
 *    answer, so it gets scrolled past — "invisible in its own way".
 *  - NOT badges only. That sends the operator to another screen at the exact moment
 *    they are deciding whether to trust the answer.
 *
 * THE COLLAPSED LINE ALWAYS CARRIES THE CAVEAT. "The honesty markers are never
 * dropped from the collapsed line… the expander is for detail, not for the existence
 * of a caveat." The line is composed on the SERVER for that reason — see
 * `answer/provenance.ts` — so this component cannot drop a marker by restyling, and
 * the warning icon below is driven by the server's own `hasCaveat` rather than by
 * anything re-derived here.
 *
 * IT SHOWS NO ROWS. Provenance says where evidence came from and what was missing
 * from it. The rows themselves went to the model; rendering them again under the
 * answer would be a second, unredacted copy of the same personal data.
 */

function stateTone(state: string): string {
  if (state === "ok") return "text-muted-foreground";
  if (state === "not_found") return "text-muted-foreground";
  return "text-warning-11";
}

/**
 * An observed-at instant, in CLUB time (INV-DATE-015).
 *
 * The COLLAPSED line says "2 minutes ago" and this says the instant, on purpose:
 * "how fresh" and "exactly when" are different questions, and the expander is where
 * the second one belongs.
 *
 * IT IS PINNED TO THE CLUB'S ZONE, not the reader's. A bare `toLocaleString` renders
 * in whatever zone the browser is in, so the same evidence would carry a different
 * timestamp for an administrator travelling overseas than for the one beside them —
 * and the audit rows, the booking nights and every other admin screen are all in club
 * time, so the one instant that disagreed would be the one used to decide whether the
 * evidence predates a change. #2256/#2264 made that a lint-enforced invariant.
 *
 * "THE CLUB'S ZONE" NOW MEANS THE PERSISTED ONE (CT-4, #2870; INV-CONFIG-002),
 * not the container's `TZ`. A hook because that setting reaches the browser as
 * data through `ClubTimeProvider` and cannot be a module constant.
 */
function useInstantFormatter() {
  const clubTime = useClubTime();
  return (iso: string): string => {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return iso;
    return clubTime.instantDateTime(parsed);
  };
}

export function DiagnosticsProvenance({
  provenance,
}: {
  provenance: DiagnosticsAskProvenance;
}) {
  const formatInstant = useInstantFormatter();
  const [open, setOpen] = useState(false);
  const detailId = useId();

  return (
    <div className="mt-2 border-t border-border pt-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={detailId}
        data-testid="diagnostics-provenance-toggle"
        data-has-caveat={provenance.hasCaveat ? "true" : "false"}
        className="flex w-full items-start gap-1.5 rounded text-left text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? (
          <ChevronDown aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        )}
        {/* The icon is a SECOND channel for the caveat, not the only one — the words
            are already in the line. Colour alone would fail the same operator this
            issue's accessibility section is written for. */}
        {provenance.hasCaveat ? (
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-11"
          />
        ) : null}
        <span className="flex-1">{provenance.line}</span>
      </button>

      <div id={detailId} hidden={!open} className="mt-2 flex flex-col gap-2 pl-5">
        {provenance.sources.length === 0 ? (
          <p className="text-muted-foreground">
            No data tools were run for this answer.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {provenance.sources.map((source, index) => (
              <li key={`${source.toolId}-${index}`} className="flex flex-col gap-0.5">
                <span className="font-medium text-foreground">{source.label}</span>
                <span className={stateTone(source.state)}>
                  {source.stateDescription}
                </span>
                <span className="text-muted-foreground">
                  {/* The row count is the honest measure of what the answer rests on:
                      "nothing matched" and "24 rows" are different evidence, and the
                      state sentence alone does not carry the number. */}
                  {source.rowCount === 1 ? "1 record" : `${source.rowCount} records`}
                  {" · read "}
                  {formatInstant(source.observedAt)}
                </span>
                {source.missingAreas.length > 0 ? (
                  <span className="text-warning-11">
                    Needs admin access to: {source.missingAreas.join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {provenance.withheldAreas.length > 0 ? (
          <p className="text-warning-11">
            A Full Admin can add these areas to your access to complete the picture:{" "}
            {provenance.withheldAreas.join(", ")}.
          </p>
        ) : null}

        <p className="text-muted-foreground">
          {provenance.roundsUsed === 1
            ? "One round of evidence gathering."
            : `${provenance.roundsUsed} rounds of evidence gathering.`}
        </p>
      </div>
    </div>
  );
}
