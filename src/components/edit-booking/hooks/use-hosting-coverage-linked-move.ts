"use client";

import { useEffect, useState } from "react";

import { hostingCoverageMutationSignature } from "@/lib/hosting-coverage-override-client";
import type {
  HostingCoverageLinkedMoveChoice,
  HostingCoverageLinkedMovePromptData,
} from "@/lib/hosting-coverage-linked-move-client";

/** The refused save's linked-move offer, bound to the proposal it refused. */
export interface HostingLinkedMoveState {
  prompt: HostingCoverageLinkedMovePromptData;
  proposalSignature: string;
  notifyMemberChoice: boolean | undefined;
}

/**
 * Hold #3232's linked-move offer only while it still describes the edit on screen.
 *
 * The same shape as `useHostingCoverageOverride`, and deliberately so: one pattern
 * for "a 409 that must be retired the moment the member changes their mind", not
 * two. It shares that hook's `hostingCoverageMutationSignature` rather than
 * computing a second canonical form of the same payload (`INV-SSOT-001`) — two
 * signatures that could disagree about whether the proposal changed would let a
 * prompt outlive the edit it belongs to.
 *
 * RETIRING THIS ONE MATTERS MORE THAN RETIRING THE OVERRIDE, because it carries a
 * PRICE. A member who changes their dates after seeing the offer must not be able
 * to submit the old answer: its state key is bound to the combined figure, so the
 * server would refuse it anyway — but a stale offer left on screen would show them
 * a total that is no longer true while they decide. Clearing it locally means they
 * are re-asked rather than shown a number that has quietly stopped applying.
 *
 * THE CHOICE IS CLEARED WITH THE PROMPT, and never carried across. A member who
 * ticked "move both" for one proposal has not agreed to move both for a different
 * one at a different price.
 *
 * `buildSavePayload` is called during RENDER, never from a dependency array, so its
 * identity is irrelevant and it is deliberately not memoised — the same contract
 * its sibling documents.
 */
export function useHostingCoverageLinkedMove(
  buildSavePayload: (notifyMemberChoice?: boolean) => Record<string, unknown>,
) {
  const [linkedMoveState, setLinkedMoveState] =
    useState<HostingLinkedMoveState | null>(null);
  const [linkedMoveChoice, setLinkedMoveChoice] =
    useState<HostingCoverageLinkedMoveChoice | null>(null);

  const linkedMoveProposalStillCurrent = Boolean(
    linkedMoveState &&
      linkedMoveState.proposalSignature ===
        hostingCoverageMutationSignature(
          buildSavePayload(linkedMoveState.notifyMemberChoice),
        ),
  );
  const activeLinkedMoveState = linkedMoveProposalStillCurrent
    ? linkedMoveState
    : null;

  useEffect(() => {
    if (linkedMoveState && !linkedMoveProposalStillCurrent) {
      setLinkedMoveState(null);
      setLinkedMoveChoice(null);
    }
  }, [linkedMoveProposalStillCurrent, linkedMoveState]);

  return {
    // `linkedMoveState` itself is deliberately NOT returned, for the reason its
    // sibling gives: the panel must read `activeLinkedMoveState`, which is null the
    // moment the offer stops describing the edit on screen. Handing out the raw
    // slot would let a caller render a retired offer — here, one with a retired
    // price on it.
    setLinkedMoveState,
    linkedMoveChoice,
    setLinkedMoveChoice,
    activeLinkedMoveState,
  };
}
