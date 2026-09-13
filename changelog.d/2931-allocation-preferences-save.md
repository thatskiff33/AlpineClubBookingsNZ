- **Allocation preferences on the Bed Allocation board can be saved again, and a
  save that is refused now says why (#2931).** Choosing a lodge, clicking
  **Edit**, changing the auto-allocation switch or the preference order and
  clicking **Save** did not save. The board answered "Failed to save allocation
  preferences" and nothing was written — whatever an administrator changed,
  every attempt failed the same way, with no hint of what was wrong.

  Two separate things were at fault and both are fixed. The screen was sending
  the settings back to the server together with a handful of extra details the
  server had added for display only — when the settings were last changed and by
  whom, and which record they came from. The part of the server that accepts the
  change deliberately refuses anything it does not recognise, so it rejected the
  whole save as invalid. The screen now sends back only the two things an
  administrator can actually edit, which is what the server has always expected.

  The second fault is why nobody could tell. The server explains every refusal
  in a plain sentence, and the screen was throwing that sentence away and showing
  the same generic failure for all of them. It now shows what the server said —
  "Lodge not found or not active", for instance — while keeping the two cases
  that need their own wording: an administrator whose role can view bookings but
  not change them is told exactly that, and a club that has bed allocation
  switched off is told the module is off rather than being shown a bare "Not
  found". If the reply is unreadable — a gateway error page rather than an answer
  from the club system — the screen falls back to its own wording instead of
  putting raw technical output on the page, and it never shows the internal
  detail that sits alongside the explanation.

  A failed save now leaves the changes staged and the screen still in edit mode,
  so the fix is one click away rather than a re-entry.
