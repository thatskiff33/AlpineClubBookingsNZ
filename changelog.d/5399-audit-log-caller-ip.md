- **Audit log entries record the IP address the proxy nearest the app saw, on
  every action (#5399).** About twenty actions, among them booking edits and
  payments, refund decisions, issue and maintenance reports and saved-card
  charges, took the first address in the forwarding header the club's proxy
  passes on. A visitor can write that address themselves.

  This affects a club whose proxy adds to the forwarding header instead of
  replacing it. On such a club those audit entries could show an address the
  visitor chose, and three refund entries stored the whole list of addresses.
  They now record the last address, the one that proxy saw, which is the same
  one the rate limits already use, and a single address rather than a list.

  Behind more than one proxy, for example a CDN in front of another proxy, that
  last address is the CDN's own address, shared by many visitors, unless the
  proxy nearest the app works out the visitor's address and overwrites the
  header. Before this change those entries usually showed the visitor, though
  the visitor could fake it. The reference Caddy in local mode does the
  overwrite when `CADDY_TRUSTED_PROXIES` lists every proxy in front of it. With
  no proxy at all, a visitor can set the address freely, so neither the audit
  log nor the rate limits can trust it. `DEPLOYMENT.md` covers both cases.

  Nothing changes for a club running the reference Caddy configuration, which
  replaces the header with one address. Entries already in the audit log are
  not changed.
