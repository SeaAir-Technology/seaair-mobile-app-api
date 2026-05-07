// Small inline SVG icons + status indicators used across the dashboard.
// Defining them as components keeps the bundle small (no icon-pack
// dependency) and gives a single source of truth for stroke width,
// view box, and aria treatment.

export function BeaconIcon({
  className = '',
}: {
  className?: string;
}): JSX.Element {
  // Alert-triangle, sized to sit naturally in a small chip.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function StatusDot({ tone }: { tone: 'live' | 'stale' }): JSX.Element {
  // A small circle indicating online/offline state, with a soft halo on the
  // live state so it reads as "active" at a row-level glance.
  const live = tone === 'live';
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${
        live
          ? 'bg-emerald-500 ring-2 ring-emerald-200'
          : 'bg-ink-300 ring-2 ring-ink-100'
      }`}
      aria-label={live ? 'Online' : 'Stale'}
      role="img"
    />
  );
}
