## Who

operator

## What to do

Before or during the deploy, if you build the app's image on your own server,
set `NODE_BUILD_OPTIONS=--max-old-space-size=8192` for the build. A server with
less than about 8 GB of free memory should deploy a published image instead.
`docs/UPGRADING.md`, "Building on your own server: raise `NODE_BUILD_OPTIONS` to
8192 (#5164)", has the detail.

## How to check it worked

The image build finishes without running out of memory, or the server runs a
published image.
