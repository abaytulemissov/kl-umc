// Renders templates to PDF in Node for checking:  node tools/test-render.js <outDir> [id...]
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const F = (n) => path.join(ROOT, 'app/fonts', n);
const fonts = { Arimo: { normal: F('Arimo-Regular.ttf'), bold: F('Arimo-Bold.ttf'), italics: F('Arimo-Italic.ttf'), bolditalics: F('Arimo-BoldItalic.ttf') } };
const PdfPrinter = require('pdfmake/src/printer');
require(path.join(ROOT, 'app/js/render.js'));
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const ids = process.argv.slice(3).length ? process.argv.slice(3) : require(path.join(ROOT, 'app/templates/index.json')).map(t => t.id);
const values = { fio: 'Иванов Иван Иванович', dob: '1975-03-12', date: '2026-11-25', opdate: '2026-12-03', f3: 'II', f4: 'IIIa' };
for (const id of ids) {
  const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/templates', id + '.json'), 'utf8'));
  const images = {};
  const walk = (o) => { if (o && typeof o === 'object') { if (o.src && /^img\//.test(o.src)) images[o.src] = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'app', o.src)).toString('base64'); Object.values(o).forEach(walk); } };
  walk(tpl);
  const stampFile = process.env.STAMP;
  const dd = Render.build(tpl, values, { images, stamp: stampFile ? 'data:image/png;base64,' + fs.readFileSync(stampFile).toString('base64') : null });
  const doc = new PdfPrinter(fonts).createPdfKitDocument(dd);
  doc.pipe(fs.createWriteStream(path.join(out, id + '.pdf'))); doc.end();
}
console.log('rendered', ids.length);
