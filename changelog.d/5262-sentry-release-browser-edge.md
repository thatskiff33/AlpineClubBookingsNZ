- **Browser error reports now say which version they came from (#5262).**
  Sentry events from members' browsers now carry the installed version as their
  release, the same value server events have carried since #4985, so every
  error can be sorted by release. The edge layer's Sentry setting carries it
  too; that takes effect once an edge route exists, as none runs on the edge
  today. The version is stamped into the image at build time from
  `package.json` (owner decision of 22 Nov 2026 on #5262), because a browser
  tab should report the code it is actually running. It is not a secret.
  Sentry's per-page-load session tracking is off, so the release adds tagging
  only, with no new traffic. Nothing to set or change.
