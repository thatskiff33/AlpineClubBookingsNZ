- **Switching on AI Diagnostics now tells the administrator where club data goes,
  and asks them to acknowledge it (#5243).** The AI Diagnostics card on Admin →
  Modules states that each question sends excerpts of club data to Anthropic,
  which may process them outside New Zealand, and what those excerpts include:
  the question and the screen it was asked from, earlier questions and answers
  in the same conversation, excerpts of the application's code, its built-in
  guides and any private notes this deployment adds, records looked up to answer
  it, and personal details held in member records only when the administrator
  ticks the personal-details box for that question; once an answer includes
  them, they are sent again with later questions in the same conversation.
  Anything typed into the
  question or a screen's search, including a name, is sent as typed. Save stays
  disabled until the administrator ticks the statement, and the acknowledgement
  is recorded in the audit log. A save built from a stale page can no longer
  switch Diagnostics back on after someone else switched it off. Clubs that
  already have Diagnostics on are not asked again; the same statement now also
  shows on the AI Diagnostics page. There is no
  zero-retention setting: the application sends Anthropic no retention
  instruction, and a club that needs zero retention arranges it with Anthropic on
  the account behind its Diagnostics key.
