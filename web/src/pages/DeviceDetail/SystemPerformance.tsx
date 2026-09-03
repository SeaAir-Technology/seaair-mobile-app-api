import { useEffect, useState } from 'react';

// System Performance panel: the refrigerant-circuit view developed during the
// EEV bench-validation project (ship_switch), restyled to the dashboard's ink
// theme. Sits between the current-state strip and the analytics charts.
//
// DATA SOURCE: simulated. The EEV controller (boss_marine EevController) is
// not yet reporting telemetry through heartbeats, so this panel runs on a
// plausible-motion simulation and says so with the SIMULATED badge. When the
// heartbeat schema grows eev/pressure fields, replace `useSimulatedPerf` with
// a hook over useDeviceState and flip the badge to LIVE per-field.

const HOT = '#dc2626'; // red-600 — discharge / high-pressure side
const HOT_LT = '#f87171';
const COLD = '#2563eb'; // blue-600 — suction / low-pressure side
const COLD_LT = '#60a5fa';
const INK_100 = '#eceef2';
const INK_300 = '#aab3c2';
const INK_400 = '#7a8497';
const INK_500 = '#586478';
const INK_900 = '#0f1320';

interface PerfData {
  superheatF: number;
  targetF: number;
  suctionF: number;
  dischargeF: number;
  liquidF: number;
  waterF: number;
  lowPsi: number;
  highPsi: number;
  valveSteps: number;
  valveRange: number;
  floorSteps: number;
}

// Gentle plausible motion around the bench-measured operating point so the
// panel is functional before live telemetry exists.
function useSimulatedPerf(): PerfData {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((v) => v + 0.35), 2000);
    return () => clearInterval(id);
  }, []);
  return {
    superheatF: 10.6 + Math.sin(t * 0.7) * 0.5,
    targetF: 10.8,
    suctionF: 48.9 + Math.sin(t * 0.5) * 0.8,
    dischargeF: 114.2 + Math.sin(t * 0.3) * 1.1,
    liquidF: 63.9 + Math.sin(t * 0.2) * 0.4,
    waterF: 83.6 + Math.sin(t * 0.15) * 0.3,
    lowPsi: 43 + Math.sin(t * 0.5) * 0.6,
    highPsi: 138 + Math.sin(t * 0.3) * 1.5,
    valveSteps: Math.round(95 + Math.sin(t * 0.25) * 4),
    valveRange: 500,
    floorSteps: 75,
  };
}

const LABEL = { fontSize: 10, letterSpacing: '.05em', fill: INK_400 } as const;
const VALUE = { fontSize: 19, fontWeight: 700 } as const;
const BOXLBL = { fontSize: 11, letterSpacing: '.05em', fill: INK_500 } as const;
const SUB = { fontSize: 10, fill: INK_400 } as const;

export function SystemPerformance(): JSX.Element {
  const d = useSimulatedPerf();
  const barW = 188;
  const fillW = Math.max(4, (d.valveSteps / d.valveRange) * barW);
  const floorX = (d.floorSteps / d.valveRange) * barW;

  return (
    <div className="px-4 pb-3">
      <div className="bg-white border border-ink-200 rounded overflow-hidden">
        <div className="flex items-center gap-3 px-4 pt-2.5 pb-2 border-b border-ink-100 flex-wrap">
          <span className="text-[11px] uppercase tracking-wide text-ink-500">
            System Performance
          </span>
          <span className="text-[10px] font-semibold tracking-wide text-amber-800 bg-amber-100 border border-amber-200 rounded px-1.5 py-px">
            SIMULATED
          </span>
          <span className="ml-auto flex items-baseline gap-2">
            <span className="text-[11px] uppercase tracking-wide text-ink-400">
              Superheat
            </span>
            <span className="text-xl font-bold tabular-nums text-ink-900">
              {d.superheatF.toFixed(1)}°F
            </span>
            <span className="text-[11px] text-ink-400">
              target {d.targetF.toFixed(1)}
            </span>
          </span>
        </div>

        <svg viewBox="0 0 900 340" className="block w-full h-auto" aria-label="refrigerant circuit">
          {/* hot side: compressor top -> condenser -> down to EEV */}
          <path d="M 620 132 L 620 66 L 300 66 L 300 136" stroke={HOT} strokeWidth={5} fill="none" strokeLinecap="round" />
          <path d="M 620 132 L 620 66 L 300 66 L 300 136" stroke={HOT_LT} strokeWidth={5} fill="none" strokeLinecap="round" className="perf-flow" />
          {/* cold side: EEV -> evaporator -> compressor bottom */}
          <path d="M 300 182 L 300 272 L 620 272 L 620 208" stroke={COLD} strokeWidth={5} fill="none" strokeLinecap="round" />
          <path d="M 300 182 L 300 272 L 620 272 L 620 208" stroke={COLD_LT} strokeWidth={5} fill="none" strokeLinecap="round" className="perf-flow" />

          {/* condenser */}
          <rect x={395} y={44} width={130} height={44} rx={6} fill="#fff" stroke={INK_300} strokeWidth={1.5} />
          <path d="M 407 66 h12 l7 -12 l9 21 l9 -21 l9 21 l9 -21 l9 21 l7 -12 h13" fill="none" stroke={INK_400} strokeWidth={2} />
          <text x={460} y={34} textAnchor="middle" style={BOXLBL} className="uppercase">Condenser</text>
          {/* seawater temp at the condenser (hose NTC / NMEA when fitted) */}
          <text x={460} y={112} textAnchor="middle" style={LABEL} className="uppercase">Water</text>
          <text x={460} y={136} textAnchor="middle" style={{ ...VALUE, fill: INK_900 }} className="tabular-nums">
            {d.waterF.toFixed(1)}°F
          </text>

          {/* evaporator — temperature intentionally not shown */}
          <rect x={395} y={250} width={130} height={44} rx={6} fill="#fff" stroke={INK_300} strokeWidth={1.5} />
          <path d="M 407 272 h12 l7 -12 l9 21 l9 -21 l9 21 l9 -21 l9 21 l7 -12 h13" fill="none" stroke={INK_400} strokeWidth={2} />
          <text x={460} y={318} textAnchor="middle" style={BOXLBL} className="uppercase">Evaporator</text>

          {/* EEV valve on the loop edge, label outside */}
          <path d="M 284 143 L 316 159 L 284 175 Z M 316 143 L 284 159 L 316 175 Z" fill="#fff" stroke={INK_500} strokeWidth={1.8} />
          <text x={268} y={163} textAnchor="end" style={BOXLBL} className="uppercase">EEV</text>

          {/* EEV data outside the loop: liquid line | steps, bar spanning both */}
          <g transform="translate(38,112)">
            <text x={0} y={0} style={LABEL} className="uppercase">Liquid line</text>
            <text x={0} y={24} style={{ ...VALUE, fill: INK_900 }} className="tabular-nums">
              {d.liquidF.toFixed(1)}°F
            </text>
            <text x={112} y={0} style={LABEL} className="uppercase">Steps</text>
            <text x={112} y={24} style={{ ...VALUE, fill: INK_900 }} className="tabular-nums">
              {d.valveSteps}
            </text>
            <text x={148} y={24} style={SUB}>/ {d.valveRange}</text>
            <rect x={0} y={40} width={barW} height={8} rx={4} fill={INK_100} />
            <rect x={0} y={40} width={fillW} height={8} rx={4} fill={COLD} />
            <rect x={floorX} y={38} width={1.8} height={12} fill={HOT} />
            <text x={0} y={64} style={SUB}>
              {((d.valveSteps / d.valveRange) * 100).toFixed(0)}% open
            </text>
          </g>

          {/* compressor on the loop edge, label outside */}
          <circle cx={620} cy={170} r={36} fill="#fff" stroke={INK_300} strokeWidth={1.5} />
          <path d="M 606 170 a14 14 0 1 1 28 0 a9 9 0 1 1 -18 0" fill="none" stroke={INK_400} strokeWidth={2} />
          <text x={666} y={174} style={BOXLBL} className="uppercase">Compressor</text>

          {/* discharge | high pressure — on the red line */}
          <g transform="translate(664,72)">
            <text x={0} y={0} style={LABEL} className="uppercase">Discharge</text>
            <text x={0} y={24} style={{ ...VALUE, fill: HOT }} className="tabular-nums">
              {d.dischargeF.toFixed(1)}°F
            </text>
            <text x={112} y={0} style={LABEL} className="uppercase">High pressure</text>
            <text x={112} y={24} style={{ ...VALUE, fill: HOT }} className="tabular-nums">
              {d.highPsi.toFixed(0)} psi
            </text>
          </g>
          {/* suction | low pressure — on the blue line */}
          <g transform="translate(664,252)">
            <text x={0} y={0} style={LABEL} className="uppercase">Suction</text>
            <text x={0} y={24} style={{ ...VALUE, fill: COLD }} className="tabular-nums">
              {d.suctionF.toFixed(1)}°F
            </text>
            <text x={112} y={0} style={LABEL} className="uppercase">Low pressure</text>
            <text x={112} y={24} style={{ ...VALUE, fill: COLD }} className="tabular-nums">
              {d.lowPsi.toFixed(0)} psi
            </text>
          </g>
        </svg>
      </div>
    </div>
  );
}
