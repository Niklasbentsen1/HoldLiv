// Et minimalt PDF-dokument med tekst (Helvetica, Windows-1252), uden eksterne biblioteker. Nok til en kvittering.
export interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  /** Ekstra luft over linjen, i punkter. */
  gap?: number;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
// Tegn uden for Windows-1252 erstattes med ?, så filen altid er gyldig.
const WIN1252: Record<string, number> = { "€": 0x80, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "–": 0x96, "—": 0x97 };
const win1252 = (s: string) =>
  Buffer.from([...esc(s)].map((ch) => (WIN1252[ch] ?? (ch.codePointAt(0)! <= 0xff ? ch.codePointAt(0)! : 0x3f))));

export function simplePdf(lines: PdfLine[]): Buffer {
  let y = 790;
  const ops: Buffer[] = [];
  for (const l of lines) {
    const size = l.size ?? 11;
    y -= (l.gap ?? 0) + size * 1.5;
    ops.push(Buffer.concat([Buffer.from(`BT /${l.bold ? "F2" : "F1"} ${size} Tf 56 ${y.toFixed(1)} Td (`), win1252(l.text), Buffer.from(") Tj ET\n")]));
  }
  const content = Buffer.concat(ops);
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>"),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("endstream")]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let pos = parts[0].length;
  objects.forEach((o, i) => {
    offsets.push(pos);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from("\nendobj\n")]);
    parts.push(chunk);
    pos += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(parts);
}
