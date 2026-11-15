// Input checks for endpoints that pass values on to other services (the planner) or whose cost
// grows with a number the caller picks (a search radius). Pure: tested in test/validate.test.js.

/** Largest search radius, metres: the apps ask for 500 (3000 when nothing's near); the web grows by 500 */
const MAX_RADIUS_M = 5000;

/** A radius from the query: the default when missing or nonsense, never more than MAX_RADIUS_M */
function radiusOf(value, fallback) {
    const r = parseFloat(value);
    if (!Number.isFinite(r) || r <= 0) return fallback;
    return Math.min(r, MAX_RADIUS_M);
}

/** A number, strictly: "-27.48" yes, "-27.48&x=1" or "" no */
const num = (v) => (v == null || String(v).trim() === '' ? NaN : Number(v));
const latOk = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
const lonOk = (v) => Number.isFinite(v) && v >= -180 && v <= 180;

/** The planner's modes we pass on, so nothing else can ride along into its URL */
const PLAN_MODES = new Set(['TRANSIT', 'WALK', 'BUS', 'RAIL', 'TRAM', 'FERRY', 'SUBWAY']);

/**
 * /api/plan's query, checked: coordinates as numbers in range, the date "2026-11-15", the time
 * "8:05am", modes from PLAN_MODES. Missing date or time: now in Brisbane (`nowBrisbane()` gives
 * { date, time }), not the server's UTC day. Returns { ok: true, plan } or { ok: false, error }.
 */
function planQuery(q, nowBrisbane) {
    const [fromLat, fromLon, toLat, toLon] = ['fromLat', 'fromLon', 'toLat', 'toLon'].map(k => num(q[k]));
    if (!latOk(fromLat) || !lonOk(fromLon) || !latOk(toLat) || !lonOk(toLon)) {
        return { ok: false, error: 'fromLat, fromLon, toLat, toLon are required.' };
    }
    const now = (!q.date || !q.time) ? nowBrisbane() : null;
    const date = q.date ? String(q.date) : now.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'date must look like 2026-11-15.' };
    const time = q.time ? String(q.time).trim().toLowerCase().replace(/\s+/g, '') : now.time;
    if (!/^\d{1,2}:\d{2}(am|pm)?$/.test(time)) return { ok: false, error: 'time must look like 8:05am.' };
    const modes = q.modes ? String(q.modes).toUpperCase().split(',').map(m => m.trim()).filter(Boolean) : ['TRANSIT', 'WALK'];
    if (!modes.length || modes.some(m => !PLAN_MODES.has(m))) return { ok: false, error: `modes can be ${[...PLAN_MODES].join(', ')}.` };
    return { ok: true, plan: { fromLat, fromLon, toLat, toLon, date, time, modes: modes.join(','), arriveBy: q.arriveBy === 'true' } };
}

module.exports = { radiusOf, planQuery, MAX_RADIUS_M, PLAN_MODES };
