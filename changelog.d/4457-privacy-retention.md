- **Review personal-data retention before turning on automatic cleanup (#4457).**
  A complete retention schedule covers personal information in member, booking,
  financial and operational records. The three new cleanup jobs ship off:
  review their candidates and club-configurable periods before enabling them.
  Inactive members without an explicit leaving date are never automatically
  erased, and anonymisation preserves financial references. Imported former
  members need a leaving date set explicitly before automatic anonymisation
  can include them; their cancellation date does not start the retention clock. Sentry Replay also
  defaults off; clubs must name it in their privacy notice before opting in.
- Audit readership: `privacy.retention.settings_updated` is an `admin` row (support:view can read it; it names no member). `privacy.retention.member_anonymised` is a `privacy` row, readable only with membership:view, so a support-only operator cannot see which member was anonymised.
