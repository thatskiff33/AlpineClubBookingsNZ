- **A failed save on any admin screen now always says why (#3445).** About two
  dozen admin screens each carried their own copy of the code that turns a
  refused request into the sentence an officer sees, and the copies had drifted:
  on most of them a refusal with a blank message showed an empty red alert, and
  a refusal whose message was not text showed the words "[object Object]".

  Every screen now reads the refusal the same way. A blank message falls back
  to the screen's own fixed sentence, such as "Failed to save membership
  type", and a message that is not text does the same. A real message still
  shows exactly as the server wrote it. Screens whose messages carry extra
  detail — the email template editor's list of what to fix, and the Xero
  actions' recovery hints — keep that detail on top of the same rule. No
  server response changed.
