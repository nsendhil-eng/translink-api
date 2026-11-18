// Which vehicle is this phone riding, by route shape and time (GET /api/ride-candidates). Pure: the
// vehicles and shapes are passed in; tested in test/ride-match.test.js.
//
// Translink's positions are 30–60 s old and carry no speed, so a vehicle's position "now" can't be
// trusted. Two things can:
//  1. Its route's shape: the rider's last minute or two of fixes either follow it, in its direction,
//     or they don't. On a shared road like Coronation Drive that still leaves ~16 routes; elsewhere
//     a handful. No vehicle position needed.
//  2. Where it was at its report time, against where the rider was at that same time (read off the
//     rider's trail, or carried at the rider's own speed along the route): a bus you're on was
//     right where you were when it reported, however old the report.
// The first call returns the set; later calls name it (`trips`) and it narrows.

const { prepareShape, windowAround, lineInWindow, project, projector, OFF_ROUTE_M } = require('./which-vehicle');

const MAX_FIXES = 40;
const MAX_TRAIL_S = 240;
const MAX_AGE_S = 180;              // older reports are skipped
const FOLLOW_M = 40;                // a fix this close to a route follows it...
const FOLLOW_MAX_M = 200;           // ...or as far as its own accuracy, up to this (GPS in a train: 100–350 m)
const FOLLOW_SHARE = 0.6;           // at least this share of the fixes must follow it
const LAST_FIX_M = 60;              // and the latest one this close
const MIN_PROGRESS_M = 25;          // along the route, forwards, over the trail: the direction
const NEAR_GAP_M = 40;              // a gap this small at report time: right with you
const GAP_DECAY_M = 150;            // beyond that, the fit falls ~e-fold per 150 m
const MIN_FIT = 0.15;
const MAX_CANDIDATES = 15;
const SEARCH_M = 2_500;             // vehicles reported further than this from the trail can't be yours
const WINDOW_EXTRA_M = 600;         // the route read this far around the trail

/** "lat,lon,epochS[,accuracyM];..." -> [{lat, lon, t, acc}], oldest first, the last MAX_FIXES within MAX_TRAIL_S */
function parseTrail(text) {
    const fixes = String(text || '').split(';').map(p => p.split(',').map(Number))
        .filter(([lat, lon, t]) => Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(t) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
        .map(([lat, lon, t, acc]) => ({ lat, lon, t, acc: Number.isFinite(acc) && acc > 0 ? acc : null }))
        .sort((a, b) => a.t - b.t);
    const last = fixes[fixes.length - 1];
    return last ? fixes.filter(f => last.t - f.t <= MAX_TRAIL_S).slice(-MAX_FIXES) : [];
}

/** The rider's movement: metres travelled, seconds, and whether it's real movement at all */
function trailMotion(fixes, toXY) {
    if (fixes.length < 2) return { pathM: 0, netM: 0, seconds: 0, speedMps: 0 };
    let pathM = 0;
    const xy = fixes.map(f => toXY([f.lat, f.lon]));
    for (let i = 1; i < xy.length; i++) pathM += Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
    const seconds = fixes[fixes.length - 1].t - fixes[0].t;
    const netM = Math.hypot(xy[xy.length - 1][0] - xy[0][0], xy[xy.length - 1][1] - xy[0][1]);
    return { pathM, netM, seconds, speedMps: seconds > 0 ? pathM / seconds : 0 };
}

/**
 * Where the rider was along this route at time `t` (s): read between the fixes either side, or
 * carried from the nearest end of the trail at the rider's own pace along the route
 */
function riderAlongAt(points, t) {
    const first = points[0], last = points[points.length - 1];
    const pace = last.t > first.t ? (last.along - first.along) / (last.t - first.t) : 0;
    if (t <= first.t) return first.along - pace * (first.t - t);
    if (t >= last.t) return last.along + pace * (t - last.t);
    for (let i = 1; i < points.length; i++) {
        if (points[i].t >= t) {
            const a = points[i - 1], b = points[i];
            return b.t > a.t ? a.along + (b.along - a.along) * (t - a.t) / (b.t - a.t) : b.along;
        }
    }
    return last.along;
}

/**
 * Score vehicles against the rider's trail.
 *   fixes: parseTrail output (at least 2)
 *   vehicles: iterable of [tripId, VehiclePosition] (the live feed)
 *   shapeOf(tripId): a prepared shape (or raw [[lat, lon]] points), or null
 *   trips: optional Set of trip ids: score only these (later calls)
 *   nowS: the time now, for report ages
 * Returns { moving, speedMps, candidates: [{ tripId, fit, gapM, follows, ageS }] }, best first
 */
function rideCandidates(fixes, vehicles, { shapeOf, trips = null, nowS }) {
    if (fixes.length < 2) return { moving: false, speedMps: 0, candidates: [] };
    const last = fixes[fixes.length - 1];
    const toXY = projector(last.lat, last.lon);
    const motion = trailMotion(fixes, toXY);
    // Real movement, at any speed: crawling traffic counts (the phone's step check rules out walking)
    const moving = motion.netM >= MIN_PROGRESS_M;
    if (!moving) return { moving, speedMps: round1(motion.speedMps), candidates: [] };
    const trailBox = windowAround(fixes.map(f => [f.lat, f.lon]), SEARCH_M);
    const trailWindow = windowAround(fixes.map(f => [f.lat, f.lon]), WINDOW_EXTRA_M);
    const fixXY = fixes.map(f => toXY([f.lat, f.lon]));

    const scored = [];
    for (const [tripId, v] of vehicles) {
        if (trips && !trips.has(tripId)) continue;
        const lat = v.position?.latitude, lon = v.position?.longitude;
        if (typeof lat !== 'number' || typeof lon !== 'number') continue;
        const ts = Number(v.timestamp) || 0;
        const ageS = ts ? Math.max(0, nowS - ts) : 0;
        if (!ts || ageS > MAX_AGE_S) continue;
        if (!trips && (lat < trailBox.minLat || lat > trailBox.maxLat || lon < trailBox.minLon || lon > trailBox.maxLon)) continue;
        const raw = shapeOf(tripId);
        const shape = raw && !raw.prepared && raw.length >= 2 ? prepareShape(raw) : raw;
        if (!shape || shape.n < 2) continue;
        // The route near the trail and near the vehicle (they can be a kilometre or two apart)
        const win = { minLat: Math.min(trailWindow.minLat, lat - 0.006), maxLat: Math.max(trailWindow.maxLat, lat + 0.006),
                      minLon: Math.min(trailWindow.minLon, lon - 0.006), maxLon: Math.max(trailWindow.maxLon, lon + 0.006) };
        const line = lineInWindow(shape, toXY, win);
        if (line.xy.length < 2) continue;

        // 1. The trail follows this route, forwards
        const onLine = fixXY.map(p => project(line, p));
        // Each fix gets as much slack as it's vague: a reading good to 150 m can't be held to 40 m
        const slack = (i) => Math.max(FOLLOW_M, Math.min(fixes[i].acc ?? FOLLOW_M, FOLLOW_MAX_M));
        const follow = onLine.filter((o, i) => o && o.dist <= slack(i)).length / fixXY.length;
        const lastOn = onLine[onLine.length - 1];
        if (follow < FOLLOW_SHARE || !lastOn || lastOn.dist > Math.max(LAST_FIX_M, slack(fixes.length - 1))) continue;
        const points = fixes.map((f, i) => ({ t: f.t, along: onLine[i]?.dist <= slack(i) * 2 ? onLine[i].along : null })).filter(p => p.along != null);
        if (points.length < 2 || points[points.length - 1].along - points[0].along < MIN_PROGRESS_M) continue;

        // 2. The vehicle is on its route, and was where the rider was when it reported
        const at = project(line, toXY([lat, lon]));
        if (!at || at.dist > OFF_ROUTE_M) continue;
        const gapM = at.along - riderAlongAt(points, ts);
        const fit = follow * (Math.abs(gapM) <= NEAR_GAP_M ? 1 : Math.exp(-(Math.abs(gapM) - NEAR_GAP_M) / GAP_DECAY_M));
        if (fit >= MIN_FIT || trips) scored.push({ tripId, fit: round2(fit), gapM: Math.round(gapM), follows: round2(follow), ageS: Math.round(ageS), v });
    }
    scored.sort((a, b) => b.fit - a.fit);
    return { moving, speedMps: round1(motion.speedMps), candidates: scored.slice(0, MAX_CANDIDATES) };
}

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

module.exports = { parseTrail, rideCandidates, riderAlongAt, trailMotion, MAX_CANDIDATES };
