// pg_trgm's word similarity, so place search ranks exactly as it did in Postgres.
// A name's words are runs of letters and digits, lowercased, padded "  word ", cut into trigrams.
// scripts/import-places.py makes the same trigrams for its index.
const WORD = /[\p{L}\p{N}]+/gu;
const WORD_SIMILARITY_THRESHOLD = 0.6;   // pg_trgm.word_similarity_threshold's default

/** Every trigram in order, repeats included */
function trigrams(text) {
    const out = [];
    for (const word of String(text).toLowerCase().match(WORD) || []) {
        const c = Array.from(`  ${word} `);
        for (let i = 0; i + 2 < c.length; i++) out.push(c[i] + c[i + 1] + c[i + 2]);
    }
    return out;
}

/** The query's distinct trigrams: Map trigram -> 0..n-1 */
function uniqueTrigrams(text) {
    const m = new Map();
    for (const t of trigrams(text)) if (!m.has(t)) m.set(t, m.size);
    return m;
}

const sml = (count, ulen1, ulen2) => Math.fround(Math.fround(count) / Math.fround(ulen1 + ulen2 - count));

/** word_similarity(query, name): the best continuous stretch of `name` against the query (iterate_word_similarity) */
function wordSimilarity(query, name) {
    const ulen1 = query.size;
    const others = new Map();
    const indexes = trigrams(name).map(t => query.get(t) ?? (others.get(t) ?? others.set(t, ulen1 + others.size).get(t)));
    const lastpos = new Int32Array(ulen1 + others.size).fill(-1);
    const inQuery = (i) => i < ulen1;
    let lower = -1, ulen2 = 0, count = 0, best = 0;
    for (let i = 0; i < indexes.length; i++) {
        const ti = indexes[i];
        if (lower >= 0 || inQuery(ti)) {
            if (lastpos[ti] < 0) { ulen2++; if (inQuery(ti)) count++; }
            lastpos[ti] = i;
        }
        if (!inQuery(ti)) continue;
        if (lower === -1) { lower = i; ulen2 = 1; }
        let cur = sml(count, ulen1, ulen2);
        const prevLower = lower;
        let tmpCount = count, tmpUlen2 = ulen2;
        for (let l = lower; l <= i; l++) {
            const s = sml(tmpCount, ulen1, tmpUlen2);
            if (s > cur) { cur = s; ulen2 = tmpUlen2; lower = l; count = tmpCount; }
            const t = indexes[l];
            if (lastpos[t] === l) { tmpUlen2--; if (inQuery(t)) tmpCount--; }
        }
        if (cur > best) best = cur;
        for (let l = prevLower; l < lower; l++) if (lastpos[indexes[l]] === l) lastpos[indexes[l]] = -1;
    }
    return best;
}

module.exports = { trigrams, uniqueTrigrams, wordSimilarity, WORD_SIMILARITY_THRESHOLD };
