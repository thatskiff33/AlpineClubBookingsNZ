// The commands that run `prisma/seed.ts` on an empty database (#4977,
// INV-OPS-019). The setup checklist names both; the deployment contract test
// holds every operator doc and `docker-compose.yml` to the Docker one, and the
// first-install smoke in CI runs it as `DEPLOYMENT.md` writes it.

/** The one-shot Compose service that seeds a Docker-only install. */
export const SEED_COMPOSE_SERVICE = "seed";

/** A Docker-only install: the server has Docker and nothing else. */
export const DOCKER_SEED_COMMAND = `docker compose run --rm ${SEED_COMPOSE_SERVICE}`;

/** A developer machine with Node and pnpm, pointed at the database by `DATABASE_URL`. */
export const HOST_SEED_COMMAND = "pnpm run db:seed";

/** How the setup checklist tells an install with no admin to create one. */
export const SEED_COMMAND_DETAILS = [
  `Docker install: ${DOCKER_SEED_COMMAND}`,
  `Developer machine: ${HOST_SEED_COMMAND}`,
] as const;
