/**
 * Leitor de CSV sem dependências: aspas, aspas duplicadas, quebras de linha
 * dentro de aspas, CRLF e BOM. O separador é detectado na primeira linha
 * (";" do Excel em português, "," ou tabulação).
 */
export function detectDelimiter(text: string): string {
  const first = text.slice(0, text.search(/\r?\n|$/));
  const counts = [';', ',', '\t'].map((d) => [d, first.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ';';
}

export function parseCsv(input: string, delimiter = detectDelimiter(input.replace(/^﻿/, ''))): string[][] {
  const text = input.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** "Pretensão Salarial (R$)" → "pretensaosalarialr" — para reconhecer colunas por nome. */
export const headerKey = (h: string) =>
  h.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
