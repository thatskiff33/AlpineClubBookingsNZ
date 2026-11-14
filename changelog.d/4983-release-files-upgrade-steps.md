- **Each release now has its own section in the upgrade guide and its own
  release-notes page (#4983).** When the maintainer prepares a release, the
  release tool now moves the upgrade guide's waiting steps from "Unreleased"
  to a heading naming the upgrade, such as "v0.13.2 → v0.14.0". It also writes
  a notes page for the release and lists it in the release index. A release
  with no manual steps still gets a heading that says so.

  A club upgrading from one release to the next can now find the steps for
  the release it is installing, instead of a pile under "Unreleased" that
  reads as "not in my version yet". The tool will not publish a release while
  its upgrade section or notes page is missing or unfinished, or while
  upgrade steps added after preparation are still waiting under "Unreleased".
