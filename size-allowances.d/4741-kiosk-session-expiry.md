# File-size allowances for #4741

file: src/lib/auth.ts
lines: 828
reason: #4612 has to wire the lodge kiosk's idle window into the two places
  only auth.ts owns: the jwt callback stamps the kioskAccount claim from the
  member row it already reads, and buildRequestAuthConfig sets session.maxAge
  from the request it already receives. The rule, both windows and the cookie
  reading live in src/lib/session-idle-expiry.ts; what is left here is the
  import, the stamp and the per-request maxAge, with one-line comments.
  Moving those out would split the callback and the config factory from the
  values they apply.
