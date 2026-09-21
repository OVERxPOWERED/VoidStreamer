// Utility: Mathematical utilities
export function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

export function roundTo(val, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

// Revision 14 - 2026-09-21
