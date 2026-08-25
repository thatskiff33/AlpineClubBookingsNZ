- Fixed `npm run pr:check`, the offline PR-body checker, reporting the changelog
  gate as passing no matter what the pull request actually contained. It handed
  the gate a plain list of file names where the gate expects each file's name
  paired with what happened to it — added, modified or deleted — so every file
  arrived unreadable, the gate concluded the pull request changed no code at all,
  and it waved through bodies that carried neither a changelog entry nor the
  `changelog: none` marker. The real check on GitHub was never fooled, so the only
  effect was that the local check said "pass" and then the pull request failed
  minutes later for the very thing it had just been cleared of.

  The checker now reads the diff through the same helper the GitHub check uses,
  which also means it no longer misses files whose names contain non-English
  characters.
