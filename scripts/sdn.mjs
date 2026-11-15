// SDN.XML's tree → the entries the mirror publishes, and only the fields a screening reads.
//
// WHAT IS LEFT OUT, ON PURPOSE: passport and national ID numbers, postal addresses, vessel
// particulars and remarks. They are public in the source too, but nothing here screens on them, and
// a copy kept for one purpose should not become a second place to look people up. Anyone who needs
// them has the uid, which opens the entry on OFAC's own Sanctions List Search.
//
// Pure: the parsed tree in, plain objects out.
import { all, one, textOf } from './sdn-xml.mjs';

export const SDN_TYPES = ['Individual', 'Entity', 'Vessel', 'Aircraft'];
export const ADDRESS_PREFIX = 'Digital Currency Address - ';

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * "LAST, First" for a person, the name alone for everything else — the order OFAC writes and
 * searches in. Kept as OFAC spells it (upper-case surname): a screening folds case anyway, and a
 * rewritten name would no longer be the one the list states.
 */
export function displayName(el) {
    const last = squash(textOf(el, 'lastName'));
    const first = squash(textOf(el, 'firstName'));
    return first ? (last ? `${last}, ${first}` : first) : last;
}

/** "11/13/2026" → "2026-11-13", refusing anything else. */
export function isoDate(us) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(us).trim());
    if (!m) throw new Error(`Publish_Date "${us}" is not MM/DD/YYYY`);
    const iso = `${m[3]}-${m[1]}-${m[2]}`;
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new Error(`Publish_Date "${us}" is not a date`);
    return iso;
}

/**
 * Read the whole list. Throws when the file is not the list it claims to be: a wrong root, no
 * publish date, an entry without uid, type or name, or an entry count that differs from the
 * Record_Count the file states. The count check is the one that matters: it is what notices a
 * truncated download or a reader that skipped something.
 */
export function readSdn(root) {
    if (root.name !== 'sdnList') throw new Error(`root element is <${root.name}>, not <sdnList>`);
    const info = one(root, 'publshInformation'); // sic: OFAC's spelling
    if (!info) throw new Error('no <publshInformation>');
    const publishDate = isoDate(textOf(info, 'Publish_Date'));
    const recordCount = Number(textOf(info, 'Record_Count'));
    if (!Number.isInteger(recordCount) || recordCount <= 0) throw new Error(`Record_Count "${textOf(info, 'Record_Count')}" is not a count`);

    const entries = [];
    const seen = new Set();
    for (const el of all(root, 'sdnEntry')) {
        const uid = Number(textOf(el, 'uid'));
        if (!Number.isInteger(uid) || uid <= 0) throw new Error(`an entry has uid "${textOf(el, 'uid')}"`);
        if (seen.has(uid)) throw new Error(`uid ${uid} appears twice`);
        seen.add(uid);
        const type = textOf(el, 'sdnType');
        if (!SDN_TYPES.includes(type)) throw new Error(`uid ${uid}: sdnType "${type}" is not one of ${SDN_TYPES.join(', ')}`);
        const name = displayName(el);
        if (!name) throw new Error(`uid ${uid}: no name`);

        const aliases = [];
        for (const aka of all(one(el, 'akaList'), 'aka')) {
            const n = displayName(aka);
            if (!n) continue;
            // OFAC marks an alias "weak" when it is too broad or generic to identify anyone by
            // itself, and does not expect a screening to match on one alone. Kept, and marked.
            const category = textOf(aka, 'category') === 'weak' ? 'weak' : 'strong';
            aliases.push([n, category]);
        }

        const addresses = [];
        for (const id of all(one(el, 'idList'), 'id')) {
            const idType = textOf(id, 'idType');
            if (!idType.startsWith(ADDRESS_PREFIX)) continue;
            const code = squash(idType.slice(ADDRESS_PREFIX.length));
            const value = textOf(id, 'idNumber').trim();
            if (!code || !value) throw new Error(`uid ${uid}: a digital currency address without a code or a value`);
            addresses.push({ code, value });
        }

        const texts = (list, item, field) => all(one(el, list), item).map((x) => squash(textOf(x, field))).filter(Boolean);
        entries.push({
            uid,
            type,
            name,
            aliases,
            programs: all(one(el, 'programList'), 'program').map((p) => squash(p.text)).filter(Boolean),
            dates_of_birth: texts('dateOfBirthList', 'dateOfBirthItem', 'dateOfBirth'),
            places_of_birth: texts('placeOfBirthList', 'placeOfBirthItem', 'placeOfBirth'),
            nationalities: texts('nationalityList', 'nationality', 'country'),
            citizenships: texts('citizenshipList', 'citizenship', 'country'),
            addresses,
        });
    }
    if (entries.length !== recordCount) {
        throw new Error(`the file states ${recordCount} entries and holds ${entries.length}: refusing a list that is not whole`);
    }
    entries.sort((a, b) => a.uid - b.uid);
    return { publishDate, recordCount, entries };
}
