export type LogFields = Record<string, string | number | boolean | null | undefined>;

export type Logger = {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

type Level = "INFO" | "WARN" | "ERROR";

function write(level: Level, message: string, fields: LogFields = {}) {
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  const line = [new Date().toISOString(), level.padEnd(5), message, ...pairs].join(" ");
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

function formatValue(value: string | number | boolean | null | undefined): string {
  return typeof value === "string" && /[\s"=]/.test(value) ? JSON.stringify(value) : String(value);
}

export const consoleLogger: Logger = {
  info: (message, fields) => write("INFO", message, fields),
  warn: (message, fields) => write("WARN", message, fields),
  error: (message, fields) => write("ERROR", message, fields),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
