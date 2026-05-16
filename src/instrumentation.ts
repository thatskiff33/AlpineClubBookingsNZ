export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
    return;
  }

  if (process.env.NEXT_RUNTIME === "nodejs") {
    const instrumentation = await import("./instrumentation.node");
    await instrumentation.register();
  }
}
