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

class Timetable {
    constructor(file) {
        this.db = new Database(file, { readonly: true, fileMustExist: true });
        this.db.pragma('cache_size = -65536');   // 64 MB page cache
        this.db.pragma('mmap_size = 268435456');
        this.meta = Object.fromEntries(this.db.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value]));

        // Stops in memory
        this.stops = this.db.prepare('SELECT * FROM stops').all().map(s => ({
            ...s,
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

        this.q = {
            departuresAt: this.db.prepare('SELECT dep, tid, seq FROM stop_times WHERE sid = ? AND dep >= ?').raw(true),
            nextStops: this.db.prepare('SELECT sid FROM stop_times WHERE tid = ? AND seq > ? ORDER BY seq LIMIT 3').raw(true)
        };
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
            for (const x of this.within(lat, lon, farRadius, s => s.location_type === 0 && overlaps(s, farTypes)).slice(0, 15))
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
        const services = this.servicesOn(day);
        const from = secs(day.fromTime);
        const out = [];
        for (const code of stopCodes)
            for (const s of this.stopsByCode.get(code) || [])
                for (const [dep, tid, seq] of this.q.departuresAt.all(s.sid, from)) {
                    const t = this.trips[tid];
                    if (!services.has(t.service_id)) continue;
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

    /** For headings: the trip's next three stops after `seq`, as [lat, lon] */
    nextStops(tripId, seq) {
        const tid = this.tidOf.get(tripId);
        if (!tid) return [];
        return this.q.nextStops.all(tid, seq).map(([sid]) => { const s = this.stopBySid.get(sid); return [s.lat, s.lon]; });
    }
}

module.exports = { Timetable, metres };
