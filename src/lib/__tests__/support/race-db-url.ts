/**
 * The loopback / port / database-name guard every real-PostgreSQL race suite
 * applies before it opens a connection (`INV-OPS`).
 *
 * WHAT IT REFUSES, AND WHY EACH CLAUSE IS THERE. A race suite TRUNCATES tables and
 * drives two concurrent writers, so pointing one at anything but a throwaway
 * database destroys data. Port 5432 is refused by name because that is where a real
 * PostgreSQL lives on a developer machine and on this project's own production host;
 * anything below 55442 is refused because the repository's throwaway harnesses are
 * allocated from that range upwards; a non-loopback host is refused because a race
 * database is never remote; and the database name must contain the harness marker so
 * a loopback throwaway server holding an unrelated database is still refused.
 *
 * WHY IT IS SHARED RATHER THAN RESTATED, which is a reversal. Each suite used to
 * carry its own copy, and the reason given was "restated rather than imported so
 * this file cannot be pointed at a real database by an import going missing". That
 * reason does not describe a reachable failure: a missing import is a module-load
 * error, so the suite does not run at all — which is fail-CLOSED, the direction the
 * guard wants. The real risk runs the other way. There were twelve copies of one
 * safety fact, so tightening it (a new refused port, a corrected hostname list) had
 * to be done twelve times, and the eleventh copy nobody updated is the one that
 * connects to something real. `INV-SSOT-001` is explicit that this is the
 * arrangement to reject.
 *
 * `label` names the suite in every message, because an operator reading a refusal
 * needs to know which harness refused and what to point it at.
 */
export function assertSafeRaceDbUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} tests need a valid race database URL.`);
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing ${label} race DB port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      parsed.hostname.toLowerCase(),
    )
  ) {
    throw new Error(`${label} race DB must be loopback-only.`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      `${label} race DB name must contain 'concurrency_race_1881'.`,
    );
  }
}
