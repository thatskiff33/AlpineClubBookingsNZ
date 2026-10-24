- **Caddy can now sit behind a proxy that terminates TLS.** The shipped Caddy configuration assumed Caddy was the
  public edge and always fetched its own certificates from Let's Encrypt. An
  installation with Nginx Proxy Manager or a similar proxy in front could never
  complete that validation, so a freshly created Caddy container had no
  certificate, the proxy answered "502 Bad Gateway", and the deploy's final
  outside health check failed and rolled the cutover back.

  A new `.env` setting, `CADDY_TLS_MODE`, selects how Caddy obtains
  certificates: `acme` (the default, unchanged) or `local`, where Caddy issues
  its own from its internal CA and the proxy is told to accept them. The deploy
  preflight refuses any other value. The deployment guide has a new section,
  "Behind a TLS-terminating proxy", with the proxy settings to match.

  Behind that proxy, the only address Caddy sees is the proxy's, so the
  per-visitor rate limits on signing in and the audit log's IP column would
  all have become the proxy. In `local` mode Caddy now trusts the proxy for
  the visitor's address (`CADDY_TRUSTED_PROXIES`, default `private_ranges`)
  and passes that address to the application; the deployment guide says what
  to set when the proxy is not on a private network, and why it must never
  be a public range.
