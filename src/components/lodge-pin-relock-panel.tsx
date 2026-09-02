"use client";

import { useState } from "react";
import { Lock } from "lucide-react";

import {
  LODGE_PIN_LOGIN_ENDPOINT,
  useLodgePinSession,
} from "./lodge-pin-session";

/**
 * "This screen locked itself — enter the PIN to carry on." (#3228)
 *
 * ## Why the roster wizard needs this and the kiosk does not
 *
 * The kiosk's answer to a closed window is to drop everything it holds and show
 * the ordinary lodge view, PIN box included; nothing is lost, because nothing was
 * unsaved. The chore-roster wizard is the opposite case. A hut leader can spend
 * a long time on step 3 moving people between chores, and every bit of that lives
 * in component state until **Confirm** writes it. Sending them back to the kiosk,
 * or reloading, throws the lot away.
 *
 * So the wizard neither reloads nor clears: it shows this, keeps the allocation
 * exactly as it is, and retries whatever was interrupted once the PIN is typed
 * again. It leaves the guest names on screen too, deliberately — the wizard is
 * reachable by the ordinary kiosk account (see `lodge/roster/layout.tsx`), and
 * everything it displays is served to the ordinary lodge tier. What the PIN gates
 * on this page is the WRITE, which the server enforces on
 * `POST .../generate` and `POST .../confirm`.
 *
 * With the renewal now mounted for the whole lodge area, a leader who is
 * actually working should never see this panel; it is the safety net for the case
 * where they walked away mid-wizard, or where renewal was being refused.
 */
export function LodgePinRelockPanel({
  /**
   * What will happen the moment the PIN is accepted, in plain words for the
   * button ("Unlock and confirm the roster"), or null when nothing is waiting.
   */
  pendingLabel,
  onUnlocked,
}: {
  pendingLabel: string | null;
  onUnlocked: () => void;
}) {
  const { setActive } = useLodgePinSession();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(LODGE_PIN_LOGIN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error || "PIN login failed");
        return;
      }
      setPin("");
      // Renewal is armed again from here, not from a reload: the provider has no
      // other way to learn that a PIN was typed on a page already open.
      setActive(true);
      onUnlocked();
    } catch {
      setError("PIN login failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      className="bg-kiosk-warning-bg text-kiosk-warning-fg border border-kiosk-warning-border rounded-xl p-4 mb-4"
      aria-live="polite"
    >
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Lock className="h-5 w-5" aria-hidden="true" />
        This screen locked itself
      </h2>
      <p className="mt-1 text-base">
        Nobody used it for a while, so it went back to being an ordinary screen.
        <strong> Nothing you have set up has been lost.</strong> Enter the
        6-digit PIN to carry on.
      </p>
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="lodge-relock-pin">
          6-digit PIN
        </label>
        <input
          id="lodge-relock-pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="\d{6}"
          maxLength={6}
          value={pin}
          onChange={(event) =>
            setPin(event.target.value.replace(/\D/g, "").slice(0, 6))
          }
          className="min-h-[56px] w-40 rounded-xl border border-kiosk-border bg-kiosk-inset px-4 text-center text-2xl tracking-[0.4em] text-kiosk-fg"
        />
        <button
          type="submit"
          disabled={submitting || pin.length !== 6}
          className="inline-flex min-h-[56px] items-center justify-center rounded-xl bg-kiosk-accent px-4 py-3 text-sm font-semibold text-kiosk-accent-fg transition-colors hover:bg-kiosk-accent-hover active:bg-kiosk-accent-active disabled:cursor-not-allowed disabled:bg-kiosk-chip disabled:text-kiosk-faint-fg"
        >
          {submitting
            ? "Unlocking..."
            : pendingLabel
              ? `Unlock and ${pendingLabel}`
              : "Unlock"}
        </button>
      </form>
      {error && <p className="mt-2 text-base font-semibold">{error}</p>}
    </section>
  );
}
