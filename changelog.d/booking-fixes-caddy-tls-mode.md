- **Caddy can now sit behind a proxy that terminates TLS (fork,
  booking-fixes).** The shipped Caddy configuration assumed Caddy was the
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
