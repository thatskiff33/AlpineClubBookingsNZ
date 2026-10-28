- **Rebuilding the app image is faster after the first build.** The Docker
  build now keeps Next.js's build cache between builds on the same machine, so
  an operator rebuilding after `git pull` no longer compiles the whole app from
  nothing. The image itself is unchanged: the cache never goes into it.

  For contributors, the browser test run in CI also finishes sooner: its shards
  are balanced by how long each test file takes, they no longer wait for the
  build cache to upload, and videos are recorded only for retried tests.
