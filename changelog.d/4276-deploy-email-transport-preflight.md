- **The production deploy no longer demands AWS SES keys from a club that
  sends mail through its own SMTP relay (#4275).** The deploy script's step-3
  preflight required `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY` and
  `SES_SNS_TOPIC_ARN` whatever the `.env` said about the mail provider, so an
  installation with `USE_SMTP_RELAY=true` and those keys legitimately blank,
  exactly as the configuration guide describes, was refused with "Missing
  required .env entry" before anything was deployed.

  The preflight now follows the provider flags the way the application does,
  and reads them as the application will receive them, after Docker Compose's
  defaults and any value exported in the shell: SES keys for AWS SES, the four
  `EMAIL_SERVER_*` keys for an SMTP relay or a capture mailbox. Because
  Compose defaults `USE_AWS_SES` to `true`, a relay needs `USE_AWS_SES=false`
  as well as `USE_SMTP_RELAY=true`, and the refusal says so. It refuses the
  states the application refuses (two flags true, none true, a value other
  than true or false) and a capture mailbox on the live site, all at step 3
  rather than at the health check. Nothing changes for a club running AWS SES.

  The same preflight also demanded `LEGACY_DASHBOARD_EXPORT_TOKEN`, which the
  configuration guide says to leave empty unless the legacy finance export
  bridge is still in use. It is now optional: blank passes and disables the
  bridge, while a placeholder value is still refused.

  A fork's image names (`GHCR_APP_IMAGE_REPOSITORY` and
  `GHCR_MIGRATE_IMAGE_REPOSITORY`) are now also read from the source
  repository's `.env` when the shell does not set them, with the same rules
  Compose applies to that file (quotes, `export`, the last duplicate wins),
  instead of falling straight back to the upstream registry, and step 3/8
  says which source each name came from. A deploy run under `sudo`, which
  strips the shell environment, therefore still pulls the fork's own images.
