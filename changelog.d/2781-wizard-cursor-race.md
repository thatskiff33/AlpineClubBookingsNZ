- **An integration setup wizard no longer jumps back to step one when you click
  a step as it opens (#2781).** Each guided setup wizard — Xero, Stripe, Google,
  backups, the lobby display — remembers where you got to last time and takes
  you back there. The wizard waits for that saved position before it shows you
  anything, so you never see a half-loaded stepper; but there is a split second
  between the stepper becoming clickable and the wizard actually moving you to
  the saved step. A click that landed in that split second was thrown away and
  you were put back on the first step. It is a very short window, and how slow
  your connection is does not make it any longer — a busy browser or a heavy
  page does, which is why it looked random rather than reproducible.

  Clicking a step now always wins: whichever step you pick is where the wizard
  stays, and the saved position is only used when you have not chosen a step
  yourself. Everything else about resuming is unchanged — open a wizard and
  leave it alone and it still returns you to the step you were last on, still
  refuses to let you skip ahead past a step you have not completed, and a first
  visit still starts at step one so you see the introduction.
