import * as XLSX from "xlsx";
import Papa from "papaparse";

export type RawRow = Record<string, unknown>;

/**
 * Parses an uploaded lead list into rows of raw cells.
 *
 * Accepts Excel, CSV/TSV and JSON so the user can drop in whatever the data
 * vendor sent without converting it first.
 */
export async function parseUpload(
  file: File,
): Promise<{ rows: RawRow[]; columns: string[]; kind: "EXCEL" | "CSV" | "JSON" }> {
  const name = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();

  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const wb = XLSX.read(buffer, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: "" });
    return { rows, columns: columnsOf(rows), kind: "EXCEL" };
  }

  const text = new TextDecoder().decode(buffer);

  if (name.endsWith(".json")) {
    const parsed = JSON.parse(text);
    const rows: RawRow[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.leads)
        ? parsed.leads
        : [parsed];
    return { rows, columns: columnsOf(rows), kind: "JSON" };
  }

  // Default to delimited text. Papa sniffs the delimiter, so TSV works too.
  const result = Papa.parse<RawRow>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  return { rows: result.data, columns: columnsOf(result.data), kind: "CSV" };
}

function columnsOf(rows: RawRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows.slice(0, 50)) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen];
}

/**
 * Guesses which column holds which field, so a well-formed file needs no
 * manual mapping. The user can override every guess in the UI.
 */
const PATTERNS: Record<string, RegExp> = {
  email: /^(e[-_ ]?mail|email[-_ ]?address|work[-_ ]?email|contact)$/i,
  first_name: /^(first[-_ ]?name|fname|given[-_ ]?name)$/i,
  last_name: /^(last[-_ ]?name|lname|surname|family[-_ ]?name)$/i,
  name: /^(full[-_ ]?name|name|contact[-_ ]?name|person)$/i,
  company: /^(company|company[-_ ]?name|organi[sz]ation|account|employer)$/i,
  title: /^(title|job[-_ ]?title|position|role|designation)$/i,
  phone: /^(phone|telephone|mobile|contact[-_ ]?number|phone[-_ ]?number)$/i,
  location: /^(location|city|country|region|address)$/i,
};

export function guessMapping(columns: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};

  for (const [field, pattern] of Object.entries(PATTERNS)) {
    const hit = columns.find((c) => pattern.test(c.trim()));
    if (hit) mapping[field] = hit;
  }

  // Fall back to a fuzzy contains-match for email, which is the only
  // field we genuinely cannot import without.
  if (!mapping.email) {
    const fuzzy = columns.find((c) => c.toLowerCase().includes("mail"));
    if (fuzzy) mapping.email = fuzzy;
  }

  return mapping;
}
