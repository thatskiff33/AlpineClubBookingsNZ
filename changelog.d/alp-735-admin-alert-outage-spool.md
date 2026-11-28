- **An admin alert raised while the database is down is no longer lost
  (#5297).** Some alerts to officers, several of them about money, are raised
  only once, at the moment something goes wrong. If the database refused every
  write at that moment (an outage, a full disk, a failover), the app could not
  record that the alert was still owed, so nothing sent it later and the error
  log was its only record.

  Such an alert is now kept as a small file on the server and sent, once, by
  the payments job within 15 minutes of the database coming back. It is never
  sent twice. Docker installs keep the file on a new `admin_alert_spool`
  volume shared by every app container; installs without Docker should set
  `ADMIN_ALERT_SPOOL_DIR` to a lasting directory (see `DEPLOYMENT.md`).
