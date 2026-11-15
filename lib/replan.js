// Where to get off a vehicle, and how to finish the trip: the planner's answer from a ride you're
// on (or about to board), rather than a rule of thumb. Pure: the stops and the planner are passed
// in, so it's tested without OTP.
//
// It backs two things: re-planning when you board a different bus than planned ("you're on the
// 444: get off at King George Square, walk 6 min"), and "coming next" at a stop, where each bus
// arriving gets its own arrival time at your destination.
//
// The planner (OTP) is never changed or second-guessed: getting off and walking is worked out
// here (it's only a walk), and anything with another vehicle is OTP's own plan from that stop.

const WALK_MPS = 1.25;
const DETOUR = 1.3;              // a real walk is about this much longer than the straight line
const MAX_DIRECT_WALK_M = 1000;  // further than this, finishing on foot isn't a sensible answer
const CHANGE_S = 60;             // getting off and finding the next stop takes at least this
const TIE_S = 60;                // arrivals this close count as the same: fewer changes, then less walking

function metres(aLat, aLon, bLat, bLon) {
    const kx = 111_320 * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
    return Math.hypot((bLon - aLon) * kx, (bLat - aLat) * 110_540);
}

/** The walk from a stop to the destination: straight-line metres and an estimated time */
function walkTo(stop, dest) {
    const m = metres(stop.lat, stop.lon, dest.lat, dest.lon);
    return { m, s: Math.round((m * DETOUR) / WALK_MPS) };
}

/** A stop that's a place to change: a station, a busway or an interchange */
const isHub = (stop) => Boolean(stop.hub);

/** A hub this much further from the destination than where you got on is still worth a change */
const SIDEWAYS_M = 2000;

/**
 * Stops worth asking the planner from, for a change of vehicle: hubs no more than [SIDEWAYS_M]
 * further from the destination than where you got on, nearest the destination first. (A long trip
 * often starts sideways: Roma Street's trains are further from the Gold Coast than Toowong is.)
 * With no hub, the stop nearest the destination (a bus might still be quicker than a long walk).
 */
function changeCandidates(ahead, board, dest, max) {
    const boardM = metres(board.lat, board.lon, dest.lat, dest.lon);
    const byDest = (a, b) => walkTo(a, dest).m - walkTo(b, dest).m;
    const hubs = ahead.filter(s => isHub(s) && walkTo(s, dest).m < boardM + SIDEWAYS_M).sort(byDest);
    if (hubs.length) return hubs.slice(0, max);
    const nearest = [...ahead].sort(byDest)[0];
    return nearest ? [nearest] : [];
}

/** Better first: soonest arrival; within a minute, fewer changes then less walking (or walking first) */
function compareOptions(prefer) {
    return (a, b) => {
        if (prefer === 'walking') return (a.walkM - b.walkM) || (a.arriveMs - b.arriveMs);
        if (Math.abs(a.arriveMs - b.arriveMs) > TIE_S * 1000) return a.arriveMs - b.arriveMs;
        return (a.transfers - b.transfers) || (a.walkM - b.walkM) || (a.arriveMs - b.arriveMs);
    };
}

/**
 * The best way to finish from a ride.
 *   ahead: the ride's stops after the one you board at, in order:
 *          [{ stopId, name, seq, lat, lon, etaMs, hub }]
 *   board: the stop you board at (or the vehicle's last stop, if already aboard)
 *   dest:  { lat, lon }
 *   planFrom(stop, atMs): the planner's itinerary from that stop at that time (or null)
 *   walkFrom(stop): optional, the real walk from a stop ({ s, m, geometry, steps } or null):
 *          the two most promising stops get it instead of the straight-line estimate
 * Returns { best, options } with each option
 *   { kind: 'walk' | 'change', alight, arriveMs, walkM, transfers, itinerary? }
 */
async function bestCompletion({ ahead, board, dest, planFrom, walkFrom = null, prefer = 'fastest', maxChanges = 3 }) {
    const options = [];
    for (const s of ahead) {
        const w = walkTo(s, dest);
        if (w.m <= MAX_DIRECT_WALK_M) options.push({ kind: 'walk', alight: s, arriveMs: s.etaMs + w.s * 1000, walkM: Math.round(w.m), transfers: 0 });
    }
    // Real walks for the two most promising stops: a straight line can't see the river or the mall
    if (walkFrom && options.length) {
        options.sort(compareOptions(prefer));
        await Promise.all(options.slice(0, 2).map(async (o) => {
            const w = await (async () => walkFrom(o.alight))().catch(() => null);
            if (!w || !Number.isFinite(w.s)) return;
            o.arriveMs = o.alight.etaMs + w.s * 1000;
            o.walkM = Math.round(w.m);
            o.walk = w;
        }));
    }
    // A good walk already: just a couple of changes to compare it with
    const tries = options.length ? Math.min(2, maxChanges) : maxChanges;
    const asked = await Promise.all(changeCandidates(ahead, board, dest, tries).map(async (s) => {
        // A planner that fails, at once or later, just leaves that change out
        const it = await (async () => planFrom(s, s.etaMs + CHANGE_S * 1000))().catch(() => null);
        if (!it || !Number.isFinite(it.endTime)) return null;
        const rides = (it.legs || []).filter(l => l.mode !== 'WALK').length;
        // The planner may just say walk from there: that's a walk, not a change
        return { kind: rides ? 'change' : 'walk', alight: s, arriveMs: it.endTime, walkM: Math.round(it.walkDistance ?? 0), transfers: rides, itinerary: it };
    }));
    options.push(...asked.filter(Boolean));
    options.sort(compareOptions(prefer));
    return { best: options[0] ?? null, options };
}

module.exports = { bestCompletion, changeCandidates, walkTo, metres, MAX_DIRECT_WALK_M, CHANGE_S, WALK_MPS, DETOUR };

/** Google's encoded polyline, for a ride's line cut from its trip shape */
function encodePolyline(points) {
    let out = '', lastLat = 0, lastLon = 0;
    const put = (v) => {
        v = v < 0 ? ~(v << 1) : v << 1;
        while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
        out += String.fromCharCode(v + 63);
    };
    for (const [lat, lon] of points) {
        const a = Math.round(lat * 1e5), b = Math.round(lon * 1e5);
        put(a - lastLat); put(b - lastLon);
        lastLat = a; lastLon = b;
    }
    return out;
}

/** The part of a shape ([[lat, lon]]) between the points nearest two stops */
function cutShape(shape, from, to) {
    if (!shape || shape.length < 2) return [];
    const nearest = (p, start) => {
        let best = start, bestD = Infinity;
        for (let i = start; i < shape.length; i++) {
            const d = metres(shape[i][0], shape[i][1], p.lat, p.lon);
            if (d < bestD) { bestD = d; best = i; }
        }
        return best;
    };
    const a = nearest(from, 0), b = nearest(to, a);
    return b > a ? shape.slice(a, b + 1) : [];
}

module.exports.encodePolyline = encodePolyline;
module.exports.cutShape = cutShape;

/**
 * A planned ride's live times: where it boards and gets off on its trip's stops (by stop code or id;
 * a station's code covers its platforms), and the live estimate at each. Null when the trip doesn't
 * call at both, in that order.
 */
function legOnTrip(stops, fromCode, toCode) {
    const at = (s, key) => key && (s.code === key || s.stopId === key);
    const i = stops.findIndex(s => at(s, fromCode));
    if (i < 0) return null;
    const j = stops.findIndex((s, k) => k > i && at(s, toCode));
    if (j < 0) return null;
    return { departMs: stops[i].etaMs, arriveMs: stops[j].etaMs, scheduledDepartMs: stops[i].scheduledMs ?? null,
        live: Boolean(stops[i].live || stops[j].live) };
}
module.exports.legOnTrip = legOnTrip;
