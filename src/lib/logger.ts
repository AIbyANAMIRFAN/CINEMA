type Level = "debug" | "info" | "warn" | "error";

// Structured JSON logs: one line per event, readable in Vercel's log viewer and log drains.
function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  const entry: Record<string, unknown> = { level, msg, time: new Date().toISOString(), ...fields };
  if (fields?.error instanceof Error) {
    entry.error = { name: fields.error.name, message: fields.error.message, stack: fields.error.stack };
  }
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level !== "debug" || process.env.LOG_LEVEL === "debug") console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
