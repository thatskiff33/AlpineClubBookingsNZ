- **The Modules reference now lists every module, and cannot quietly fall
  behind again (#2996).** Three modules that were already on the Admin →
  Modules page — the AI help assistant, Maintenance reports and the Alpine
  Central Server connection — had no row in the operator guide's settings
  reference, so an administrator reading the guide could not find what they
  did or how they ship. All three are documented now, with their defaults.

  Behind the scenes, the guide's table is checked against the application's own
  module list every time the test suite runs, in both directions: a module with
  no row, a row for a module that no longer exists, a wrong label or a wrong
  default all fail the build. The second, unchecked copy of that table in
  `CONFIGURATION.md` — which had already drifted — is gone, replaced by a
  pointer to the guide. The setup-readiness check also reads the module
  list from that one place instead of keeping its own copy, so a new module
  reaches the readiness page the moment it is added. No module behaviour or
  default changed.
