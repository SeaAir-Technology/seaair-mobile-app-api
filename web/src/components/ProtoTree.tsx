import { useState } from 'react';

interface Props {
  data: unknown;
  rootKey?: string;
}

// Minimal collapsible tree for decoded protobuf payloads. The decoder on
// the server returns plain JSON-friendly objects (numbers, strings, nested
// objects, arrays), so we just render those generically. Default state
// for every node is open: the typical decoded BLE.Msg has at most three
// or four levels of nesting, and the operator almost always wants to see
// the full payload at a glance rather than click-drilling. Each node is
// still individually collapsible if the layout gets too tall.
export function ProtoTree({ data, rootKey }: Props): JSX.Element {
  return <Node value={data} keyName={rootKey} depth={0} />;
}

function Node({
  value,
  keyName,
  depth,
}: {
  value: unknown;
  keyName?: string;
  depth: number;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const indent = { paddingLeft: `${depth * 12}px` };

  if (value === null || value === undefined) {
    return (
      <div style={indent} className="font-mono text-xs">
        {keyName && <span className="text-ink-500">{keyName}: </span>}
        <span className="text-ink-400">null</span>
      </div>
    );
  }

  if (Array.isArray(value)) {
    return (
      <div style={indent} className="font-mono text-xs">
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-ink-500 hover:text-ink-900"
        >
          {open ? '▼' : '▶'}{' '}
          {keyName && <span>{keyName}</span>}
          <span className="text-ink-400"> [{value.length}]</span>
        </button>
        {open &&
          value.map((v, i) => (
            <Node key={i} value={v} keyName={String(i)} depth={depth + 1} />
          ))}
      </div>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <div style={indent} className="font-mono text-xs">
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-ink-500 hover:text-ink-900"
        >
          {open ? '▼' : '▶'}{' '}
          {keyName ?? <span className="text-ink-400">object</span>}
        </button>
        {open &&
          entries.map(([k, v]) => (
            <Node key={k} value={v} keyName={k} depth={depth + 1} />
          ))}
      </div>
    );
  }

  return (
    <div style={indent} className="font-mono text-xs">
      {keyName && <span className="text-ink-500">{keyName}: </span>}
      <span className="text-ink-900">{String(value)}</span>
    </div>
  );
}
