// Utility: Collection utilities
export function chunk(array, size = 10) {
  const res = [];
  for (let i = 0; i < array.length; i += size) res.push(array.slice(i, i + size));
  return res;
}

export function uniqueBy(arr, key) {
  return [...new Map(arr.map((item) => [item[key], item])).values()];
}

// Revision 26 - 2026-09-21
