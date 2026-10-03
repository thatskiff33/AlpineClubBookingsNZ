- **`NODE_BUILD_OPTIONS` now reaches the migration image build too (#3824).**
  Setting `NODE_BUILD_OPTIONS=--max-old-space-size=4096` in `.env` (added in
  #2977) fixed an out-of-memory `docker compose build` for the app image, but
  the migration image builds the same stage and never received it. On a machine
  that needed the setting, the app built and then `docker compose run --rm
  migrate` failed with the same "JavaScript heap out of memory" error.

  One setting now covers both builds. Nothing changes for a deployment that
  does not set it.
