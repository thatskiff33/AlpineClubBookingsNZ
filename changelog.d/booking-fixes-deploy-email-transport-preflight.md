- **The production deploy no longer demands AWS SES keys from a club that
  sends mail through its own SMTP relay (fork, booking-fixes).** The deploy
  script's step-3 preflight required `AWS_SES_ACCESS_KEY_ID`,
  `AWS_SES_SECRET_ACCESS_KEY` and `SES_SNS_TOPIC_ARN` whatever the
  `.env` said about the mail provider, so an installation with
  `USE_SMTP_RELAY=true` and those keys legitimately blank, exactly as the
  configuration guide describes, was refused with "Missing required .env
  entry" before anything was deployed.

  The preflight now follows the provider flags the way the application does:
  SES keys for AWS SES (and when none of the three flags is named at all),
  the `EMAIL_SERVER_*` keys for an SMTP relay or a capture mailbox. It refuses
  the two states the application refuses, two flags true or a flag named but
  false with none true, and refuses a capture mailbox on the live site, all at
  step 3 rather than at the health check. Nothing changes for a club running
  AWS SES.

  The same preflight also demanded `LEGACY_DASHBOARD_EXPORT_TOKEN`, which the
  configuration guide says to leave empty unless the legacy finance export
  bridge is still in use. It is now optional: blank passes and disables the
  bridge, while a placeholder value is still refused.

  A fork's image names (`GHCR_APP_IMAGE_REPOSITORY` and
  `GHCR_MIGRATE_IMAGE_REPOSITORY`) are now also read from the source
  repository's `.env` when the shell does not set them, instead of falling
  straight back to the upstream registry, and step 3/8 says which source each
  name came from. A deploy run under `sudo`, which strips the shell
  environment, therefore still pulls the fork's own images.
