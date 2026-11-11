- The old Xero token table is gone. Tokens stay in the credential store.
  Deploying this release needs the maintenance window in
  [UPGRADING.md](../docs/UPGRADING.md). A mistake while the previous release is
  still refreshing leaves Xero on a dead token, and the fix is an administrator
  reconnect.
