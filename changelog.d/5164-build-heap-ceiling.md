- **Servers that build the image themselves should set
  `NODE_BUILD_OPTIONS=--max-old-space-size=8192` (#5164).** The production
  build's type check now needs about 4.6 GB of Node heap, more than Node's
  default ceiling and more than the `4096` the docs used to suggest, so a build
  could stop with "JavaScript heap out of memory" or "Failed to type check".

  CI's builds now run with an 8 GB ceiling, and `.env.example`,
  `CONFIGURATION.md` and the upgrade notes recommend the same value. It affects
  the build only, never the running app. A server that deploys a published
  image builds nothing and needs no change.
