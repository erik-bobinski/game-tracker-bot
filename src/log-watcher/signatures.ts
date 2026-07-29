export interface ErrorSignature {
  readonly signature: string;
  readonly count: number;
  readonly level: string;
  readonly sample: string;
  readonly annotations: unknown;
  readonly firstSeen: string | null;
  readonly lastSeen: string | null;
}

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"],
  [/\b\d{17,20}\b/g, "<snowflake>"],
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<timestamp>"],
  [/\?[^\s)"]*/g, "?<query>"],
  [/\b\d+\b/g, "<n>"],
];

export const normalize = (message: string): string => {
  let shape = message;
  for (const [pattern, replacement] of REDACTIONS) {
    shape = shape.replace(pattern, replacement);
  }
  return shape.replace(/\s+/g, " ").trim();
};

interface LogEntry {
  readonly message: string;
  readonly level: string;
  readonly timestamp: string | null;
  readonly annotations: unknown;
}

const parseEntry = (line: string): LogEntry => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) {
      return { message: line, level: "", timestamp: null, annotations: null };
    }
    const record = parsed as Record<string, unknown>;
    return {
      message: typeof record.message === "string" ? record.message : line,
      level: String(record.level ?? "").toUpperCase(),
      timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
      annotations: record.annotations ?? null,
    };
  } catch {
    return { message: line, level: "", timestamp: null, annotations: null };
  }
};

const isActionable = (entry: LogEntry): boolean =>
  entry.level === "ERROR" ||
  entry.level === "WARN" ||
  /\b(error|failed|panic)\b/i.test(entry.message);

/**
 * Collapses repeated failures into one entry per shape. A single bad match
 * produced 254 identical lines in production, so without this every run would
 * re-report the same issue.
 */
export const groupBySignature = (
  lines: ReadonlyArray<string>,
): ReadonlyArray<ErrorSignature> => {
  const groups = new Map<string, ErrorSignature>();

  for (const line of lines) {
    if (line.trim() === "") continue;
    const entry = parseEntry(line);
    if (!isActionable(entry)) continue;

    const signature = normalize(entry.message);
    const existing = groups.get(signature);

    groups.set(
      signature,
      existing
        ? {
            ...existing,
            count: existing.count + 1,
            lastSeen: entry.timestamp ?? existing.lastSeen,
          }
        : {
            signature,
            count: 1,
            level: entry.level,
            sample: entry.message,
            annotations: entry.annotations,
            firstSeen: entry.timestamp,
            lastSeen: entry.timestamp,
          },
    );
  }

  return [...groups.values()].sort((a, b) => b.count - a.count);
};

/**
 * Deliberately generous: a false "already known" costs a missed report, so only
 * strong term overlap with an open PR or issue counts as covered.
 */
export const looksKnown = (
  signature: string,
  knownWork: ReadonlyArray<{ readonly title: string; readonly body: string }>,
): boolean => {
  const terms = signature
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((term) => term.length > 4);
  if (terms.length === 0) return false;

  return knownWork.some((item) => {
    const haystack = `${item.title}\n${item.body}`.toLowerCase();
    const hits = terms.filter((term) => haystack.includes(term)).length;
    return hits / terms.length >= 0.6;
  });
};
