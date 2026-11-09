// The API's copy of the places file (scripts/import-places.py), kept current by lib/file-keeper.js.
// Published monthly to the fixed release `places-current`.
//
//   PLACES_URL   where manifest.json and the file are (default: that release, when TIMETABLE_URL is set)
//   PLACES_FILE  or a local file to open as is (development, tests)
const Database = require('better-sqlite3');
const { createFileKeeper } = require('./file-keeper');
const { uniqueTrigrams, wordSimilarity, WORD_SIMILARITY_THRESHOLD } = require('./trigram');

const RELEASE_URL = 'https://github.com/nsendhil-eng/translink-api/releases/download/places-current';
const RESULTS = 12;

class Places {
    constructor(file) {
        this.db = new Database(file, { readonly: true, fileMustExist: true });
        this.db.pragma('cache_size = -16384');
        this.db.pragma('mmap_size = 134217728');
        this.meta = Object.fromEntries(this.db.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value]));
        // Names and positions in memory: a broad query scores tens of thousands of them
        const n = this.db.prepare('SELECT max(pid) FROM places').pluck().get();
        this.names = new Array(n + 1);
        this.lat = new Float64Array(n + 1);
        this.lon = new Float64Array(n + 1);
        for (const [pid, name, lat, lon] of this.db.prepare('SELECT pid, name, lat, lon FROM places').raw(true).iterate()) {
            this.names[pid] = name; this.lat[pid] = lat; this.lon[pid] = lon;
        }
        this.hits = new Uint16Array(n + 1);
        this.q = {
            postings: this.db.prepare('SELECT pids FROM place_trigrams WHERE tri = ?').pluck(),
            row: this.db.prepare('SELECT id, name, category, address, locality, lat, lon FROM places WHERE pid = ?')
        };
    }

    /**
     * Names with words like the query's, strong matches first, nearer ones ahead; up to 60 km
     * counts against a place, beyond that only the match does. Same answers as pg_trgm's
     * `q <% name ORDER BY word_similarity(q, name) - 0.004 * least(60, km) DESC`.
     */
    search(q, lat, lon) {
        const wanted = uniqueTrigrams(q);
        if (!wanted.size) return [];
        // A name can only reach the threshold if it holds this many of the query's trigrams
        const need = Math.max(1, Math.ceil(WORD_SIMILARITY_THRESHOLD * wanted.size - 1e-9));
        this.hits.fill(0);
        const candidates = [];
        for (const tri of wanted.keys()) {
            const blob = this.q.postings.get(tri);
            if (!blob) continue;
            for (let i = 0; i < blob.length; i += 4) {
                const pid = blob.readInt32LE(i);
                if (++this.hits[pid] === need) candidates.push(pid);
            }
        }
        const scored = [];
        for (const pid of candidates) {
            const sim = wordSimilarity(wanted, this.names[pid]);
            if (sim < WORD_SIMILARITY_THRESHOLD) continue;
            const km = 111 * Math.sqrt((this.lat[pid] - lat) ** 2 + ((this.lon[pid] - lon) * 0.89) ** 2);
            scored.push({ pid, km, rank: sim - 0.004 * Math.min(60, km) });
        }
        // Past 60 km places tie on distance: Postgres returned those in any order, here nearer wins
        scored.sort((a, b) => b.rank - a.rank || a.km - b.km || a.pid - b.pid);
        return scored.slice(0, RESULTS).map(s => this.q.row.get(s.pid));
    }
}

module.exports = createFileKeeper({
    prefix: 'places',
    baseUrl: () => process.env.PLACES_URL || (process.env.TIMETABLE_URL ? RELEASE_URL : null),
    localFile: () => process.env.PLACES_FILE || null,
    open: (file) => new Places(file),
    extraStatus: (p) => ({ release: p?.meta.release ?? null, rows: p ? Number(p.meta.rows) : null })
});
module.exports.Places = Places;
