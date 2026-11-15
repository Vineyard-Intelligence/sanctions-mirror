// A strict reader for OFAC's SDN.XML, and nothing else.
//
// Node has no XML parser, and a general one would be the largest piece of code in this repository
// that nobody here wrote. SDN.XML does not need one: it is generated, it uses elements and text
// only, and measured on the 2026-11-13 file (29.5 MB, 19,565 entries) it has no comments, no CDATA,
// no DOCTYPE, no processing instruction after the declaration, no self-closing tags, no attribute
// outside the root's namespace declarations, and no entity but &amp; &lt; &gt;.
//
// So this reads that shape and REFUSES everything else, rather than guessing. The failure it guards
// against is a quiet one: a reader that skipped a construct it did not understand would drop an
// entry or an address and still produce a mirror that looks complete. A thrown error stops the
// scheduled update instead, and the mirror keeps serving the last list it could read whole.
//
// Pure: a string in, a tree out. Element: { name, children, text }.

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** `where` for an error: the line of `pos`, so a refusal can be found in a 1,000,000-line file. */
function lineOf(text, pos) {
    let line = 1;
    for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) line++;
    return line;
}

function decode(raw, text, at) {
    if (!raw.includes('&')) return raw;
    return raw.replace(/&([^;&\s]*);?/g, (m, ref) => {
        if (!m.endsWith(';')) throw new Error(`line ${lineOf(text, at)}: a bare "&" in text`);
        if (ref in ENTITIES) return ENTITIES[ref];
        const num = /^#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/.exec(ref);
        if (num) {
            const code = num[1] ? parseInt(num[1], 16) : Number(num[2]);
            if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code === 0) {
                throw new Error(`line ${lineOf(text, at)}: character reference &${ref}; is not a character`);
            }
            return String.fromCodePoint(code);
        }
        throw new Error(`line ${lineOf(text, at)}: unknown entity &${ref}; (SDN.XML has used only &amp; &lt; &gt;)`);
    });
}

/**
 * Parse SDN.XML text into its root element.
 *
 * Text is kept only for leaf elements, trimmed of the surrounding whitespace the file indents with.
 * An element that holds both children and non-whitespace text is refused: SDN.XML has none, and
 * keeping one half would lose the other.
 */
export function parseXml(text) {
    if (typeof text !== 'string') throw new TypeError('parseXml takes the file as a string');
    let pos = 0;
    if (text.charCodeAt(0) === 0xfeff) pos = 1;
    const decl = /^<\?xml\s[^?]*\?>/.exec(text.slice(pos, pos + 200));
    if (decl) pos += decl[0].length;

    const stack = [];
    let root = null;
    let textStart = pos;

    while (pos < text.length) {
        const lt = text.indexOf('<', pos);
        if (lt === -1) {
            if (text.slice(pos).trim()) throw new Error(`line ${lineOf(text, pos)}: text after the root element`);
            break;
        }
        const between = text.slice(textStart, lt);
        const next = text[lt + 1];
        if (next === '!' || next === '?') {
            // Comments, CDATA, DOCTYPE and later processing instructions: none in SDN.XML, and each
            // would change what the text means if skipped.
            throw new Error(`line ${lineOf(text, lt)}: "<${next}" constructs are not read here (comment, CDATA, DOCTYPE or processing instruction)`);
        }
        const gt = text.indexOf('>', lt);
        if (gt === -1) throw new Error(`line ${lineOf(text, lt)}: unterminated tag`);
        const tag = text.slice(lt + 1, gt);

        if (tag.startsWith('/')) {
            const name = tag.slice(1).trim();
            const open = stack.pop();
            if (!open || open.name !== name) {
                throw new Error(`line ${lineOf(text, lt)}: </${name}> closes ${open ? `<${open.name}>` : 'nothing'}`);
            }
            if (open.children.length) {
                if (between.trim()) throw new Error(`line ${lineOf(text, lt)}: <${name}> mixes text and elements`);
            } else {
                open.text = decode(between, text, lt).trim();
            }
            if (!stack.length) root = open;
        } else {
            if (between.trim() && stack.length) {
                throw new Error(`line ${lineOf(text, lt)}: <${stack[stack.length - 1].name}> mixes text and elements`);
            }
            if (!stack.length && root) throw new Error(`line ${lineOf(text, lt)}: a second root element`);
            if (!stack.length && between.trim()) throw new Error(`line ${lineOf(text, lt)}: text before the root element`);
            const selfClosing = tag.endsWith('/');
            const body = selfClosing ? tag.slice(0, -1) : tag;
            const space = body.search(/\s/);
            const name = space === -1 ? body : body.slice(0, space);
            const attrs = space === -1 ? '' : body.slice(space).trim();
            if (!NAME.test(name)) throw new Error(`line ${lineOf(text, lt)}: "${name}" is not an element name`);
            // Only the root may carry attributes, and only namespace declarations: anything else
            // would be data this reader drops.
            if (attrs) {
                const ok = !stack.length && /^(\s*xmlns(:[A-Za-z_][\w.-]*)?\s*=\s*"[^"]*")+\s*$/.test(` ${attrs}`);
                if (!ok) throw new Error(`line ${lineOf(text, lt)}: <${name}> has attributes, which SDN.XML has only on its root`);
            }
            const el = { name, children: [], text: '' };
            if (stack.length) stack[stack.length - 1].children.push(el);
            if (selfClosing) {
                if (!stack.length) root = el;
            } else {
                stack.push(el);
            }
        }
        pos = gt + 1;
        textStart = pos;
    }
    if (stack.length) throw new Error(`unexpected end of file inside <${stack[stack.length - 1].name}>`);
    if (!root) throw new Error('no root element');
    return root;
}

/** The children of `el` named `name`. */
export const all = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);

/** The first child of `el` named `name`, or undefined. */
export const one = (el, name) => el?.children.find((c) => c.name === name);

/** The text of `el`'s first child named `name`, or ''. */
export const textOf = (el, name) => one(el, name)?.text ?? '';
