// "How long to get there from here, leaving when": a journey plan boiled down to what a
// saved-place chip shows ("Home · 34 min · leave in 3 min · 412"). Pure functions only.

const TRANSIT_MODES = new Set(['BUS', 'RAIL', 'TRAM', 'FERRY', 'SUBWAY', 'GONDOLA', 'FUNICULAR', 'CABLE_CAR']);

// A walk this short beats waiting for transit, so a walk-only plan can win
const WALK_ONLY_MAX_S = 25 * 60;

/**
 * The plan to show from OTP itineraries (legacy REST shape): the one arriving first, with
 * walk-only plans allowed only when short. Null when there is nothing sensible.
 */
function bestItinerary(itineraries) {
    const usable = (itineraries || []).filter(it =>
        it.legs?.some(l => TRANSIT_MODES.has(l.mode)) || it.duration <= WALK_ONLY_MAX_S);
    if (!usable.length) return null;
    return usable.reduce((a, b) => (b.endTime < a.endTime ? b : a));
}

/** The chip's summary of an itinerary, relative to `nowMs` */
function etaSummary(it, nowMs) {
    const firstTransit = it.legs.find(l => TRANSIT_MODES.has(l.mode));
    const walkS = it.legs.filter(l => l.mode === 'WALK').reduce((s, l) => s + (l.duration || 0), 0);
    return {
        minutes: Math.round((it.endTime - nowMs) / 60000),
        leaveInMinutes: Math.max(0, Math.round((it.startTime - nowMs) / 60000)),
        departAt: new Date(it.startTime).toISOString(),
        arriveAt: new Date(it.endTime).toISOString(),
        walkMinutes: Math.round(walkS / 60),
        transfers: it.transfers ?? 0,
        walkOnly: !firstTransit,
        firstLeg: firstTransit ? {
            mode: firstTransit.mode,
            route: firstTransit.routeShortName || null,
            headsign: firstTransit.headsign || null,
            color: firstTransit.routeColor || null,
            textColor: firstTransit.routeTextColor || null,
            stopName: firstTransit.from?.name || null,
            departAt: new Date(firstTransit.startTime).toISOString(),
            realTime: Boolean(firstTransit.realTime)
        } : null
    };
}

/** Cache key: origin to ~150 m, destination to ~50 m, and the minute */
function etaCacheKey(fromLat, fromLon, toLat, toLon, nowMs) {
    const r = (v, step) => Math.round(v / step) * step;
    return [r(fromLat, 0.0015), r(fromLon, 0.0015), r(toLat, 0.0005), r(toLon, 0.0005)]
        .map(v => v.toFixed(4)).join(',') + '@' + Math.floor(nowMs / 60000);
}

module.exports = { bestItinerary, etaSummary, etaCacheKey, TRANSIT_MODES, WALK_ONLY_MAX_S };
