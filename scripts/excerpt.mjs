// Cut a small SDN.XML out of a real one: the chosen entries with Record_Count set to match. For
// test fixtures (test/fixture-sdn.xml here, the plugin pack's test-fixtures/mirror), so they are
// OFAC's own records rather than invented ones.
//
// Identity document numbers and street addresses are replaced with REDACTED. The mirror leaves them
// out (sdn.mjs says why), so a fixture has no reason to carry them; keeping the elements lets a test
// show they are dropped.
//
//   node scripts/excerpt.mjs <SDN.XML> <uid>[,<uid>…] > excerpt.xml
import { readFileSync } from 'node:fs';

const [file, list] = process.argv.slice(2);
if (!file || !list) {
    console.error('usage: node scripts/excerpt.mjs <SDN.XML> <uid>[,<uid>…]');
    process.exit(2);
}
const want = new Set(list.split(',').map((s) => s.trim()).filter(Boolean));
const text = readFileSync(file, 'utf8');
const first = text.indexOf('<sdnEntry>');
const close = '</sdnEntry>';
const end = text.lastIndexOf(close) + close.length;
if (first < 0 || end < first) throw new Error('no <sdnEntry> in the file');

function redact(block) {
    return block
        .replace(/<id>[\s\S]*?<\/id>/g, (id) =>
            /<idType>Digital Currency Address - /.test(id) ? id : id.replace(/<idNumber>[^<]*<\/idNumber>/, '<idNumber>REDACTED</idNumber>'),
        )
        .replace(/<(address[123]|postalCode)>[^<]*<\/\1>/g, '<$1>REDACTED</$1>');
}

// The indentation before the first entry, so the excerpt keeps the file's layout.
const indent = text.slice(text.lastIndexOf('\n', first) + 1, first);
const kept = [];
for (let at = first; at < end; ) {
    const stop = text.indexOf(close, at) + close.length;
    const block = text.slice(at, stop);
    const uid = /<uid>(\d+)<\/uid>/.exec(block)?.[1];
    if (uid && want.delete(uid)) kept.push(redact(block));
    at = text.indexOf('<sdnEntry>', stop);
    if (at < 0) break;
}
if (want.size) throw new Error(`not in the file: ${[...want].join(', ')}`);

const head = text.slice(0, text.lastIndexOf('\n', first) + 1).replace(/<Record_Count>\d+<\/Record_Count>/, `<Record_Count>${kept.length}</Record_Count>`);
const tail = text.slice(end);
process.stdout.write(`${head}${kept.map((b) => indent + b).join('\n')}${tail}`);
