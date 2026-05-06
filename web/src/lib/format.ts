// User-facing formatters. Per the dashboard style rule, these spell out time
// units in full ("5 minutes ago", not "5m ago") so labels read naturally and
// stay accessible to anyone who isn't already steeped in the codebase.

function pluralize(value: number, unit: string): string {
  return `${value} ${value === 1 ? unit : `${unit}s`}`;
}

export function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '\u2014';
  if (ms < 1000) return 'just now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${pluralize(seconds, 'second')} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${pluralize(minutes, 'minute')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${pluralize(hours, 'hour')} ago`;
  const days = Math.floor(hours / 24);
  return `${pluralize(days, 'day')} ago`;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatWindow(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return pluralize(seconds, 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return pluralize(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return pluralize(hours, 'hour');
  const days = Math.floor(hours / 24);
  return pluralize(days, 'day');
}
