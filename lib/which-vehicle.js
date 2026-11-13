// Which vehicle is this phone riding? Given a few recent GPS fixes, rank the live vehicles it
// could be on (GET /api/which-vehicle). Pure: the feed, shapes and stop lookups are passed in.
//
// Translink's positions are 30 s to 3 min old and carry no bearing or speed, and routes share
// corridors (the 411, 412, 444 and 460 all run down Coronation Drive), so a vehicle is matched
// by where it can have got to along its own route since its fix (its "reach window"), by whether
// the rider's fixes follow that route in the same direction, and by whether it left the stop the
// rider was waiting at. Near ties are reported as ties: the app asks rather than guesses.

const STOPPED_AT = 1;                 // VehicleStopStatus
const DEFAULT_SPEED_MPS = 12;         // about 43 km/h: a bus between stops in traffic
const STOPPED_AHEAD_M = 150;          // a bus the feed says is at a stop hasn't gone far
const BEHIND_M = 30;                  // its GPS can sit a little behind where it really is
const MAX_AGE_S = 180;                // older fixes are skipped (as VEHICLE_STALE_S)
const NEAR_M = 60;                    // a rider this close to the window is "with" the bus
const DECAY_M = 200;                  // beyond that, the fit halves about every 140 m
const ON_ROUTE_M = 60;                // a fix this close to the route follows it
const MIN_MOVE_M = 30;                // less net movement than this: no direction to compare
const RIDING_MPS = 4.5;               // as the app's RIDING_SPEED_MPS
const STOP_HINT = 1.25;               // it left (or is at) the stop you were waiting at
const MIN_FIT = 0.2;
const CELL_DEG = 0.005;               // grid cells about 550 m tall, 490 m wide in Brisbane

// --- Local flat geometry, metres around an origin ---------------------------------------------

function projector(lat0, lon0) {
    const ky = 110_540, kx = 111_320 * Math.cos(lat0 * Math.PI / 180);
    return ([lat, lon]) => [(lon - lon0) * kx, (lat - lat0) * ky];
}

/** A route shape in metres, with distance along it at each point */
function lineOf(points, toXY) {
    const xy = points.map(toXY);
    const cum = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    return { xy, cum };
}

/** Nearest point of the line to p: how far along, how far off, and the line's direction there */
function project(line, [px, py]) {
    let best = null;
    for (let i = 0; i + 1 < line.xy.length; i++) {
        const [ax, ay] = line.xy[i], [bx, by] = line.xy[i + 1];
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        if (len2 < 0.25) continue;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        const dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        if (!best || dist < best.dist) best = { dist, along: line.cum[i] + t * Math.sqrt(len2), dx, dy };
    }
    return best;
}

/** Distance from p to the part of the line between two distances along it */
function distToStretch(line, p, from, to) {
    let best = Infinity;
    for (let i = 0; i + 1 < line.xy.length; i++) {
        const a0 = line.cum[i], a1 = line.cum[i + 1];
        if (a1 < from || a0 > to || a1 - a0 < 0.5) continue;
        const [ax, ay] = line.xy[i], [bx, by] = line.xy[i + 1];
        const t0 = Math.max(0, (from - a0) / (a1 - a0)), t1 = Math.min(1, (to - a0) / (a1 - a0));
        const sx = ax + t0 * (bx - ax), sy = ay + t0 * (by - ay);
        const ex = ax + t1 * (bx - ax), ey = ay + t1 * (by - ay);
        const dx = ex - sx, dy = ey - sy, len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((p[0] - sx) * dx + (p[1] - sy) * dy) / len2)) : 0;
        best = Math.min(best, Math.hypot(p[0] - (sx + t * dx), p[1] - (sy + t * dy)));
    }
    return best;
}

// --- The rider ----------------------------------------------------------------------------------

/** Fixes as [{lat, lon, t}] (t in seconds), oldest first: their average speed and net movement */
function motionOf(fixes, toXY) {
    if (fixes.length < 2) return { speedMps: 0, netM: 0, moving: false };
    let path = 0;
    for (let i = 1; i < fixes.length; i++) {
        const a = toXY([fixes[i - 1].lat, fixes[i - 1].lon]), b = toXY([fixes[i].lat, fixes[i].lon]);
        path += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    const dt = fixes[fixes.length - 1].t - fixes[0].t;
    const first = toXY([fixes[0].lat, fixes[0].lon]), last = toXY([fixes[fixes.length - 1].lat, fixes[fixes.length - 1].lon]);
    const netM = Math.hypot(last[0] - first[0], last[1] - first[1]);
    const speedMps = dt > 0 ? path / dt : 0;
    return { speedMps, netM, moving: speedMps >= RIDING_MPS && netM >= MIN_MOVE_M, dir: [last[0] - first[0], last[1] - first[1]] };
}

/** "lat,lon,t;lat,lon,t" -> [{lat, lon, t}], oldest first; at most 6, nonsense dropped */
function parseFixes(text) {
    return String(text || '').split(';').map(p => p.split(',').map(Number))
        .filter(([lat, lon, t]) => Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(t) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
        .map(([lat, lon, t]) => ({ lat, lon, t }))
        .sort((a, b) => a.t - b.t)
        .slice(-6);
}

// --- The vehicles -------------------------------------------------------------------------------

/** How far ahead of its fix a vehicle can be by now, metres */
function reachAheadM(vehicle, ageS) {
    const age = Math.min(ageS, MAX_AGE_S);
    const speed = vehicle.position?.speed > 0 ? vehicle.position.speed : DEFAULT_SPEED_MPS;
    if (vehicle.currentStatus === STOPPED_AT || vehicle.position?.speed === 0) return Math.min(age * speed, STOPPED_AHEAD_M);
    return age * speed;
}

/**
 * Live vehicles by grid cell, each in every cell its reach can cover (a 60 s old fix at 60 km/h
 * may be 1 km on), so a lookup reads one cell. Built once per feed refresh.
 * `vehicles`: iterable of [tripId, VehiclePosition].
 */
function buildGrid(vehicles, nowS) {
    const grid = new Map();
    for (const [tripId, v] of vehicles) {
        const lat = v.position?.latitude, lon = v.position?.longitude;
        if (typeof lat !== 'number' || typeof lon !== 'number') continue;
        const ts = Number(v.timestamp) || 0;
        const ageS = ts ? Math.max(0, nowS - ts) : 0;
        if (ts && ageS > MAX_AGE_S) continue;
        const aheadM = reachAheadM(v, ageS);
        const r = aheadM + BEHIND_M + NEAR_M + DECAY_M;
        const dLat = r / 110_540, dLon = r / (111_320 * Math.cos(lat * Math.PI / 180));
        const entry = { tripId, v, lat, lon, ageS: Math.round(ageS), aheadM };
        for (let i = Math.floor((lat - dLat) / CELL_DEG); i <= Math.floor((lat + dLat) / CELL_DEG); i++) {
            for (let j = Math.floor((lon - dLon) / CELL_DEG); j <= Math.floor((lon + dLon) / CELL_DEG); j++) {
                const key = i * 100_000 + j;
                (grid.get(key) || grid.set(key, []).get(key)).push(entry);
            }
        }
    }
    return grid;
}

const cellOf = (grid, lat, lon) => grid.get(Math.floor(lat / CELL_DEG) * 100_000 + Math.floor(lon / CELL_DEG)) || [];

// --- Scoring ------------------------------------------------------------------------------------

/**
 * Rank the vehicles in `entries` for these fixes.
 * shapeOf(tripId) -> [[lat, lon], ...] in travel order, or []
 * stopSeqOf(tripId) -> the sequence of the rider's waiting stop on that trip, or null
 * Returns { moving, speedMps, candidates: [{ tripId, fit, share, distanceM, ageS, calledAtStop }] }
 */
function rankVehicles(fixes, entries, { shapeOf, stopSeqOf = () => null } = {}) {
    if (!fixes.length) return { moving: false, speedMps: 0, candidates: [] };
    const now = fixes[fixes.length - 1];
    const toXY = projector(now.lat, now.lon);
    const motion = motionOf(fixes, toXY);
    if (!motion.moving) return { moving: false, speedMps: round1(motion.speedMps), candidates: [] };
    const fixXY = fixes.map(f => toXY([f.lat, f.lon]));
    const here = fixXY[fixXY.length - 1];

    const scored = [];
    for (const e of entries) {
        const shape = shapeOf(e.tripId);
        const vXY = toXY([e.lat, e.lon]);
        let distanceM, onRoute, heading;
        if (shape && shape.length >= 2) {
            const line = lineOf(shape, toXY);
            const at = project(line, vXY);
            if (!at) continue;
            distanceM = distToStretch(line, here, at.along - BEHIND_M, at.along + e.aheadM);
            onRoute = fixXY.filter(p => project(line, p).dist <= ON_ROUTE_M).length / fixXY.length;
            const mine = project(line, here);
            const [ux, uy] = motion.dir, len = Math.hypot(ux, uy) * Math.hypot(mine.dx, mine.dy);
            heading = len > 0 ? Math.max(0, (ux * mine.dx + uy * mine.dy) / len) : 0.7;
        } else {
            // No shape: straight-line distance less how far it can have gone; neutral otherwise
            distanceM = Math.max(0, Math.hypot(here[0] - vXY[0], here[1] - vXY[1]) - e.aheadM);
            onRoute = 0.5;
            heading = 0.7;
        }
        const proximity = distanceM <= NEAR_M ? 1 : Math.exp(-(distanceM - NEAR_M) / DECAY_M);
        const seq = stopSeqOf(e.tripId);
        const calledAtStop = seq != null && e.v.currentStopSequence != null && e.v.currentStopSequence >= seq;
        const fit = Math.min(1, proximity * onRoute * heading * (calledAtStop ? STOP_HINT : 1));
        if (fit >= MIN_FIT) scored.push({ tripId: e.tripId, fit, distanceM: Math.round(distanceM), ageS: e.ageS, calledAtStop, v: e.v });
    }
    scored.sort((a, b) => b.fit - a.fit);
    const top = scored.slice(0, 3);
    const total = top.reduce((s, c) => s + c.fit, 0);
    return {
        moving: true,
        speedMps: round1(motion.speedMps),
        candidates: top.map(c => ({ ...c, fit: round2(c.fit), share: round2(total ? c.fit / total : 0) }))
    };
}

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

module.exports = { parseFixes, buildGrid, cellOf, rankVehicles, reachAheadM, motionOf, projector, MAX_AGE_S };
