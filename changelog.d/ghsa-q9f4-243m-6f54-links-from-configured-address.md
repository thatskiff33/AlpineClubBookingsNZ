- **A forged request header can no longer point a club link at another site
  (GHSA-q9f4-243m-6f54).** When a member reported a problem, the app could take
  the site's address from the request instead of from your configuration. Where
  a caller could set the forwarded host header (behind a proxy that passes it
  through unchanged, or with no proxy in front of the app), a signed-in member
  could make the link in the officers' issue-report email, and the page link on
  the admin issue-reports page, lead to a site of their choosing. Those links
  are now built from `NEXTAUTH_URL` only, and reports already stored are shown
  on your own address. A few redirects that fell back to the request's address
  when `NEXTAUTH_URL` was unset now use the built-in default instead. The
  reference Caddy deployment was not affected. There is nothing to do, provided
  `NEXTAUTH_URL` is your public address, which the deploy script already checks.
