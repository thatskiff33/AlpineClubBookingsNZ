- **The setup guides now say where club settings really go (#4984).** The
  README, the Implementation Guide and the configure-or-fork page told a new
  club to type its name, beds and prices into `config/club.json`, and said the
  setup wizard filled that file in. Club settings live in the database: set
  them at `/admin/setup` (or with `pnpm run setup:wizard` against the migrated
  database) and set nightly rates at `/admin/seasons`. The Docker app never
  reads `config/club.json`, so its first seed starts from placeholder values
  that must be checked in `/admin/setup`.

  The deployment guide no longer says the Stripe webhook secret is set with
  `STRIPE_WEBHOOK_SECRET` (it is entered in-app and that variable is ignored),
  drops a key command for Xero variables that no longer exist, and shows how to
  generate a `DATA_ENCRYPTION_KEYS` entry.
