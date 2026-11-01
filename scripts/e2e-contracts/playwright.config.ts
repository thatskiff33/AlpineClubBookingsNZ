import { defineConfig } from "@playwright/test";

// No application, database, credentials or network: specs fulfil their pages.
export default defineConfig({
  testDir: ".",
  testMatch: "*.pw.ts",
  workers: 1,
  retries: 0,
  reporter: [["list"], ["./reporter.ts"]],
  use: {
    launchOptions: {
      args: ["--no-sandbox"],
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
  },
});
