// Which stations a rail closure covers. Translink's feed names only the routes ("every
// Ipswich/Rosewood train"), so a closure between Ipswich and Rosewood looked like it shut
// Auchenflower too. The update page linked from the alert lists the stations. Pure
// functions only; fetching and caching live in index.js.

const decode = (s) => s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'")
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Station names from the page's "Affected stations" list, in page order, de-duplicated
 * (lists split by line repeat stations). [] if the page has no such list.
 */
function affectedStationNames(html) {
    const m = /Affected stations\s*<\/h(\d)>/i.exec(html);
    if (!m) return [];
    const level = Number(m[1]);
    const rest = html.slice(m.index + m[0].length);
    // The list ends at the next heading that isn't a per-line subheading ("<h3>Ipswich
    // line</h3><ul>…") under it, e.g. "Map of track closure"
    let end = -1;
    for (const h of rest.matchAll(/<h(\d)[^>]*>[\s\S]*?<\/h\d>\s*(<ul)?/gi)) {
        if (Number(h[1]) <= level || !h[2]) { end = h.index; break; }
    }
    const section = end >= 0 ? rest.slice(0, end) : rest.slice(0, 5000);
    const names = [...section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(x => decode(x[1])).filter(Boolean);
    return [...new Set(names)];
}

/** The two ends of "trains will not run between Northgate and Shorncliffe stations", or null */
function closureEnds(html) {
    const m = /between ([A-Z][A-Za-z' -]+?) and ([A-Z][A-Za-z' -]+?) stations/.exec(decode(html));
    return m ? [m[1], m[2]] : null;
}

/** "Thomas St station" -> "thomasstreet" */
const normalise = (name) => name.toLowerCase()
    .replace(/\bstation\b/g, '')
    .replace(/\bst\b\.?/g, 'street')
    .replace(/[^a-z]/g, '');

function editDistance(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

/**
 * Page names -> our stations ({ stop_id, stop_name }). Exact after normalising, else the one
 * station within two typos ("Wulkaraka" on the page is Wulkuraka). Unmatched names are dropped.
 */
function matchStations(names, stations) {
    const byKey = new Map(stations.map(s => [normalise(s.stop_name), s]));
    const out = [];
    for (const name of names) {
        const key = normalise(name);
        let hit = byKey.get(key);
        if (!hit) {
            const close = stations.filter(s => editDistance(normalise(s.stop_name), key) <= 2);
            if (close.length === 1) hit = close[0];
        }
        if (hit && !out.includes(hit)) out.push(hit);
    }
    return out;
}

module.exports = { affectedStationNames, closureEnds, matchStations, normalise };
