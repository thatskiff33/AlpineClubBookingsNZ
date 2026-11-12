- **Browser error reports now go to your club's Sentry project (#4982).**
  Published images no longer include the upstream maintainer's browser Sentry
  destination. Before upgrading, set `NEXT_PUBLIC_SENTRY_DSN` in your deployment's
  `.env` if you want browser error reports. The upstream maintainer must do this
  too. Leaving it blank disables browser reports and replay. Both DSNs are read
  at runtime, so published images and host builds use the same configuration;
  restart/redeploy after an edit, with no image rebuild. Replay still requires
  the club's privacy opt-in and remains off by default. Browser reporting starts
  after runtime configuration loads; errors before then are not captured.
