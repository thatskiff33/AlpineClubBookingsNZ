- **Switching on AI Diagnostics now tells the administrator where club data goes,
  and asks them to acknowledge it (#5243).** The AI Diagnostics card on Admin →
  Modules states that each question sends excerpts of club data to Anthropic for
  processing outside New Zealand, and what those excerpts include: the question
  and the screen it was asked from, earlier questions and answers in the same
  conversation, excerpts of the application's code, its built-in guides and any
  private notes this deployment adds, records looked up to answer it, and
  members' personal details only when the administrator ticks consent for that
  question. Save stays disabled until the administrator ticks the statement, and
  the acknowledgement is recorded in the audit log. Clubs that already have Diagnostics on are not asked again; the
  same statement now also shows on the AI Diagnostics page. There is no
  zero-retention setting: the application sends Anthropic no retention
  instruction, and a club that needs zero retention arranges it with Anthropic on
  the account behind its Diagnostics key.
