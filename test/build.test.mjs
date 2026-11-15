// node --test test/
//
// The fixture is 26 real entries cut from the 2026-11-13 SDN.XML with scripts/excerpt.mjs (document
// numbers and street addresses redacted). They were picked for the cases the network table has to
// get right, each named in the test that checks it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GENERATOR_FILES, ROOT, build, generatorFingerprint, write } from '../scripts/build.mjs';
import { dataPath } from '../scripts/layout.mjs';
import { parseXml } from '../scripts/sdn-xml.mjs';
import { readSdn } from '../scripts/sdn.mjs';
import { placeAddress } from '../scripts/networks.mjs';
import { digestOf, update } from '../scripts/update.mjs';
import { canonicalAddress, identityFold } from '../scripts/crypto-address.ts';

const FIXTURE = readFileSync(new URL('./fixture-sdn.xml', import.meta.url));
const CHECKED = '2026-11-14T23:47:00Z';
const built = build(FIXTURE, { checkedAt: CHECKED, lastModified: '2026-11-13T16:32:59Z', digestVerified: true });
const addresses = JSON.parse(built.files['addresses.json']);
const find = (network, address) => addresses.addresses.find((a) => a.network === network && a.address === address);

const wrap = (body, count = 1) =>
    `<?xml version="1.0" standalone="yes"?>\n<sdnList xmlns="x"><publshInformation><Publish_Date>11/13/2026</Publish_Date><Record_Count>${count}</Record_Count></publshInformation>${body}</sdnList>`;
const entry = (uid, extra = '') => `<sdnEntry><uid>${uid}</uid><lastName>X</lastName><sdnType>Entity</sdnType>${extra}</sdnEntry>`;

test('the reader refuses what SDN.XML does not contain, instead of skipping it', () => {
    const cases = {
        'an attribute off the root': wrap(`<sdnEntry id="1"><uid>1</uid></sdnEntry>`),
        CDATA: wrap(entry(1, '<remarks><![CDATA[x]]></remarks>')),
        'a comment': wrap(`<!-- note -->${entry(1)}`),
        'an unknown entity': wrap(entry(1, '<remarks>a &nbsp; b</remarks>')),
        'a bare ampersand': wrap(entry(1, '<remarks>a & b</remarks>')),
        'a mismatched close': wrap('<sdnEntry><uid>1</uid></sdnentry>'),
        'mixed content': wrap(`<sdnEntry>text<uid>1</uid></sdnEntry>`),
        'a second root': `${wrap(entry(1))}<sdnList></sdnList>`,
        'a truncated file': wrap(entry(1)).slice(0, -20),
    };
    for (const [what, xml] of Object.entries(cases)) {
        assert.throws(() => readSdn(parseXml(xml)), Error, what);
    }
    // And the entities it does use come through.
    const ok = readSdn(parseXml(wrap(entry(1, '<akaList><aka><uid>2</uid><type>a.k.a.</type><category>strong</category><lastName>A &amp; B &lt;C&gt;</lastName></aka></akaList>'))));
    assert.equal(ok.entries[0].aliases[0][0], 'A & B <C>');
});

test('a list that is not whole is refused: Record_Count, duplicate uids, missing fields', () => {
    assert.throws(() => readSdn(parseXml(wrap(entry(1) + entry(2), 3))), /states 3 entries and holds 2/);
    assert.throws(() => readSdn(parseXml(wrap(entry(1) + entry(1), 2))), /uid 1 appears twice/);
    assert.throws(() => readSdn(parseXml(wrap('<sdnEntry><uid>1</uid><sdnType>Entity</sdnType></sdnEntry>'))), /no name/);
    assert.throws(() => readSdn(parseXml(wrap('<sdnEntry><uid>1</uid><lastName>X</lastName><sdnType>Ship</sdnType></sdnEntry>'))), /sdnType/);
    assert.throws(() => readSdn(parseXml(wrap(entry(1)).replace('11/13/2026', '2026-11-13'))), /MM\/DD\/YYYY/);
});

test('the fixture reads whole: 26 entries, the publish date, and the index describes every file', () => {
    const { index } = built;
    assert.equal(index.source.publish_date, '2026-11-13');
    assert.equal(index.source.record_count, 26);
    assert.equal(index.counts.entries, 26);
    assert.equal(index.checked_at, CHECKED);
    assert.equal(index.source.digest_verified, true);
    assert.deepEqual(Object.keys(index.files), ['addresses.json', 'names/aircraft.json', 'names/entity.json', 'names/individual.json', 'names/vessel.json']);
    for (const [path, meta] of Object.entries(index.files)) {
        assert.equal(meta.sha256, createHash('sha256').update(built.files[path]).digest('hex'), path);
        assert.equal(meta.bytes, Buffer.byteLength(built.files[path]), path);
        JSON.parse(built.files[path]);
    }
    assert.equal(index.source.sha256, createHash('sha256').update(FIXTURE).digest('hex'));
});

test('uid 45404: an XBT value that is a TRON address goes to tron, and the listing says the format decided', () => {
    const rec = find('tron', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq');
    assert.ok(rec);
    assert.deepEqual(rec.listings, [{ uid: 45404, code: 'XBT', network_from: 'format', note: 'listed as XBT, but the value is not a bitcoin address' }]);
    assert.equal(find('bitcoin', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq'), undefined);
    // The same entry's USDT 0x value names no chain.
    assert.ok(find('evm', '0xfac583c0cf07ea434052c49115a4682172ab6b4f'));
});

test('uid 42498: one 0x value under ETH, BSC and ARB is three addresses, one per network', () => {
    const v = '0x4f47bc496083c727c5fbe3ce9cdf2b0f6496270c';
    for (const [network, code] of [['ethereum', 'ETH'], ['bsc', 'BSC'], ['arbitrum', 'ARB']]) {
        assert.deepEqual(find(network, v)?.listings, [{ uid: 42498, code }], network);
    }
});

test('uid 30518: a legacy BCH address is written as CashAddr, with the value as listed beside it', () => {
    const rec = find('bitcoin_cash', 'qpgf0ztxq3mwfq6eg5versgfdzq9c3pwv5jsk6wnay');
    assert.deepEqual(rec?.listings, [{ uid: 30518, code: 'BCH', listed: '18M8bJWMzWHDBMxoLqjHHAffdRy4SrzkfB' }]);
});

test('uid 33151: USDT in Base58Check is Bitcoin (Omni), and meets the XBT listing of the same value', () => {
    const rec = find('bitcoin', '1CF46Rfbp97absrs7zb7dFfZS6qBXUm9EP');
    assert.deepEqual(rec?.listings, [
        { uid: 33151, code: 'USDT', network_from: 'format' },
        { uid: 33151, code: 'XBT' },
    ]);
});

test('uid 45314: EIP-55 values are written in lower case, USDT and USDC on one value are two listings', () => {
    const rec = find('evm', '0x983a81ca6fb1e441266d2fbcb7d8e530ac2e05a2');
    assert.deepEqual(
        rec?.listings.map((l) => [l.code, l.listed]),
        [
            ['USDC', '0x983a81ca6FB1e441266D2FbcB7D8E530AC2E05A2'],
            ['USDT', '0x983a81ca6FB1e441266D2FbcB7D8E530AC2E05A2'],
        ],
    );
});

test('one address listed by two entries is one record with both; the same value twice in one entry is one listing', () => {
    assert.deepEqual(find('litecoin', 'LeKvNdNEzgQkzVVnRdV3fAu2DSF1nLsNw6')?.listings, [
        { uid: 30518, code: 'LTC' },
        { uid: 30520, code: 'LTC' },
    ]);
    assert.deepEqual(find('ethereum', '0x761edd5e4546229a0bd35ae99b4d3d01cf4a3510')?.listings.map((l) => l.uid), [58886, 58889]);
    assert.deepEqual(find('bitcoin', '3F6bbvS1krsc1qR8FsbTDfYQyvkMm3QvmR')?.listings, [{ uid: 37070, code: 'XBT' }]);
    const xml = FIXTURE.toString('utf8');
    assert.equal(xml.split('3F6bbvS1krsc1qR8FsbTDfYQyvkMm3QvmR').length - 1, 2, 'the fixture does list it twice in uid 37070');
});

test('uid 29585: an XMR value that is not a Monero address is kept as listed, and index.json notes it', () => {
    const v = '5be5543ff73456ab9f2d207887e2af87322c651ea1a873c5b25b7ffae456c320';
    assert.equal(find('monero', v)?.listings[0].note, 'the value does not read as a monero address; kept as listed');
    assert.ok(built.index.notes.some((n) => n.startsWith('uid 29585 XMR')));
    assert.ok(built.index.notes.some((n) => n.startsWith('uid 45404 XBT')));
    assert.equal(built.index.notes.length, 2, 'token routes are not notes');
});

test('the BNB listing is a Beacon Chain address; a 0x value under BNB would be BSC', () => {
    assert.ok(find('bnb_beacon', 'bnb136ns6lfw4zs5hg4n85vdthaad7hq5m4gtkgf23'));
    assert.deepEqual(placeAddress('BNB', '0x4F47BC496083c727c5fbe3ce9cdf2b0f6496270c'), {
        network: 'bsc',
        address: '0x4f47bc496083c727c5fbe3ce9cdf2b0f6496270c',
        network_from: 'format',
        listed: '0x4F47BC496083c727c5fbe3ce9cdf2b0f6496270c',
        note: 'BNB with a 0x value is BNB Smart Chain',
    });
});

test('a code the table does not know is placed by format and reported, never dropped', () => {
    assert.deepEqual(placeAddress('MATIC', '0x4f47bc496083c727c5fbe3ce9cdf2b0f6496270c'), {
        network: 'evm',
        address: '0x4f47bc496083c727c5fbe3ce9cdf2b0f6496270c',
        network_from: 'format',
        note: "OFAC code MATIC is not in this mirror's table",
    });
    assert.equal(placeAddress('NEWCOIN', 'abc').network, 'unknown');
    const xml = wrap(entry(1, '<idList><id><uid>9</uid><idType>Digital Currency Address - MATIC</idType><idNumber>0x4f47bc496083c727c5fbe3ce9cdf2b0f6496270c</idNumber></id></idList>'));
    const b = build(Buffer.from(xml), { checkedAt: CHECKED });
    assert.deepEqual(b.index.unmapped_codes, ['MATIC']);
    assert.equal(JSON.parse(b.files['addresses.json']).addresses.length, 1);
});

test('every address is in the canonical form the type pack identifies it by', () => {
    const files = [built.files['addresses.json']];
    // The committed mirror too, when this runs in a checkout that has one.
    if (existsSync(join(ROOT, 'addresses.json'))) files.push(readFileSync(join(ROOT, 'addresses.json'), 'utf8'));
    for (const text of files) {
        for (const a of JSON.parse(text).addresses) {
            assert.equal(identityFold(a.address), a.address, `${a.network} ${a.address} folds to itself`);
            const c = canonicalAddress(a.network, a.address);
            if (c !== null && !a.listings.some((l) => l.note)) assert.equal(c, a.address, `${a.network} ${a.address} is canonical`);
        }
    }
});

test('names: one shard per SDN type, one entry per line, sorted by uid; weak aliases marked', () => {
    const ind = built.files['names/individual.json'].split('\n');
    assert.match(ind[0], /^\{"format":1,"list":"OFAC SDN","as_of":"2026-11-13","type":"Individual","fields":\["uid","name","aliases",/);
    const rows = JSON.parse(built.files['names/individual.json']).entries;
    assert.deepEqual(rows.map((r) => r[0]), [...rows.map((r) => r[0])].sort((a, b) => a - b));
    assert.equal(ind.length, rows.length + 3, 'a header line, one line per entry, the closing line and the final newline');
    const kim = rows.filter((r) => r[1] === 'KIM, Yong Chol');
    assert.deepEqual(kim.map((r) => r[0]), [12211, 17614], 'two people with one name stay two entries');
    const lazarus = JSON.parse(built.files['names/entity.json']).entries.find((r) => r[0] === 27307);
    assert.ok(lazarus[2].every(([, c]) => c === 'weak'));
    assert.equal(JSON.parse(built.files['names/vessel.json']).entries[0][1], 'MAR AZUL');
    assert.equal(JSON.parse(built.files['names/aircraft.json']).entries[0][1], 'EP-GOL');
});

test('document numbers and street addresses are not published', () => {
    assert.ok(FIXTURE.toString('utf8').includes('<idType>National ID No.</idType>'), 'the input has them');
    for (const [path, text] of Object.entries(built.files)) {
        assert.ok(!text.includes('REDACTED'), path);
        assert.ok(!text.includes('National ID'), path);
    }
});

test('the build is deterministic, and write() leaves an unchanged index alone until it is due', () => {
    const again = build(FIXTURE, { checkedAt: CHECKED, lastModified: '2026-11-13T16:32:59Z', digestVerified: true });
    assert.deepEqual(again.files, built.files);
    const dir = mkdtempSync(join(tmpdir(), 'sanctions-mirror-'));
    const t0 = new Date('2026-11-15T00:00:00Z');
    assert.ok(write(built, dir, t0).changed.includes('index.json'));
    const later = build(FIXTURE, { checkedAt: '2026-11-15T06:00:00Z', lastModified: '2026-11-13T16:32:59Z', digestVerified: true });
    assert.deepEqual(write(later, dir, new Date('2026-11-15T06:00:00Z')).changed, [], 'six hours on, nothing to commit');
    const nextDay = build(FIXTURE, { checkedAt: '2026-11-15T20:00:00Z', lastModified: '2026-11-13T16:32:59Z', digestVerified: true });
    assert.deepEqual(write(nextDay, dir, new Date('2026-11-15T20:00:00Z')).changed, ['index.json'], 'twenty hours on, checked_at moves');
    assert.equal(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).checked_at, '2026-11-15T20:00:00Z');
});

test("OFAC's Digest header is read in the form it is sent", () => {
    assert.equal(digestOf('sha-25655badef6928044db9fd5e798e6279802c1fa2019fa82a580a2e0d29a741ec9ae'), '55badef6928044db9fd5e798e6279802c1fa2019fa82a580a2e0d29a741ec9ae');
    assert.equal(digestOf('SHA-256=55badef6928044db9fd5e798e6279802c1fa2019fa82a580a2e0d29a741ec9ae'), '55badef6928044db9fd5e798e6279802c1fa2019fa82a580a2e0d29a741ec9ae');
    assert.equal(digestOf(`sha-256=${Buffer.from('55badef6928044db9fd5e798e6279802c1fa2019fa82a580a2e0d29a741ec9ae', 'hex').toString('base64')}`), '55badef6928044db9fd5e798e6279802c1fa2019fa82a580a2e0d29a741ec9ae');
    assert.equal(digestOf('md5=abc'), null);
    assert.equal(digestOf(null), null);
});

// ---- what readers fetch, and when the mirror rebuilds ------------------------------------------------

const sha = (b) => createHash('sha256').update(b).digest('hex');
const dated = (us) => Buffer.from(FIXTURE.toString('utf8').replace('<Publish_Date>11/13/2026</Publish_Date>', `<Publish_Date>${us}</Publish_Date>`));
const dataFiles = (dir) => (existsSync(join(dir, 'data')) ? readdirSync(join(dir, 'data')).map((f) => `data/${f}`).sort() : []);
const pathsOf = (index) => Object.values(index.files).map((m) => dataPath(m.sha256)).sort();

test('every file is also at its content path, and the previous build stays readable until the next one', () => {
    // raw.githubusercontent.com leaves the query string out of its cache key, so an index cached from
    // one build and a file cached from the next cannot be told apart by `?v=`: only a path can.
    const dir = mkdtempSync(join(tmpdir(), 'sanctions-mirror-'));
    const opts = { checkedAt: CHECKED, lastModified: null, digestVerified: true };
    const a = build(dated('11/12/2026'), opts);
    const b = build(dated('11/13/2026'), opts);
    const c = build(dated('11/14/2026'), opts);

    write(a, dir);
    for (const [path, meta] of Object.entries(a.index.files)) {
        const text = readFileSync(join(dir, dataPath(meta.sha256)), 'utf8');
        assert.equal(text, a.files[path], path);
        assert.equal(sha(text), meta.sha256);
    }
    assert.deepEqual(dataFiles(dir), pathsOf(a.index));

    const wb = write(b, dir);
    assert.deepEqual(dataFiles(dir), [...pathsOf(a.index), ...pathsOf(b.index)].sort(), 'an index cached before b still finds its files');
    assert.deepEqual(wb.removed, []);

    const wc = write(c, dir);
    assert.deepEqual(dataFiles(dir), [...pathsOf(b.index), ...pathsOf(c.index)].sort(), 'a is gone once c is out');
    assert.deepEqual(wc.removed.sort(), pathsOf(a.index));

    // A write that changes no data removes nothing, however often it runs.
    const again = write(build(dated('11/14/2026'), { ...opts, checkedAt: '2026-11-16T00:00:00Z' }), dir, new Date('2026-11-16T00:00:00Z'));
    assert.deepEqual(again.removed, []);
    assert.deepEqual(dataFiles(dir), [...pathsOf(b.index), ...pathsOf(c.index)].sort());
});

test('index.json names the generator, and a change to any generator file changes it', () => {
    assert.equal(built.index.generator, generatorFingerprint());
    assert.match(built.index.generator, /^[0-9a-f]{64}$/);
    const copy = mkdtempSync(join(tmpdir(), 'sanctions-mirror-gen-'));
    mkdirSync(join(copy, 'scripts'));
    for (const f of GENERATOR_FILES) cpSync(join(ROOT, f), join(copy, f));
    assert.equal(generatorFingerprint(copy), generatorFingerprint());
    for (const f of GENERATOR_FILES) {
        const before = readFileSync(join(copy, f));
        writeFileSync(join(copy, f), Buffer.concat([before, Buffer.from('\n// changed\n')]));
        assert.notEqual(generatorFingerprint(copy), generatorFingerprint(), f);
        writeFileSync(join(copy, f), before);
    }
});

/** OFAC as update.mjs sees it: HEAD with `digest` (or none), GET with `body`. */
function ofac({ digest = `sha-256${sha(FIXTURE)}`, body = FIXTURE } = {}) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push(init.method);
        if (init.method === 'HEAD') {
            const headers = { 'last-modified': 'Fri, 13 Nov 2026 16:32:59 GMT' };
            if (digest) headers.digest = digest;
            return new Response(null, { status: 200, headers });
        }
        return new Response(body, { status: 200 });
    };
    return { calls, fetchImpl };
}
const quiet = { log() {}, warn() {} };
const at = (iso) => () => new Date(iso);

test('update: no readable Digest, or a download that does not hash to it, writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanctions-mirror-up-'));
    const none = ofac({ digest: null });
    await assert.rejects(update({ root: dir, fetchImpl: none.fetchImpl, now: at('2026-11-15T00:00:00Z'), log: quiet }), /no readable Digest header/);
    assert.deepEqual(none.calls, ['HEAD'], 'nothing is downloaded');
    const wrong = ofac({ digest: `sha-256${'0'.repeat(64)}` });
    await assert.rejects(update({ root: dir, fetchImpl: wrong.fetchImpl, now: at('2026-11-15T00:00:00Z'), log: quiet }), /OFAC's Digest header says 0{64}: not publishing it/);
    assert.ok(!existsSync(join(dir, 'index.json')));
    assert.deepEqual(dataFiles(dir), []);
});

test('update: an unchanged list is skipped only when the generator is unchanged too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanctions-mirror-up-'));
    const first = ofac();
    const r1 = await update({ root: dir, fetchImpl: first.fetchImpl, now: at('2026-11-15T00:00:00Z'), log: quiet });
    assert.equal(r1.action, 'rebuilt');
    const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    assert.equal(idx.source.digest_verified, true);
    assert.equal(idx.generator, generatorFingerprint());
    assert.deepEqual(dataFiles(dir), pathsOf(idx));

    const same = ofac();
    const r2 = await update({ root: dir, fetchImpl: same.fetchImpl, now: at('2026-11-15T06:00:00Z'), log: quiet });
    assert.equal(r2.action, 'unchanged');
    assert.deepEqual(same.calls, ['HEAD'], 'same list, same code: no download');

    // The data was built by other code: the same list is downloaded and rebuilt.
    writeFileSync(join(dir, 'index.json'), `${JSON.stringify({ ...idx, generator: 'f'.repeat(64) }, null, 2)}\n`);
    const changed = ofac();
    const r3 = await update({ root: dir, fetchImpl: changed.fetchImpl, now: at('2026-11-15T07:00:00Z'), log: quiet });
    assert.deepEqual(changed.calls, ['HEAD', 'GET']);
    assert.equal(r3.action, 'rebuilt');
    assert.match(r3.message, /Rebuilt because the generator changed: ffffffffffff → /);
    assert.equal(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).generator, generatorFingerprint());
    assert.match(readFileSync(join(dir, '.cache', 'commit-message'), 'utf8'), /Rebuilt because the generator changed/);
});
