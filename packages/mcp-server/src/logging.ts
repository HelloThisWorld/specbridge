/**
 * Structured stderr logging for stdio MCP operation.
 *
 * Invariant: under the stdio transport, stdout carries MCP protocol frames
 * and nothing else. Every log line — including startup notices and crash
 * reports — goes to stderr. Nothing in this module (or anything it is given
 * to log) may ever write to stdout.
 *
 * Logs carry safe metadata only: no spec contents, no source file contents,
 * no candidate Markdown, no prompts, no environment values, no secrets, and
 * no unrestricted command output.
 */

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export type LogEvent =
  | 'server_started'
  | 'server_stopped'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'tool_cancelled'
  | 'resource_read'
  | 'prompt_requested'
  | 'interactive_run_started'
  | 'interactive_run_completed'
  | 'interactive_run_aborted'
  | (string & {});

export interface LogFields {
  requestId?: string | number;
  tool?: string;
  resource?: string;
  prompt?: string;
  runId?: string;
  durationMs?: number;
  errorCode?: string;
  [key: string]: unknown;
}

export interface McpLogger {
  readonly level: LogLevel;
  error(event: LogEvent, fields?: LogFields): void;
  warn(event: LogEvent, fields?: LogFields): void;
  info(event: LogEvent, fields?: LogFields): void;
  debug(event: LogEvent, fields?: LogFields): void;
}

export interface CreateLoggerOptions {
  level: LogLevel;
  json: boolean;
  /** Sink for one complete log line (defaults to process.stderr). */
  sink?: (line: string) => void;
  clock?: () => Date;
}

export function createLogger(options: CreateLoggerOptions): McpLogger {
  const sink = options.sink ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const clock = options.clock ?? ((): Date => new Date());
  const threshold = LEVEL_RANK[options.level];

  const emit = (level: LogLevel, event: LogEvent, fields: LogFields = {}): void => {
    if (LEVEL_RANK[level] > threshold) return;
    const timestamp = clock().toISOString();
    if (options.json) {
      sink(JSON.stringify({ timestamp, level, event, ...fields }));
      return;
    }
    const extras = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ');
    sink(`${timestamp} [${level}] ${event}${extras.length > 0 ? ` ${extras}` : ''}`);
  };

  return {
    level: options.level,
    error: (event, fields) => emit('error', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    info: (event, fields) => emit('info', event, fields),
    debug: (event, fields) => emit('debug', event, fields),
  };
}

export function parseLogLevel(value: string): LogLevel | undefined {
  return (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : undefined;
}
