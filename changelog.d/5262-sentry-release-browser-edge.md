- **Browser and edge error reports now say which version they came from (#5262).**
  Sentry events from members' browsers and from the edge layer now carry the
  installed version as their release, the same value server events have carried
  since #4985, so every error can be sorted by release. The version is stamped
  into the image at build time from `package.json` and is not a secret. Nothing
  to set or change.
