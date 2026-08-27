- Pinned the #2619 hosting participant-fence bypass out of the source, not just out of
  behaviour. The fence can no longer be silently disabled by a plausible-looking "keep the
  test doubles narrow" early return: a source contract now requires every proof to be
  issued *after* the row lock, and the waitlist suite proves its widened double still
  refuses genuine drift rather than rubber-stamping it. Tests only — no behaviour change.
