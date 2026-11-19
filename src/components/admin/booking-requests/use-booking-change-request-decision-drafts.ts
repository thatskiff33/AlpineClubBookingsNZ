"use client";

/**
 * The change-request panel's per-row decision drafts, split out of
 * `booking-change-requests-panel.tsx` so the panel file holds the decision flow
 * and its rendering (the same split `booking-change-request-panel-model.ts`
 * made for the data types). The state and its three helpers are moved as they
 * were; nothing about how a draft is read, patched or cleared changed.
 */
import { useState } from "react";
import {
  EMPTY_DECISION_DRAFT,
  type DecisionDraft,
} from "@/components/admin/booking-requests/booking-change-request-panel-model";

export function useBookingChangeRequestDecisionDrafts() {
  /**
   * Every open decision draft, keyed by the request it belongs to.
   *
   * One entry per row the officer has typed into, so a row's fields, the guard on
   * its buttons and the body it submits all read the SAME object and no row can
   * read another's (#2562 review — see `DecisionDraft`). A row nobody has typed
   * into has no entry, which is exactly the empty draft its buttons stay disabled
   * on.
   */
  const [decisionDrafts, setDecisionDrafts] = useState<
    Record<string, DecisionDraft>
  >({});
  /** This row's draft as typed, or the empty one. Never another row's. */
  function decisionDraftFor(id: string): DecisionDraft {
    return decisionDrafts[id] ?? EMPTY_DECISION_DRAFT;
  }
  /** Patch one field of one row's draft, leaving every other row untouched. */
  function updateDecisionDraft(id: string, patch: Partial<DecisionDraft>) {
    setDecisionDrafts((current) => ({
      ...current,
      [id]: { ...(current[id] ?? EMPTY_DECISION_DRAFT), ...patch },
    }));
  }
  /** Drop one row's draft — used on a SUCCESSFUL decision, and only then. */
  function clearDecisionDraft(id: string) {
    setDecisionDrafts((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }
  return { decisionDraftFor, updateDecisionDraft, clearDecisionDraft };
}
