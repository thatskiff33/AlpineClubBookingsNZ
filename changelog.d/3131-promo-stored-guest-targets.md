- **The rule deciding which guests a promotional code covers on an existing
  booking now lives in one place instead of five (#3131).** Nothing changes for
  members or administrators: prices, discounts and who a promotion applies to
  are all exactly as they were. This is a maintenance change, and it removes a
  real risk of a future one going wrong.

  When a member changes their dates, removes a guest, or asks for a quote on a
  booking that already has a promotional code on it, the system has to work out
  which of that booking's guests the code covers — the ones the member picked
  when they made the booking, where the code asked them to pick. The few lines
  of code answering that question had been copied into five different files:
  the add-guest and quote screens' handlers, the date-change service, the
  guest-removal service, and the shared booking-modification planner. Nothing
  connected them, and there was no way to tell from any one copy that the other
  four existed.

  That matters because a correction applied to one copy and not the rest would
  have priced the same booking differently depending on which of those things
  the member happened to be doing. It was not a theoretical worry: one of the
  five copies had already drifted into a different shape from the other four,
  and this club's codebase has previously carried a duplicated age rule that
  still had a bug its main copy had been fixed for.

  The five copies are now one, in `src/lib/promo-stored-guest-targets.ts`, and
  the five files read from it. The one judgement it makes — that a promotional
  code only asks for a specific list of guests when it is assigned to members
  *and* is not limited to those members' own nights — is now written down once,
  alongside a set of tests that pin every possible answer so the same rule
  cannot quietly change meaning again.
