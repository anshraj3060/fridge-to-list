// Small text helpers shared by the server (Node) and the browser (no build step).
// Keep this file dependency-free so both can import it directly.

/** Trim, collapse whitespace, drop control chars and stray bullets/quotes. */
export function cleanText(value, maxLen = 60) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[-*•\u2022#>\s]+/, '');
  // Wrapping quotes and trailing punctuation can come in either order.
  s = s.replace(/^["'“”‘’`\s]+/, '');
  s = s.replace(/["'“”‘’`.,;:\s]+$/, '').trim();
  if (s.length > maxLen) {
    s = s.slice(0, maxLen).replace(/[\s,;:/-]+$/, '').trim();
  }
  return s;
}

/** Very small English singularizer. Good enough for grocery names. */
export function singularize(word) {
  if (!word) return word;
  const w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (/(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (/(oes|ches|shes|xes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Canonical key used for de-duplicating and matching grocery names. */
export function normalizeKey(value) {
  let s = String(value ?? '');
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase();
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  if (!s) return '';
  const words = s.split(' ').map((word) => singularize(word));
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

/** Display form: first letter up, keep the rest of the typed casing. */
export function titleCase(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  return s[0].toUpperCase() + s.slice(1);
}

/** Plain language for the reasons an item landed on the list. */
export const REASON_LABELS = {
  missing: 'not seen in photos',
  nearlyEmpty: 'looks nearly empty',
  manual: 'added by you',
};
