const {
  AlignmentType, BorderStyle, Document, Packer, Paragraph, Table, TableCell, TableRow,
  TextRun, WidthType
} = require('docx');

const FONT = 'Microsoft YaHei';
const MAX_REPORT_LENGTH = 300000;
const PAGE_CONTENT_WIDTH = 10368; // Letter portrait with 0.65-inch side margins, in twips.

function plain(value) {
  return String(value || '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/`/g, '');
}

function paragraph(value, options = {}) {
  return new Paragraph({
    children: [new TextRun({ text: plain(value), font: FONT, ...options.run })],
    spacing: { after: options.after ?? 85, line: 270 },
    keepNext: Boolean(options.keepNext),
    ...(options.style ? { style: options.style } : {}),
    ...(options.alignment ? { alignment: options.alignment } : {})
  });
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(value => plain(value.trim()));
}

function separator(line) {
  if (!/^\|[\s|:\-]+\|\s*$/.test(line)) return false;
  return tableCells(line).every(cell => /^:?-{3,}:?$/.test(cell));
}

function columnWidths(headers) {
  const weights = headers.map(header => /摘要|备注|结论|说明/.test(header) ? 2.5 :
    /序号|匹配分|状态/.test(header) ? 0.9 : 1.35);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const widths = weights.map(weight => Math.round(PAGE_CONTENT_WIDTH * weight / total));
  widths[widths.length - 1] += PAGE_CONTENT_WIDTH - widths.reduce((sum, width) => sum + width, 0);
  return widths;
}

function reportTable(rows) {
  const headers = rows[0];
  const widths = columnWidths(headers);
  const border = { color: 'D9D9D9', style: BorderStyle.SINGLE, size: 4 };
  return new Table({
    width: { size: PAGE_CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    borders: { top: border, bottom: border, left: border, right: border,
      insideHorizontal: border, insideVertical: border },
    rows: rows.map((row, rowIndex) => new TableRow({
      tableHeader: rowIndex === 0,
      cantSplit: true,
      children: headers.map((_, columnIndex) => new TableCell({
        width: { size: widths[columnIndex], type: WidthType.DXA },
        margins: { top: 90, bottom: 90, left: 100, right: 100 },
        shading: { fill: rowIndex === 0 ? '243B53' : rowIndex % 2 === 0 ? 'F5F8FB' : 'FFFFFF' },
        children: [new Paragraph({
          children: [new TextRun({ text: row[columnIndex] || '', font: FONT,
            size: 18, color: rowIndex === 0 ? 'FFFFFF' : '222222', bold: rowIndex === 0 })],
          spacing: { after: 0, line: 250 },
          alignment: /序号|匹配分|状态/.test(headers[columnIndex])
            ? AlignmentType.CENTER : AlignmentType.LEFT
        })]
      }))
    }))
  });
}

function reportChildren(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const children = [];
  let titleSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('|') && i + 1 < lines.length && separator(lines[i + 1])) {
      const headers = tableCells(line);
      const rows = [headers];
      i++;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
        const cells = tableCells(lines[++i]);
        rows.push(cells.slice(0, headers.length));
      }
      children.push(reportTable(rows));
      children.push(paragraph('', { after: 80 }));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const style = heading[1].length === 1 && !titleSeen ? 'Title' :
        heading[1].length === 3 ? 'Heading2' : 'Heading1';
      titleSeen = true;
      children.push(paragraph(heading[2], { style, keepNext: true,
        after: style === 'Title' ? 230 : 110 }));
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const checkbox = /^-\s+\[\s*\]\s*/.test(line);
      children.push(paragraph(`${checkbox ? '☐ ' : '• '}${line.replace(/^[-*]\s+(?:\[\s*\]\s*)?/, '')}`,
        { after: 55 }));
      continue;
    }
    if (line.startsWith('>')) {
      children.push(paragraph(line.replace(/^>\s*/, ''), { run: { italics: true }, after: 110 }));
      continue;
    }
    children.push(paragraph(line));
  }
  return children.length ? children : [paragraph('无可导出的报告内容')];
}

/** Convert the existing screening-report Markdown into a readable Word file. */
async function markdownToDocx(markdown) {
  if (typeof markdown !== 'string' || markdown.length > MAX_REPORT_LENGTH) {
    throw new Error('报告内容无效或过长，无法导出 Word');
  }
  const title = markdown.match(/^#\s+([^\r\n]+)/m)?.[1] || '候选人筛选报告';
  const doc = new Document({
    creator: '本地智能招聘系统',
    title,
    description: '供招聘人员人工复核的候选人筛选报告',
    styles: {
      default: { document: { run: { font: FONT, size: 21, color: '222222' } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal',
          run: { font: FONT, size: 34, bold: true, color: '000000' },
          paragraph: { spacing: { after: 230 }, keepNext: true } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal',
          run: { font: FONT, size: 27, bold: true, color: '000000' },
          paragraph: { spacing: { before: 180, after: 110 }, keepNext: true } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal',
          run: { font: FONT, size: 23, bold: true, color: '000000' },
          paragraph: { spacing: { before: 140, after: 95 }, keepNext: true } }
      ]
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 },
        margin: { top: 1040, bottom: 1040, left: 936, right: 936 } } },
      children: reportChildren(markdown)
    }]
  });
  return Packer.toBuffer(doc);
}

module.exports = { markdownToDocx };
