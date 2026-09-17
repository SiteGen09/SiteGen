type Fields = Record<string, unknown>;

type Level = 'info' | 'warn' | 'error';

export interface Logger {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(extra: Fields): Logger;
}

function write(level: Level, bindings: Fields, msg: string, fields?: Fields): void {
  const line = `${JSON.stringify({
    level,
    ts: new Date().toISOString(),
    msg,
    ...bindings,
    ...fields,
  })}\n`;
  if (level === 'info') {
    process.stdout.write(line);
  } else {
    process.stderr.write(line);
  }
}

/** Structured single-line JSON logger. Bindings (e.g. `request_id`) appear on every line. */
export function logger(bindings: Fields): Logger {
  return {
    info: (msg, fields) => write('info', bindings, msg, fields),
    warn: (msg, fields) => write('warn', bindings, msg, fields),
    error: (msg, fields) => write('error', bindings, msg, fields),
    child: (extra) => logger({ ...bindings, ...extra }),
  };
}
