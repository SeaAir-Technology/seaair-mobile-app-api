export function DirectionBadge({
  direction,
}: {
  direction: 'fw2mobile' | 'mobile2fw';
}): JSX.Element {
  const isFw = direction === 'fw2mobile';
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
        isFw
          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
          : 'bg-sky-50 text-sky-700 border border-sky-200'
      }`}
    >
      {isFw ? 'FW → MOBILE' : 'MOBILE → FW'}
    </span>
  );
}
