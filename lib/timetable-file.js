// Keeps the API's copy of the timetable file (scripts/build-sqlite.js) current.
//
// The weekly build publishes seq.sqlite.gz and manifest.json (a GitHub release). At start this
// downloads the file in the background, checks it against the manifest's checksum and opens it;
// then it looks for a newer one every 30 minutes and swaps it in without a restart. Until a
// file is ready (or if downloads keep failing) `current()` is null and callers use Postgres.
//
//   TIMETABLE_URL   where manifest.json and the file are, e.g.
//                   https://github.com/nsendhil-eng/translink-api/releases/latest/download
//   TIMETABLE_FILE  or a local file to open as is (development, tests)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const fetch = require('node-fetch');
const { Timetable } = require('./sqlite-data');

const CHECK_EVERY_MS = Number(process.env.TIMETABLE_CHECK_MS) || 30 * 60_000;
const RETRY_MS = 5 * 60_000;
// The old file stays open this long after a swap, for anything still holding it
const CLOSE_OLD_AFTER_MS = 60_000;

const state = {
    timetable: null,        // the open Timetable, or null
    version: null,
    source: null,
    loadedAt: null,
    checkedAt: null,
    error: null,
    downloading: false
};

const dataDir = () => path.join(__dirname, '..', 'data');

/** The open timetable, or null (not downloaded yet, or not configured) */
const current = () => state.timetable;

/** For /api/health */
function status() {
    const t = state.timetable;
    return {
        configured: Boolean(process.env.TIMETABLE_URL || process.env.TIMETABLE_FILE),
        version: state.version,
        builtAt: t?.meta.built_at ?? null,
        calendarEnd: t?.meta.calendar_end ?? null,
        source: state.source,
        loadedAt: state.loadedAt,
        checkedAt: state.checkedAt,
        downloading: state.downloading,
        error: state.error
    };
}

function swapIn(timetable, version, source) {
    const old = state.timetable;
    state.timetable = timetable;
    state.version = version;
    state.source = source;
    state.loadedAt = new Date().toISOString();
    state.error = null;
    console.log(`Timetable file ${version} in use (${source})`);
    if (old) setTimeout(() => { try { old.db.close(); } catch (e) { /* already closed */ } }, CLOSE_OLD_AFTER_MS).unref();
}

/** Download, check and unpack the file a manifest describes; returns its path */
async function download(base, manifest) {
    const dir = dataDir();
    fs.mkdirSync(dir, { recursive: true });
    const final = path.join(dir, `seq-${manifest.version}.sqlite`);
    if (fs.existsSync(final)) return final;            // already here (an earlier start)
    const tmp = final + '.part';
    const r = await fetch(`${base}/${manifest.file}`, { timeout: 120_000 });
    if (!r.ok) throw new Error(`timetable download: HTTP ${r.status}`);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const tap = new Transform({ transform(chunk, _, done) { hash.update(chunk); bytes += chunk.length; done(null, chunk); } });
    await pipeline(r.body, tap, zlib.createGunzip(), fs.createWriteStream(tmp));
    const sha = hash.digest('hex');
    if (sha !== manifest.sha256 || bytes !== manifest.bytes) {
        fs.rmSync(tmp, { force: true });
        throw new Error(`timetable download didn't match its manifest (${bytes} bytes, sha ${sha.slice(0, 12)})`);
    }
    fs.renameSync(tmp, final);
    return final;
}

/** Old versions' files, beyond the one in use */
function tidy(keep) {
    for (const f of fs.readdirSync(dataDir())) {
        if (/^seq-.*\.sqlite(\.part)?$/.test(f) && path.join(dataDir(), f) !== keep) fs.rmSync(path.join(dataDir(), f), { force: true });
    }
}

/** Look for a newer file and use it; never throws */
async function refresh() {
    const base = process.env.TIMETABLE_URL;
    if (!base || state.downloading) return;
    state.downloading = true;
    try {
        const r = await fetch(`${base}/manifest.json`, { timeout: 15_000 });
        if (!r.ok) throw new Error(`timetable manifest: HTTP ${r.status}`);
        const manifest = await r.json();
        state.checkedAt = new Date().toISOString();
        if (manifest.version === state.version) return;
        const file = await download(base, manifest);
        swapIn(new Timetable(file), manifest.version, `${base} (${manifest.version})`);
        tidy(file);
    } catch (e) {
        state.error = e.message;
        console.error('Timetable file:', e.message);
    } finally {
        state.downloading = false;
    }
}

/** Start keeping the file current: in the background, so the API starts at once */
function start() {
    if (process.env.TIMETABLE_FILE) {
        try {
            const t = new Timetable(process.env.TIMETABLE_FILE);
            swapIn(t, t.meta.version || 'local', process.env.TIMETABLE_FILE);
        } catch (e) { state.error = e.message; console.error('Timetable file:', e.message); }
        return;
    }
    if (!process.env.TIMETABLE_URL) return;
    const loop = async () => {
        await refresh();
        setTimeout(loop, state.timetable && !state.error ? CHECK_EVERY_MS : RETRY_MS).unref();
    };
    loop();
}

module.exports = { start, current, status, refresh };
