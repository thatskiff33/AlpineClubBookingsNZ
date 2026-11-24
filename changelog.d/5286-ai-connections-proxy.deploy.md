## Who

operator

## What to do

Only if the club will switch on AI app connections, which are off by default:
before switching them on, make sure your reverse proxy forwards
`/.well-known/oauth-*` to the app. `docs/guides/mcp-server.md` explains why.

## How to check it worked

Requesting `/.well-known/oauth-authorization-server` on the club's site returns
the app's JSON document, not the proxy's 404 page.
