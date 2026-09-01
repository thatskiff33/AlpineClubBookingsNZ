/**
 * The kiosk's PIN-session clocks, in one module both sides of the client/server
 * boundary can hold (#3228).
 *
 * ## Why these numbers share one module
 *
 * They are one rule with several halves, and the halves live on opposite sides
 * of the client/server boundary: the server decides when a PIN session has gone
 * idle, and the browser decides when to tell it somebody is still there and when
 * to stop showing a view it believes has lapsed. If they drifted apart in either
 * direction the result is a defect rather than a tuning change — a renewal
 * interval longer than the idle window logs a hut leader out mid-roster, an idle
 * window shorter than the interval can never be renewed at all, and a client
 * that gives up BEFORE the server does drops a working hut leader's screen for
 * no reason. So they are defined here, once, with the relations between them
 * stated and pinned by a test.
 *
 * `@/lib/lodge-pin-session` (which reads the database and the auth secret) is
 * unreachable from a browser bundle, and the kiosk page and the roster wizard
 * are `"use client"` modules, so the constants could not have been shared from
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
 * keeps a session alive up to the absolute ceiling below, and no interruption
 * ever falls in the middle of a piece of work.
 */
export const HUT_LEADER_PIN_SESSION_IDLE_SECONDS = 10 * 60;

/**
 * The longest a PIN session can live, however busy the screen is.
 *
 * **This is the twelve-hour deadline the idle window replaced, kept as an
 * absolute ceiling rather than dropped.** The idle window is the control against
 * an unattended tablet; it is no control at all against a cookie somebody
 * COPIED. That is a minute's work at the tablet — the value sits in the same
 * devtools panel as the sign-in cookie — and without a ceiling the thief renews
 * it from their own laptop for as long as the assignment runs, because renewal
 * re-signs the same authority with a later deadline and asks nothing else of the
 * caller. `DELETE /api/lodge/pin-session` (the Lock button) clears the cookie in
 * the browser that asked; it does not revoke anything server-side, so a copy
 * taken before the lock is unaffected by it. Twelve hours from the PIN entry is
 * therefore the one bound that case has.
 *
 * It costs nothing legitimate. A genuine all-day shift re-enters a six-digit PIN
 * once, and the ceiling is judged from `iat` — the ORIGINAL sign-in — so no
 * amount of renewal moves it.
 */
export const HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS = 12 * 60 * 60;

/**
 * The browser tells the server "a person interacted" at most this often.
 *
 * Interaction is continuous and renewal is a request, so a burst of taps is
 * collapsed into one call. **Leading edge**: the first interaction after a quiet
 * stretch renews immediately, and further interactions inside the next interval
 * are suppressed. That ordering is what keeps a busy hut leader signed in — a
 * trailing throttle would send the renewal AFTER the deadline it was meant to
 * move.
 *
 * The cost of collapsing is that the server's deadline is measured from the last
 * RENEWAL rather than the last tap, so a session can close up to this long
 * before a full idle window has passed since somebody last touched the screen.
 * The browser knows exactly when its own renewals were accepted, so it counts
 * from the same instant the server does rather than from the taps — see
 * `src/components/lodge-pin-session.tsx`.
 */
export const HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS = 60_000;

/**
 * How often the browser checks whether the window it is holding has closed.
 *
 * Deliberately much shorter than the renewal interval, and deliberately NOT the
 * thing that drives renewal. Nothing depends on this timer firing on schedule:
 * a tablet that dims, sleeps or is backgrounded has its timers throttled to
 * about one a minute or frozen outright, and the only consequence here is that
 * the check happens late — which errs towards the server's answer, not away from
 * it.
 */
export const HUT_LEADER_PIN_IDLE_CHECK_INTERVAL_MS = 15_000;

/**
 * How far past its own estimate of the server's deadline the browser waits
 * before it stops showing a hut leader's view.
 *
 * **The margin exists so the browser can never give up first, and that
 * direction is the whole point.** Erring early looks like the safe direction and
 * is the opposite: the server session is still valid, so the refetch that
 * follows returns the privileged payload again, the clock restarts from a
 * background event, and the real expiry then passes unnoticed until the next
 * two-minute data refresh. A drop that lands after the server's deadline
 * produces the ordinary lodge view on the first try and stays there.
 *
 * Five seconds covers clock granularity and the difference between when the
 * server stamped a deadline and when the browser saw the response. It is not
 * covering network latency in the dangerous direction: the browser starts
 * counting from the moment a renewal RESPONSE arrived, which is at or after the
 * instant the server stamped, so its estimate already sits on the safe side.
 */
export const HUT_LEADER_PIN_SESSION_IDLE_DROP_MARGIN_MS = 5_000;

/**
 * The idle window in whole minutes, for the sentences of kiosk copy that tell a
 * hut leader how long the screen stays unlocked. Derived rather than typed into
 * the JSX so the screen cannot promise a number the server does not enforce
 * (`INV-SSOT`).
 *
 * An exact division, not a rounded one: `Math.round` would print "2 minutes"
 * for a ninety-second window, which is copy that lies. A test asserts the
 * window really is a whole number of minutes, so a future change to it has to
 * face the copy rather than silently mis-state it.
 */
export const HUT_LEADER_PIN_SESSION_IDLE_MINUTES =
  HUT_LEADER_PIN_SESSION_IDLE_SECONDS / 60;

/**
 * How often the kiosk re-asks for its data, and the slower cadence it backs off
 * to after three consecutive failures.
 *
 * Here rather than in the page because it is the number the PIN-session rules
 * are stated AGAINST — "background refreshes do not extend the session" is
 * about this timer, and both the page and the tests that prove the rule need
 * the same value. A page module may export nothing but its component, so the
 * tests could not have imported it from there and had a private copy instead.
 */
export const KIOSK_DATA_REFRESH_MS = 120_000;
export const KIOSK_DATA_REFRESH_BACKOFF_MS = 300_000;
