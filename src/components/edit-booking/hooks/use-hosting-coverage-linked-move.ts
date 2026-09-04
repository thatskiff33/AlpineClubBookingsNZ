"use client";

import { useState } from "react";

import {
  useRetiredPrompt,
  type RetiredPromptState,
} from "@/components/edit-booking/hooks/use-retired-prompt";
import type {
  HostingCoverageLinkedMoveChoice,
  HostingCoverageLinkedMovePromptData,
} from "@/lib/hosting-coverage-linked-move-client";

/** The refused save's linked-move offer, bound to the proposal it refused. */
export type HostingLinkedMoveState =
  RetiredPromptState<HostingCoverageLinkedMovePromptData>;

/**
 * Hold #3232's linked-move offer only while it still describes the edit on screen.
 *
 * The retire-on-change machinery is `useRetiredPrompt`, shared with the officer's
 * override rather than copied — one pattern for "a 409 that must be retired the
 * moment the member changes their mind", not two, which is what this docblock
 * asked for while being a renamed copy of the other hook.
 *
 * RETIRING THIS ONE MATTERS MORE THAN RETIRING THE OVERRIDE, because it carries a
 * PRICE, and the chosen arm is cleared with it: a member who ticked "move both"
 * for one proposal has not agreed to move both for a different one at a different
 * price.
 */
export function useHostingCoverageLinkedMove(
  buildSavePayload: (notifyMemberChoice?: boolean) => Record<string, unknown>,
) {
  const [linkedMoveChoice, setLinkedMoveChoice] =
    useState<HostingCoverageLinkedMoveChoice | null>(null);

  const { setState, activeState } =
    useRetiredPrompt<HostingCoverageLinkedMovePromptData>(buildSavePayload, () =>
      setLinkedMoveChoice(null),
    );

  return {
    setLinkedMoveState: setState,
    linkedMoveChoice,
    setLinkedMoveChoice,
    activeLinkedMoveState: activeState,
  };
}
