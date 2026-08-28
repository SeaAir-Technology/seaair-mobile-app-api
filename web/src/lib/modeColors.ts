// One place for the run-mode color language: the analytics charts shade the
// background with MODE_FILL, and the Current State cockpit paints its mode
// block with the matching MODE_THEME, so "blue above the graph, blue band in
// the graph" always mean the same thing. Standby is deliberately white.

export const MODE_FILL: Record<string, string> = {
  COOL: '#dbeafe', // light blue
  HEAT: '#fee2e2', // light red
  HUMIDITY: '#dcfce7', // light green
  FAN: '#ffedd5', // light orange
};

export interface ModeTheme {
  bg: string;
  border: string;
  label: string;
  value: string;
  sub: string;
}

const THEMES: Record<string, ModeTheme> = {
  COOL: { bg: '#dbeafe', border: '#bfdbfe', label: '#1d4ed8', value: '#1e3a8a', sub: '#2563eb' },
  HEAT: { bg: '#fee2e2', border: '#fecaca', label: '#b91c1c', value: '#7f1d1d', sub: '#dc2626' },
  HUMIDITY: { bg: '#dcfce7', border: '#bbf7d0', label: '#15803d', value: '#14532d', sub: '#16a34a' },
  FAN: { bg: '#ffedd5', border: '#fed7aa', label: '#c2410c', value: '#7c2d12', sub: '#ea580c' },
};

// Standby, unknown, and missing modes all get the neutral white card.
const NEUTRAL: ModeTheme = {
  bg: '#ffffff',
  border: '#d5dae3', // ink-200
  label: '#586478', // ink-500
  value: '#0f1320', // ink-900
  sub: '#7a8497', // ink-400
};

export function modeTheme(mode: string | undefined): ModeTheme {
  return (mode && THEMES[mode]) || NEUTRAL;
}
