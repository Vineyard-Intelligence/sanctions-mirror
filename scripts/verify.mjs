// Check the committed mirror against the SDN.XML it says it was built from.
//
//   node scripts/verify.mjs <SDN.XML>
//
// For anyone auditing a copy: get OFAC's file for the publish date in index.json (or the one
// scripts/update.mjs left in .cache/), and this rebuilds every file in memory with index.json's own
// `checked_at` and compares bytes, the content paths readers fetch included. Exit 1 on any
// difference, when the file is not the one index.json names, or when the scripts in this checkout
// are not the generator index.json names: a rebuild by other code proves nothing either way, so that
// is said instead of a list of differing files.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATOR_FILES, ROOT, build, generatorFingerprint } from './build.mjs';
import { dataPath, indexText } from './layout.mjs';

const file = process.argv[2];
if (!file) {
    console.error('usage: node scripts/verify.mjs <SDN.XML>');
    process.exit(2);
}
const index = JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8'));
const bytes = readFileSync(file);
const sha = createHash('sha256').update(bytes).digest('hex');
if (sha !== index.source.sha256) {
    console.error(`${file} hashes to ${sha}; index.json was built from ${index.source.sha256} (OFAC SDN ${index.source.publish_date})`);
    process.exit(1);
}
const generator = generatorFingerprint();
if (index.generator !== generator) {
    console.error(
        `index.json was built by generator ${index.generator ?? '(none recorded)'}, and the scripts here are ${generator} ` +
            `(${GENERATOR_FILES.join(', ')}). Check out the commit whose scripts match, or wait for the update the change triggers.`,
    );
    process.exit(1);
}
const built = build(bytes, {
    checkedAt: index.checked_at,
    lastModified: index.source.last_modified,
    digestVerified: index.source.digest_verified,
    generator,
});
const expected = [
    ...Object.entries(built.files),
    ...Object.entries(built.index.files).map(([path, meta]) => [dataPath(meta.sha256), built.files[path]]),
    ['index.json', indexText(built.index)],
];
let bad = 0;
for (const [path, text] of expected) {
    let disk = null;
    try {
        disk = readFileSync(join(ROOT, path), 'utf8');
    } catch {
        disk = null;
    }
    if (disk === text) {
        console.log(`ok       ${path}`);
    } else {
        bad++;
        console.error(`DIFFERS  ${path}${disk == null ? ' (missing)' : ''}`);
    }
}
console.log(bad ? `${bad} file(s) differ from a rebuild` : `every file is the rebuild of OFAC SDN ${index.source.publish_date}`);
process.exit(bad ? 1 : 0);
