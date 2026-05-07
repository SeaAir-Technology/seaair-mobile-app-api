export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <div className="inline-flex items-center gap-2 text-ink-500 text-sm">
      <span className="inline-block w-3 h-3 border-2 border-ink-300 border-t-ink-700 rounded-full animate-spin" />
      {label}
    </div>
  );
}
