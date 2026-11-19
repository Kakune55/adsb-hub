const stops = [[0, 25], [4000, 53], [10000, 108], [20000, 174], [30000, 228], [40000, 285]];
const color = (hue) => `hsl(${hue}, 90%, 59%)`;

export function altitudeColor(feet) {
  if (!Number.isFinite(feet)) return '#a9b4c2';
  const altitude = Math.min(40000, Math.max(0, Math.round(feet / 500) * 500));
  const index = stops.findIndex(([limit]) => limit >= altitude);
  if (index === 0) return color(stops[0][1]);
  const [low, lowHue] = stops[index - 1], [high, highHue] = stops[index];
  return color(Math.round(lowHue + (highHue - lowHue) * (altitude - low) / (high - low)));
}

export const altitudeGradient = `linear-gradient(90deg, ${stops.map(([feet, hue]) => `${color(hue)} ${feet / 400}%`).join(', ')})`;
