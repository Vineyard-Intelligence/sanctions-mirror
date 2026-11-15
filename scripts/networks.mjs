// OFAC's currency codes → the Cryptocurrency type pack's `network`, with the address in the form
// that type pack identifies it by.
//
// THE CODE IS NOT A NETWORK. OFAC writes "Digital Currency Address - <code>", and the codes mix
// chains (XBT, ETH, TRX, BSC, ARB) with tokens that run on several chains (USDT, USDC). Measured on
// the 2026-11-13 list: of 94 USDT addresses, 79 are TRON `T…`, 8 are EVM `0x…` and 7 are Bitcoin
// Base58 (Tether on the Omni layer); one XBT value is a TRON address (uid 45404); one of 7 BCH
// values is a legacy `1…` address. So the code and the value's FORMAT are read together:
//
//   - A chain code names the network when the value is an address on it. When it is not, the
//     format decides if it can (the XBT `T…` is TRON's), and the listing records that it did.
//   - A token code names no chain. The format decides: TRON `T…` → tron, `0x…` → evm (the list
//     does not say which EVM chain), USDT in Base58Check → bitcoin (Omni).
//   - A code this table does not know yet goes the token route and is reported in index.json, so a
//     new OFAC code is visible instead of silently mapped.
//
// No code list is fixed beyond this table: an address is any id whose type starts with
// "Digital Currency Address - ", so the DOGE and BNB listings OFAC added are read like the rest.
//
// The address is written in the type pack's canonical form (crypto-address.ts, the same copy the
// packs use): EVM and bech32 in lower case — 71 of the 137 EVM values on that list are EIP-55
// checksummed — a Bitcoin Cash legacy address as CashAddr, Base58 as written. The value as OFAC
// wrote it is kept beside it when the two differ.
import { canonicalAddress, classifyAddress, identityFold } from './crypto-address.ts';

/** Codes that name one network. */
export const CHAIN_CODES = {
    XBT: 'bitcoin',
    BCH: 'bitcoin_cash',
    BSV: 'bitcoin_sv',
    BTG: 'bitcoin_gold',
    LTC: 'litecoin',
    DOGE: 'dogecoin',
    DASH: 'dash',
    ZEC: 'zcash',
    XMR: 'monero',
    XVG: 'verge',
    ETH: 'ethereum',
    ETC: 'ethereum_classic',
    BSC: 'bsc',
    ARB: 'arbitrum',
    TRX: 'tron',
    SOL: 'solana',
    XRP: 'xrpl',
    // The one BNB listing is a Beacon Chain `bnb1…` address. A `0x…` value under BNB would be BNB
    // Smart Chain, which the format check below sends to bsc.
    BNB: 'bnb_beacon',
};

/** Token codes, read by format. USDT is the only one OFAC lists in Base58Check (Omni). */
export const TOKEN_CODES = { USDT: { base58: 'bitcoin' }, USDC: {} };

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Networks whose formats canonicalAddress checks itself (checksum or pattern). */
const CHECKED = new Set(['bitcoin', 'litecoin', 'dogecoin', 'bitcoin_cash', 'monero', 'ethereum', 'ethereum_classic', 'bsc', 'arbitrum']);

/** Whether `value` is plausibly an address on `network`, where canonicalAddress cannot tell. */
function fits(network, value) {
    if (CHECKED.has(network)) return true;
    switch (network) {
        case 'tron':
            return classifyAddress(value).network === 'tron';
        case 'bnb_beacon':
            return classifyAddress(value).network === 'bnb_beacon';
        case 'dash':
            return /^[X7][1-9A-HJ-NP-Za-km-z]{33}$/.test(value);
        case 'zcash':
            return /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(value);
        case 'xrpl':
            return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value);
        case 'solana':
            return BASE58.test(value) && value.length >= 32 && value.length <= 44;
        default:
            // bitcoin_sv, bitcoin_gold, verge: Base58 as written.
            return BASE58.test(value);
    }
}

/**
 * Where one listed value goes: `{ network, address, network_from, listed?, note? }`.
 *
 * `network_from` is "code" when the code named the network and the value fits it, "format" when
 * the value's format decided. `listed` is the value as OFAC wrote it, present only when the
 * canonical form differs. `note` is there only when something needs a person: the format overrode
 * a chain code, a code is not in the table, or no network could be read.
 */
export function placeAddress(code, rawValue) {
    const value = String(rawValue).trim();
    if (!value || /\s/.test(value)) {
        return { network: 'unknown', address: value, network_from: 'format', note: 'the value is not one address' };
    }
    const done = (network, canonical, from, note) => {
        const address = identityFold(canonical);
        const out = { network, address, network_from: from };
        if (address !== value) out.listed = value;
        if (note) out.note = note;
        return out;
    };
    const byFormat = (why) => {
        const c = classifyAddress(value);
        if (c.network !== 'unknown') return done(c.network, c.address, 'format', why);
        return null;
    };

    const chain = CHAIN_CODES[code];
    if (chain) {
        // A 0x value under BNB is BNB Smart Chain, not the Beacon Chain the code usually means.
        if (code === 'BNB' && /^0x[0-9a-fA-F]{40}$/.test(value)) return done('bsc', value, 'format', 'BNB with a 0x value is BNB Smart Chain');
        const canonical = canonicalAddress(chain, value);
        if (canonical && fits(chain, canonical)) return done(chain, canonical, 'code');
        return (
            byFormat(`listed as ${code}, but the value is not a ${chain} address`) ??
            done(chain, value, 'code', `the value does not read as a ${chain} address; kept as listed`)
        );
    }

    // A token code is expected to leave the network to the format, so that route carries no note:
    // `network_from: "format"` says it. A code this table lacks is noted on every listing, so a new
    // OFAC code shows up in index.json until someone decides what it names.
    const token = TOKEN_CODES[code];
    const unlisted = token ? null : `OFAC code ${code} is not in this mirror's table`;
    const c = classifyAddress(value);
    if (c.network !== 'unknown') return done(c.network, c.address, 'format', unlisted);
    if (token?.base58) {
        const canonical = canonicalAddress(token.base58, value);
        if (canonical) return done(token.base58, canonical, 'format', null);
    }
    return done('unknown', value, 'format', `${unlisted ?? `${code} is a token`}, and the value's format names no network`);
}
