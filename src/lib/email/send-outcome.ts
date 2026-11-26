import type { EmailSendOutcome } from "./core";

/**
 * Nothing was transmitted, but the row this send left is the email retry
 * job's to send, so a caller that would otherwise send its own copy must not:
 * an unreadable "No emails" switch, an environment-safety fault (not a
 * confirmed copy), or a lost hand-over (#5298). A row with no body kept lands in
 * the officers' review queue instead of being replayed.
 */
export function isLeftForTheEmailRetryJob(outcome: EmailSendOutcome): boolean {
  return (
    (outcome.status === "withheld_for_booking" && outcome.reason === "booking_flag_unreadable") ||
    // Written as "not the terminal one" rather than as a list of faults, so a
    // fault added later is replayable by default (#3035).
    (outcome.status === "withheld_for_environment" && outcome.reason !== "environment_non_production") ||
    outcome.status === "handover_lost"
  );
}
