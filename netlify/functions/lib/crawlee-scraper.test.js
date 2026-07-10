import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';

import {
  assertPublicUrl,
  cleanText,
  crawlSources,
  extractDocumentText,
  isPrivateAddress,
} from './crawlee-scraper.js';

function createMinimalPdf(text) {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const stream = `BT\n/F1 16 Tf\n72 720 Td\n(${escaped}) Tj\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

function createZip(files) {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)]))));
}

function createMinimalDocx(text) {
  return createZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  });
}

function createMinimalXlsx() {
  return createZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Fees" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>Permit Fee</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>500</v></c></row></sheetData></worksheet>',
  });
}

test('private address detection covers local network ranges', async () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('10.4.3.2'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('::ffff:7f00:1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/admin'), /private/i);
});

test('document extraction reads JSON, text, PDF, DOCX, and XLSX data', async () => {
  assert.match(await extractDocumentText(Buffer.from('{"permitFee":1250}'), 'json'), /permitFee/);
  assert.equal(await extractDocumentText(Buffer.from('fee,amount\nreview,500'), 'csv'), 'fee,amount\nreview,500');
  assert.match(await extractDocumentText(createMinimalPdf('Zoning Ordinance 2026'), 'pdf'), /Zoning Ordinance 2026/);
  assert.match(await extractDocumentText(createMinimalDocx('Official setback schedule'), 'docx'), /Official setback schedule/);
  assert.match(await extractDocumentText(createMinimalXlsx(), 'xlsx'), /Permit Fee\s+500/);
});

test('Crawlee extracts a page and follows relevant document links', async (t) => {
  const server = createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('User-agent: *\nAllow: /');
      return;
    }
    if (request.url === '/fees.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('Permit fee schedule. Residential plan review fee is $500. This source is authoritative for the test.');
      return;
    }
    if (request.url === '/zoning-data.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ district: 'R-3', frontSetbackFt: 30, source: 'planning department' }));
      return;
    }
    if (request.url === '/start') {
      response.writeHead(302, { location: '/' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><html><head><title>County Planning</title></head><body><main>
      <h1>County zoning ordinance</h1><p>This planning page contains current dimensional standards and official development requirements for local parcels.</p>
      <a href="/fees.txt">Permit fee schedule</a><a href="/zoning-data.json">Zoning data</a><a href="/sports">Sports</a>
    </main></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const result = await crawlSources({
    urls: [`http://lvh.me:${port}/start`],
    queries: ['county zoning permit fee schedule'],
    maxPages: 4,
    maxDepth: 1,
    allowPrivateHosts: true,
  });

  assert.equal(result.errors.length, 0);
  assert.ok(result.results.some((item) => item.kind === 'html' && /dimensional standards/i.test(item.content)));
  assert.ok(result.results.some((item) => item.kind === 'text' && /\$500/.test(item.content)));
  assert.ok(result.results.some((item) => item.kind === 'json' && /frontSetbackFt/.test(item.content)));
  assert.ok(result.results.some((item) => item.kind === 'html' && item.links.some((url) => url.endsWith('/fees.txt'))));
  assert.equal(result.results.some((item) => item.url.endsWith('/sports')), false);
});

test('cleanText bounds output and removes noisy whitespace', () => {
  assert.equal(cleanText('  zoning   code\n\n\n fee  ', 20), 'zoning code\n\nfee');
});
