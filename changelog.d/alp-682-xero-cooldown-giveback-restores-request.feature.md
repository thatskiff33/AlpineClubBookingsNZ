- **Xero documents refused while Xero was paused are sent once it clears, and
  any left stuck by older versions can be found and released (#5228).** When
  Xero's "temporarily unavailable" pause, the daily limit or the environment
  check refused a queued refund credit note, booking invoice, change credit
  note, joining fee invoice or group invoice, the app put it back in the queue
  in a form the queue could no longer pick up. It then sat there for good:
  nothing reached Xero, and nothing failed or alerted. Such documents now go
  back in the queue as they were queued and are sent on the next run.

  Documents an older version left stuck stay where they are until the owner
  releases them, and the Xero cron run now shows an amber warning while any
  exist. Run `pnpm run xero:stuck-queued-report` once after upgrading: it lists
  them and changes nothing. `--release` then marks exactly those as failed, so
  they appear in Xero Operations; check Xero for each, then use Retry. A refund
  note's Retry bills only what is still not covered by another note, so nothing
  is credited twice. Nothing already in Xero is changed. The steps are in
  `docs/MAINTENANCE.md`.
