import pino from "pino";

const isDev = process.env.NODE_ENV === "development";

const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  ...(isDev
    ? {
        transport: {
          target: "pino/file",
          options: { destination: 1 },
        },
        formatters: {
          level(label: string) {
            return { level: label };
          },
        },
      }
    : {
        formatters: {
          level(label: string) {
            return { level: label };
          },
        },
      }),
});

export default logger;
