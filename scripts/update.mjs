// Fetch OFAC's SDN.XML and rebuild the mirror when it changed. What the scheduled workflow runs.
//
//   node scripts/update.mjs
//
// WHY A MIRROR AT ALL: the file cannot be read from a browser. Measured 2026-11-14 with an Origin
// header: the API answers GET with a 302 that carries `Access-Control-Allow-Origin: *`, to an
// S3 pre-signed URL (one hour) that carries none, so a page's fetch fails at the second hop. A
// plugin runs in the analyst's browser or the desktop app's renderer, so it reads this copy.
//
// THE DOWNLOAD MUST MATCH OFAC'S OWN DIGEST. A HEAD request (no redirect) answers 200 with
// `Digest: sha-256<hex>` and `Last-Modified`; the 302 on GET carries neither. The digest is read
// first, and the downloaded bytes must hash to it. No readable digest, or a mismatch, stops the run
// before anything is written: the mirror keeps the last list it could verify, and the workflow opens
// an issue, rather than publish a list it could not check. So `digest_verified` is true in every
// index this writes; only a hand build (build.mjs without --digest-verified) records false.
//
// AN UNCHANGED LIST SKIPS THE 29 MB DOWNLOAD only when the generator is unchanged too: index.json
// records the fingerprint of the code that built it (build.mjs), and a different one means the
// committed data is not what this code makes of the same file, so it is rebuilt.
//
// Writes .cache/SDN.XML (kept for scripts/verify.mjs, never committed) and .cache/commit-message.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, REFRESH_AFTER_HOURS, build, generatorFingerprint, write } from './build.mjs';
import { SOURCE_URL, indexText } from './layout.mjs';

const UA = 'sanctions-mirror (+https://github.com/Vineyard-Intelligence/sanctions-mirror)';

const isoOf = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** `Digest: sha-25655bade…` (OFAC's form, measured), `sha-256=<hex>` or `sha-256=<base64>`. */
export function digestOf(header) {
    if (!header) return null;
    for (const part of header.split(',')) {
        const m = /^\s*sha-256=?(.+?)\s*$/i.exec(part);
        if (!m) continue;
        const v = m[1];
        if (/^[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();
        try {
            const hex = Buffer.from(v, 'base64').toString('hex');
            if (hex.length === 64) return hex;
        } catch {
            /* not base64 either */
        }
    }
    return null;
}

async function request(fetchImpl, method, attempt = 0) {
    try {
        const res = await fetchImpl(SOURCE_URL, {
            method,
            redirect: method === 'HEAD' ? 'manual' : 'follow',
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(180_000),
        });
        if (res.status >= 500 && attempt < 3) throw new Error(`HTTP ${res.status}`);
        return res;
    } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 15_000 * 2 ** attempt));
        return request(fetchImpl, method, attempt + 1);
    }
}

/** What changed between two addresses.json / names texts, for the commit message. */
function lineDiff(before, after) {
    const a = new Set((before ?? '').split('\n'));
    const b = new Set(after.split('\n'));
    let added = 0;
    let removed = 0;
    for (const l of b) if (l.startsWith('{"network"') && !a.has(l)) added++;
    for (const l of a) if (l.startsWith('{"network"') && !b.has(l)) removed++;
    return { added, removed };
}

/**
 * One update of the mirror in `root`. `fetchImpl` and `now` are the network and the clock, so the
 * tests can stand in for OFAC. Returns { action: 'unchanged' | 'checked' | 'rebuilt', message }, and
 * throws, having written nothing, when the download cannot be verified.
 */
export async function update({ root = ROOT, fetchImpl = globalThis.fetch, now = () => new Date(), log = console } = {}) {
    const cache = join(root, '.cache');
    const read = (path) => {
        try {
            return readFileSync(join(root, path), 'utf8');
        } catch {
            return null;
        }
    };
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'commit-message'), '');
    const previous = (() => {
        try {
            return JSON.parse(read('index.json'));
        } catch {
            return null;
        }
    })();
    const generator = generatorFingerprint();

    const head = await request(fetchImpl, 'HEAD');
    const digest = head.ok ? digestOf(head.headers.get('digest')) : null;
    if (!digest) {
        throw new Error(`HEAD ${SOURCE_URL} → HTTP ${head.status} with no readable Digest header, so a download could not be checked against OFAC's: not updating`);
    }
    const lastModifiedHeader = head.headers.get('last-modified');

    const sameList = previous?.source?.sha256 === digest;
    const sameGenerator = previous?.generator === generator;
    if (sameList && sameGenerator) {
        const age = (now().getTime() - Date.parse(previous.checked_at)) / 3_600_000;
        if (age < REFRESH_AFTER_HOURS) {
            const message = `OFAC SDN ${previous.source.publish_date}: unchanged, last recorded check ${previous.checked_at}`;
            log.log(message);
            return { action: 'unchanged', message };
        }
        const next = { ...previous, checked_at: isoOf(now()) };
        writeFileSync(join(root, 'index.json'), indexText(next));
        const message = `OFAC SDN ${previous.source.publish_date}: unchanged, checked ${next.checked_at}`;
        writeFileSync(join(cache, 'commit-message'), `${message}\n`);
        log.log(message);
        return { action: 'checked', message };
    }

    const res = await request(fetchImpl, 'GET');
    if (!res.ok) throw new Error(`GET ${SOURCE_URL} → HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== digest) {
        throw new Error(`the download hashes to ${sha}, OFAC's Digest header says ${digest}: not publishing it`);
    }
    writeFileSync(join(cache, 'SDN.XML'), bytes);

    const lastModified = lastModifiedHeader ? isoOf(new Date(lastModifiedHeader)) : null;
    const before = read('addresses.json');
    const built = build(bytes, { checkedAt: isoOf(now()), lastModified, digestVerified: true, generator });
    const { changed, removed } = write(built, root, now());

    const { added, removed: dropped } = lineDiff(before, built.files['addresses.json']);
    const c = built.index.counts;
    const was = previous?.counts?.entries;
    const message = [
        `OFAC SDN ${built.index.source.publish_date}: ${c.entries} entries${was != null ? ` (${c.entries - was >= 0 ? '+' : ''}${c.entries - was})` : ''}, ${c.addresses} addresses (+${added} −${dropped} lines)`,
        '',
        `Source sha256 ${sha}, matching OFAC's Digest header.`,
        ...(sameList ? [`Rebuilt because the generator changed: ${String(previous?.generator ?? 'none').slice(0, 12)} → ${generator.slice(0, 12)}.`] : []),
        changed.length ? `Changed: ${changed.join(', ')}.` : 'No file changed.',
        ...(removed.length ? [`Removed: ${removed.join(', ')}.`] : []),
        ...(built.index.unmapped_codes.length ? ['', `Codes not in the network table: ${built.index.unmapped_codes.join(', ')}.`] : []),
    ].join('\n');
    writeFileSync(join(cache, 'commit-message'), `${message}\n`);
    log.log(message);
    return { action: 'rebuilt', message };
}

if (process.argv[1] && process.argv[1].endsWith('update.mjs')) {
    update().catch((e) => {
        console.error(e?.stack ?? String(e));
        process.exit(1);
    });
}
