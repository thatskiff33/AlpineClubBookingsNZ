- **A new live site can no longer start up believing it is a test copy
  (#4980).** The first-install steps in `DEPLOYMENT.md` copy `.env.example`,
  which declares `APP_ENVIRONMENT_ROLE=non-production`. A live site started from
  it unchanged held back every member email and replaced the email addresses on
  the club's real Xero contacts, while **Admin → Setup** showed a green tick.

  First Bootstrap now tells you to set `APP_ENVIRONMENT_ROLE=production` and to
  run `bash scripts/check-environment-role.sh` before the first
  `docker compose up`. The check refuses anything but exactly `production`,
  names the setting, and starts nothing. It is the same check the production
  deploy already runs at step 3, now shared by both.

  On **Admin → Setup**, the **Production Or Non-Production** step now shows an
  amber warning when the deployment declares non-production: "If this is the
  club's live site, members are getting no email and Xero contact addresses are
  being replaced." On a real copy (staging, a restore rehearsal, a laptop),
  press **Acknowledge** once. A copy forced by the safer override inside the app
  stays green. Expect staging to show the warning until someone acknowledges it.
