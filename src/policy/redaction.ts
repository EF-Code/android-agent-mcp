export const REDACTED = '[REDACTED]';

const LOG_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  [/(cookie\s*[:=]\s*)[^\s;]+/gi, `$1${REDACTED}`],
  [/(set-cookie\s*[:=]\s*)[^\r\n]+/gi, `$1${REDACTED}`],
  [/(\b(?:token|secret|password|passwd|api[_-]?key|access[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`],
  [/(\b[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key)[A-Za-z0-9_-]*\s+)[^\s,;]+/gi, `$1${REDACTED}`],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED],
];

export function redactLogText(value: string): string {
  return LOG_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), value);
}

export function redactUiText(text: string | null, password: boolean): string | null {
  return password && text !== null ? REDACTED : text;
}

export function redactSensitiveUiText(text: string | null): string | null {
  return text === null ? null : REDACTED;
}

export function redactCommandArgs(args: string[], secretIndexes: ReadonlySet<number> = new Set()): string[] {
  return args.map((arg, index) => (secretIndexes.has(index) ? REDACTED : arg));
}
