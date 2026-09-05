- **Saving an admin settings page no longer fails at random with a bare error
  (#3293).** An administrator who opened a settings page, spent a moment reading
  it and then pressed Save could get a blunt failure — on Lodge Maintenance it
  read simply "Failed to save" — with nothing written and no explanation. Trying
  again usually worked, which made it look like a glitch in the page.

  Nothing was wrong with the page. The request was never reaching the site at
  all. The web server in front of the application was re-using network
  connections that the application had already closed, and when the two decided
  at the same instant the connection was dropped mid-request. Only actions that
  *save* something could show this: page loads are automatically retried behind
  the scenes, saves cannot be, so a save was the one thing that surfaced it.

  The two timers are now set explicitly, in the right order, so the front-end
  server always lets a connection go before the application does. Fronting this
  application with something other than the bundled Caddy? `DEPLOYMENT.md` →
  "Keep-alive windows must stay ordered" gives the equivalent setting for nginx
  and HAProxy.

  A single dropped connection also used to take the serving instance out of
  rotation for thirty seconds and push live traffic onto the standby, which runs
  a smaller database connection allowance — so one blip became half a minute of
  a slower site. It now takes three failures in a row, so a one-off no longer
  costs anything.

- **The web server now keeps an access log, with credentials stripped out of it
  (#3293).** Until now only *failed* requests were recorded, so there was no way
  to tell how often something went wrong as a share of everything that went
  right — which is exactly the question the fault above raised and nobody could
  answer.

  Ordinary requests are now logged too. Anything that could carry a credential
  is removed before the line is written: the one-time links in emails and on the
  printed lodge QR signs, sign-in codes returned by Google, and payment secrets
  returned by Stripe, in the address, in the referring page's address, and in the
  error log as well as the new access log — the error log had been recording
  these in full. Ordinary web addresses are untouched, so the log is still
  readable.

  Logs go where the rest of the container's output goes and are capped at the
  same size, so nothing needs to be pruned. `DEPLOYMENT.md` → "Access logs" shows
  how to read them.

  **Operators: this release changes `Caddyfile`, so Caddy must be reloaded on the
  host after deploying it** — the app deploy alone does not pick it up. The
  commands are in `DEPLOYMENT.md` → "Public Rate Limits And Proxy Headers".
