- **Payment history survives attempts to delete its parent (#4574).** The database
  refuses to delete payments with transactions and transactions linked to refunds
  or recovery operations. Deploying this protection requires the reviewed
  breaking-migration override described in the upgrade guide.
