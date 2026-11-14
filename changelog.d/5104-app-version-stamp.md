- **System Health and the health checks now show the release that is actually
  installed (#4985).** Every release used to report version "0.1.0" on
  **Admin → Monitoring & Support → System Health**, `/api/health` and
  `/api/health/ready`, and to file server-side Sentry errors under release
  "0.1.0". Config-transfer exports and the diagnostics support-evidence pack
  recorded the version as "unknown".

  The version is now taken from the release itself when the app is built, so all
  of these show the real version (for example 0.13.2) with no setting to add.
  Browser and edge Sentry events are not changed by this release.
  If an uptime monitor reads the `version` field from a health check, expect it
  to change from "0.1.0" to the real version after this upgrade.
