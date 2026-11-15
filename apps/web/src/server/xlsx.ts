import { crc32, deflateRawSync } from 'node:zlib';
import { WATERMARK_PNG } from './xlsx-watermark';

/**
 * Planilha XLSX padronizada do Malha, gerada sem dependências: um zip com os XML do Office Open XML.
 * - Bloco de identificação no topo (título, grupo, escopo, quem exportou e quando).
 * - Cabeçalho e rodapé de impressão com os mesmos dados em todas as páginas.
 * - Marca d'água "MALHA · USO INTERNO" como imagem de fundo da planilha.
 * - Todo texto vai como string inline: nenhuma célula vira fórmula, mesmo começando com = + - @.
 */

export type Cell = string | number | boolean | Date | null | undefined;
export interface SheetMeta { title: string; group: string; scope: string; exportedBy: string; exportedAt: Date }

// Caracteres de controle não são válidos em XML 1.0 e quebrariam o arquivo.
const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
const xml = (value: string) => clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Nos códigos de cabeçalho e rodapé do Excel, & começa um comando: o texto literal usa &&.
const headerText = (value: string) => xml(clean(value).replace(/&/g, '&&'));

function column(index: number) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const formatDate = (date: Date) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(date);
/** Data do Excel: dias desde 30/12/1899, em UTC. */
const excelDate = (date: Date) => date.getTime() / 86400000 + 25569;

// Estilos: 0 padrão · 1 título · 2 linha de identificação · 3 cabeçalho da tabela · 4 data · 5 aviso.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/></numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="16"/><color rgb="FF1D3A24"/><name val="Calibri"/></font>
<font><sz val="10"/><color rgb="FF4D5A50"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><i/><sz val="9"/><color rgb="FF8A6F2C"/><name val="Calibri"/></font>
</fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF2F6B3A"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFB6CDAF"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cell(ref: string, value: Cell, style = 0) {
  if (value === null || value === undefined || value === '') return `<c r="${ref}" s="${style}"/>`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? `<c r="${ref}" s="${style}"/>` : `<c r="${ref}" s="4"><v>${excelDate(value)}</v></c>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  const text = typeof value === 'boolean' ? (value ? 'sim' : 'não') : String(value);
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}

function zip(files: Array<[string, Buffer]>) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(nameBytes.length, 26); header.writeUInt16LE(0, 28);
    local.push(header, nameBytes, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12); entry.writeUInt16LE(33, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export function buildXlsx(meta: SheetMeta, header: string[], rows: Cell[][]) {
  const sheetName = clean(meta.title).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Malha';
  const last = column(header.length - 1);
  const when = `${formatDate(meta.exportedAt)} UTC`;
  const intro: Array<[string, number]> = [
    [`Malha · ${meta.title}`, 1],
    [`Grupo: ${meta.group} · Escopo: ${meta.scope}`, 2],
    [`Exportado por ${meta.exportedBy} em ${when}. Horários em UTC.`, 2],
    ['Documento gerado pelo Malha para uso interno do grupo. Não compartilhe fora da empresa.', 5],
  ];
  const headRow = intro.length + 2;
  const lines: string[] = intro.map(([text, style], index) => `<row r="${index + 1}">${cell(`A${index + 1}`, text, style)}</row>`);
  lines.push(`<row r="${headRow}">${header.map((name, index) => cell(`${column(index)}${headRow}`, name, 3)).join('')}</row>`);
  rows.forEach((row, rowIndex) => {
    const r = headRow + 1 + rowIndex;
    lines.push(`<row r="${r}">${header.map((_, index) => cell(`${column(index)}${r}`, row[index])).join('')}</row>`);
  });
  const widths = header.map((name, index) => {
    const longest = Math.max(name.length, ...rows.slice(0, 500).map((row) => {
      const value = row[index];
      return value instanceof Date ? 16 : value === null || value === undefined ? 0 : String(value).length;
    }));
    return Math.min(48, Math.max(10, longest + 2));
  });
  const lastRow = headRow + rows.length;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="A1:${last}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headRow}" topLeftCell="A${headRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>
<sheetData>${lines.join('')}</sheetData>
<autoFilter ref="A${headRow}:${last}${lastRow}"/>
<mergeCells count="${intro.length}">${intro.map((_, index) => `<mergeCell ref="A${index + 1}:${last}${index + 1}"/>`).join('')}</mergeCells>
<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddHeader>&amp;L&amp;"-,Bold"Malha · ${headerText(meta.title)}&amp;C${headerText(meta.group)}&amp;R${headerText(when)}</oddHeader><oddFooter>&amp;LExportado por ${headerText(meta.exportedBy)} · uso interno&amp;CPágina &amp;P de &amp;N&amp;R${headerText(meta.scope)}</oddFooter></headerFooter>
<picture r:id="rId1"/>
</worksheet>`;
  const quotedName = `'${sheetName.replace(/'/g, "''")}'`;
  const files: Array<[string, string | Buffer]> = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`],
    ['docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(`Malha · ${meta.title}`)}</dc:title><dc:subject>${xml(`${meta.group} · ${meta.scope}`)}</dc:subject><dc:creator>${xml(meta.exportedBy)}</dc:creator><dc:description>Documento gerado pelo Malha para uso interno do grupo.</dc:description><dcterms:created xsi:type="dcterms:W3CDTF">${meta.exportedAt.toISOString().replace(/\.\d{3}Z$/, 'Z')}</dcterms:created></cp:coreProperties>`],
    ['docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Malha</Application><Company>${xml(meta.group)}</Company></Properties>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${xml(quotedName)}!$A$${headRow}:$${last}$${lastRow}</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">${xml(quotedName)}!$${headRow}:$${headRow}</definedName></definedNames></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ['xl/worksheets/sheet1.xml', sheet],
    ['xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/marca-dagua.png"/></Relationships>`],
    ['xl/media/marca-dagua.png', WATERMARK_PNG],
  ];
  return zip(files.map(([name, data]) => [name, typeof data === 'string' ? Buffer.from(data, 'utf8') : data]));
}
