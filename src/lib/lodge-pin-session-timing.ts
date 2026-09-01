/**
 * How long a hut leader's kiosk PIN session lives, and how often the browser is
 * allowed to say a person touched the screen (#3228).
 *
 * ## Why these two numbers share one module
 *
 * They are one rule with two halves, and the halves live on opposite sides of
 * the client/server boundary: the server decides when a PIN session has gone
 * idle, and the kiosk page decides when to tell it somebody is still there. If
 * they drifted apart in either direction the result is a defect rather than a
 * tuning change — a renewal interval longer than the idle window logs a hut
 * leader out mid-roster, and an idle window shorter than the interval can never
 * be renewed at all. So both are defined here, once, with the relation between
 * them stated and pinned by a test.
 *
 * `@/lib/lodge-pin-session` (which reads the database and the auth secret) is
 * unreachable from a browser bundle, and `src/app/(lodge)/lodge/kiosk/page.tsx`
 * is a `"use client"` module, so the constants could not have been shared from
 * there. This module deliberately imports NOTHING, which is what makes it safe
 * for both sides (`INV-OPS-013`, and the client/server boundary census).
 */

/**
 * A PIN session ends after this long with **nobody touching the screen**.
 *
 * It used to be twelve hours from sign-in, with nothing in the tree that could
 * end it early: one PIN entry made a shared wall tablet a hut leader's screen
 * for the rest of the day, to whoever walked up to it (#3228).
 *
 * Ten minutes of INACTIVITY, rather than a hard ten minutes from sign-in, is
 * the owner's decision of 1 September 2026, and the rejected alternative is
 * recorded with it: a leader part-way through marking a full lodge would be
 * logged out over and over, and that ends with the PIN on a sticky note beside
 * the tablet — worse than the problem being fixed. Continuous use therefore
 * keeps a session alive indefinitely, bounded only by the assignment's own
 * date window, which `getActiveLodgePinSessionForDate` already enforces.
 */
export const HUT_LEADER_PIN_SESSION_IDLE_SECONDS = 10 * 60;

/**
 * The kiosk tells the server "a person interacted" at most this often.
 *
 * Interaction is continuous and renewal is a request, so the browser collapses
 * a burst of taps into one call. **Leading edge**: the first interaction after
 * a quiet stretch renews immediately, and further interactions inside the next
 * interval are suppressed. That ordering is what keeps a busy hut leader
 * signed in — a trailing throttle would send the renewal AFTER the deadline it
 * was meant to move.
 *
 * The cost of collapsing is that a session can expire up to this long before
 * its full idle window, measured from the last tap: the deadline is set from
 * the last RENEWAL, and a suppressed tap does not move it. That errs towards
 * locking, which is the safe direction, and it is why this must stay small
 * relative to the window above.
 */
export const HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS = 60_000;

/**
 * The idle window in whole minutes, for the one sentence of kiosk copy that
 * tells a hut leader how long the screen stays unlocked. Derived rather than
 * typed into the JSX so the screen cannot promise a number the server does not
 * enforce (`INV-SSOT`).
 */
export const HUT_LEADER_PIN_SESSION_IDLE_MINUTES = Math.round(
  HUT_LEADER_PIN_SESSION_IDLE_SECONDS / 60
);
