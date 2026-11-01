// Distance and direction helpers. Points are [lat, lon].

function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// --- Vehicle heading from the trip's shape ------------------------------------
// Translink's VehiclePositions feed sends no bearing, so derive it: snap the vehicle onto
// the trip's shape (points in travel order) and take the direction of that segment.
// Works from a single fix, so it is right even when the bus is stopped.
const MAX_OFF_SHAPE_M = 150;   // further than this from the route: don't guess a direction

function headingAlongShape(points, lat, lon, nextStop) {
    if (!points || points.length < 2 || typeof lat !== 'number' || typeof lon !== 'number') return null;
    // Local equirectangular projection around the vehicle (metres); plenty accurate at city scale
    const mPerDegLat = 111_320, mPerDegLon = 111_320 * Math.cos(lat * Math.PI / 180);
    const xy = ([pLat, pLon]) => [(pLon - lon) * mPerDegLon, (pLat - lat) * mPerDegLat];
    const project = (px, py, ax, ay, bx, by) => {
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
        const qx = ax + t * dx, qy = ay + t * dy;
        return { t, dist: Math.hypot(px - qx, py - qy), len: Math.sqrt(len2) };
    };

    const segs = [];
    let along = 0;
    for (let i = 0; i + 1 < points.length; i++) {
        const [ax, ay] = xy(points[i]), [bx, by] = xy(points[i + 1]);
        const p = project(0, 0, ax, ay, bx, by);
        if (p.len > 0.5) segs.push({ ax, ay, bx, by, dist: p.dist, along: along + p.t * p.len });
        along += p.len;
    }
    if (!segs.length) return null;
    let best = segs.reduce((a, b) => (b.dist < a.dist ? b : a));
    if (best.dist > MAX_OFF_SHAPE_M) return null;

    // Shapes that pass the same street twice (loops, out-and-back): among near-equal
    // matches, prefer the one just before the stop the vehicle is heading to
    if (nextStop) {
        const [sx, sy] = xy(nextStop);
        let stopAlong = null, stopDist = Infinity, acc = 0;
        for (let i = 0; i + 1 < points.length; i++) {
            const [ax, ay] = xy(points[i]), [bx, by] = xy(points[i + 1]);
            const p = project(sx, sy, ax, ay, bx, by);
            if (p.dist < stopDist) { stopDist = p.dist; stopAlong = acc + p.t * p.len; }
            acc += p.len;
        }
        const before = segs.filter(s => s.dist <= best.dist + 25 && s.along <= stopAlong + 30);
        if (before.length) best = before.reduce((a, b) => (b.along > a.along ? b : a));
    }

    const heading = (Math.atan2(best.bx - best.ax, best.by - best.ay) * 180 / Math.PI + 360) % 360;
    return { heading: Math.round(heading), offShapeM: Math.round(best.dist) };
}

/** GeoJSON LineString / MultiLineString ([lon, lat]) -> [[lat, lon], ...]; [] if unreadable */
function geojsonToLatLon(geojson) {
    try {
        const geo = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;
        const toLatLon = c => [c[1], c[0]];
        if (geo?.type === 'LineString') return geo.coordinates.map(toLatLon);
        if (geo?.type === 'MultiLineString') return geo.coordinates.flat().map(toLatLon);
    } catch { /* fall through */ }
    return [];
}

module.exports = { haversineMeters, headingAlongShape, geojsonToLatLon, MAX_OFF_SHAPE_M };
