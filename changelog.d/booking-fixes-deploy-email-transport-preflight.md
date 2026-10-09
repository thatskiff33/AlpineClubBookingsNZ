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
