## Who

owner

## What to do

Measure the public-page stall fix (#5264, part A). Poll `/`, `/faq` and
`/family-invite/x` on the public site every 2 seconds for 90 seconds, and
compare the 24-hour Caddy median for `/` with the 1,311 ms measured on 20 Nov
2026. The orchestrator can run the poll if asked.

## How to check it worked

No render takes over 300 ms, and you have compared the 24-hour Caddy median
for `/` with the 1,311 ms measured on 20 Nov 2026.
