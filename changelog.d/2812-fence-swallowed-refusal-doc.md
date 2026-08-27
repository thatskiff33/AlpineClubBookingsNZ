- Documented the one path on which a participant-fence wiring fault is logged rather than
  surfaced: because the refusal deliberately stays outside the retryable 409 hierarchy,
  the four Xero subscription-history boundaries report it as a partial-success warning.
  Unreachable in production, but written down rather than left to be rediscovered. Also
  records that the fence's ordering rule is now pinned on the source, not just in
  behaviour. Docs only.
