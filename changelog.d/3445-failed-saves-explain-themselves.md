- **A failed save on an admin screen now always says why (#3445).** About two
  dozen admin screens each carried their own copy of the code that turns a
  refused request into the sentence an officer sees, and the copies had drifted:
  on most of them a refusal with a blank message showed an empty red alert, and
  on nine a refusal whose message was not text showed the words
  "[object Object]".

  Those twenty-one copies, and eight further one-line readings in the same
  screens, now read the refusal one way. A blank message falls back to the
  screen's own fixed sentence, such as "Failed to save membership type", and a
  message that is not text does the same. A real message still shows exactly as
  the server wrote it. Screens whose messages carry extra detail — the email
  template editor's list of what to fix, the finance mapping panel's details,
  and the Xero actions' recovery hints — keep that detail on top of the same
  rule. One converged screen is member-facing: the two-factor sign-in panel,
  where a blank refusal now reads a sentence instead of an empty alert.

  Not every screen is covered yet. A check now fails the build if anyone writes
  a new private copy of the rule as a function, but the same reading written
  inline into a handler survives on many screens beyond these, and converging
  those is a filed follow-up. No server response changed.
