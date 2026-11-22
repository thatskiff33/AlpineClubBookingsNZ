/**
 * The refusal "Add to work party" and "Remove from work party" (#5149) answer
 * when a booking's figures moved after the officer saw them: its code and its
 * sentence, in one client-safe home. The service's error carries both, and the
 * two dialogs compare the code (`apiErrorCodeFromBody`) to take the fresh
 * figures, falling back to the same sentence (`apiErrorMessageFromBody`).
 */
export const WORK_PARTY_FIGURES_CHANGED_CODE = "FIGURES_CHANGED";

export const WORK_PARTY_CORRECTION_FIGURES_CHANGED_MESSAGE =
  "The booking changed since the figures were shown. Check the new figures and confirm again.";
