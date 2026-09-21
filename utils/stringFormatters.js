// Utility: String formatting routines
export function slugify(text) {
  return text.toString().toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w\-]+/g, '');
}

export function camelCase(str) {
  return str.replace(/[-_ ]+(.)?/g, (_, c) => c ? c.toUpperCase() : '');
}

// Revision 23 - 2026-09-21
