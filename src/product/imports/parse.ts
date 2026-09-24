/**
 * Deterministic parsing of user-provided CSV / JSON. No network, no guessing, no silent repair:
 * every row comes back with its line number so a rejected row can always be shown to the user.
 */

export interface RawRow {
  /** 1-based line in the file (CSV) or 1-based index (JSON). */
  line: number;
  values: Record<string, string>;
}

export interface ParsedFile {
  format: 'csv' | 'json';
  columns: string[];
  rows: RawRow[];
  /** A problem with the file as a whole (nothing could be read). */
  error?: string;
}

const normaliseHeader = (h: string) =>
  h
    .trim()
    .replace(/^﻿/, '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

/** RFC 4180-style CSV: quoted fields, escaped quotes, commas and newlines inside quotes, CRLF. */
export function parseCsv(text: string): ParsedFile {
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else {
        if (c === '\n') line++;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      cells.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell);
      records.push({ line: recordLine, cells });
      cells = [];
      cell = '';
      line++;
      recordLine = line;
    } else cell += c;
  }
  if (quoted) return { format: 'csv', columns: [], rows: [], error: 'The file ends inside a quoted field (an unmatched " character).' };
  if (cell !== '' || cells.length) {
    cells.push(cell);
    records.push({ line: recordLine, cells });
  }
  const nonEmpty = records.filter((r) => r.cells.some((x) => x.trim() !== ''));
  if (!nonEmpty.length) return { format: 'csv', columns: [], rows: [], error: 'The file is empty.' };
  const [header, ...body] = nonEmpty;
  const columns = header.cells.map(normaliseHeader);
  if (columns.some((c) => !c)) return { format: 'csv', columns, rows: [], error: 'The header row has an empty column name.' };
  return {
    format: 'csv',
    columns,
    rows: body.map((r) => ({
      line: r.line,
      values: Object.fromEntries(columns.map((c, i) => [c, (r.cells[i] ?? '').trim()])),
    })),
  };
}

/** A JSON array of objects, or an object with a `records` / `data` / `rows` array. */
export function parseJson(text: string): ParsedFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { format: 'json', columns: [], rows: [], error: 'The file is not valid JSON.' };
  }
  const list = Array.isArray(data) ? data : ((data as Record<string, unknown>)?.records ?? (data as Record<string, unknown>)?.data ?? (data as Record<string, unknown>)?.rows);
  if (!Array.isArray(list)) return { format: 'json', columns: [], rows: [], error: 'Expected a JSON array of records (or an object with a "records" array).' };
  const columns = new Set<string>();
  const rows = list.map((item, i): RawRow => {
    const values: Record<string, string> = {};
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        const key = normaliseHeader(k);
        columns.add(key);
        values[key] = v === null || v === undefined ? '' : Array.isArray(v) ? v.join(';') : typeof v === 'object' ? JSON.stringify(v) : String(v).trim();
      }
    }
    return { line: i + 1, values };
  });
  if (!rows.length) return { format: 'json', columns: [], rows: [], error: 'The file has no records.' };
  return { format: 'json', columns: [...columns], rows };
}

export function parseFile(filename: string, text: string): ParsedFile {
  const trimmed = text.trimStart();
  return /\.json$/i.test(filename) || trimmed.startsWith('[') || trimmed.startsWith('{') ? parseJson(text) : parseCsv(text);
}
