export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger { log(level: LogLevel, message: string, meta?: Record<string, unknown>): void }
export const consoleLogger: Logger = {
  log(level, message, meta) { console[level === "debug" ? "log" : level](`[sandbox] ${message}`, meta ?? ""); },
};
export const silentLogger: Logger = { log() {} };
