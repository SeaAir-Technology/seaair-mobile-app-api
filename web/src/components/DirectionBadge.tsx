// Visual badge for message direction. Wire format is the protocol-level
// `fw2mobile` / `mobile2fw` (kept identical to the backend), but the badge
// label spells out the directions in full per the dashboard style rule.

export function DirectionBadge({
  direction,
}: {
  direction: 'fw2mobile' | 'mobile2fw';
}): JSX.Element {
  const fromFirmware = direction === 'fw2mobile';
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
        fromFirmware
          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
          : 'bg-sky-50 text-sky-700 border border-sky-200'
      }`}
    >
      {fromFirmware ? 'Firmware \u2192 Mobile' : 'Mobile \u2192 Firmware'}
    </span>
  );
}
