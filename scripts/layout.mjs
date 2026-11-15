// The list → the files the mirror publishes. Pure: what readSdn returned in, file texts out.
//
//   index.json             what was read, from where, by which generator, when the mirror last
//                          checked, and the SHA-256 of every file below
//   addresses.json         every listed digital currency address, one per line, with the listing
//                          parties in full
//   names/individual.json  every entry's names, one entry per line: the shards a name screening
//   names/entity.json      reads. Split by SDN type because a person is screened against people and
//   names/vessel.json      an organisation against entities, and a whole shard is fetched so the
//   names/aircraft.json    host learns which kind was screened, not which name.
//   data/<sha256>.json     each file above again, at a path named by its SHA-256: what a reader
//                          fetches (below)
//
// ONE RECORD PER LINE, sorted by network and address or by uid, so `git log -p` on this repository
// reads as the list's history: a designation is an added line, a delisting a removed one.
//
// WHY THE CONTENT PATHS: raw.githubusercontent.com caches each path for five minutes and leaves the
// query string out of its cache key (measured 2026-11-15: three different random queries on one
// path were one cache object, its age counting up), so `?v=<hash>` cannot pick a build. Right after
// an update an edge can hold index.json from one build and addresses.json from the next. A path that
// changes with the content cannot: whichever index a reader gets, the files it names are that
// build's. The copies cost nothing in git, which stores identical content once.
//
// Everything but index.json's `checked_at` is a function of SDN.XML and the generator's code
// (`generator`, build.mjs), so a build can be checked byte for byte against the file it names
// (scripts/verify.mjs).
import { createHash } from 'node:crypto';
import { placeAddress } from './networks.mjs';

export const FORMAT = 1;
export const LIST = 'OFAC SDN';
export const SOURCE_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';
export const NAME_SHARDS = { Individual: 'names/individual.json', Entity: 'names/entity.json', Vessel: 'names/vessel.json', Aircraft: 'names/aircraft.json' };
export const NAME_FIELDS = ['uid', 'name', 'aliases', 'programs', 'dates_of_birth', 'places_of_birth', 'nationalities', 'citizenships'];
export const DATA_DIR = 'data';

/** Where a file with this SHA-256 is published for readers. */
export const dataPath = (sha) => `${DATA_DIR}/${sha}.json`;

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * A JSON object whose listed keys are written one element per line: `head`'s keys first, then each
 * of `parts` — [key, array] or [key, object] — with one array element or one object entry a line.
 */
function document(head, parts) {
    const out = [JSON.stringify(head).slice(0, -1)];
    for (const [key, value] of parts) {
        const rows = Array.isArray(value)
            ? value.map((r) => JSON.stringify(r))
            : Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
        const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
        out.push(`,${JSON.stringify(key)}:${open}${rows.length ? `\n${rows.join(',\n')}\n` : ''}${close}`);
    }
    return `${out.join('')}}\n`;
}

const party = (e) => ({
    type: e.type,
    name: e.name,
    aliases: e.aliases,
    programs: e.programs,
    dates_of_birth: e.dates_of_birth,
    places_of_birth: e.places_of_birth,
    nationalities: e.nationalities,
    citizenships: e.citizenships,
});

/**
 * Build every file. `source` is { sha256, last_modified, digest_verified } from the download;
 * `checkedAt` an ISO time; `generator` the fingerprint of the code that built it (build.mjs).
 * Returns { files: { path: text }, index }; the content paths are the index's to name, not files.
 */
export function layout({ publishDate, recordCount, entries }, source, checkedAt, generator) {
    const head = { format: FORMAT, list: LIST, as_of: publishDate };

    // ---- addresses ----
    const byKey = new Map();
    const parties = {};
    const unmappedCodes = new Set();
    const notes = [];
    for (const e of entries) {
        for (const { code, value } of e.addresses) {
            const placed = placeAddress(code, value);
            if (placed.note && /not in this mirror's table/.test(placed.note)) unmappedCodes.add(code);
            const key = `${placed.network}\0${placed.address}`;
            let rec = byKey.get(key);
            if (!rec) {
                rec = { network: placed.network, address: placed.address, listings: [] };
                byKey.set(key, rec);
            }
            const listing = { uid: e.uid, code };
            if (placed.network_from !== 'code') listing.network_from = placed.network_from;
            if (placed.listed) listing.listed = placed.listed;
            if (placed.note) listing.note = placed.note;
            // The same value under the same code twice in one entry is one listing.
            if (!rec.listings.some((l) => l.uid === e.uid && l.code === code)) rec.listings.push(listing);
            parties[e.uid] = party(e);
            if (placed.note) notes.push(`uid ${e.uid} ${code} ${value}: ${placed.note}`);
        }
    }
    const addresses = [...byKey.values()].sort((a, b) =>
        a.network === b.network ? (a.address < b.address ? -1 : a.address > b.address ? 1 : 0) : a.network < b.network ? -1 : 1,
    );
    for (const a of addresses) a.listings.sort((x, y) => x.uid - y.uid || (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));
    const sortedParties = Object.fromEntries(
        Object.keys(parties)
            .map(Number)
            .sort((a, b) => a - b)
            .map((uid) => [String(uid), parties[uid]]),
    );

    const files = {};
    files['addresses.json'] = document(head, [
        ['addresses', addresses],
        ['parties', sortedParties],
    ]);

    // ---- names ----
    const names = {};
    for (const [type, path] of Object.entries(NAME_SHARDS)) {
        const rows = entries
            .filter((e) => e.type === type)
            .map((e) => [e.uid, e.name, e.aliases, e.programs, e.dates_of_birth, e.places_of_birth, e.nationalities, e.citizenships]);
        files[path] = document({ ...head, type, fields: NAME_FIELDS }, [['entries', rows]]);
        names[type] = rows.length;
    }

    const perNetwork = {};
    for (const a of addresses) perNetwork[a.network] = (perNetwork[a.network] ?? 0) + 1;
    const index = {
        format: FORMAT,
        list: LIST,
        source: {
            url: SOURCE_URL,
            publish_date: publishDate,
            record_count: recordCount,
            sha256: source.sha256,
            last_modified: source.last_modified ?? null,
            digest_verified: Boolean(source.digest_verified),
        },
        generator: generator ?? null,
        checked_at: checkedAt,
        counts: {
            entries: entries.length,
            names,
            addresses: addresses.length,
            listings: addresses.reduce((n, a) => n + a.listings.length, 0),
            parties_with_addresses: Object.keys(sortedParties).length,
            addresses_by_network: Object.fromEntries(Object.entries(perNetwork).sort(([a], [b]) => (a < b ? -1 : 1))),
        },
        unmapped_codes: [...unmappedCodes].sort(),
        notes,
        files: Object.fromEntries(
            Object.keys(files)
                .sort()
                .map((p) => [p, { sha256: sha256(files[p]), bytes: Buffer.byteLength(files[p], 'utf8') }]),
        ),
    };
    return { files, index };
}

/** index.json's text. */
export const indexText = (index) => `${JSON.stringify(index, null, 2)}\n`;
