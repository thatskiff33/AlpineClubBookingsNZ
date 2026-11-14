/**
 * Pre-flight target-safety guard for the k6 load harness (issue #1884).
 *
 * Load tests generate real bookings, real logins, and real database writes on
 * whatever they are pointed at. This guard makes it structurally hard to point
 * the harness at anything other than a throwaway local stack:
 *
 *   1. `BASE_URL` must be set explicitly — there is no default target.
 *   2. `LOAD_TEST_CONFIRM_TARGET=1` must be set as a deliberate opt-in.
 *   3. The URL must not contain `:5432` anywhere. On club deployment hosts
 *      (and on at least one developer machine) port 5432 is the LIVE
 *      PRODUCTION Postgres. The harness only ever speaks HTTP to the app,
 *      never to a database.
 *   4. The hostname must not be a known production domain (tokoroa.org.nz or
 *      any subdomain), must not contain "prod", and must be on the local
 *      allowlist: localhost / 127.0.0.1 / ::1 / host.docker.internal or a
 *      `.test` / `.localhost` name.
 *
 * The volume seeder (#4940) writes to a database directly, so it calls
 * `assertSafeDatabaseTarget(process.env)` instead: the same opt-in and hostname
 * rules applied to `DATABASE_URL`, plus an explicit non-5432 port.
 *
 * Every scenario script calls `assertSafeTarget(__ENV)` in k6's init context,
 * so a violation aborts the run before a single VU starts, and again in
 * `setup()` as a belt-and-braces re-check.
 *
 * This module deliberately avoids k6-specific imports so `node --check`
 * (and unit tooling) can parse it. It also avoids the WHATWG `URL` class,
 * which k6's runtime does not provide globally.
 */

// Hostnames that may be load tested (throwaway local stacks only).
const ALLOWED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "host.docker.internal",
];

// Suffix allowlist: reserved non-routable TLDs used by local stacks
// (e.g. demo.alpineclub.test).
const ALLOWED_HOST_SUFFIXES = [".localhost", ".test"];

// Known real deployment domains. The apex and every subdomain are refused
// (Caddy serves the app on the apex plus www./bookings./dashboard.).
const DENIED_HOST_SUFFIXES = ["tokoroa.org.nz"];

// Defence in depth: refuse anything that self-identifies as production.
const DENIED_HOST_SUBSTRINGS = ["prod"];

function guardError(reason) {
  return new Error(
    "LOAD TEST TARGET REFUSED: " +
      reason +
      "\n\nThis harness may only run against a throwaway local stack " +
      "(see docs/LOAD_TESTING.md). Required environment:\n" +
      "  BASE_URL=http://localhost:3001        # staging compose stack\n" +
      "  LOAD_TEST_CONFIRM_TARGET=1            # explicit opt-in\n" +
      "Never point it at a live deployment, and never at port 5432 " +
      "(live production Postgres)."
  );
}

/**
 * The hostname rules every guarded target shares: never a known production
 * domain, nothing containing "prod", and on the local allowlist. `label` names
 * the variable in the error so a refused DATABASE_URL is not reported as
 * BASE_URL.
 */
function assertLocalHost(host, bareHost, label) {
  for (const suffix of DENIED_HOST_SUFFIXES) {
    if (bareHost === suffix || bareHost.endsWith("." + suffix)) {
      throw guardError(
        label + ' hostname "' + bareHost + '" is a known production domain (' + suffix + ")."
      );
    }
  }

  for (const fragment of DENIED_HOST_SUBSTRINGS) {
    if (bareHost.indexOf(fragment) !== -1) {
      throw guardError(
        label + ' hostname "' + bareHost + '" contains "' + fragment + '" — refusing anything that looks like production.'
      );
    }
  }

  const allowedExact =
    ALLOWED_HOSTS.indexOf(host) !== -1 || ALLOWED_HOSTS.indexOf(bareHost) !== -1;
  const allowedSuffix = ALLOWED_HOST_SUFFIXES.some(function (suffix) {
    return bareHost.endsWith(suffix);
  });
  if (!allowedExact && !allowedSuffix) {
    throw guardError(
      label +
        ' hostname "' +
        bareHost +
        '" is not on the local allowlist (' +
        ALLOWED_HOSTS.join(", ") +
        ", *" +
        ALLOWED_HOST_SUFFIXES.join(", *") +
        ")."
    );
  }
}

/**
 * Validate the target described by an env object (pass k6's `__ENV`).
 * `name` is the env key holding the URL (BASE_URL unless the caller guards
 * another, such as STRIPE_STUB_URL), so a refusal names the variable the
 * operator actually set. Returns the normalised URL (no trailing slash) or
 * throws.
 */
export function assertSafeTarget(env, name) {
  const key = name || "BASE_URL";
  const raw = (env && env[key] ? String(env[key]) : "").trim();
  if (!raw) {
    throw guardError(key + " is not set. There is no default target.");
  }

  // Check the raw string first so a database URL pasted by mistake is
  // refused even if it would not parse as http.
  if (raw.indexOf(":5432") !== -1) {
    throw guardError(
      key +
        " contains :5432 — that is the live production Postgres " +
        "port. The harness talks HTTP to the app only, never to a database."
    );
  }

  if (!env || String(env.LOAD_TEST_CONFIRM_TARGET) !== "1") {
    throw guardError(
      "LOAD_TEST_CONFIRM_TARGET=1 is not set. Set it only after confirming " +
        key +
        " points at a throwaway local stack."
    );
  }

  // Minimal http(s) URL parse without WHATWG URL (absent in k6's runtime).
  // Captures: scheme, host (bracketed IPv6 or reg-name), optional port.
  const match = /^(https?):\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?(?:[/?#]|$)/i.exec(
    raw
  );
  if (!match) {
    throw guardError(
      key + ' "' + raw + '" is not a plain http(s) URL the guard can parse.'
    );
  }

  const host = match[2].toLowerCase();
  const port = match[3] || "";
  const bareHost =
    host.charAt(0) === "[" ? host.slice(1, host.length - 1) : host;

  if (Number(port) === 5432) {
    throw guardError(key + " targets port 5432 (live production Postgres).");
  }

  assertLocalHost(host, bareHost, key);

  return raw.replace(/\/+$/, "");
}

/**
 * Validate the database the volume seeder (#4940) is about to write to (pass
 * `process.env`). The same rules as `assertSafeTarget`, applied to
 * `DATABASE_URL`, with two additions a database URL needs:
 *
 *   - the port must be written out and must not be 5432. PostgreSQL defaults
 *     an omitted port to 5432, so "no port" is refused too;
 *   - libpq/Prisma query parameters that re-point the connection (`host`,
 *     `hostaddr`, `port`, `socket`) and multi-host authorities are refused,
 *     so the host the guard checked is the host the client dials.
 *
 * Returns the URL unchanged or throws. There is no override.
 */
export function assertSafeDatabaseTarget(env) {
  const raw = (env && env.DATABASE_URL ? String(env.DATABASE_URL) : "").trim();
  if (!raw) {
    throw guardError("DATABASE_URL is not set. There is no default database.");
  }

  if (raw.indexOf(":5432") !== -1) {
    throw guardError(
      "DATABASE_URL contains :5432 — that is the live production Postgres port."
    );
  }

  if (!env || String(env.LOAD_TEST_CONFIRM_TARGET) !== "1") {
    throw guardError(
      "LOAD_TEST_CONFIRM_TARGET=1 is not set. Set it only after confirming " +
        "DATABASE_URL points at a throwaway local database."
    );
  }

  const scheme = /^(postgres|postgresql):\/\//i.exec(raw);
  if (!scheme) {
    throw guardError("DATABASE_URL is not a postgres:// or postgresql:// URL.");
  }
  const rest = raw.slice(scheme[0].length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const tail = authorityEnd === -1 ? "" : rest.slice(authorityEnd);
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);

  if (hostPort.indexOf(",") !== -1) {
    throw guardError("DATABASE_URL names several hosts; give exactly one.");
  }
  // pg decodes query keys before applying connection options. Check the
  // decoded names too: ?%68ost=remote must not escape the checked authority.
  // Everything after the FIRST "?" is the query, as pg reads it: a second "?"
  // must not hide `&host=` from the check.
  const queryStart = tail.indexOf("?");
  const query = queryStart === -1 ? "" : tail.slice(queryStart + 1);
  const keys = query ? query.split("#")[0].split("&").map(function (part) {
    try {
      return decodeURIComponent(part.split("=")[0].replace(/\+/g, " ")).toLowerCase();
    } catch {
      throw guardError("DATABASE_URL has a malformed query parameter.");
    }
  }) : [];
  if (keys.some(function (key) {
    return ["host", "hostaddr", "port", "socket", "connectionstring", "service"].indexOf(key) !== -1;
  })) {
    throw guardError(
      "DATABASE_URL carries a host, hostaddr, port or socket parameter that " +
        "would re-point the connection away from the checked host."
    );
  }

  const match = /^(\[[^\]]+\]|[^:\[\]]+)(?::(\d*))?$/.exec(hostPort);
  if (!match) {
    throw guardError("DATABASE_URL has no host the guard can parse.");
  }
  const host = match[1].toLowerCase();
  const port = match[2] || "";
  const bareHost =
    host.charAt(0) === "[" ? host.slice(1, host.length - 1) : host;

  if (!port) {
    throw guardError(
      "DATABASE_URL has no explicit port, and PostgreSQL defaults to 5432 " +
        "(live production Postgres). Name the throwaway port, e.g. :5433."
    );
  }
  if (Number(port) === 5432) {
    throw guardError("DATABASE_URL targets port 5432 (live production Postgres).");
  }

  assertLocalHost(host, bareHost, "DATABASE_URL");
  return raw;
}
