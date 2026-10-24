- **A failed Xero operation now says why, in plain English (#4278).** The Xero
  operations screen, a record's Xero activity, and the warning on a booking whose
  invoice failed used to show Xero's raw error text or a JSON dump. Each now shows
  one headline (what happened), what it means for the club, and "What to do",
  including whether the app tries again by itself. Common causes are covered: the
  daily request limit (with a rounded wait), an invoice already paid, a credit note
  with less credit than expected, a duplicate contact name, a locked period, an
  archived account or contact, a lost job, a timeout and a lost connection to Xero.
  When the reason is hidden for privacy, or is not one the app recognises, it says
  so rather than guessing. Xero's own wording and the error code are still one
  click away under "Show technical details".
