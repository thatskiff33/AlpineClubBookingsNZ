- **Caddy can now sit behind a proxy that terminates TLS (#4275).** The
  shipped Caddy configuration assumed Caddy was the public edge and always
  fetched its own certificates from Let's Encrypt. An installation with Nginx
  Proxy Manager or a similar proxy in front could never complete that
  validation, so a freshly created Caddy container had no certificate, the
  proxy answered "502 Bad Gateway", and the deploy's final outside health check
  failed and rolled the cutover back.

  A new `.env` setting, `CADDY_TLS_MODE`, selects how Caddy obtains
  certificates: `acme` (the default, unchanged) or `local`, where Caddy issues
  its own from its internal CA and the proxy is told to accept them. The deploy
  preflight refuses any other value, and checks the Caddy configuration with
  the mode and settings Caddy will actually run with, before the database
  migration rather than at the cutover. The deployment guide has a new section,
  "Behind a TLS-terminating proxy", with the proxy settings to match and the
  safe way to apply a change (re-run the deploy; running Compose from the
  checkout can point the site at the wrong container).

  Behind that proxy, the only address Caddy sees is the proxy's, so the
  per-visitor rate limits on signing in and the audit log's IP column would
  all have become the proxy. In `local` mode Caddy now takes the visitor's
  address from the proxy, and forwarded-address trust is strict and explicit:
  `CADDY_TRUSTED_PROXIES` must name the proxy's own address (the deploy refuses
  local mode without it), and Caddy believes only the address that proxy
  added. Nothing changes in `acme` mode.
