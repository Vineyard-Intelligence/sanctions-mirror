// Build the mirror from an SDN.XML on disk.
//
//   node scripts/build.mjs <SDN.XML> [--checked-at <ISO time>] [--last-modified <HTTP date>]
//                                    [--digest-verified] [--out <dir>]
//
// scripts/update.mjs downloads the file and calls this; run it by hand to build from a copy you
// already have. `--checked-at` defaults to now, which is right only when the file was just fetched.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXml } from './sdn-xml.mjs';
import { readSdn } from './sdn.mjs';
import { DATA_DIR, dataPath, indexText, layout } from './layout.mjs';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The scripts whose code decides what a build writes. Their combined hash is index.json's
 * `generator`: without it, a fix to the network table would sit unpublished until OFAC next changed
 * the list (scripts/update.mjs skips an unchanged list), and in the meantime scripts/verify.mjs at
 * HEAD would report the committed data as differing, with nothing to tell a stale build from a
 * tampered one.
 */
export const GENERATOR_FILES = [
    'scripts/build.mjs',
    'scripts/crypto-address.ts',
    'scripts/layout.mjs',
    'scripts/networks.mjs',
    'scripts/sdn-xml.mjs',
    'scripts/sdn.mjs',
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** SHA-256 over each generator file's path and SHA-256, one line each, in GENERATOR_FILES order. */
export function generatorFingerprint(root = ROOT) {
    return sha256(GENERATOR_FILES.map((f) => `${f} ${sha256(readFileSync(join(root, f)))}\n`).join(''));
}

/** How long an unchanged list goes before index.json is rewritten just to move `checked_at`. A
 *  scheduled run every six hours then commits about once a day when nothing was designated, which
 *  keeps the repository active (GitHub stops the schedule of a repository idle for 60 days) without
 *  a commit per run. The plugin pack warns when `checked_at` is three days old. */
export const REFRESH_AFTER_HOURS = 20;

/** Parse and lay out one SDN.XML. `bytes` is the file as downloaded. */
export function build(bytes, { checkedAt, lastModified = null, digestVerified = false, generator = generatorFingerprint() }) {
    const text = Buffer.from(bytes).toString('utf8');
    const list = readSdn(parseXml(text));
    return layout(list, { sha256: sha256(bytes), last_modified: lastModified, digest_verified: digestVerified }, checkedAt, generator);
}

const withoutCheckedAt = (index) => JSON.stringify({ ...index, checked_at: null });

/**
 * Write a build into `out`. Each data file is written at its name and at its content path
 * (layout.mjs), and only when its bytes change. index.json is rewritten when anything but
 * `checked_at` changed, or when the stored `checked_at` is older than REFRESH_AFTER_HOURS.
 *
 * Content paths that neither this build's index nor the previous one names are removed, and only
 * when this build wrote a new one. So the previous build stays readable for as long as an index
 * cached before this one can be served (about five minutes; builds come at least six hours apart),
 * and a run that changes nothing removes nothing. Returns what was written and removed.
 */
export function write(built, out = ROOT, now = new Date()) {
    const changed = [];
    const put = (path, text) => {
        const target = join(out, path);
        if (existsSync(target) && readFileSync(target, 'utf8') === text) return;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
        changed.push(path);
    };
    for (const [path, text] of Object.entries(built.files)) put(path, text);
    for (const [path, meta] of Object.entries(built.index.files)) put(dataPath(meta.sha256), built.files[path]);

    const indexPath = join(out, 'index.json');
    let previous = null;
    try {
        previous = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch {
        previous = null;
    }

    const removed = [];
    if (changed.some((p) => p.startsWith(`${DATA_DIR}/`))) {
        const keep = new Set([built.index, previous].flatMap((idx) => Object.values(idx?.files ?? {}).map((m) => dataPath(m.sha256))));
        for (const name of readdirSync(join(out, DATA_DIR))) {
            const path = `${DATA_DIR}/${name}`;
            if (keep.has(path)) continue;
            unlinkSync(join(out, path));
            removed.push(path);
        }
    }

    const same = previous && withoutCheckedAt(previous) === withoutCheckedAt(built.index);
    const age = previous?.checked_at ? (now.getTime() - Date.parse(previous.checked_at)) / 3_600_000 : Infinity;
    if (!same || !(age < REFRESH_AFTER_HOURS)) {
        writeFileSync(indexPath, indexText(built.index));
        changed.push('index.json');
    }
    return { changed, removed, previous };
}

function args(argv) {
    const out = { file: null, checkedAt: null, lastModified: null, digestVerified: false, out: ROOT };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--checked-at') out.checkedAt = argv[++i];
        else if (a === '--last-modified') out.lastModified = argv[++i];
        else if (a === '--digest-verified') out.digestVerified = true;
        else if (a === '--out') out.out = resolve(argv[++i]);
        else if (!out.file) out.file = a;
        else throw new Error(`unexpected argument ${a}`);
    }
    if (!out.file) throw new Error('usage: node scripts/build.mjs <SDN.XML> [--checked-at ISO] [--last-modified DATE] [--digest-verified] [--out DIR]');
    return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const a = args(process.argv.slice(2));
    const checkedAt = a.checkedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    if (!a.checkedAt) console.warn(`no --checked-at: recording ${checkedAt}, as if the file were fetched now`);
    const built = build(readFileSync(a.file), { checkedAt, lastModified: a.lastModified, digestVerified: a.digestVerified });
    const { changed, removed } = write(built, a.out);
    const c = built.index.counts;
    console.log(
        `OFAC SDN ${built.index.source.publish_date}: ${c.entries} entries, ${c.addresses} addresses (${c.listings} listings, ${c.parties_with_addresses} parties)` +
            (changed.length ? ` — wrote ${changed.join(', ')}` : ' — nothing changed') +
            (removed.length ? `; removed ${removed.join(', ')}` : ''),
    );
    if (built.index.unmapped_codes.length) console.warn(`codes not in the network table: ${built.index.unmapped_codes.join(', ')}`);
}
