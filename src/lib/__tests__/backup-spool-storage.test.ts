import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers/compose";

describe("backup spool storage", () => {
  it("mounts the dump directory on disk instead of the parent tmpfs", () => {
    const backupSource = readRepoFile("src/lib/backup-spool.ts");
    const directory = /^export const BACKUP_DIR = "([^"]+)";/m.exec(backupSource)?.[1];
    expect(directory).toBeTruthy();

    const compose = readRepoFile("docker-compose.yml");
    const appAnchor = compose.split("\nx-app-service:")[1]?.split("\nservices:")[0];
    expect(appAnchor).toBeTruthy();
    expect(appAnchor?.split("\n")).toContain(`    - backup_spool:${directory}`);
    // An empty named-volume declaration uses Docker's disk-backed local driver;
    // a tmpfs driver_opts block would fail this check.
    expect(compose).toMatch(/^  backup_spool:\n(?= {0,2}\S|$)/m);

    // Fresh volumes inherit image ownership before the app runs as uid 1001.
    expect(readRepoFile("Dockerfile").split("\n")).toContain(
      `RUN mkdir -p ${directory} && chown nextjs:nodejs ${directory}`,
    );
  });
});
