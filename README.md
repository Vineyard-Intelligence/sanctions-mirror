# Sanctions Mirror

OFAC's Specially Designated Nationals and Blocked Persons list (SDN), as JSON shards a browser can
read: every entry's names for name screening, and every listed digital currency address on the
network it belongs to. This is data, not a plugin. The
[Sanctions Screening](https://github.com/Vineyard-Intelligence/pluginpack-sanctions) pack for
Vineyard reads it.

This repository is not OFAC's and is not affiliated with the U.S. Treasury. The list OFAC publishes
is the authority; check a result against [Sanctions List Search](https://sanctionssearch.ofac.treas.gov/)
before acting on it.

## Why a mirror

OFAC publishes the list at
`https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML`. A web page
cannot read it: the API answers with a 302 that allows any origin, to an S3 pre-signed URL that
sends no CORS header, so the browser stops at the second hop (measured 2026-11-14). A plugin runs in
the analyst's browser, or in the desktop app's renderer, so it reads this copy instead.

`SDN.CSV` is not used because it cuts its remarks column short, and the existing address-only mirrors
carry neither the entry nor its programmes.

## Files

| File | What it holds |
|---|---|
| `index.json` | The source file's publish date, record count and SHA-256, the fingerprint of the scripts that built it (`generator`), when the mirror last checked OFAC (`checked_at`), counts, notes, and the SHA-256 and size of every file below |
| `addresses.json` | Every listed digital currency address, one per line, sorted by network and address, and every entry that lists one (`parties`) |
| `names/individual.json` | Every individual's names, one entry per line, sorted by uid |
| `names/entity.json` | The same for entities |
| `names/vessel.json`, `names/aircraft.json` | The same for vessels and aircraft |
| `data/<sha256>.json` | Each file above again, named by its SHA-256 as `index.json` gives it. What a reader fetches |

Served from `https://raw.githubusercontent.com/Vineyard-Intelligence/sanctions-mirror/main/`. A
reader fetches `index.json`, then each file it needs at `data/<sha256>.json`, and checks the bytes
against that SHA-256. The named files are there for people and for `git log -p`; readers do not use
them, because raw.githubusercontent.com caches each path for five minutes and leaves the query
string out of its cache key (measured 2026-11-15), so right after an update an edge can serve
`index.json` from one build and `addresses.json` from the next, and `?v=…` cannot tell them apart.
A content path holds one build's bytes whichever index named it. The previous build's content paths
stay until the next build replaces them, so an index cached just before an update still finds its
files. The copies take no space in git, which stores identical content once.

The name shards are split by SDN type so that a screening downloads a whole shard: whoever serves
the files learns that a person or an organisation was screened, never which name.

### `addresses.json`

```json
{"format":1,"list":"OFAC SDN","as_of":"2026-11-13","addresses":[
{"network":"tron","address":"TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq","listings":[{"uid":45404,"code":"XBT","network_from":"format","note":"listed as XBT, but the value is not a bitcoin address"}]},
…
],"parties":{
"45404":{"type":"Individual","name":"WANG, Mingming","aliases":[],"programs":["ILLICIT-DRUGS-EO14059"],"dates_of_birth":["12 Mar 1989"],"places_of_birth":["Hebei, China"],"nationalities":["China"],"citizenships":["China"]},
…
}}
```

- `network` and `address` are the identity the Vineyard Cryptocurrency type pack gives an address:
  the same string on two networks is two records.
- `listings` are the entries (`uid`) that list the address and the OFAC code they list it under.
  One address can be listed by several entries, and under several codes (`XBT` and `USDT` for the
  same Bitcoin address, `USDC` and `USDT` for the same `0x` value).
- `network_from` is present when the value's format, not the code, decided the network. `listed` is
  the value as OFAC wrote it, present when the canonical form differs. `note` is present only when
  something needs a person (see below), and every note is repeated in `index.json`.

### Name shards

```json
{"format":1,"list":"OFAC SDN","as_of":"2026-11-13","type":"Individual","fields":["uid","name","aliases","programs","dates_of_birth","places_of_birth","nationalities","citizenships"],"entries":[
[20157,"KIM, Jong Un",[],["DPRK3"],["08 Jan 1984"],[],[],[]],
…
]}
```

Names are as OFAC writes them: `LAST, First` for a person. An alias is `[name, "strong" | "weak"]`;
OFAC marks an alias weak when it is too broad to identify anyone by itself. Dates of birth are
OFAC's text (`08 Jan 1984`, `1984`, `circa 1979`, `1984 to 1986`).

### What is left out

Passport and national ID numbers, street addresses, vessel particulars and remarks. They are public
in the source too, but nothing here screens on them, and a copy kept for screening should not become
a second place to look people up. The uid opens the full entry on OFAC's site.

## From OFAC codes to networks

OFAC lists an address as an ID of type `Digital Currency Address - <code>`. Every such ID is read,
whatever the code, so new codes are never dropped. The codes mix chains with tokens that run on
several chains, so the code and the value's format are read together.

| Code | Network | Rule |
|---|---|---|
| `XBT` | `bitcoin` | |
| `BCH` | `bitcoin_cash` | a legacy `1…`/`3…` value is written as CashAddr |
| `BSV`, `BTG`, `LTC`, `DOGE`, `DASH`, `ZEC`, `XMR`, `XVG` | `bitcoin_sv`, `bitcoin_gold`, `litecoin`, `dogecoin`, `dash`, `zcash`, `monero`, `verge` | a Litecoin `3…` value is written as `M…` |
| `ETH`, `ETC`, `BSC`, `ARB` | `ethereum`, `ethereum_classic`, `bsc`, `arbitrum` | the same `0x…` under ETH, BSC and ARB is three addresses |
| `TRX`, `SOL`, `XRP` | `tron`, `solana`, `xrpl` | |
| `BNB` | `bnb_beacon` | a `0x…` value would be `bsc` |
| `USDT`, `USDC` | by format | TRON `T…` → `tron`; `0x…` → `evm` (the list does not say which EVM chain); USDT in Base58Check → `bitcoin` (Omni) |
| anything else | by format | reported in `index.json` `unmapped_codes` |

When a chain code's value is not an address on that chain, the format decides if it can: the one
`XBT` value that is a TRON address goes to `tron`. Addresses are written in the canonical form: `0x…`
and bech32 in lower case (71 of the 137 EVM values on the 2026-11-13 list are EIP-55 checksummed),
Base58 as written.

`index.json` `notes` lists every case that needed the format, or that nothing could read. On the
2026-11-13 list there are two: uid 45404's `XBT` value is a TRON address, and uid 29585's `XMR`
value is 64 hex characters, not a Monero address, so it is kept as listed under `monero`.

## Updates

`.github/workflows/update.yml` runs every six hours. It reads OFAC's `Digest` header first (a HEAD
request answers `Digest: sha-256…` and `Last-Modified`), skips the 29 MB download when the list is
unchanged, and otherwise downloads the file and refuses it unless it hashes to that digest. When
OFAC sends no readable digest, the run stops before downloading. The build also refuses a file
whose entry count differs from the `Record_Count` it states, and the XML reader refuses any
construct SDN.XML does not use rather than skipping it. A failed run changes nothing: the mirror
keeps the last list it could verify, and the workflow opens an issue.

An unchanged list is skipped only when the scripts are unchanged too. `index.json` records the
fingerprint of the code that built it (`generator`: the SHA-256 over each file in
`GENERATOR_FILES` in `scripts/build.mjs`), and a run that finds a different one downloads the list
again and rebuilds. The workflow also runs on every push that changes `scripts/`, so a fix to the
network table is published at once rather than with OFAC's next list.

`checked_at` moves when the list changes and otherwise about once a day. A reader that sees it more
than a few days old is reading a stalled mirror, not a quiet list; the Vineyard pack warns at three
days.

The git history is the list's history: a designation is an added line in `addresses.json` or a
name shard, a delisting a removed one, and each data commit names the publish date.

## Checking a build

Everything except `checked_at` is a function of SDN.XML and the scripts named by `generator`. To
check the files against OFAC's:

```bash
curl -L -o SDN.XML https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML
node scripts/verify.mjs SDN.XML     # needs Node 22.18+; no dependencies
```

It fails when the file is not the one `index.json` names (OFAC has published since), or when the
scripts in the checkout are not the `generator` that built the data (check out the commit that
built it), and otherwise rebuilds every file, content paths included, in memory and compares bytes.

```bash
npm test                            # the reader, the network table and the layout, on test/fixture-sdn.xml
node scripts/update.mjs             # what the workflow runs: fetch, verify, rebuild
node scripts/build.mjs SDN.XML --checked-at 2026-11-15T00:00:00Z
node scripts/excerpt.mjs SDN.XML 36,45404 > small.xml   # real entries for a fixture, ID numbers redacted
```

`test/fixture-sdn.xml` is 26 real entries cut from the 2026-11-13 list with `excerpt.mjs`, with ID
numbers and street addresses redacted. `scripts/crypto-address.ts` is the address code the Vineyard
packs that write crypto addresses carry, copied unchanged, so the mirror and the packs agree on the
canonical form.

## Licence

The scripts are Apache-2.0 (`LICENSE`). The list is a work of the U.S. Government, published by
OFAC, and not subject to copyright in the United States (17 U.S.C. § 105).
