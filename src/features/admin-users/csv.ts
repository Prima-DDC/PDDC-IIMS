/**
 * A minimal CSV reader for the bulk user import.
 *
 * Handles what a spreadsheet export actually produces: quoted fields, escaped
 * quotes, commas and newlines inside quotes, CRLF line endings, and a trailing
 * newline. A dependency would be more thorough, but this is small enough to
 * read in full and test exhaustively, which matters for a code path that
 * grants access to case material.
 *
 * Kept out of the server-action module so it can be unit-tested directly.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          // An escaped quote inside a quoted field.
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop rows that are entirely empty, which a trailing newline or a blank
  // line in the middle of a file would otherwise produce.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** Maps a header row and a data row into a record, lower-casing the keys. */
export function toRecord(
  header: readonly string[],
  cells: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    header.map((column, i) => [column.trim().toLowerCase(), cells[i] ?? ""]),
  );
}
