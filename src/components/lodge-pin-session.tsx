"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  HUT_LEADER_PIN_IDLE_CHECK_INTERVAL_MS,
  HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS,
  HUT_LEADER_PIN_SESSION_IDLE_DROP_MARGIN_MS,
  HUT_LEADER_PIN_SESSION_IDLE_SECONDS,
} from "@/lib/lodge-pin-session-timing";

/**
 * The browser half of the hut-leader PIN session (#3228) — ONE implementation,
 * mounted once for the whole lodge area.
 *
 * ## Why this is not in the kiosk page
 *
 * It was, and that was the defect. A hut leader's authority spans **two** pages:
 * `/lodge/kiosk`, where the PIN is typed, and `/lodge/roster/<date>/setup`, the
 * chore-roster wizard the kiosk links to with a plain `<a href>`. That link is a
 * FULL NAVIGATION, so the kiosk unmounts and takes its listeners with it. With
 * renewal living on the kiosk, the wizard's deadline was fixed at the moment the
 * leader left the kiosk — at most ten minutes, and often less, because the
 * throttle means the last renewal can be up to a minute old.
 *
 * Everything the wizard reads is served to the ordinary lodge tier, so the page
 * looked perfectly healthy the whole time. The failure arrived at the end:
 * `POST .../generate` or `.../confirm` answered `{"error":"Forbidden"}`, printed
 * verbatim over a full lodge's chore allocation that existed only in component
 * state. Allocating chores for a full lodge plausibly takes longer than ten
 * minutes every single time, so the outcome was a hut leader losing all of it
 * and starting again — precisely the outcome the owner rejected the hard-timeout
 * option to avoid ("that ends with the PIN on a sticky note beside the tablet").
 *
 * So the listeners and the renewal live here, mounted from
 * `src/app/(lodge)/layout.tsx`, which wraps both pages. Any human interaction
 * anywhere in the lodge area renews, once, from one implementation. Copying the
 * listener block into the wizard would have fixed the symptom and created a
 * second copy of the rule (`INV-SSOT`), which is how the two would then drift.
 *
 * ## What the server decides, and what this decides
 *
 * The server owns the deadline: it lives inside the HMAC-signed cookie as `exp`,
 * and renewal mints a NEW cookie from the server's own clock for a session that
 * is still valid. Nothing here can extend a session by asserting that time has
 * not passed, and nothing here can bring an expired one back — the PIN is the
 * only way in.
 *
 * This module decides two things only: WHEN to tell the server somebody is
 * still there, and when to stop painting a view it believes has lapsed.
 */

/** `POST` to renew, `DELETE` to lock. */
export const LODGE_PIN_SESSION_ENDPOINT = "/api/lodge/pin-session";

/** Where a six-digit hut-leader PIN is exchanged for a session. */
export const LODGE_PIN_LOGIN_ENDPOINT = "/api/lodge/pin-login";

/*
  WHAT COUNTS AS A PERSON BEING HERE.

  A hut leader's PIN session ends after ten minutes with nobody touching the
  screen, and this list is the definition of "touching". Get it wrong in the
  generous direction and the fix is undone: the kiosk refreshes itself every two
  minutes to keep the roster current, so anything a WALL TABLET SITTING ALONE ON
  A BENCH does by itself must not appear here. That is exactly the situation
  being closed, and it is why renewal hangs off DOM input events rather than off
  either page's fetches.

  Each entry, and why:

   - `pointerdown` — the tap or click itself, on mouse, pen and touch alike.
   - `keydown` — an on-screen or attached keyboard, including the PIN pad.
   - `touchstart` — belt and braces for a touch device whose browser does not
     give us pointer events.
   - `wheel` — reading a long guest list on a device with a mouse or a trackpad
     is real use, and it produces no tap at all. A touch device scrolling the
     same list fires `touchstart`.

  `scroll` is deliberately ABSENT, and the reason is the whole trap in one
  example: a programmatic scroll fires `scroll` with `isTrusted: true`, so any
  future auto-scroll, `scrollIntoView`, or layout shift on either page would
  read as a person. `wheel` and the pointer/key events are only produced by real
  input.

  Every listener additionally requires `event.isTrusted`, which is false for
  anything a script dispatches with `dispatchEvent`. That does not make the
  signal unforgeable — see the route's docblock — but it does mean forging it
  takes deliberate work rather than an accident somewhere else on the page.
*/
export const HUMAN_INTERACTION_EVENTS = [
  "pointerdown",
  "keydown",
  "touchstart",
  "wheel",
] as const;

const IDLE_MS = HUT_LEADER_PIN_SESSION_IDLE_SECONDS * 1000;

interface LodgePinSessionValue {
  /**
   * Whether THIS device holds a PIN session — as opposed to a hut leader signed
   * in with their own account, who also reads `tier: "hut-leader"` and is
   * governed by none of this.
   */
  active: boolean;
  /**
   * A renewal was refused for a reason that is NOT "the session is over" — a
   * 429, a 5xx, a dropped connection. The deadline did not move, so the screen
   * may lock itself; a surface holding one should say so rather than swallow it.
   */
  renewalTrouble: boolean;
  /** Publish what the server just said about this device's PIN session. */
  setActive: (active: boolean) => void;
  /** @internal — reach it through {@link useLodgePinSessionLapse}. */
  lapseHandlerRef: React.MutableRefObject<(() => void) | null>;
}

const LodgePinSessionContext = createContext<LodgePinSessionValue | null>(null);

/**
 * Read the shared PIN-session state.
 *
 * **Throws without a provider, deliberately.** An inert default would mean a
 * page that forgot to mount the provider silently never renews, which is exactly
 * the failure this module exists to fix — and it took a review to find that one,
 * because nothing on screen looked wrong until the save at the end. Failing
 * loudly at render is the cheap version of that lesson.
 */
export function useLodgePinSession(): LodgePinSessionValue {
  const value = useContext(LodgePinSessionContext);
  if (!value) {
    throw new Error(
      "useLodgePinSession requires <LodgePinSessionProvider>, mounted in src/app/(lodge)/layout.tsx",
    );
  }
  return value;
}

/**
 * Be told when the window has closed without the server having said so in a
 * response — the browser's own count ran out.
 *
 * The kiosk uses it to drop every privileged answer it holds and re-ask. The
 * roster wizard uses it to say the screen has locked itself, WITHOUT throwing
 * away the allocation somebody has been building. One handler at a time: only
 * one lodge page is mounted, and the last to register wins.
 */
export function useLodgePinSessionLapse(handler: () => void): void {
  const { lapseHandlerRef } = useLodgePinSession();
  useEffect(() => {
    lapseHandlerRef.current = handler;
    return () => {
      if (lapseHandlerRef.current === handler) {
        lapseHandlerRef.current = null;
      }
    };
  }, [handler, lapseHandlerRef]);
}

export function LodgePinSessionProvider({
  initialActive = false,
  children,
}: {
  /**
   * What the SERVER said when it rendered the layout, by reading the cookie. It
   * is what covers a full navigation into the roster wizard: the wizard renders
   * with renewal already armed, rather than having to be told by a client fetch
   * it never makes.
   */
  initialActive?: boolean;
  children: React.ReactNode;
}) {
  const [active, setActiveState] = useState(initialActive);
  const [renewalTrouble, setRenewalTrouble] = useState(false);
  const lapseHandlerRef = useRef<(() => void) | null>(null);

  /*
    THE ARITHMETIC, because the obvious version of this is wrong in the
    self-defeating direction.

    The first implementation counted INTERVAL TICKS anchored at effect mount and
    dropped the view after ten of them. Ticks land at `t0 + 60k`; the flag that
    allows a renewal was re-set at each tick, so the first interaction in an
    interval renewed and the rest were suppressed. Take the last interaction `x`
    in `(T_k, T_k+60]`: the last renewal `r` satisfies `T_k < r <= x`, the
    counter reaches ten at `T_k + 600`, and the server expires at
    `r + 600 > T_k + 600`. So the client ALWAYS dropped strictly early — by up to
    a minute, and by a second or two when somebody was tapping steadily.

    That is not a harmless rounding error, it is a loop. Dropping early blanks
    the state and refetches; the server session is still valid, so the privileged
    payload comes back, the effect remounts, the counter restarts, and the client
    grants itself another ten minutes from a background event. The real expiry
    then passes unnoticed until the two-minute data refresh — up to two minutes
    of an expired hut-leader view on a shared screen, which is the thing the code
    claimed to prevent.

    So: TIMESTAMPS, not ticks, and every one of them on the safe side.

      - `deadlineBasisRef` is the browser's estimate of the instant the server
        measures its ten minutes from. It is set when a renewal RESPONSE arrives
        (at or after the moment the server stamped the new deadline) and when the
        session is first learned about (from a response the server produced after
        it validated the cookie). Both are at or after the server's own basis,
        never before it, so `basis + 10min + margin` always lands AFTER the
        server's deadline.
      - `lastRenewalAttemptAtRef` drives the throttle and nothing else, so a
        failed renewal cannot move the deadline estimate.
      - Neither depends on a timer firing on schedule, which is what makes this
        immune to a dimmed or backgrounded tablet having its timers throttled to
        about one a minute. The old `armed` flag was set only by the interval
        callback, so on such a device a person could return, tap once, and
        produce no renewal at all.

    ONE THING THIS MUST NOT DO: re-base on every response that mentions an active
    session. The kiosk asks `/api/lodge/access` every two minutes, and re-basing
    on those answers would be the original defect wearing a new hat — the
    browser's clock would never run out and the view would stay painted
    indefinitely. It re-bases only when `active` goes false to true, which is a
    session being acquired, and on a renewal it made itself.

    `Date.now()` rather than `performance.now()`: it is the clock the server side
    of this rule uses (`nextIdleDeadline`), and it is the one a test can move.
    A wall tablet stepping its clock under NTP is the case a monotonic source
    would improve on, and the cost of getting it wrong either way is a refetch
    or a stale paint the two-minute refresh clears — not a lockout, because the
    server is still the one deciding.
  */
  const deadlineBasisRef = useRef(0);
  const lastRenewalAttemptAtRef = useRef<number | null>(null);
  const lapsedRef = useRef(false);

  const setActive = useCallback((next: boolean) => {
    setActiveState((current) => (current === next ? current : next));
  }, []);

  const lapse = useCallback(() => {
    if (lapsedRef.current) return;
    lapsedRef.current = true;
    // Stop listening and stop asking: this device believes it has nothing to
    // renew. If it turns out to be wrong, the handler's own refetch publishes an
    // active session again and the effect re-arms with a fresh basis.
    setActiveState(false);
    setRenewalTrouble(false);
    lapseHandlerRef.current?.();
  }, []);

  useEffect(() => {
    if (!active) return;

    const startedAt = Date.now();
    deadlineBasisRef.current = startedAt;
    lastRenewalAttemptAtRef.current = null;
    lapsedRef.current = false;
    setRenewalTrouble(false);

    const renew = async () => {
      try {
        const res = await fetch(LODGE_PIN_SESSION_ENDPOINT, {
          method: "POST",
          // The tap that triggers this is very often the tap on the kiosk's "Set
          // Up Today's Roster" link, and that starts a full navigation which
          // would otherwise cancel the request in flight — losing the one
          // renewal that matters most, immediately before the longest piece of
          // work a hut leader does. The body is empty, so the keepalive size cap
          // is not in play.
          keepalive: true,
        });
        if (res.ok) {
          deadlineBasisRef.current = Date.now();
          setRenewalTrouble(false);
          return;
        }
        if (res.status === 403) {
          // The server says there is no session to renew. That is authoritative
          // and immediate — no estimate beats being told.
          lapse();
          return;
        }
        // A 429 or a 5xx. The deadline did NOT move, and the throttle is spent,
        // so the next attempt is an interval away; say so rather than letting
        // the screen lock itself with no explanation.
        setRenewalTrouble(true);
      } catch {
        setRenewalTrouble(true);
      }
    };

    const handleInteraction = (event: Event) => {
      // A scripted event is not a person. `isTrusted` is false for anything
      // dispatched by `dispatchEvent`.
      if (!event.isTrusted) return;
      const now = Date.now();
      const lastAttempt = lastRenewalAttemptAtRef.current;
      if (
        lastAttempt !== null &&
        now - lastAttempt < HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS
      ) {
        return;
      }
      lastRenewalAttemptAtRef.current = now;
      void renew();
    };

    const listenerOptions = { capture: true, passive: true } as const;
    for (const type of HUMAN_INTERACTION_EVENTS) {
      window.addEventListener(type, handleInteraction, listenerOptions);
    }

    const timer = setInterval(() => {
      if (
        Date.now() - deadlineBasisRef.current >=
        IDLE_MS + HUT_LEADER_PIN_SESSION_IDLE_DROP_MARGIN_MS
      ) {
        lapse();
      }
    }, HUT_LEADER_PIN_IDLE_CHECK_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      for (const type of HUMAN_INTERACTION_EVENTS) {
        window.removeEventListener(type, handleInteraction, listenerOptions);
      }
    };
  }, [active, lapse]);

  const value = useMemo<LodgePinSessionValue>(
    () => ({ active, renewalTrouble, setActive, lapseHandlerRef }),
    [active, renewalTrouble, setActive],
  );

  return (
    <LodgePinSessionContext.Provider value={value}>
      {children}
    </LodgePinSessionContext.Provider>
  );
}
