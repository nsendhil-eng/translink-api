// Keeps the API's copy of a published SQLite file current.
//
// A scheduled build publishes <prefix>.sqlite.gz and manifest.json (a GitHub release). At start this
// downloads the file in the background, checks it against the manifest's checksum and opens it;
// then it looks for a newer one every 30 minutes and swaps it in without a restart. Until a
// file is ready (or if downloads keep failing) `current()` is null and callers use Postgres.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const fetch = require('node-fetch');

const CHECK_EVERY_MS = Number(process.env.TIMETABLE_CHECK_MS) || 30 * 60_000;
const RETRY_MS = 5 * 60_000;
// The old file stays open this long after a swap, for anything still holding it
const CLOSE_OLD_AFTER_MS = 60_000;
const dataDir = () => path.join(__dirname, '..', 'data');

/**
 * @param prefix       names the local files: <prefix>-<version>.sqlite
 * @param baseUrl      () => where manifest.json and the file are, or null when not configured
 * @param localFile    () => a local file to open as is (development, tests), or null
 * @param open         (file) => the opened object, with a `meta` of { built_at, ... } and a `db`
 * @param extraStatus  (opened) => more fields for /api/health
 */
function createFileKeeper({ prefix, baseUrl, localFile, open, extraStatus = () => ({}) }) {
    const state = {
        data: null, version: null, source: null, loadedAt: null,
        checkedAt: null, error: null, downloading: false
    };

    const current = () => state.data;

    function status() {
        return {
            configured: Boolean(baseUrl() || localFile()),
            version: state.version,
            builtAt: state.data?.meta.built_at ?? null,
            ...extraStatus(state.data),
            source: state.source,
            loadedAt: state.loadedAt,
            checkedAt: state.checkedAt,
            downloading: state.downloading,
            error: state.error
        };
    }

    function swapIn(data, version, source) {
        const old = state.data;
        state.data = data;
        state.version = version;
        state.source = source;
        state.loadedAt = new Date().toISOString();
        state.error = null;
        console.log(`${prefix} file ${version} in use (${source})`);
        if (old) setTimeout(() => { try { old.db.close(); } catch (e) { /* already closed */ } }, CLOSE_OLD_AFTER_MS).unref();
    }

    /** Download, check and unpack the file a manifest describes; returns its path */
    async function download(base, manifest) {
        const dir = dataDir();
        fs.mkdirSync(dir, { recursive: true });
        const final = path.join(dir, `${prefix}-${manifest.version}.sqlite`);
        if (fs.existsSync(final)) return final;            // already here (an earlier start)
        const tmp = final + '.part';
        const r = await fetch(`${base}/${manifest.file}`, { timeout: 120_000 });
        if (!r.ok) throw new Error(`${prefix} download: HTTP ${r.status}`);
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        const tap = new Transform({ transform(chunk, _, done) { hash.update(chunk); bytes += chunk.length; done(null, chunk); } });
        await pipeline(r.body, tap, zlib.createGunzip(), fs.createWriteStream(tmp));
        const sha = hash.digest('hex');
        if (sha !== manifest.sha256 || bytes !== manifest.bytes) {
            fs.rmSync(tmp, { force: true });
            throw new Error(`${prefix} download didn't match its manifest (${bytes} bytes, sha ${sha.slice(0, 12)})`);
        }
        fs.renameSync(tmp, final);
        return final;
    }

    /** Old versions' files, beyond the one in use */
    function tidy(keep) {
        const mine = new RegExp(`^${prefix}-.*\\.sqlite(\\.part)?$`);
        for (const f of fs.readdirSync(dataDir())) {
            if (mine.test(f) && path.join(dataDir(), f) !== keep) fs.rmSync(path.join(dataDir(), f), { force: true });
        }
    }

    /** Look for a newer file and use it; never throws */
    async function refresh() {
        const base = baseUrl();
        if (!base || state.downloading) return;
        state.downloading = true;
        try {
            const r = await fetch(`${base}/manifest.json`, { timeout: 15_000 });
            if (!r.ok) throw new Error(`${prefix} manifest: HTTP ${r.status}`);
            const manifest = await r.json();
            state.checkedAt = new Date().toISOString();
            if (manifest.version === state.version) return;
            const file = await download(base, manifest);
            swapIn(open(file), manifest.version, `${base} (${manifest.version})`);
            tidy(file);
        } catch (e) {
            state.error = e.message;
            console.error(`${prefix} file:`, e.message);
        } finally {
            state.downloading = false;
        }
    }

    /** Start keeping the file current: in the background, so the API starts at once */
    function start() {
        const local = localFile();
        if (local) {
            try {
                const d = open(local);
                swapIn(d, d.meta.version || 'local', local);
            } catch (e) { state.error = e.message; console.error(`${prefix} file:`, e.message); }
            return;
        }
        if (!baseUrl()) return;
        const loop = async () => {
            await refresh();
            setTimeout(loop, state.data && !state.error ? CHECK_EVERY_MS : RETRY_MS).unref();
        };
        loop();
    }

    return { start, current, status, refresh };
}

module.exports = { createFileKeeper };
