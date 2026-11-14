// The timetable read in-process from the SQLite file built by scripts/build-sqlite.js
// (Phase 0: stops near me and departures, to compare with the Postgres versions).
//
// Stops (13k) live in memory with a grid index: "stops near me" never touches the file.
// Timetable lookups are indexed reads of the file.
const Database = require('better-sqlite3');

// WGS84, for distances that match PostGIS geography within centimetres at these ranges
const A = 6378137, E2 = 0.00669437999014;
const RAD = Math.PI / 180;

/** Metres between two points: ellipsoidal, flat at this scale (good to well under 1 m within 10 km) */
function metres(lat1, lon1, lat2, lon2) {
    const phi = ((lat1 + lat2) / 2) * RAD;
    const w = 1 - E2 * Math.sin(phi) ** 2;
    const M = (A * (1 - E2)) / (w * Math.sqrt(w));      // north-south radius of curvature
    const N = A / Math.sqrt(w);                          // east-west
    const dy = (lat2 - lat1) * RAD * M;
    const dx = (lon2 - lon1) * RAD * N * Math.cos(phi);
    return Math.hypot(dx, dy);
}

const CELL = 0.01;   // degrees, about 1.1 km
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const pad2 = (n) => String(n).padStart(2, '0');
const gtfsTime = (s) => `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
const secs = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + s; };
const byText = (a, b) => (a === b ? 0 : a === null || a === undefined ? 1 : b === null || b === undefined ? -1 : a < b ? -1 : 1);   // NULLs last, as Postgres

/** A compiled SQL ILIKE pattern ('%' any run, '_' one character, backslash escapes) */
function ilike(pattern) {
    const special = /[.*+?^${}()|[\]\\/]/g;
    const src = pattern.replace(/\\(.)|%+|_|[.*+?^${}()|[\]\\/]/gsu, (m, escaped) => {
        if (escaped !== undefined) return escaped.replace(special, '\\$&');
        if (m[0] === '%') return '.*';
        return m === '_' ? '.' : `\\${m}`;
    });
    return new RegExp(`^${src}$`, 'isu');
}

/** Douglas-Peucker, as PostGIS ST_Simplify: planar in degrees; keeps a point only if strictly over the tolerance */
function simplify(points, tolerance) {
    if (points.length < 3) return points;
    const tol2 = tolerance * tolerance;
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [first, last] = stack.pop();
        if (last - first < 2) continue;
        const [ay, ax] = points[first], [by, bx] = points[last];
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        let max = -1, split = first;
        for (let i = first + 1; i < last; i++) {
            const [py, px] = points[i];
            let d2;
            if (len2 === 0) d2 = (px - ax) ** 2 + (py - ay) ** 2;
            else {
                const r = ((px - ax) * dx + (py - ay) * dy) / len2;
                const qx = r <= 0 ? ax : r >= 1 ? bx : ax + r * dx, qy = r <= 0 ? ay : r >= 1 ? by : ay + r * dy;
                d2 = (px - qx) ** 2 + (py - qy) ** 2;
            }
            if (d2 > max) { max = d2; split = i; }
        }
        if (max > tol2) { keep[split] = 1; stack.push([split, last], [first, split]); }
    }
    return points.filter((_, i) => keep[i]);
}

class Timetable {
    constructor(file) {
        this.db = new Database(file, { readonly: true, fileMustExist: true });
        this.db.pragma('cache_size = -65536');   // 64 MB page cache
        this.db.pragma('mmap_size = 268435456');
        this.meta = Object.fromEntries(this.db.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value]));

        // Stops in memory
        this.stops = this.db.prepare('SELECT * FROM stops').all().map(s => ({
            ...s,
            // Sorted, as Postgres gives them (files built before 2026-11-09 kept the feed's order)
            servicing_routes: s.servicing_routes ? s.servicing_routes.split(', ').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(', ') : null,
            route_directions: s.route_directions ? JSON.parse(s.route_directions) : null,
            route_types: s.route_types ? JSON.parse(s.route_types) : null
        }));
        this.stopById = new Map(this.stops.map(s => [s.stop_id, s]));
        this.stopBySid = new Map(this.stops.map(s => [s.sid, s]));
        this.stopsByCode = new Map();
        this.childrenOf = new Map();
        this.grid = new Map();
        for (const s of this.stops) {
            if (s.stop_code) (this.stopsByCode.get(s.stop_code) || this.stopsByCode.set(s.stop_code, []).get(s.stop_code)).push(s);
            if (s.parent_station) (this.childrenOf.get(s.parent_station) || this.childrenOf.set(s.parent_station, []).get(s.parent_station)).push(s);
            if (s.lat == null) continue;
            const k = `${Math.floor(s.lat / CELL)},${Math.floor(s.lon / CELL)}`;
            (this.grid.get(k) || this.grid.set(k, []).get(k)).push(s);
        }

        // Calendar in memory (a couple of hundred rows)
        this.calendar = this.db.prepare('SELECT * FROM calendar').all();
        this.calendarDates = new Map();
        for (const r of this.db.prepare('SELECT * FROM calendar_dates').all())
            (this.calendarDates.get(r.date) || this.calendarDates.set(r.date, []).get(r.date)).push(r);

        // Trips and routes in memory too (about 130k trips): a departure row is then three
        // numbers read from the file, with no joins
        this.routes = new Map(this.db.prepare('SELECT * FROM routes').all().map(r => [r.route_id, r]));
        this.trips = [];
        for (const t of this.db.prepare('SELECT * FROM trips').iterate()) { t.route = this.routes.get(t.route_id); this.trips[t.tid] = t; }
        this.tidOf = new Map();
        for (const t of this.trips) if (t) this.tidOf.set(t.trip_id, t.tid);

        // Files built before Phase 3 lack these; the endpoints that need them stay on Postgres
        const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
        this.complete = tables.has('shapes') && tables.has('route_stops');

        this.q = {
            departuresAt: this.db.prepare('SELECT dep, tid, seq FROM stop_times WHERE sid = ? AND dep >= ?').raw(true),
            nextStops: this.db.prepare('SELECT sid FROM stop_times WHERE tid = ? AND seq > ? ORDER BY seq LIMIT 3').raw(true),
            tripStopSids: this.db.prepare('SELECT sid FROM stop_times WHERE tid = ?').raw(true)
        };
        if (!this.complete) return;

        // Broad searches hit their limit, so which stops they keep depends on this: stations first
        this.searchOrder = [...this.stops.filter(s => s.location_type === 1), ...this.stops.filter(s => s.location_type !== 1)];

        // One representative trip per route + headsign, first in feed order (search)
        this.routeVariants = new Map();
        for (const t of this.trips) {
            if (!t) continue;
            let m = this.routeVariants.get(t.route_id);
            if (!m) this.routeVariants.set(t.route_id, m = new Map());
            if (!m.has(t.trip_headsign)) m.set(t.trip_headsign, t);
        }
        Object.assign(this.q, {
            tripTimes: this.db.prepare('SELECT seq, dep, sid FROM stop_times WHERE tid = ? ORDER BY seq').raw(true),
            lastDep: this.db.prepare('SELECT max(dep) FROM stop_times WHERE tid = ?').pluck(),
            tripsAt: this.db.prepare('SELECT tid FROM stop_times WHERE sid = ?').pluck(),
            shape: this.db.prepare('SELECT pts FROM shapes WHERE shape_id = ?').pluck(),
            shapesInBox: this.db.prepare('SELECT shape_id FROM shapes WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?').pluck(),
            routeStopsHeadsign: this.db.prepare('SELECT DISTINCT sid FROM route_stops WHERE route_id = ? AND headsign = ?').pluck(),
            routeStopsDirection: this.db.prepare('SELECT DISTINCT sid FROM route_stops WHERE route_id = ? AND direction_id = ?').pluck(),
            routesAtSid: this.db.prepare('SELECT DISTINCT route_id FROM route_stops WHERE sid = ?').pluck()
        });
    }

    /** Service ids running on a service day ({ dateString: "20261109", dayOfWeek: "monday" }) */
    servicesOn(day) {
        const set = new Set();
        for (const c of this.calendar)
            if (c.start_date <= day.dateString && c.end_date >= day.dateString && c[day.dayOfWeek] === 1) set.add(c.service_id);
        for (const d of this.calendarDates.get(day.dateString) || []) {
            if (d.exception_type === 2) set.delete(d.service_id);
            else if (d.exception_type === 1) set.add(d.service_id);
        }
        return set;
    }

    /** Stops within `radius` metres, nearest first: [{ stop, distance }] */
    within(lat, lon, radius, filter = () => true) {
        const dLat = radius / 110_000, dLon = radius / (110_000 * Math.cos(lat * RAD));
        const out = [];
        for (let i = Math.floor((lat - dLat) / CELL); i <= Math.floor((lat + dLat) / CELL); i++)
            for (let j = Math.floor((lon - dLon) / CELL); j <= Math.floor((lon + dLon) / CELL); j++)
                for (const s of this.grid.get(`${i},${j}`) || []) {
                    if (!filter(s)) continue;
                    const d = metres(lat, lon, s.lat, s.lon);
                    if (d <= radius) out.push({ stop: s, distance: d });
                }
        return out.sort((a, b) => a.distance - b.distance);
    }

    /** A stop as /api/stops-near-me returns it */
    stopRow(s, lat, lon) {
        return {
            id: s.stop_id, name: s.stop_name, stop_code: s.stop_code, parent_station: s.parent_station,
            servicing_routes: s.servicing_routes, route_directions: s.route_directions, route_types: s.route_types,
            parent_station_name: s.parent_station ? this.stopById.get(s.parent_station)?.stop_name ?? null : null,
            distance_m: Math.round(metres(lat, lon, s.lat, s.lon)),
            latitude: s.lat, longitude: s.lon
        };
    }

    /** /api/stops-near-me, same rules as the Postgres version */
    stopsNearMe({ lat, lon, radius = 500, types = null, farRadius = 0, farTypes = [2, 4] }) {
        const overlaps = (s, ts) => (s.route_types || []).some(t => ts.includes(t));
        const rows = this.within(lat, lon, radius, s => !types || overlaps(s, types)).slice(0, 25).map(x => this.stopRow(x.stop, lat, lon));
        if (farRadius > radius) {
            const have = new Set(rows.map(r => r.id));
            // Busway and bus stations too (platforms with a parent station): Eight Mile Plains
            // station, a kilometre from McGarry St, was missing while it's by far the best option
            const worthTheWalk = (s) => overlaps(s, farTypes) || (Boolean(s.parent_station) && overlaps(s, [3]));
            for (const x of this.within(lat, lon, farRadius, s => s.location_type === 0 && worthTheWalk(s)).slice(0, 15))
                if (!have.has(x.stop.stop_id)) rows.push(this.stopRow(x.stop, lat, lon));
        }
        const parents = [...new Set(rows.map(r => r.parent_station).filter(Boolean))];
        if (parents.length) {
            const have = new Set(rows.map(r => r.id));
            for (const p of parents)
                for (const s of this.childrenOf.get(p) || []) {
                    if (have.has(s.stop_id)) continue;
                    if (types && types.length && !overlaps(s, types)) continue;
                    rows.push(this.stopRow(s, lat, lon));
                }
            rows.sort((a, b) => a.distance_m - b.distance_m);
        }
        return rows;
    }

    /**
     * The scheduled part of /api/departures: stop times at these stop codes from `day.fromTime`
     * on `day`, with their trip and route; the same columns the Postgres query returns.
     */
    scheduledDepartures(stopCodes, day) {
        return this.scheduledAt(stopCodes.flatMap(code => this.stopsByCode.get(code) || []), day);
    }

    /** Stop times at these stops from `day.fromTime`, optionally only one route + direction */
    scheduledAt(stops, day, { routeId = null, directionId = null } = {}) {
        const services = this.servicesOn(day);
        const from = secs(day.fromTime);
        const out = [];
        for (const s of stops)
                for (const [dep, tid, seq] of this.q.departuresAt.all(s.sid, from)) {
                    const t = this.trips[tid];
                    if (!services.has(t.service_id)) continue;
                    if (routeId !== null && (t.route_id !== routeId || t.direction_id !== directionId)) continue;
                    const r = t.route;
                    out.push({
                        trip_id: t.trip_id, stop_id: s.stop_id, stop_name: s.stop_name, stop_sequence: seq,
                        departure_time: gtfsTime(dep), platform_code: s.platform_code,
                        trip_headsign: t.trip_headsign, direction_id: t.direction_id, shape_id: t.shape_id,
                        route_id: r.route_id, route_short_name: r.route_short_name, route_long_name: r.route_long_name,
                        route_color: r.route_color, route_text_color: r.route_text_color, route_type: r.route_type,
                        stop_lat: s.lat, stop_lon: s.lon
                    });
                }
        return out;
    }

    /** scheduledAt by stop id */
    upcoming(stopIds, day, filter) {
        return this.scheduledAt(stopIds.map(id => this.stopById.get(id)).filter(Boolean), day, filter);
    }

    route(routeId) { return this.routes.get(routeId) ?? null; }
    trip(tripId) { const tid = this.tidOf.get(tripId); return tid ? this.trips[tid] : null; }

    /** A trip's stops in order */
    tripStopTimes(tripId) {
        const tid = this.tidOf.get(tripId);
        if (!tid) return [];
        return this.q.tripTimes.all(tid).map(([seq, dep, sid]) => {
            const s = this.stopBySid.get(sid);
            return { stop_sequence: seq, departure_time: gtfsTime(dep), stop_id: s.stop_id, stop_name: s.stop_name, lat: s.lat, lon: s.lon };
        });
    }

    /** Is this trip scheduled on `day`, with stops still due from `day.fromTime`? */
    tripRunsOn(tripId, day) {
        const t = this.trip(tripId);
        return Boolean(t && this.servicesOn(day).has(t.service_id) && this.q.lastDep.get(t.tid) >= secs(day.fromTime));
    }

    stopsOfRouteHeadsign(routeId, headsign) { return this.q.routeStopsHeadsign.all(routeId, headsign).map(sid => this.stopBySid.get(sid)); }
    stopsOfRouteDirection(routeId, directionId) { return this.q.routeStopsDirection.all(routeId, directionId).map(sid => this.stopBySid.get(sid)); }

    /** The route's stop in this direction nearest the point, or (no point) its lowest stop id */
    routeStopFor(routeId, directionId, lat = null, lon = null) {
        const stops = this.stopsOfRouteDirection(routeId, directionId);
        if (!stops.length) return null;
        if (lat === null) return stops.map(s => s.stop_id).sort(byText)[0];
        return stops.reduce((best, s) => {
            const d = metres(lat, lon, s.lat, s.lon);
            return d < best.d ? { d, id: s.stop_id } : best;
        }, { d: Infinity, id: null }).id;
    }

    /** Route ids serving any of these stop ids */
    routeIdsAt(stopIds) {
        const out = new Set();
        for (const id of stopIds) {
            const s = this.stopById.get(id);
            if (s) for (const r of this.q.routesAtSid.all(s.sid)) out.add(r);
        }
        return [...out];
    }

    /** Distinct routes (name, type, colours) serving these stop codes, as /api/routes-for-stops */
    routesForStopCodes(codes) {
        const seen = new Map();
        for (const code of codes)
            for (const s of this.stopsByCode.get(code) || [])
                for (const id of this.q.routesAtSid.all(s.sid)) {
                    const r = this.routes.get(id);
                    seen.set([r.route_short_name, r.route_type, r.route_color, r.route_text_color].join('\0'), {
                        route_short_name: r.route_short_name, route_type: r.route_type,
                        route_color: r.route_color, route_text_color: r.route_text_color
                    });
                }
        return [...seen.values()].sort((a, b) => a.route_type - b.route_type || byText(a.route_short_name, b.route_short_name) ||
            byText(a.route_color, b.route_color) || byText(a.route_text_color, b.route_text_color));
    }

    /** These stops plus their sibling platforms, as { stop_id, parent } */
    stopsWithSiblings(stopIds) {
        const out = new Map();
        for (const id of stopIds) {
            const s = this.stopById.get(id);
            if (!s) continue;
            out.set(s.stop_id, { stop_id: s.stop_id, parent: s.parent_station });
            if (s.parent_station) for (const c of this.childrenOf.get(s.parent_station) || []) out.set(c.stop_id, { stop_id: c.stop_id, parent: c.parent_station });
        }
        return [...out.values()];
    }

    /** Every rail station: { stop_id, stop_name, lat, lon } */
    railStations() {
        return this.railStationList ??= this.stops.filter(s => s.location_type === 1 && / station$/i.test(s.stop_name || ''))
            .map(s => ({ stop_id: s.stop_id, stop_name: s.stop_name, lat: s.lat, lon: s.lon }));
    }

    /** The station ids a train calling at both stations passes, in order; [] if none does */
    stationIdsAlongTrain(fromId, toId) {
        const toSids = new Set((this.childrenOf.get(toId) || []).map(s => s.sid));
        for (const s of this.childrenOf.get(fromId) || [])
            for (const tid of this.q.tripsAt.all(s.sid)) {
                if (this.trips[tid].route.route_type !== 2) continue;
                const calls = this.q.tripTimes.all(tid);
                if (calls.some(([, , sid]) => toSids.has(sid))) return calls.map(([, , sid]) => this.stopBySid.get(sid).parent_station);
            }
        return [];
    }

    /** The nearest `limit` stops: { stop_id, stop_name, parent, servicing_routes, dist } */
    nearestStops(lat, lon, limit) {
        return this.stops.filter(s => s.lat != null)
            .map(s => ({ stop_id: s.stop_id, stop_name: s.stop_name, parent: s.parent_station, servicing_routes: s.servicing_routes, dist: Math.round(metres(lat, lon, s.lat, s.lon)) }))
            .sort((a, b) => a.dist - b.dist).slice(0, limit);
    }

    /** A stop as the search endpoints return it */
    searchRow(s) {
        return {
            id: s.stop_id, name: s.stop_name, stop_code: s.stop_code, parent_station: s.parent_station,
            servicing_routes: s.servicing_routes, route_directions: s.route_directions, route_types: s.route_types,
            parent_station_name: s.parent_station ? this.stopById.get(s.parent_station)?.stop_name ?? null : null,
            latitude: s.lat, longitude: s.lon
        };
    }

    /** Routes whose name matches, one row per headsign: name, then headsign, then route id */
    matchingRouteVariants(q, limit) {
        const m = ilike(`%${q}%`);
        const hit = (v) => v != null && m.test(v);
        const out = [];
        for (const r of this.routes.values()) {
            if (!hit(r.route_short_name) && !hit(r.route_long_name)) continue;
            for (const [headsign, t] of this.routeVariants.get(r.route_id) || []) out.push({ r, t, headsign });
        }
        return out.sort((a, b) => byText(a.r.route_short_name, b.r.route_short_name) || byText(a.headsign, b.headsign) || byText(a.r.route_id, b.r.route_id)).slice(0, limit);
    }

    /** /api/search: the web app's stops and routes */
    searchV1(q) {
        const m = ilike(`%${q}%`);
        const initial = [];
        for (const s of this.searchOrder) {
            if (m.test(s.stop_name || '') || m.test(s.stop_desc || '')) initial.push(s);
            if (initial.length === 20) break;
        }
        const ids = new Set(initial.map(s => s.stop_id));
        const parents = new Set(initial.map(s => s.parent_station).filter(Boolean));
        const stops = this.stops.filter(s => ids.has(s.stop_id) || parents.has(s.parent_station) || parents.has(s.stop_id)).map(s => this.searchRow(s));
        const routes = this.matchingRouteVariants(q, 10).map(({ r, t, headsign }) => ({
            route_id: r.route_id, route_short_name: r.route_short_name, route_long_name: r.route_long_name,
            route_color: r.route_color, trip_headsign: headsign, shape_id: t.shape_id
        }));
        return { stops, routes };
    }

    /** /api/v2/search: the apps' stops (order-independent words, whole stations) and routes */
    searchV2(q, lat, lon) {
        const tests = q.trim().split(/\s+/).filter(Boolean).map(t => ilike(`%${t}%`));
        const hasLocation = lat !== null;
        let initial = this.searchOrder.filter(s => tests.every(m => m.test(s.stop_name || '')) || tests.every(m => m.test(s.stop_desc || '')));
        // The 50 kept are the nearest when we know where the user is
        if (hasLocation) initial = initial.sort((a, b) => metres(lat, lon, a.lat, a.lon) - metres(lat, lon, b.lat, b.lon));
        initial = initial.slice(0, 50);
        const expanded = new Set();
        for (const s of initial) {
            for (const c of this.childrenOf.get(s.parent_station || s.stop_id) || []) expanded.add(c);
            if (!s.parent_station) expanded.add(s);
        }
        let stops = [...expanded].filter(s => s.stop_code).sort((a, b) => a.sid - b.sid)
            .map(s => ({ ...this.searchRow(s), distance_m: hasLocation ? Math.round(metres(lat, lon, s.lat, s.lon)) : null }));
        stops = stops.sort(hasLocation ? (a, b) => a.distance_m - b.distance_m : (a, b) => byText(a.name, b.name)).slice(0, 20);
        const routes = this.matchingRouteVariants(q, 20).map(({ r, t, headsign }) => ({
            route_id: r.route_id, route_short_name: r.route_short_name, route_long_name: r.route_long_name,
            route_color: r.route_color, route_text_color: r.route_text_color, route_type: r.route_type,
            trip_headsign: headsign, direction_id: t.direction_id, shape_id: t.shape_id
        }));
        return { stops, routes };
    }

    /** A shape's points as [[lat, lon], ...], [] when unknown */
    shape(shapeId) {
        const buf = shapeId ? this.q.shape.get(shapeId) : null;
        if (!buf) return [];
        const pts = new Array(buf.length / 8);
        for (let i = 0; i < pts.length; i++) pts[i] = [buf.readInt32LE(i * 8) / 1e7, buf.readInt32LE(i * 8 + 4) / 1e7];
        return pts;
    }

    /** As ST_Simplify(shape, tolerance) */
    simplifiedShape(shapeId, tolerance) { return simplify(this.shape(shapeId), tolerance); }

    /** Up to 30 routes with a shape near the point, by route id: { route_id, route_color, points } */
    shapesNearMe(lat, lon, delta) {
        if (!this.routesOfShape) {
            this.routesOfShape = new Map();
            for (const t of this.trips) {
                if (!t?.shape_id) continue;
                let set = this.routesOfShape.get(t.shape_id);
                if (!set) this.routesOfShape.set(t.shape_id, set = new Set());
                set.add(t.route_id);
            }
        }
        const shapeOf = new Map();
        for (const id of this.q.shapesInBox.all(lat - delta, lat + delta, lon - delta, lon + delta))
            for (const r of this.routesOfShape.get(id) || []) if (!shapeOf.has(r)) shapeOf.set(r, id);
        return [...shapeOf.keys()].sort(byText).slice(0, 30)
            .map(r => ({ route_id: r, route_color: this.routes.get(r)?.route_color ?? null, points: this.simplifiedShape(shapeOf.get(r), 0.00008) }));
    }

    /** Of these trips, the ones that call at any of these stop ids (departures' get_off_stop) */
    tripsCallingAt(tripIds, stopIds) {
        const sids = new Set(stopIds.map(id => this.stopById.get(id)?.sid).filter(Boolean));
        const out = new Set();
        for (const tripId of tripIds) {
            const tid = this.tidOf.get(tripId);
            if (tid && this.q.tripStopSids.all(tid).some(([sid]) => sids.has(sid))) out.add(tripId);
        }
        return out;
    }

    /** A stop's position, [lat, lon], or null */
    stopPosition(stopId) {
        const s = this.stopById.get(stopId);
        return s ? [s.lat, s.lon] : null;
    }

    /** For headings: the trip's next three stops after `seq`, as [lat, lon] */
    nextStops(tripId, seq) {
        const tid = this.tidOf.get(tripId);
        if (!tid) return [];
        return this.q.nextStops.all(tid, seq).map(([sid]) => { const s = this.stopBySid.get(sid); return [s.lat, s.lon]; });
    }
}

module.exports = { Timetable, metres, simplify, ilike };
