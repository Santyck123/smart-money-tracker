import pino, { type LoggerOptions } from "pino";
import { env } from "./config.js";

const options: LoggerOptions = { level: env.LOG_LEVEL };
if (process.stdout.isTTY) {
  options.transport = {
    target: "pino-pretty",
    options: { colorize: true, translateTime: "HH:MM:ss" },
  };
}

export const logger = pino(options);
