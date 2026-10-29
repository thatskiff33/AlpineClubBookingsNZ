- **Review personal-data retention before turning on automatic cleanup (#4457).**
  A complete retention schedule covers personal information in member, booking,
  financial and operational records. The three new cleanup jobs ship off:
  review their candidates and club-configurable periods before enabling them.
  Inactive members without an explicit leaving date are never automatically
  erased, and anonymisation preserves financial references. Sentry Replay also
  defaults off; clubs must name it in their privacy notice before opting in.
