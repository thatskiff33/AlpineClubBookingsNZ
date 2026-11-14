- **The legacy finance dashboard route and the extra hostnames are now settings,
  off unless a club asks for them (#4981).** Every installation used to serve
  the original club's `/finance-legacy` route (forwarded to a fixed private
  address), plus `bookings.`, `dashboard.` and `www.` versions of its domain.
  A club without those DNS records saw certificate errors for hostnames it
  never created, and could not remove them without blocking its next deploy.

  `CADDY_LEGACY_ROUTES` (default `off`) now turns the legacy route and the
  `bookings.`/`dashboard.` hosts on, with the dashboard's address in
  `CADDY_FINANCE_LEGACY_UPSTREAM`. `CADDY_WWW_REDIRECT` (default `on`) can turn
  the `www.` redirect off. The deploy refuses a mistyped value, or the legacy
  route without an address, before it changes anything.

  **Action needed only if your club used `/finance-legacy` or the `bookings.`
  or `dashboard.` hostnames:** set `CADDY_LEGACY_ROUTES=on` and
  `CADDY_FINANCE_LEGACY_UPSTREAM` in `.env` before deploying this release.
  `DEPLOYMENT.md` → "Hostnames and DNS records" lists the DNS record each
  hostname needs.
