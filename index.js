// index.js (Cleaned up and corrected)

require('dotenv').config();
const { Pool } = require('pg');
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const protobuf = require('protobufjs');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());

const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
});
// Neon drops idle connections. On an always-on server an unhandled error here would end the
// process; the pool simply opens a new connection for the next query.
pool.on('error', (err) => console.warn('Idle database connection closed:', err.message));

const REALTIME_URL = 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates';
const VEHICLE_POSITIONS_URL = 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions';
const fetchOptions = { headers: { 'User-Agent': 'Mozilla/5.0' } };

// --- Shared GTFS-RT feed cache ----------------------------------------------
// Every live endpoint reads Translink's feeds through these caches instead of fetching
// per request (TripUpdates is ~1.2 MB). Per server instance:
//  - refresh at most once per TTL; concurrent requests share one in-flight download
//  - an index by trip_id is built once per refresh, not re-scanned by every endpoint
//  - if a refresh fails, serve the last good copy for up to STALE_MAX_MS
const STALE_MAX_MS = 120_000;

function createFeedCache(name, url, ttlMs, buildIndex) {
    let current = null;     // { feed, index, fetchedAt }
    let inFlight = null;
    const refresh = async () => {
        const r = await fetch(url, fetchOptions);
        if (!r.ok) throw new Error(`${name} feed HTTP ${r.status}`);
        const feed = gtfsRealtime.decode(Buffer.from(await r.arrayBuffer()));
        current = { feed, index: buildIndex(feed), fetchedAt: Date.now() };
        return current;
    };
    return async function get() {
        if (current && Date.now() - current.fetchedAt < ttlMs) return current;
        if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
        try {
            return await inFlight;
        } catch (err) {
            if (current && Date.now() - current.fetchedAt < STALE_MAX_MS) {
                console.warn(`${name} refresh failed, serving ${Math.round((Date.now() - current.fetchedAt) / 1000)}s old copy:`, err.message);
                return current;
            }
            throw err;
        }
    };
}

// trip_id -> TripUpdate
const getTripUpdates = createFeedCache('TripUpdates', REALTIME_URL, 10_000, (feed) => {
    const byTrip = new Map();
    for (const e of feed.entity) if (e.tripUpdate?.trip?.tripId) byTrip.set(e.tripUpdate.trip.tripId, e.tripUpdate);
    return byTrip;
});

// trip_id -> VehiclePosition; with duplicate vehicles on a trip, see preferVehicle
const getVehiclePositions = createFeedCache('VehiclePositions', VEHICLE_POSITIONS_URL, 4_000, (feed) => {
    const nowS = Date.now() / 1000;
    const byTrip = new Map();
    for (const e of feed.entity) {
        const v = e.vehicle;
        const id = v?.trip?.tripId;
        if (id && preferVehicle(v, byTrip.get(id), nowS)) byTrip.set(id, v);
    }
    return byTrip;
});

const { haversineMeters, departureHeading, headingAlongShape, pathAhead, geojsonToLatLon } = require('./lib/geo');
const {
    STOP_SKIPPED, VEHICLE_STALE_S, serviceDay, activeServiceDays, scheduledUtc, formatBrisbane, stopEvent, liveStopTime,
    toNum, isTripCancelled, isStopSkipped, fixAgeSeconds, isFreshFix, preferVehicle, vehiclePassedStop, passedPerFeed
} = require('./lib/realtime');
const { routeCode, parseAlertEntity, alertWindow, alertJson } = require('./lib/alerts');
const { affectedStationNames, closureEnds, matchStations } = require('./lib/alertPages');
const { bestItinerary, etaSummary, etaCacheKey } = require('./lib/eta');
const { SEQ_BBOX, HOUSE_NUMBER_PREFIX, fromPhoton, fromNominatim, tidy } = require('./lib/places');

// --- Timetable by service day ----------------------------------------------------
/** SQL list of the service_ids running on the date in parameter `dateParam` ('$2') */
const servicesRunningOn = (dateParam, dayOfWeek) => `(
    (SELECT service_id FROM calendar WHERE start_date <= ${dateParam} AND end_date >= ${dateParam} AND ${dayOfWeek} = 1)
    EXCEPT (SELECT service_id FROM calendar_dates WHERE date = ${dateParam} AND exception_type = 2)
    UNION (SELECT service_id FROM calendar_dates WHERE date = ${dateParam} AND exception_type = 1)
)`;

/**
 * Upcoming stop times, read once per service day that can still have services due
 * (today, plus yesterday's after-midnight trips early in the morning; see activeServiceDays).
 * `buildSql(services)` gets that day's service_id list; in the query $1 is the date, $2 the
 * earliest departure_time worth reading (filter `st.departure_time >= $2`), and `params`
 * follow from $3. Each row comes back with `day`, for scheduledUtc.
 */
async function upcomingStopTimes(buildSql, params, now = new Date()) {
    const days = activeServiceDays(now);
    const results = await Promise.all(days.map(d =>
        pool.query(buildSql(servicesRunningOn('$1', d.dayOfWeek)), [d.dateString, d.fromTime, ...params])));
    return results.flatMap((r, i) => r.rows.map(row => ({ ...row, day: days[i] })));
}

// --- Service alerts --------------------------------------------------------------
const ALERTS_URL = 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts';

const getAlerts = createFeedCache('Alerts', ALERTS_URL, 60_000, (feed) => {
    const obj = gtfsRealtime.toObject(feed, { enums: String, longs: Number });
    return (obj.entity || []).filter(e => e.alert).map(parseAlertEntity);
});

// --- Which stations a rail closure covers --------------------------------------
// The feed names only routes for rail closures, so "Ipswich to Rosewood closed" matched every
// Ipswich-line station. The alert's Translink page lists the stations (lib/alertPages.js).
// Per instance: pages are cached for hours, and a request waits briefly for any not yet read.
const SECTION_TTL_MS = 6 * 3600_000;
const SECTION_RETRY_MS = 30 * 60_000;    // after a failed or unreadable page
const SECTION_WAIT_MS = 2500;
const sectionCache = new Map();          // alert id -> { at, stations: [...] | null, pending }
let railStationsPromise = null;          // every station: { stop_id, stop_name, lat, lon }

const needsSection = (a) => a.stopIds.size === 0 && /translink\.com\.au\/updates\//.test(a.url || '') &&
    [...a.routeCodes].some(c => /^[A-Z]{4}$/.test(c));   // rail route codes: "BRIP"

const railStations = () => railStationsPromise ??= pool.query(`
    SELECT stop_id, stop_name, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon
    FROM stops WHERE location_type = 1 AND stop_name ILIKE '% station'
`).then(r => r.rows).catch(e => { railStationsPromise = null; throw e; });

/** Stations along a train trip from one station to the other, both included */
async function stationsBetween(from, to) {
    const { rows } = await pool.query(`
        WITH trip AS (
            SELECT st.trip_id FROM stop_times st JOIN stops s ON s.stop_id = st.stop_id
            JOIN trips t ON t.trip_id = st.trip_id JOIN routes r ON r.route_id = t.route_id
            WHERE s.parent_station IN ($1, $2) AND r.route_type = 2   -- a train, not the railbus
            GROUP BY st.trip_id HAVING count(DISTINCT s.parent_station) = 2 LIMIT 1
        )
        SELECT s.parent_station AS stop_id FROM stop_times st
        JOIN trip ON trip.trip_id = st.trip_id JOIN stops s ON s.stop_id = st.stop_id
        ORDER BY st.stop_sequence
    `, [from.stop_id, to.stop_id]);
    const ids = rows.map(r => r.stop_id);
    const [i, j] = [ids.indexOf(from.stop_id), ids.indexOf(to.stop_id)].sort((x, y) => x - y);
    if (i < 0) return [];
    const byId = new Map((await railStations()).map(s => [s.stop_id, s]));
    return ids.slice(i, j + 1).map(id => byId.get(id)).filter(Boolean);
}

async function readSection(a) {
    const stations = await railStations();
    const html = await (await fetch(a.url, { ...fetchOptions, timeout: 5000 })).text();
    let found = matchStations(affectedStationNames(html), stations);
    if (!found.length) {
        // No list: "trains will not run between Northgate and Shorncliffe stations"
        const ends = closureEnds(html);
        const [from, to] = ends ? matchStations(ends, stations) : [];
        if (from && to) found = await stationsBetween(from, to);
    }
    return found.length ? found : null;
}

/** For clients: ["Ipswich", "Thomas Street", …], or null when the closed stations aren't known */
const stationNames = (section) => section ? section.map(s => s.stop_name.replace(/ station$/i, '')) : null;

/** alert id -> the stations its closure covers, for the rail alerts whose page says */
async function closureSections(alerts) {
    const now = Date.now();
    const waits = [];
    for (const a of alerts) {
        if (!needsSection(a)) continue;
        const c = sectionCache.get(a.id);
        if (c && (c.pending || now - c.at < (c.stations ? SECTION_TTL_MS : SECTION_RETRY_MS))) {
            if (c.pending) waits.push(c.pending);
            continue;
        }
        const entry = { at: now, stations: c?.stations ?? null, pending: null };
        entry.pending = readSection(a)
            .then(s => { entry.stations = s; })
            .catch(e => console.error(`alert ${a.id} page:`, e.message))
            .finally(() => { entry.at = Date.now(); entry.pending = null; });
        sectionCache.set(a.id, entry);
        waits.push(entry.pending);
    }
    if (waits.length) await Promise.race([Promise.all(waits), new Promise(r => setTimeout(r, SECTION_WAIT_MS))]);
    const out = new Map();
    for (const a of alerts) { const s = sectionCache.get(a.id)?.stations; if (s) out.set(a.id, s); }
    return out;
}

// Load the GTFS-realtime schema once when the server starts
let gtfsRealtime;
protobuf.load(path.join(__dirname, 'gtfs-realtime.proto')).then((root) => {
    gtfsRealtime = root.lookupType("transit_realtime.FeedMessage");
    console.log('✅ GTFS-realtime schema loaded.');
}).catch(err => console.error('❌ Failed to load GTFS-realtime schema:', err));


// --- UNIFIED SEARCH ENDPOINT ---
app.get('/api/search', async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 3) { return res.json({ stops: [], routes: [] }); }

    try {
        const searchQuery = `%${q}%`;

        // Step 1: Find initial matching stops and their parent stations.
        const initialStopsResult = await pool.query(`
            WITH initial_matches AS (
                SELECT stop_id, parent_station
                FROM stops
                WHERE stop_name ILIKE $1 OR COALESCE(stop_desc, '') ILIKE $1
                LIMIT 20
            )
            SELECT s.stop_id AS id, s.stop_name AS name, s.stop_code, s.parent_station, s.servicing_routes, s.route_directions, s.route_types,
                parent.stop_name AS parent_station_name,
                ST_Y(s.location::geometry) AS latitude, ST_X(s.location::geometry) AS longitude
            FROM stops s
            LEFT JOIN stops parent ON s.parent_station = parent.stop_id
            WHERE s.stop_id IN (SELECT stop_id FROM initial_matches)
               OR s.parent_station IN (SELECT parent_station FROM initial_matches WHERE parent_station IS NOT NULL AND parent_station != '')
               OR s.stop_id IN (SELECT parent_station FROM initial_matches WHERE parent_station IS NOT NULL AND parent_station != '');
        `, [searchQuery]);

        // De-duplicate stops, as the query might return the same stop multiple times
        const uniqueStops = Array.from(new Map(initialStopsResult.rows.map(stop => [stop.id, stop])).values());

        // The stopsPromise is now resolved.
        const stopsPromise = Promise.resolve({ rows: uniqueStops });

        // Search for routes with distinct headsigns
        const routesPromise = pool.query(`
            SELECT
                r.route_id,
                r.route_short_name,
                r.route_long_name,
                r.route_color,
                t.trip_headsign,
                t.shape_id
            FROM routes r
            JOIN (
                SELECT DISTINCT ON (route_id, trip_headsign) route_id, trip_headsign, shape_id
                FROM trips
            ) t ON r.route_id = t.route_id
            WHERE r.route_short_name ILIKE $1 OR r.route_long_name ILIKE $1
            ORDER BY r.route_short_name, t.trip_headsign
            LIMIT 10;
        `, [searchQuery]);
        
        // Search for routes by suburb
        const suburbRoutesPromise = pool.query(`
            SELECT
                r.route_id, r.route_short_name, r.route_long_name, r.route_color,
                t.trip_headsign, t.shape_id
            FROM routes r
            JOIN (SELECT DISTINCT ON (route_id, trip_headsign) route_id, trip_headsign, shape_id FROM trips) t
                ON r.route_id = t.route_id
            WHERE r.route_id IN (
                SELECT DISTINCT route_id FROM suburb_routes WHERE suburb ILIKE $1
            )
            LIMIT 10;
        `, [searchQuery]);

        const [stopsResult, routesResult, suburbRoutesResult] = await Promise.all([stopsPromise, routesPromise, suburbRoutesPromise]);

        // Merge and de-duplicate route results
        const allRoutes = [...routesResult.rows, ...suburbRoutesResult.rows];
        const uniqueRoutes = Array.from(new Map(allRoutes.map(route => [`${route.route_id}-${route.trip_headsign}`, route])).values());

        res.json({ stops: stopsResult.rows, routes: uniqueRoutes });

    } catch (error) {
        console.error('Unified search query failed:', error);
        res.status(500).json({ error: 'Failed to perform search.' });
    }
});

// --- MOBILE SEARCH ENDPOINT (v2) ---
// Purpose-built for iOS/Android apps. Key differences from /api/search:
//   - Returns exactly one result per direction (DISTINCT ON direction_id), not per headsign.
//     This prevents train/ferry lines returning dozens of rows (one per terminus variant).
//   - Picks the headsign from the longest trip in each direction (true terminus, not a short-runner).
//   - Includes direction_id, route_type, and route_text_color in the response.
app.get('/api/v2/search', async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 2) { return res.json({ stops: [], routes: [] }); }

    try {
        const searchQuery = `%${q}%`;

        // Stops — platform expansion + stop_code filter + optional distance ordering
        const lat = parseFloat(req.query.lat);
        const lon = parseFloat(req.query.lon);
        const hasLocation = !isNaN(lat) && !isNaN(lon);

        // Split query into tokens for order-independent matching
        // e.g. "stop 10 ann" matches "Ann Street Stop 10"
        const tokens = q.trim().split(/\s+/).filter(t => t.length >= 1);
        const tokenPatterns = tokens.map(t => `%${t}%`);
        const nameTokenConds = tokenPatterns.map((_, i) => `stop_name ILIKE $${i + 1}`).join(' AND ');
        const descTokenConds = tokenPatterns.map((_, i) => `COALESCE(stop_desc, '') ILIKE $${i + 1}`).join(' AND ');
        const stopTokenCondition = `(${nameTokenConds}) OR (${descTokenConds})`;
        const locOffset = tokenPatterns.length;

        const stopsQueryParams = hasLocation ? [...tokenPatterns, lon, lat] : tokenPatterns;
        const distanceSelect = hasLocation
            ? `ROUND(ST_Distance(s.location, ST_SetSRID(ST_MakePoint($${locOffset + 1}, $${locOffset + 2}), 4326)::geography))::int AS distance_m`
            : `NULL::int AS distance_m`;
        const orderBy = hasLocation ? `ORDER BY distance_m ASC NULLS LAST` : `ORDER BY s.stop_name`;

        const stopsPromise = pool.query(`
            WITH initial_matches AS (
                SELECT stop_id, parent_station
                FROM stops
                WHERE ${stopTokenCondition}
                LIMIT 50
            ),
            expanded AS (
                SELECT stop_id FROM initial_matches
                WHERE parent_station IS NULL OR parent_station = ''
                UNION
                SELECT s.stop_id FROM stops s
                WHERE s.parent_station IN (
                    SELECT stop_id FROM initial_matches
                    WHERE parent_station IS NULL OR parent_station = ''
                )
                UNION
                SELECT s.stop_id FROM stops s
                WHERE s.parent_station IN (
                    SELECT parent_station FROM initial_matches
                    WHERE parent_station IS NOT NULL AND parent_station != ''
                )
            )
            SELECT
                s.stop_id AS id, s.stop_name AS name, s.stop_code,
                s.parent_station, s.servicing_routes, s.route_directions, s.route_types,
                parent.stop_name AS parent_station_name,
                ST_Y(s.location::geometry) AS latitude,
                ST_X(s.location::geometry) AS longitude,
                ${distanceSelect}
            FROM stops s
            LEFT JOIN stops parent ON s.parent_station = parent.stop_id
            WHERE s.stop_id IN (SELECT stop_id FROM expanded)
              AND s.stop_code IS NOT NULL AND s.stop_code != ''
            ${orderBy}
            LIMIT 20;
        `, stopsQueryParams);

        // Routes — one row per unique headsign, surfaces all destination variants
        const routesPromise = pool.query(`
            SELECT
                r.route_id,
                r.route_short_name,
                r.route_long_name,
                r.route_color,
                r.route_text_color,
                r.route_type,
                t.trip_headsign,
                t.direction_id,
                t.shape_id
            FROM routes r
            JOIN (
                SELECT DISTINCT ON (t2.route_id, t2.trip_headsign)
                    t2.route_id, t2.trip_headsign, t2.direction_id, t2.shape_id
                FROM trips t2
                WHERE t2.route_id IN (
                    SELECT route_id FROM routes
                    WHERE route_short_name ILIKE $1 OR route_long_name ILIKE $1
                )
                ORDER BY t2.route_id, t2.trip_headsign
            ) t ON r.route_id = t.route_id
            WHERE r.route_short_name ILIKE $1 OR r.route_long_name ILIKE $1
            ORDER BY r.route_short_name, t.trip_headsign
            LIMIT 20;
        `, [searchQuery]);

        // Suburb routes — same headsign-based distinct
        const suburbRoutesPromise = pool.query(`
            SELECT
                r.route_id, r.route_short_name, r.route_long_name, r.route_color, r.route_text_color, r.route_type,
                t.trip_headsign, t.direction_id, t.shape_id
            FROM routes r
            JOIN (
                SELECT DISTINCT ON (t2.route_id, t2.trip_headsign)
                    t2.route_id, t2.trip_headsign, t2.direction_id, t2.shape_id
                FROM trips t2
                WHERE t2.route_id IN (
                    SELECT DISTINCT route_id FROM suburb_routes WHERE suburb ILIKE $1
                )
                ORDER BY t2.route_id, t2.trip_headsign
            ) t ON r.route_id = t.route_id
            WHERE r.route_id IN (
                SELECT DISTINCT route_id FROM suburb_routes WHERE suburb ILIKE $1
            )
            LIMIT 20;
        `, [searchQuery]);

        const [stopsResult, routesResult, suburbRoutesResult] = await Promise.all([stopsPromise, routesPromise, suburbRoutesPromise]);

        const allRoutes = [...routesResult.rows, ...suburbRoutesResult.rows];
        // Dedup on route_id + headsign — one result per unique destination
        const uniqueRoutes = Array.from(new Map(allRoutes.map(route => [`${route.route_id}-${route.trip_headsign}`, route])).values());

        res.json({ stops: stopsResult.rows, routes: uniqueRoutes });


    } catch (error) {
        console.error('v2 search query failed:', error);
        res.status(500).json({ error: 'Failed to perform search.' });
    }
});

app.get('/api/stops-for-route', async (req, res) => {
    const { route_id, headsign } = req.query;
    if (!route_id || !headsign) { return res.status(400).json({ error: 'route_id and headsign are required.' }); }
    try {
        const { rows } = await pool.query(`
            SELECT DISTINCT s.stop_id as id, s.stop_name as name, s.stop_code, s.servicing_routes, s.route_directions,
                   ST_Y(s.location::geometry) AS latitude,
                   ST_X(s.location::geometry) AS longitude
            FROM stops s
            JOIN stop_times st ON s.stop_id = st.stop_id
            JOIN trips t ON st.trip_id = t.trip_id
            WHERE t.route_id = $1 AND t.trip_headsign = $2;
        `, [route_id, headsign]);
        res.json(rows);
    } catch (error) {
        console.error('Stops for route query failed:', error);
        res.status(500).json({ error: 'Failed to fetch stops for the route.' });
    }
});

app.get('/api/vehicles-near-me', async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const radius = parseFloat(req.query.radius) || 1000;
    if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'lat and lon are required.' });

    try {
        const vehiclePositions = (await getVehiclePositions()).feed;

        // Filter to vehicles within radius
        const nearby = [];
        for (const entity of vehiclePositions.entity) {
            const v = entity.vehicle;
            if (!v?.position) continue;
            const vLat = v.position.latitude;
            const vLon = v.position.longitude;
            if (typeof vLat !== 'number' || typeof vLon !== 'number') continue;
            if (haversineMeters(lat, lon, vLat, vLon) > radius) continue;
            nearby.push({
                vehicleId: entity.id,
                lat: vLat,
                lon: vLon,
                bearing: v.position.bearing ?? 0,
                tripId: v.trip?.tripId ?? null,
            });
        }

        if (nearby.length === 0) return res.json([]);

        // Enrich with route info from the DB
        const tripIds = nearby.map(v => v.tripId).filter(Boolean);
        const routeByTrip = {};
        if (tripIds.length > 0) {
            const { rows } = await pool.query(`
                SELECT t.trip_id, r.route_short_name, r.route_color, r.route_type
                FROM trips t
                JOIN routes r ON r.route_id = t.route_id
                WHERE t.trip_id = ANY($1)
            `, [tripIds]);
            for (const row of rows) routeByTrip[row.trip_id] = row;
        }

        const result = nearby.map(v => {
            const route = (v.tripId && routeByTrip[v.tripId]) || {};
            return {
                vehicleId: v.vehicleId,
                lat: v.lat,
                lon: v.lon,
                bearing: v.bearing,
                routeShortName: route.route_short_name ?? '',
                routeColor: route.route_color ?? null,
                routeType: route.route_type ?? 3,
            };
        });

        res.json(result);
    } catch (error) {
        console.error('vehicles-near-me failed:', error);
        res.json([]);
    }
});

app.get('/api/shapes-near-me', async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'lat and lon are required.' });
    const delta = 0.018; // ~2km bounding box in degrees
    try {
        const { rows } = await pool.query(`
            SELECT DISTINCT ON (r.route_id)
                r.route_id,
                r.route_color,
                ST_AsGeoJSON(ST_Simplify(rs.shape::geometry, 0.00008)) AS geojson
            FROM route_shapes rs
            JOIN trips t ON t.shape_id = rs.shape_id
            JOIN routes r ON r.route_id = t.route_id
            WHERE rs.shape && ST_MakeEnvelope($1, $2, $3, $4, 4326)
            ORDER BY r.route_id
            LIMIT 30
        `, [lon - delta, lat - delta, lon + delta, lat + delta]);

        const result = rows.flatMap(row => {
            try {
                const geojson = JSON.parse(row.geojson);
                const toLatLon = c => [c[1], c[0]]; // GeoJSON is [lon,lat] → swap to [lat,lon]
                let points = [];
                if (geojson.type === 'LineString') {
                    points = geojson.coordinates.map(toLatLon);
                } else if (geojson.type === 'MultiLineString') {
                    points = geojson.coordinates.flat().map(toLatLon);
                }
                if (points.length < 2) return [];
                return [{ routeId: row.route_id, routeColor: row.route_color, points }];
            } catch { return []; }
        });

        res.json(result);
    } catch (error) {
        console.error('shapes-near-me failed:', error);
        res.json([]);
    }
});

// --- TRIP VEHICLES: where the vehicles on given trips are, for the home map ----------
// GET /api/trip-vehicles?trip_ids=T1,T2
// -> { vehicles: [{ tripId, lat, lon, heading, headingKnown, ageSeconds, isStale }] }; trips
// with no vehicle reporting are left out. The feed sends no bearing, so heading comes from
// the trip's shape (cached per instance: shapes only change with the timetable).
const TRIP_VEHICLES_MAX = 20;
const shapePointsCache = new Map();   // shape_id -> [[lat, lon], ...]
async function shapePoints(shapeIds) {
    const missing = shapeIds.filter(id => !shapePointsCache.has(id));
    if (missing.length) {
        const { rows } = await pool.query(`
            SELECT shape_id, ST_AsGeoJSON(ST_Simplify(shape::geometry, 0.00003)) AS geojson
            FROM route_shapes WHERE shape_id = ANY($1)
        `, [missing]);
        if (shapePointsCache.size > 500) shapePointsCache.clear();
        for (const r of rows) shapePointsCache.set(r.shape_id, geojsonToLatLon(r.geojson));
    }
    return new Map(shapeIds.map(id => [id, shapePointsCache.get(id) || []]));
}

// GET /api/shapes?ids=S1,S2 -> { shapes: { S1: [[lat, lon], ...] } }: whole route shapes,
// simplified to ~3 m, for drawing on the home map. CDN-cacheable: shapes change only with the timetable.
const SHAPES_MAX = 20;
app.get('/api/shapes', async (req, res) => {
    const ids = [...new Set(String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean))].slice(0, SHAPES_MAX);
    if (!ids.length) return res.json({ shapes: {} });
    try {
        const points = await shapePoints(ids);
        const shapes = {};
        for (const [id, pts] of points) if (pts.length >= 2) shapes[id] = pts.map(([la, lo]) => [+la.toFixed(6), +lo.toFixed(6)]);
        res.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
        res.json({ shapes });
    } catch (error) {
        console.error('shapes failed:', error);
        res.status(500).json({ error: 'Failed to fetch shapes.' });
    }
});

app.get('/api/trip-vehicles', async (req, res) => {
    const tripIds = [...new Set(String(req.query.trip_ids || '').split(',').map(s => s.trim()).filter(Boolean))]
        .slice(0, TRIP_VEHICLES_MAX);
    if (!tripIds.length) return res.json({ vehicles: [] });
    try {
        const byTrip = (await getVehiclePositions()).index;
        const live = tripIds.map(id => [id, byTrip.get(id)]).filter(([, vp]) => vp?.position);
        if (!live.length) return res.json({ vehicles: [] });

        const { rows } = await pool.query('SELECT trip_id, shape_id FROM trips WHERE trip_id = ANY($1)', [live.map(([id]) => id)]);
        const shapeOf = new Map(rows.map(r => [r.trip_id, r.shape_id]));
        const shapes = await shapePoints([...new Set(rows.map(r => r.shape_id).filter(Boolean))]);

        const vehicles = live.map(([tripId, vp]) => {
            const lat = vp.position.latitude, lon = vp.position.longitude;
            const h = vp.position.bearing
                ? { heading: vp.position.bearing }
                : headingAlongShape(shapes.get(shapeOf.get(tripId)) || [], lat, lon);
            return {
                tripId, lat, lon,
                heading: h ? h.heading : 0,
                headingKnown: Boolean(h),
                ageSeconds: fixAgeSeconds(vp.timestamp),
                isStale: !isFreshFix(vp.timestamp)
            };
        });
        res.json({ vehicles });
    } catch (error) {
        console.error('trip-vehicles failed:', error);
        res.json({ vehicles: [] });
    }
});

// --- PATHS AHEAD: the next stretch of a route from a stop, for the home map ---------
// GET /api/paths-ahead?items=shapeId:stopId,shapeId:stopId&meters=1200
// -> { paths: { "shapeId:stopId": [[lat, lon], ...] } }; items with no usable shape are left out.
// Shapes only change with the timetable, so the CDN and clients can keep these a long time.
const PATH_AHEAD_MAX_ITEMS = 20;
app.get('/api/paths-ahead', async (req, res) => {
    const items = [...new Set(String(req.query.items || '').split(',').map(s => s.trim()).filter(s => /^[^:]+:[^:]+$/.test(s)))]
        .slice(0, PATH_AHEAD_MAX_ITEMS);
    const meters = Math.min(Math.max(parseInt(req.query.meters, 10) || 1200, 100), 5000);
    if (!items.length) return res.json({ paths: {} });
    try {
        const pairs = items.map(i => i.split(':'));
        const { rows } = await pool.query(`
            SELECT q.shape_id, q.stop_id,
                   ST_AsGeoJSON(ST_Simplify(rs.shape::geometry, 0.00003)) AS geojson,
                   ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lon
            FROM unnest($1::text[], $2::text[]) AS q(shape_id, stop_id)
            JOIN route_shapes rs ON rs.shape_id = q.shape_id
            JOIN stops s ON s.stop_id = q.stop_id
        `, [pairs.map(p => p[0]), pairs.map(p => p[1])]);
        const paths = {};
        for (const r of rows) {
            const path = pathAhead(geojsonToLatLon(r.geojson), [Number(r.lat), Number(r.lon)], meters);
            if (path.length) paths[`${r.shape_id}:${r.stop_id}`] = path;
        }
        res.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
        res.json({ paths });
    } catch (error) {
        console.error('paths-ahead failed:', error);
        res.status(500).json({ error: 'Failed to fetch paths.' });
    }
});

app.get('/api/route-shape', async (req, res) => {
    const { shape_id } = req.query;
    if (!shape_id) { return res.status(400).json({ error: 'shape_id is required.' }); }
    try {
        const { rows } = await pool.query(`
            SELECT ST_AsGeoJSON(shape) as shape_geojson
            FROM route_shapes
            WHERE shape_id = $1;
        `, [shape_id]);
        res.json(rows[0] ? JSON.parse(rows[0].shape_geojson) : null);
    } catch (error) {
        console.error('Route shape query failed:', error);
        res.status(500).json({ error: 'Failed to fetch route shape.' });
    }
});

app.get('/api/route-info', async (req, res) => {
    const { route_id } = req.query;
    if (!route_id) {
        return res.status(400).json({ error: 'route_id is required.' });
    }
    try {
        const { rows } = await pool.query(`
            SELECT route_short_name, route_long_name, route_color, route_text_color
            FROM routes
            WHERE route_id = $1;
        `, [route_id]);
        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            res.status(404).json({ error: 'Route not found.' });
        }
    } catch (error) {
        console.error('Route info query failed:', error);
        res.status(500).json({ error: 'Failed to fetch route info.' });
    }
});

app.get('/api/stops-for-route-at-station', async (req, res) => {
    const { route_id, headsign, parent_station } = req.query;
    if (!route_id || !headsign || !parent_station) {
        return res.status(400).json({ error: 'route_id, headsign, and parent_station are required.' });
    }
    try {
        // Find all child stops of the parent station that are serviced by the specific route and headsign.
        const { rows } = await pool.query(`
            SELECT s.stop_id as id, s.stop_name as name, s.stop_code, s.parent_station,
                   ST_Y(s.location::geometry) AS latitude, ST_X(s.location::geometry) AS longitude
            FROM stops s
            WHERE s.parent_station = $1
              AND s.stop_id IN (
                SELECT DISTINCT st.stop_id
                FROM stop_times st
                JOIN trips t ON st.trip_id = t.trip_id
                WHERE t.route_id = $2 AND t.trip_headsign = $3
              );
        `, [parent_station, route_id, headsign]);
        res.json(rows);
    } catch (error) {
        console.error('Stops for route at station query failed:', error);
        res.status(500).json({ error: 'Failed to fetch stops for the route at the specified station.' });
    }
});

app.get('/api/routes-for-stops', async (req, res) => {
    const { stop_codes } = req.query;
    if (!stop_codes) {
        return res.status(400).json({ error: 'stop_codes are required.' });
    }
    try {
        const stopCodesArray = stop_codes.split(',');
        const { rows } = await pool.query(`
            SELECT DISTINCT r.route_short_name, r.route_type, r.route_color, r.route_text_color
            FROM routes r
            JOIN trips t ON r.route_id = t.route_id
            JOIN stop_times st ON t.trip_id = st.trip_id
            JOIN stops s ON st.stop_id = s.stop_id
            WHERE s.stop_code = ANY($1::text[])
            ORDER BY r.route_type, r.route_short_name;
        `, [stopCodesArray]);
        res.json(rows);
    } catch (error) {
        console.error('Routes for stops query failed:', error);
        res.status(500).json({ error: 'Failed to fetch routes for the specified stops.' });
    }
});

app.get('/api/stops-near-me', async (req, res) => {
  const { lat, lon, radius, types } = req.query;
  if (!lat || !lon) { return res.status(400).json({ error: 'Latitude and longitude are required.' }); }
  try {
    const radiusInMeters = parseInt(radius, 10) || 500;
    const typeFilter = types ? types.split(',').map(Number) : null;
    let query = `
      SELECT s.stop_id AS id, s.stop_name AS name, s.stop_code, s.parent_station, s.servicing_routes, s.route_directions, s.route_types,
             parent_stop.stop_name AS parent_station_name, ROUND(ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)::numeric)::int AS distance_m,
             ST_Y(s.location::geometry) AS latitude, ST_X(s.location::geometry) AS longitude
      FROM stops AS s
      LEFT JOIN stops AS parent_stop ON s.parent_station = parent_stop.stop_id
      WHERE ST_DWithin(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
    `;
    const queryParams = [lon, lat, radiusInMeters];
    if (typeFilter && typeFilter.length > 0) {
      query += ` AND s.route_types && $4`;
      queryParams.push(typeFilter);
    }
    query += ` ORDER BY ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) LIMIT 25;`;
    const { rows } = await pool.query(query, queryParams);

    // Additive, opt-in: trains and ferries (or `far_types`) within `far_radius` too. A station
    // ten minutes' walk away can beat the buses at the door, but sits outside the bus radius.
    const farRadius = Math.min(parseInt(req.query.far_radius, 10) || 0, 3000);
    if (farRadius > radiusInMeters) {
      const farTypes = String(req.query.far_types || '2,4').split(',').map(Number).filter(n => !isNaN(n));
      const { rows: far } = await pool.query(`
        SELECT s.stop_id AS id, s.stop_name AS name, s.stop_code, s.parent_station, s.servicing_routes, s.route_directions, s.route_types,
               parent_stop.stop_name AS parent_station_name, ROUND(ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)::numeric)::int AS distance_m,
               ST_Y(s.location::geometry) AS latitude, ST_X(s.location::geometry) AS longitude
        FROM stops AS s
        LEFT JOIN stops AS parent_stop ON s.parent_station = parent_stop.stop_id
        WHERE ST_DWithin(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
          AND s.location_type = 0 AND s.route_types && $4
        ORDER BY ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) LIMIT 15
      `, [lon, lat, farRadius, farTypes]);
      const have = new Set(rows.map(r => r.id));
      for (const s of far) if (!have.has(s.id)) rows.push(s);
    }

    // A station is one place: if any of its stops is in range, include all of them. Its
    // bus bays (e.g. rail replacement buses at "Auchenflower station - Auchenflower Tce")
    // can sit just outside the radius while the platforms are inside it.
    const parents = [...new Set(rows.map(r => r.parent_station).filter(Boolean))];
    if (parents.length) {
      const have = new Set(rows.map(r => r.id));
      const { rows: siblings } = await pool.query(`
        SELECT s.stop_id AS id, s.stop_name AS name, s.stop_code, s.parent_station, s.servicing_routes, s.route_directions, s.route_types,
               parent_stop.stop_name AS parent_station_name, ROUND(ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)::numeric)::int AS distance_m,
               ST_Y(s.location::geometry) AS latitude, ST_X(s.location::geometry) AS longitude
        FROM stops AS s
        LEFT JOIN stops AS parent_stop ON s.parent_station = parent_stop.stop_id
        WHERE s.parent_station = ANY($3)
      `, [lon, lat, parents]);
      for (const s of siblings) {
        if (have.has(s.id)) continue;
        if (typeFilter && typeFilter.length && !(s.route_types || []).some(t => typeFilter.includes(t))) continue;
        rows.push(s);
      }
      rows.sort((a, b) => a.distance_m - b.distance_m);
    }
    res.json(rows);
  } catch (error) {
    console.error('Geospatial query failed:', error);
    res.status(500).json({ error: 'Failed to fetch nearby stops.' });
  }
});

// --- MAIN DEPARTURES ENDPOINT ---
// Sets `heading` (degrees, null at a trip's last stop) on each departure, from the stop
// towards the trip's following stops, and `isLastStop`. One query for the whole list.
async function addDepartureHeadings(departures) {
    if (!departures.length) return;
    const { rows } = await pool.query(`
        SELECT q.i,
               ST_Y(here.location::geometry) AS lat, ST_X(here.location::geometry) AS lon,
               ARRAY(
                   SELECT ST_Y(s.location::geometry) || ',' || ST_X(s.location::geometry)
                   FROM stop_times st JOIN stops s ON s.stop_id = st.stop_id
                   WHERE st.trip_id = q.trip_id AND st.stop_sequence > q.seq
                   ORDER BY st.stop_sequence LIMIT 3
               ) AS next
        FROM unnest($1::text[], $2::int[], $3::text[]) WITH ORDINALITY AS q(trip_id, seq, stop_id, i)
        JOIN stops here ON here.stop_id = q.stop_id
    `, [departures.map(d => d.trip_id), departures.map(d => d.stop_sequence), departures.map(d => d.stop_id)]);
    for (const d of departures) { d.heading = null; d.isLastStop = false; }
    for (const r of rows) {
        const next = (r.next || []).map(p => p.split(',').map(Number));
        const d = departures[Number(r.i) - 1];
        d.heading = departureHeading([Number(r.lat), Number(r.lon)], next);
        // Additive: the trip ends here (arriving, not leaving), e.g. a train terminating at Roma Street
        d.isLastStop = next.length === 0;
    }
}

app.get('/api/departures', async (req, res) => {
    // No `stops` param at all: the web board's default stops (it relies on this).
    // `stops` given but empty (e.g. a parent-station record with no stop_code): return
    // nothing, rather than silently answering with the default stops' departures.
    if (req.query.stops !== undefined) {
        const requested = String(req.query.stops).split(',').map(s => s.trim()).filter(Boolean);
        if (requested.length === 0) return res.json([]);
    }
    const stopCodes = (req.query.stops || '001951,600284,600286').split(',').map(s => s.trim()).filter(Boolean);

    try {
        const scheduledDepartures = await upcomingStopTimes((services) => `
            SELECT
                st.trip_id, s.stop_id, s.stop_name, st.stop_sequence, st.departure_time,s.platform_code,
                t.trip_headsign, t.direction_id, t.shape_id, r.route_id, r.route_short_name, r.route_long_name, r.route_color, r.route_text_color,
                r.route_type, ST_Y(s.location::geometry) AS stop_lat, ST_X(s.location::geometry) AS stop_lon
            FROM stop_times AS st
            JOIN trips AS t ON st.trip_id = t.trip_id
            JOIN routes AS r ON t.route_id = r.route_id
            JOIN stops s ON st.stop_id = s.stop_id
            WHERE s.stop_code = ANY($3::text[])
            AND st.departure_time >= $2
            AND t.service_id IN ${services}
        `, [stopCodes]);

        if (scheduledDepartures.length === 0) {
            return res.json([]);
        }

        // trip_id -> stopTimeUpdates / vehicle, from the shared GTFS-RT caches
        const [tuCache, vpCache] = await Promise.all([getTripUpdates(), getVehiclePositions().catch(() => null)]);
        const tripUpdates = tuCache.index;
        const vehicles = vpCache?.index ?? new Map();
        const synchronizedNow = new Date();
        const enrichedDepartures = scheduledDepartures.map(s => {
            const scheduled = scheduledUtc(s.day, s.departure_time);
            const stopTimeUpdates = tripUpdates.get(s.trip_id)?.stopTimeUpdate;
            const cancelled = isTripCancelled(tripUpdates.get(s.trip_id));
            const skipped = !cancelled && isStopSkipped(stopTimeUpdates, s.stop_sequence);
            // A cancelled trip has no live progress, so the "passed" checks don't apply to it
            if (!cancelled && passedPerFeed(stopTimeUpdates, s.stop_sequence, vehicles.get(s.trip_id))) return null;
            const live = liveStopTime(stopTimeUpdates, s.stop_sequence, scheduled);
            const secondsUntil = Math.round((live.estimatedUtc - synchronizedNow) / 1000);

            let vehicleType = 'Train';
            if (s.route_type === 3) vehicleType = 'Bus';
            if (s.route_type === 4) vehicleType = 'Ferry';
            // The Gold Coast G:link; it used to fall through to 'Train'
            if (s.route_type === 0) vehicleType = 'Tram';

            return {
                trip_id: s.trip_id,
                stop_id: s.stop_id,
                stop_sequence: s.stop_sequence,
                stopName: s.stop_name,
                vehicleType: vehicleType,
                routeNumber: s.route_short_name,
                routeId: s.route_id,
                directionId: s.direction_id,
                headsign: s.trip_headsign,
                scheduledDepartureUtc: scheduled.toISOString(),
                expectedDepartureUtc: live.estimatedUtc.getTime() !== scheduled.getTime() ? live.estimatedUtc.toISOString() : null,
                isDelayed: live.delaySeconds > 0,
                // Additive: lets clients tell "live & on time" from "timetable only"
                isRealtime: live.isRealtime,
                // Additive: trip cancelled, or this stop skipped (e.g. a diversion)
                isCancelled: cancelled,
                isSkipped: skipped,
                delaySeconds: live.delaySeconds,
                secondsUntilDeparture: secondsUntil,
                routeLongName: s.route_long_name,
                routeColor: s.route_color,
                routeTextColor: s.route_text_color,
                platformCode:s.platform_code,
                // Additive: for /api/paths-ahead (the route drawn ahead of the stop)
                shapeId: s.shape_id
            };
        });
        
        let sorted = enrichedDepartures
            .filter(dep => dep && dep.secondsUntilDeparture > -120)
            .sort((a, b) => a.secondsUntilDeparture - b.secondsUntilDeparture);

        // Filter to trips that actually call at the get-off stop(s).
        // Accepts a comma-separated list of stop_ids to support multi-platform stations.
        if (req.query.get_off_stop) {
            const getOffStopIds = req.query.get_off_stop.split(',').map(s => s.trim()).filter(Boolean);
            const tripIds = [...new Set(sorted.map(d => d.trip_id))];
            if (tripIds.length > 0 && getOffStopIds.length > 0) {
                const { rows: validRows } = await pool.query(
                    'SELECT DISTINCT trip_id FROM stop_times WHERE trip_id = ANY($1) AND stop_id = ANY($2)',
                    [tripIds, getOffStopIds]
                );
                const validTripIds = new Set(validRows.map(r => r.trip_id));
                sorted = sorted.filter(d => validTripIds.has(d.trip_id));
            }
        }

        const perStop = parseInt(req.query.per_stop, 10) || null;
        const perRoute = parseInt(req.query.per_route, 10) || null;
        let result;
        if (perRoute) {
            // Additive, per-route mode (home screen): each route + direction's next departures
            // from the stop nearest `lat`/`lon` that it serves, so every route nearby is listed.
            // per_stop caps each stop instead, and at a busy stop its few departures crowd out
            // most of the routes calling there.
            const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
            const stopLoc = new Map(scheduledDepartures.map(r => [r.stop_id, [Number(r.stop_lat), Number(r.stop_lon)]]));
            const dist = (id) => {
                const p = stopLoc.get(id);
                return p && !isNaN(lat) && !isNaN(lon) ? haversineMeters(lat, lon, p[0], p[1]) : 0;
            };
            const key = (d) => `${d.routeId}|${d.directionId}`;
            const nearestStop = new Map();
            for (const d of sorted) {
                const cur = nearestStop.get(key(d));
                if (cur === undefined || dist(d.stop_id) < dist(cur)) nearestStop.set(key(d), d.stop_id);
            }
            const count = new Map();
            result = [];
            for (const d of sorted) {
                if (d.stop_id !== nearestStop.get(key(d))) continue;
                const n = count.get(key(d)) ?? 0;
                if (n < perRoute) { result.push(d); count.set(key(d), n + 1); }
            }
        } else if (perStop) {
            // Per-stop mode: guarantees every stop gets at least one departure,
            // even for infrequent platforms with service hours away.
            const countPerStop = new Map();
            result = [];
            for (const dep of sorted) {
                const n = countPerStop.get(dep.stop_id) ?? 0;
                if (n < perStop) {
                    result.push(dep);
                    countPerStop.set(dep.stop_id, n + 1);
                }
            }
        } else {
            result = sorted.slice(0, 15);
        }
        // Additive, opt-in: which way each service leaves the stop (map arrows)
        if (req.query.with_heading === '1') await addDepartureHeadings(result);
        res.json(result);
    } catch (error) {
        console.error('An error occurred in /api/departures:', error);
        res.status(500).json({ message: 'The server failed to process the request.', error_details: error.message });
    }
});

app.get('/api/trip-details', async (req, res) => {
    const { trip_id, stop_sequence } = req.query;
    if (!trip_id || !stop_sequence) { return res.status(400).json({ error: 'trip_id and stop_sequence are required.' }); }
    try {
        const { rows } = await pool.query(`
            SELECT s.stop_name, st.departure_time FROM stop_times st
            JOIN stops s ON st.stop_id = s.stop_id
            WHERE st.trip_id = $1 AND st.stop_sequence > $2
            ORDER BY st.stop_sequence;
        `, [trip_id, stop_sequence]);
        res.json(rows);
    } catch (error) {
        console.error('Trip details query failed:', error);
        res.status(500).json({ error: 'Failed to fetch trip details.' });
    }
});


// --- STOP LIVE: shapes + vehicle positions for the next 2 departures at a stop ---
// GET /api/stop-live?stop_ids=id1,id2
// Returns up to 2 upcoming trips, each with split shape (before/after stop) and GTFS-RT vehicle position.
app.get('/api/stop-live', async (req, res) => {
    const stopIdsParam = req.query.stop_ids || req.query.stop_id;
    if (!stopIdsParam) return res.status(400).json({ error: 'stop_ids is required.' });
    const stopIds = stopIdsParam.split(',').map(s => s.trim()).filter(Boolean);

    try {
        const allRows = await upcomingStopTimes((services) => `
            SELECT
                st.trip_id, st.stop_id, st.stop_sequence, st.departure_time,
                t.shape_id,
                r.route_short_name, r.route_color, r.route_text_color, r.route_type,
                ST_Y(s.location::geometry) AS stop_lat,
                ST_X(s.location::geometry) AS stop_lon
            FROM stop_times st
            JOIN trips t ON st.trip_id = t.trip_id
            JOIN routes r ON t.route_id = r.route_id
            JOIN stops s ON st.stop_id = s.stop_id
            WHERE st.stop_id = ANY($3)
            AND st.departure_time >= $2
            AND t.service_id IN ${services}
        `, [stopIds]);

        // Convert GTFS departure_time to UTC, filter to upcoming, take first 2
        const synchronizedNow = new Date();
        const upcoming = allRows
            .map(row => ({ ...row, secondsUntil: Math.round((scheduledUtc(row.day, row.departure_time) - synchronizedNow) / 1000) }))
            .filter(row => row.secondsUntil > -60)
            .sort((a, b) => a.secondsUntil - b.secondsUntil)
            .slice(0, 2);

        if (upcoming.length === 0) return res.json({ trips: [] });

        const vehiclesByTrip = (await getVehiclePositions()).index;

        // For each upcoming trip: get shape, split at stop, attach vehicle
        const trips = await Promise.all(upcoming.map(async (row) => {
            // Get simplified shape as GeoJSON from route_shapes
            const { rows: shapeRows } = await pool.query(`
                SELECT ST_AsGeoJSON(ST_Simplify(shape::geometry, 0.00008)) AS geojson
                FROM route_shapes
                WHERE shape_id = $1
            `, [row.shape_id]);

            // Split the shape at the point closest to the stop
            const shapePoints = shapeRows.length > 0 ? geojsonToLatLon(shapeRows[0].geojson) : [];
            const stopLat = parseFloat(row.stop_lat);
            const stopLon = parseFloat(row.stop_lon);
            let splitIdx = 0;
            let minDist = Infinity;
            for (let i = 0; i < shapePoints.length; i++) {
                const d = haversineMeters(stopLat, stopLon, shapePoints[i][0], shapePoints[i][1]);
                if (d < minDist) { minDist = d; splitIdx = i; }
            }
            const shapeBefore = shapePoints.slice(0, splitIdx + 1);
            const shapeAfter = shapePoints.slice(splitIdx);

            const vp = vehiclesByTrip.get(row.trip_id);
            const liveVehicle = vp?.position ? {
                lat: vp.position.latitude,
                lon: vp.position.longitude,
                bearing: vp.position.bearing ?? 0,
                ageSeconds: fixAgeSeconds(vp.timestamp),
            } : null;
            // Direction of travel from the shape (feed bearing if Translink ever sends one)
            let heading = null;
            if (liveVehicle) {
                heading = liveVehicle.bearing
                    ? { heading: liveVehicle.bearing }
                    : headingAlongShape(shapePoints, liveVehicle.lat, liveVehicle.lon);
            }
            // A stale fix can't tell us the trip has gone past this stop
            const hasPassed = liveVehicle ? vehiclePassedStop(vp, row.stop_sequence) : false;

            return {
                tripId: row.trip_id,
                routeShortName: row.route_short_name ?? '',
                routeColor: row.route_color ?? null,
                routeTextColor: row.route_text_color ?? null,
                routeType: row.route_type ?? null,
                shapeBefore,
                shapeAfter,
                vehicle: liveVehicle ? {
                    lat: liveVehicle.lat,
                    lon: liveVehicle.lon,
                    bearing: heading ? heading.heading : 0,
                    headingKnown: Boolean(heading),
                    ageSeconds: liveVehicle.ageSeconds,
                    isStale: !isFreshFix(vp.timestamp),
                } : null,
                hasPassed,
            };
        }));

        res.json({ trips });
    } catch (error) {
        console.error('stop-live failed:', error);
        res.json({ trips: [] });
    }
});

// --- TRIP STOPS ENDPOINT ---
// GET /api/trip-stops?trip_id=X
// GET /api/trip-stops?route_id=X&direction_id=Y&user_lat=Z&user_lon=W
// Returns full stop list with scheduled/estimated times + simplified shape
app.get('/api/trip-stops', async (req, res) => {
    let { trip_id, route_id, direction_id, user_lat, user_lon } = req.query;
    const userLat = parseFloat(user_lat);
    const userLon = parseFloat(user_lon);
    const hasLocation = !isNaN(userLat) && !isNaN(userLon);

    try {
        const syncNow = new Date();
        // The service day the trip runs on: today, unless it's one of yesterday's late trips
        let day = serviceDay(syncNow);

        // If route_id given without trip_id: find nearest stop on route, then next upcoming trip
        if (!trip_id && route_id) {
            const dirId = parseInt(direction_id) || 0;
            let nearestStopId = null;

            if (hasLocation) {
                const { rows: nearbyStops } = await pool.query(`
                    SELECT DISTINCT s.stop_id,
                           ST_Distance(s.location, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography) AS dist
                    FROM stops s
                    JOIN stop_times st ON s.stop_id = st.stop_id
                    JOIN trips t ON st.trip_id = t.trip_id
                    WHERE t.route_id = $1 AND t.direction_id = $2
                    ORDER BY dist ASC
                    LIMIT 1
                `, [route_id, dirId, userLon, userLat]);
                nearestStopId = nearbyStops[0]?.stop_id || null;
            }

            if (!nearestStopId) {
                // Fall back to any stop on the route
                const { rows } = await pool.query(`
                    SELECT DISTINCT s.stop_id FROM stops s
                    JOIN stop_times st ON s.stop_id = st.stop_id
                    JOIN trips t ON st.trip_id = t.trip_id
                    WHERE t.route_id = $1 AND t.direction_id = $2 LIMIT 1
                `, [route_id, dirId]);
                nearestStopId = rows[0]?.stop_id || null;
            }

            if (!nearestStopId) return res.status(404).json({ error: 'No stops found for this route/direction.' });

            const tripRows = await upcomingStopTimes((services) => `
                SELECT st.trip_id, st.departure_time, st.stop_sequence
                FROM stop_times st
                JOIN trips t ON st.trip_id = t.trip_id
                WHERE st.stop_id = $3
                  AND t.route_id = $4 AND t.direction_id = $5
                  AND st.departure_time >= $2
                  AND t.service_id IN ${services}
            `, [nearestStopId, route_id, dirId], syncNow);

            // Pick the next trip by its LIVE time at the stop: a bus running 5 min late is
            // still coming after its scheduled time has passed
            const updates = (await getTripUpdates()).index;
            const liveSecondsUntil = (tr) => {
                const live = liveStopTime(updates.get(tr.trip_id)?.stopTimeUpdate, tr.stop_sequence, scheduledUtc(tr.day, tr.departure_time));
                return Math.round((live.estimatedUtc - syncNow) / 1000);
            };
            let best = null;
            for (const tr of tripRows) {
                const s = liveSecondsUntil(tr);
                if (s > -60 && (best === null || s < best.s)) best = { s, id: tr.trip_id, day: tr.day };
            }
            if (best) { trip_id = best.id; day = best.day; }
            if (!trip_id) return res.status(404).json({ error: 'No upcoming trips found.' });
        } else if (trip_id) {
            // A trip asked for by id: after midnight it may be one of yesterday's late trips
            const yesterday = activeServiceDays(syncNow).find(d => d.dateString !== day.dateString);
            if (yesterday) {
                const { rows } = await pool.query(`
                    SELECT 1 FROM trips t
                    WHERE t.trip_id = $2 AND t.service_id IN ${servicesRunningOn('$1', yesterday.dayOfWeek)}
                      AND (SELECT max(departure_time) FROM stop_times WHERE trip_id = $2) >= $3
                `, [yesterday.dateString, trip_id, yesterday.fromTime]);
                if (rows.length) day = yesterday;
            }
        }

        if (!trip_id) return res.status(400).json({ error: 'trip_id or (route_id + direction_id) required.' });

        // Parallel: trip info, stop list, GTFS-RT trip updates + vehicle positions
        const [tripInfoResult, stopResult, tripUpdates, vehiclePositions] = await Promise.all([
            pool.query(`
                SELECT t.trip_id, t.route_id, t.trip_headsign, t.direction_id, t.shape_id,
                       r.route_short_name, r.route_color, r.route_text_color, r.route_type
                FROM trips t JOIN routes r ON r.route_id = t.route_id WHERE t.trip_id = $1
            `, [trip_id]),
            pool.query(`
                SELECT st.stop_sequence, st.departure_time, s.stop_id, s.stop_name,
                       ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lon
                FROM stop_times st JOIN stops s ON st.stop_id = s.stop_id
                WHERE st.trip_id = $1 ORDER BY st.stop_sequence
            `, [trip_id]),
            getTripUpdates(),
            // Vehicle position isn't critical — a feed failure just means no live vehicle
            getVehiclePositions().catch(() => null)
        ]);

        if (tripInfoResult.rows.length === 0) return res.status(404).json({ error: 'Trip not found.' });
        const tripInfo = tripInfoResult.rows[0];

        // GTFS-RT trip updates for this trip
        const stopTimeUpdateMap = new Map();
        for (const stu of (tripUpdates.index.get(trip_id)?.stopTimeUpdate || [])) {
            stopTimeUpdateMap.set(stu.stopSequence, stu);
        }

        // GTFS-RT vehicle position for this trip
        let vehicle = null;
        const vp = vehiclePositions?.index.get(trip_id);
        if (vp?.position) {
            vehicle = {
                lat: vp.position.latitude,
                lon: vp.position.longitude,
                bearing: vp.position.bearing || 0,
                // How old the GPS fix is — clients show "40s ago"
                ageSeconds: fixAgeSeconds(vp.timestamp),
                isStale: !isFreshFix(vp.timestamp),
                // Lets clients place the vehicle between the right stops
                currentStopSequence: vp.currentStopSequence ?? null,
                // GTFS-RT VehicleStopStatus: 0 INCOMING_AT, 1 STOPPED_AT, 2 IN_TRANSIT_TO
                currentStatus: vp.currentStatus ?? null
            };
        }

        // Get shape
        let shape = [];
        if (tripInfo.shape_id) {
            const { rows: shapeRows } = await pool.query(`
                SELECT ST_AsGeoJSON(ST_Simplify(shape::geometry, 0.00008)) AS geojson
                FROM route_shapes WHERE shape_id = $1
            `, [tripInfo.shape_id]);
            if (shapeRows[0]?.geojson) shape = geojsonToLatLon(shapeRows[0].geojson);
        }

        // Direction of travel. The feed's bearing is used if Translink ever sends one;
        // otherwise derive it from the shape, using the stop the vehicle is heading to
        // to pick the right pass on loop/out-and-back shapes.
        if (vehicle) {
            const feedBearing = vp?.position?.bearing;
            if (feedBearing) {
                vehicle.bearing = feedBearing;
                vehicle.headingKnown = true;
            } else {
                const next = stopResult.rows.find(s => s.stop_sequence === vehicle.currentStopSequence);
                const h = headingAlongShape(shape, vehicle.lat, vehicle.lon,
                    next ? [parseFloat(next.lat), parseFloat(next.lon)] : null);
                vehicle.bearing = h ? h.heading : 0;
                vehicle.headingKnown = Boolean(h);
            }
        }

        // Build stops array
        let nearestUpcomingIdx = -1;
        let minDist = Infinity;
        // GTFS-RT only sends updates for some stops; a delay carries forward to later
        // stops until the next explicit update (per the GTFS-RT propagation rules)
        let propagatedDelay = null;

        const stops = stopResult.rows.map((s, idx) => {
            const scheduled = scheduledUtc(day, s.departure_time);
            let estimatedUtc = scheduled;
            let isRealtime = false;
            // Walking the whole trip, so a delay can be carried forward even from a stop
            // that only gave a predicted time (liveStopTime can't, for a single stop)
            const event = stopEvent(stopTimeUpdateMap.get(s.stop_sequence));
            if (event?.time != null) {
                estimatedUtc = new Date(toNum(event.time) * 1000);
                propagatedDelay = Math.round((estimatedUtc - scheduled) / 1000);
                isRealtime = true;
            } else if (event?.delay != null) {
                propagatedDelay = toNum(event.delay);
                estimatedUtc = new Date(scheduled.getTime() + propagatedDelay * 1000);
                isRealtime = true;
            } else if (propagatedDelay != null) {
                estimatedUtc = new Date(scheduled.getTime() + propagatedDelay * 1000);
                isRealtime = true;
            }

            const secondsUntil = Math.round((estimatedUtc - syncNow) / 1000);
            const isUpcoming = secondsUntil > -60;

            // The user's stop is the route stop closest to them, passed or not: following an
            // upcoming-only nearest made "your stop" slide to the terminus once the bus went by
            if (hasLocation) {
                const dist = haversineMeters(userLat, userLon, parseFloat(s.lat), parseFloat(s.lon));
                if (dist < minDist) { minDist = dist; nearestUpcomingIdx = idx; }
            }

            const scheduledTime = formatBrisbane(scheduled);
            const estimatedTime = formatBrisbane(estimatedUtc);

            return {
                stopId: s.stop_id,
                stopName: s.stop_name,
                stopSequence: s.stop_sequence,
                lat: parseFloat(s.lat),
                lon: parseFloat(s.lon),
                scheduledTime,
                estimatedTime: estimatedTime !== scheduledTime ? estimatedTime : null,
                estimatedUtc: estimatedUtc.toISOString(),
                secondsUntil,
                isUpcoming,
                isNearest: false,
                // Additive: this stop is skipped on this trip (e.g. a diversion)
                isSkipped: (stopTimeUpdateMap.get(s.stop_sequence)?.scheduleRelationship) === STOP_SKIPPED,
                isRealtime,
                delaySeconds: isRealtime ? Math.round((estimatedUtc - scheduled) / 1000) : null
            };
        });

        // Mark nearest upcoming stop (or first upcoming if no location)
        if (nearestUpcomingIdx >= 0) {
            stops[nearestUpcomingIdx].isNearest = true;
        } else {
            const firstUpcoming = stops.findIndex(s => s.isUpcoming);
            if (firstUpcoming >= 0) stops[firstUpcoming].isNearest = true;
        }

        res.json({
            tripInfo: {
                tripId: tripInfo.trip_id,
                routeId: tripInfo.route_id,
                routeShortName: tripInfo.route_short_name,
                routeColor: tripInfo.route_color,
                routeTextColor: tripInfo.route_text_color,
                isCancelled: isTripCancelled(tripUpdates.index.get(trip_id)),
                routeType: tripInfo.route_type,
                headsign: tripInfo.trip_headsign,
                directionId: tripInfo.direction_id
            },
            shape,
            stops,
            vehicle
        });
    } catch (error) {
        console.error('trip-stops failed:', error);
        res.status(500).json({ error: 'Failed to fetch trip stops.' });
    }
});

// --- NEXT TRIPS ENDPOINT ---
// GET /api/next-trips?route_id=X&direction_id=Y&stop_id=Z
// Returns next ~5 upcoming trips for this route+direction at the given stop
app.get('/api/next-trips', async (req, res) => {
    const { route_id, stop_id } = req.query;
    const direction_id = parseInt(req.query.direction_id);
    if (!route_id || isNaN(direction_id) || !stop_id) {
        return res.status(400).json({ error: 'route_id, direction_id, and stop_id are required.' });
    }

    try {
        const syncNow = new Date();

        const [stopRows, tripUpdates, vpCache] = await Promise.all([
            upcomingStopTimes((services) => `
                SELECT st.trip_id, st.departure_time, st.stop_sequence
                FROM stop_times st
                JOIN trips t ON st.trip_id = t.trip_id
                WHERE st.stop_id = $3
                  AND t.route_id = $4 AND t.direction_id = $5
                  AND st.departure_time >= $2
                  AND t.service_id IN ${services}
            `, [stop_id, route_id, direction_id], syncNow),
            getTripUpdates(),
            getVehiclePositions().catch(() => null)
        ]);
        // Timetable order across both service days
        for (const row of stopRows) row.scheduled = scheduledUtc(row.day, row.departure_time);
        stopRows.sort((a, b) => a.scheduled - b.scheduled);

        // trip_id -> stopTimeUpdates, from the shared GTFS-RT cache
        const liveDataMap = { get: (tripId) => tripUpdates.index.get(tripId)?.stopTimeUpdate };

        const trips = [];
        for (const row of stopRows) {
            if (trips.length >= 5) break;
            const scheduled = row.scheduled;
            const stopUpdates = liveDataMap.get(row.trip_id);
            const tripCancelled = isTripCancelled(tripUpdates.index.get(row.trip_id));
            const stopSkipped = !tripCancelled && isStopSkipped(stopUpdates, row.stop_sequence);
            if (!tripCancelled && passedPerFeed(stopUpdates, row.stop_sequence, vpCache?.index.get(row.trip_id))) continue;
            const { estimatedUtc, isRealtime, delaySeconds } = liveStopTime(stopUpdates, row.stop_sequence, scheduled);

            // Filter on the live time so a late bus isn't dropped once its scheduled time passes
            const secondsUntil = Math.round((estimatedUtc - syncNow) / 1000);
            if (secondsUntil < -60) continue;

            const scheduledTime = formatBrisbane(scheduled);
            const estTime = formatBrisbane(estimatedUtc);

            trips.push({
                tripId: row.trip_id,
                scheduledTime,
                estimatedTime: estTime !== scheduledTime ? estTime : null,
                departureUtc: estimatedUtc.toISOString(),
                isRealtime,
                delaySeconds,
                isCancelled: tripCancelled || stopSkipped
            });
        }

        res.json({ trips });
    } catch (error) {
        console.error('next-trips failed:', error);
        res.status(500).json({ error: 'Failed to fetch next trips.' });
    }
});

// --- PLAN ENDPOINT ---
// GET /api/plan?fromLat=X&fromLon=Y&toLat=A&toLon=B&time=08:00am&date=2026-03-09
// Proxies to OTP and returns cleaned itineraries
const OTP_URL = process.env.OTP_URL || 'http://152.67.98.226:8080';

// ── GET /api/plan-delays?trip_ids=T1,T2 ────────────────────────────────────
// Returns GTFS-RT departure delay (seconds) for the requested trip IDs.
// Only trips with delay > 0 appear in the response.
// Used by clients to show "Delays reported" badge when expanding an itinerary.
app.get('/api/plan-delays', async (req, res) => {
    const { trip_ids } = req.query;
    if (!trip_ids) return res.json({ delays: {} });
    // OTP prefixes trip IDs with agency ID (e.g. "1:36180842-BT...") but the
    // GTFS-RT feed uses bare trip IDs — strip the prefix before matching.
    const requested = new Set(
        trip_ids.split(',').map(s => s.trim().replace(/^\d+:/, '')).filter(Boolean)
    );

    try {
        const byTrip = (await getTripUpdates()).index;

        const delays = {};
        for (const tripId of requested) {
            const tu = byTrip.get(tripId);
            if (!tu) continue;
            let maxDelay = 0;
            for (const stu of (tu.stopTimeUpdate || [])) {
                const d = stu.departure?.delay ?? stu.arrival?.delay ?? 0;
                if (d > maxDelay) maxDelay = d;
            }
            if (maxDelay > 0) delays[tu.trip.tripId] = maxDelay;
        }

        res.json({ delays });
    } catch (e) {
        console.error('plan-delays failed:', e);
        res.json({ delays: {} });
    }
});

// --- ALERTS ENDPOINT ---
// GET /api/alerts?route_ids=412-5146,SPRP-4740&stop_ids=1951,600284
// Active Translink service alerts (plus those starting within 24 h, as "upcoming") that
// affect any of the given routes or stops, most important first. Stop matching includes
// the stop's parent station and sibling platforms.
app.get('/api/alerts', async (req, res) => {
    const split = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
    const routeIds = split(req.query.route_ids);
    const stopIds = split(req.query.stop_ids);
    if (!routeIds.length && !stopIds.length) return res.json({ alerts: [] });

    try {
        // Stops expand to their station (parent + sibling platforms) and to every route that
        // serves them: route-wide alerts like track closures name routes, not stops, and a
        // closed station has no departures for the client to take route ids from
        const [alerts, stopRows, servingRows] = await Promise.all([
            getAlerts().then(c => c.index),
            stopIds.length
                ? pool.query(`
                    SELECT s.stop_id, NULLIF(s.parent_station, '') AS parent
                    FROM stops s
                    WHERE s.stop_id = ANY($1)
                       OR s.parent_station IN (SELECT parent_station FROM stops WHERE stop_id = ANY($1) AND parent_station <> '')
                  `, [stopIds]).then(r => r.rows)
                : Promise.resolve([]),
            stopIds.length
                ? pool.query(`
                    SELECT DISTINCT t.route_id
                    FROM stop_times st JOIN trips t ON t.trip_id = st.trip_id
                    WHERE st.stop_id = ANY($1)
                  `, [stopIds]).then(r => r.rows)
                : Promise.resolve([])
        ]);

        const sections = await closureSections(alerts);
        const wantCodes = new Map(routeIds.map(id => [routeCode(id), id]));
        for (const r of servingRows) if (!wantCodes.has(routeCode(r.route_id))) wantCodes.set(routeCode(r.route_id), r.route_id);
        const wantStops = new Set(stopIds);
        for (const r of stopRows) { wantStops.add(r.stop_id); if (r.parent) wantStops.add(r.parent); }

        const now = Math.floor(Date.now() / 1000);
        const out = [];
        for (const a of alerts) {
            const w = alertWindow(a, now);
            if (!w) continue;

            let matchedRouteIds = [...a.routeCodes].filter(c => wantCodes.has(c)).map(c => wantCodes.get(c));
            let matchedStopIds = [...a.stopIds].filter(s => wantStops.has(s));
            // A closure with known stations matters at a stop only inside the closed section;
            // asked by route alone (line details), the route match stands
            const section = sections.get(a.id);
            if (section && stopIds.length) {
                const closed = new Set(section.map(s => s.stop_id));
                matchedStopIds = stopRows
                    .filter(r => stopIds.includes(r.stop_id) && (closed.has(r.stop_id) || closed.has(r.parent)))
                    .map(r => r.stop_id);
                if (!matchedStopIds.length) matchedRouteIds = [];
            }
            if (!matchedRouteIds.length && !matchedStopIds.length) continue;

            out.push(alertJson(a, w, { matchedRouteIds, matchedStopIds, affectedStations: stationNames(section) }));
        }
        out.sort((x, y) => y.priority - x.priority || (x.activeFrom || '').localeCompare(y.activeFrom || ''));
        res.json({ alerts: out });
    } catch (error) {
        console.error('alerts failed:', error);
        // Alerts are supplementary: never break the screen asking for them
        res.json({ alerts: [] });
    }
});

// GET /api/alerts/all?lat=X&lon=Y
// Every current (and next-24 h) alert across the network, nearest first: distance is to the
// closest stop the alert names or that a route it names serves. Alerts with nothing within
// the scanned area (or no location given) come last, by importance.
const ALERTS_NEARBY_SCAN = 6000;   // nearest stops considered when measuring alert distance

app.get('/api/alerts/all', async (req, res) => {
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
    const hasLocation = !isNaN(lat) && !isNaN(lon);
    try {
        const now = Math.floor(Date.now() / 1000);
        const [alerts, stopRows] = await Promise.all([
            getAlerts().then(c => c.index),
            hasLocation
                // KNN on the location index: the nearest few thousand stops, closest first
                ? pool.query(`
                    SELECT stop_id, stop_name, NULLIF(parent_station, '') AS parent, servicing_routes,
                           ROUND(ST_Distance(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography))::int AS dist
                    FROM stops
                    ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
                    LIMIT $3
                  `, [lon, lat, ALERTS_NEARBY_SCAN]).then(r => r.rows)
                : Promise.resolve([])
        ]);

        const sections = await closureSections(alerts);
        const out = [];
        for (const a of alerts) {
            const w = alertWindow(a, now);
            if (!w) continue;
            const section = sections.get(a.id);
            let nearest = null;
            if (section) {
                // Distance to the closed section itself, not to anywhere its routes run
                if (hasLocation) {
                    for (const s of section) {
                        const dist = Math.round(haversineMeters(lat, lon, Number(s.lat), Number(s.lon)));
                        if (!nearest || dist < nearest.dist) nearest = { dist, stop_name: s.stop_name };
                    }
                }
            } else {
                // Rows are sorted by distance, so the first match is the nearest
                nearest = stopRows.find(s =>
                    a.stopIds.has(s.stop_id) || (s.parent && a.stopIds.has(s.parent)) ||
                    (s.servicing_routes && s.servicing_routes.split(', ').some(r => a.routeCodes.has(r))));
            }
            out.push(alertJson(a, w, {
                distanceM: nearest ? nearest.dist : null,
                nearestStopName: nearest ? nearest.stop_name : null,
                // A few route codes for display; routeCount has the full total
                routeCodes: [...a.routeCodes].sort().slice(0, 12),
                affectedStations: stationNames(section)
            }));
        }
        out.sort((x, y) => {
            const dx = x.distanceM ?? Infinity, dy = y.distanceM ?? Infinity;
            if (dx !== dy) return dx - dy;
            return y.priority - x.priority;
        });
        res.json({ alerts: out });
    } catch (error) {
        console.error('alerts/all failed:', error);
        res.json({ alerts: [] });
    }
});

// --- ETA: a saved-place chip's answer ("Home · 34 min · leave in 3 min · 412") ---------
// GET /api/eta?fromLat&fromLon&toLat&toLon -> { eta: {...} | null } (~300 bytes; /api/plan's
// itineraries are ~40 KB). Plans now, in Brisbane time. Cached ~90 s per origin (to ~150 m),
// destination and minute, so reopening the app or neighbours heading the same way are free.
const ETA_CACHE_MS = 90_000;
const etaCache = new Map();   // key -> { at, eta }
app.get('/api/eta', async (req, res) => {
    const fromLat = parseFloat(req.query.fromLat), fromLon = parseFloat(req.query.fromLon);
    const toLat = parseFloat(req.query.toLat), toLon = parseFloat(req.query.toLon);
    if ([fromLat, fromLon, toLat, toLon].some(isNaN)) {
        return res.status(400).json({ error: 'fromLat, fromLon, toLat, toLon are required.' });
    }
    const now = Date.now();
    const key = etaCacheKey(fromLat, fromLon, toLat, toLon, now);
    const hit = etaCache.get(key);
    if (hit && now - hit.at < ETA_CACHE_MS) return res.json({ eta: hit.eta, cached: true });
    try {
        const day = serviceDay(new Date(now));
        const date = `${day.dateString.slice(0, 4)}-${day.dateString.slice(4, 6)}-${day.dateString.slice(6)}`;
        const otpUrl = `${OTP_URL}/otp/routers/default/plan` +
            `?fromPlace=${fromLat},${fromLon}&toPlace=${toLat},${toLon}` +
            `&time=${encodeURIComponent(formatBrisbane(new Date(now)))}&date=${date}` +
            `&mode=TRANSIT,WALK&numItineraries=3&walkReluctance=5&maxWalkDistance=1500`;
        const otpRes = await fetch(otpUrl, { headers: { 'User-Agent': 'WayGo/1.0' }, timeout: 8000 });
        if (!otpRes.ok) return res.status(502).json({ error: 'OTP request failed.' });
        const best = bestItinerary((await otpRes.json()).plan?.itineraries);
        const eta = best ? etaSummary(best, now) : null;
        if (etaCache.size > 2000) etaCache.clear();
        etaCache.set(key, { at: now, eta });
        res.json({ eta });
    } catch (error) {
        console.error('eta failed:', error);
        res.status(500).json({ error: 'Failed to work out a travel time.' });
    }
});

// --- PLACES: address and place search for the planner and saved places -----------------
// GET /api/places?q=&lat=&lon= -> [{ placeId, displayName, lat, lon }] (up to 6, SEQ only).
// With PHOTON_URL set (our own Photon on the Oracle box, see scripts/setup-photon.sh) every
// query goes there. Until then: public Photon, and Nominatim for "45 Station Rd" style house
// numbers, as the app did directly; both public services limit heavy and commercial use.
// Cached 10 min per query and ~1 km of location, so typing doesn't repeat upstream calls.
const PHOTON_URL = process.env.PHOTON_URL || null;          // e.g. http://152.67.98.226/photon
const PHOTON_KEY = process.env.PHOTON_KEY || '';
const PLACES_CACHE_MS = 10 * 60_000;
const placesCache = new Map();
const geoHeaders = { 'User-Agent': 'WayGo/1.0 (transit.sn-app.space; Brisbane transit app)' };

async function photonSearch(base, q, lat, lon, extraHeaders = {}) {
    const url = `${base}/api?q=${encodeURIComponent(q)}&lat=${lat}&lon=${lon}&bbox=${SEQ_BBOX}&lang=en&limit=10`;
    const r = await fetch(url, { headers: { ...geoHeaders, ...extraHeaders }, timeout: 5000 });
    if (!r.ok) throw new Error(`Photon ${r.status}`);
    return tidy(((await r.json()).features || []).map(fromPhoton));
}

async function nominatimSearch(q) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&countrycodes=au` +
        `&viewbox=${SEQ_BBOX}&bounded=1&format=json&limit=6`;
    const r = await fetch(url, { headers: geoHeaders, timeout: 5000 });
    if (!r.ok) throw new Error(`Nominatim ${r.status}`);
    return tidy((await r.json()).map(fromNominatim));
}

app.get('/api/places', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 3) return res.json([]);
    // Brisbane CBD when the location isn't known
    const lat = Number.isFinite(parseFloat(req.query.lat)) ? parseFloat(req.query.lat) : -27.4698;
    const lon = Number.isFinite(parseFloat(req.query.lon)) ? parseFloat(req.query.lon) : 153.0251;
    const key = `${q.toLowerCase()}@${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = placesCache.get(key);
    if (hit && Date.now() - hit.at < PLACES_CACHE_MS) return res.json(hit.results);
    try {
        let results;
        if (PHOTON_URL) {
            results = await photonSearch(PHOTON_URL, q, lat, lon, PHOTON_KEY ? { 'X-WayGo-Key': PHOTON_KEY } : {});
        } else if (HOUSE_NUMBER_PREFIX.test(q)) {
            results = await nominatimSearch(q);
        } else {
            results = await photonSearch('https://photon.komoot.io', q, lat, lon).catch(() => []);
            if (!results.length) results = await nominatimSearch(q);
        }
        if (placesCache.size > 5000) placesCache.clear();
        placesCache.set(key, { at: Date.now(), results });
        res.json(results);
    } catch (error) {
        console.error('places failed:', error.message);
        res.json([]);
    }
});

// --- HEALTH: is everything the app depends on working? ----------------------------------
// GET /api/health -> 200 when all checks pass, 503 otherwise, with a line per check. Watched by
// an uptime monitor every few minutes, so problems email/notify instead of waiting to be noticed.
// Cached 60 s: monitors (and anyone else) can't turn it into load on OTP or Photon.
const HEALTH_CACHE_MS = 60_000;
const TIMETABLE_MIN_DAYS = 7;          // warn while there's still time for the weekly import to fix it
const REALTIME_MAX_AGE_S = 300;
let healthCache = null;

async function healthChecks() {
    const timed = async (name, fn) => {
        const t0 = Date.now();
        try {
            const detail = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 10000))]);
            return { name, ok: true, ms: Date.now() - t0, ...detail };
        } catch (e) {
            return { name, ok: false, ms: Date.now() - t0, error: e.message };
        }
    };
    return Promise.all([
        timed('timetable', async () => {
            const { rows } = await pool.query('SELECT max(end_date) AS e FROM calendar');
            const end = rows[0].e;
            const today = serviceDay().dateString;
            const days = Math.round((Date.UTC(+end.slice(0, 4), +end.slice(4, 6) - 1, +end.slice(6)) -
                Date.UTC(+today.slice(0, 4), +today.slice(4, 6) - 1, +today.slice(6))) / 86_400_000);
            if (days < TIMETABLE_MIN_DAYS) throw new Error(`timetable ends ${end}, ${days} days away`);
            return { validUntil: end, daysLeft: days };
        }),
        timed('realtime', async () => {
            const feed = (await getTripUpdates()).feed;
            const ageS = Math.round(Date.now() / 1000 - toNum(feed.header?.timestamp));
            if (!(ageS <= REALTIME_MAX_AGE_S)) throw new Error(`Translink trip updates are ${ageS}s old`);
            return { ageSeconds: ageS };
        }),
        timed('planner', async () => {
            // Roma Street to South Bank: always has a plan when OTP is up
            const r = await fetch(`${OTP_URL}/otp/routers/default/plan?fromPlace=-27.4656,153.0194&toPlace=-27.4766,153.0203&mode=TRANSIT,WALK&numItineraries=1`,
                { headers: { 'User-Agent': 'WayGo/1.0' }, timeout: 9000 });
            if (!r.ok) throw new Error(`OTP HTTP ${r.status}`);
            const n = ((await r.json()).plan?.itineraries || []).length;
            if (!n) throw new Error('OTP returned no plan');
            return {};
        }),
        timed('places', async () => {
            if (!PHOTON_URL) return { note: 'using public geocoders (PHOTON_URL not set)' };
            const results = await photonSearch(PHOTON_URL, 'Suncorp Stadium', -27.47, 153.02, PHOTON_KEY ? { 'X-WayGo-Key': PHOTON_KEY } : {});
            if (!results.length) throw new Error('Photon found nothing for "Suncorp Stadium"');
            return {};
        })
    ]);
}

app.get('/api/health', async (req, res) => {
    if (!healthCache || Date.now() - healthCache.at > HEALTH_CACHE_MS) {
        healthCache = { at: Date.now(), checks: await healthChecks() };
    }
    const ok = healthCache.checks.every(c => c.ok);
    res.status(ok ? 200 : 503).json({ ok, checkedAt: new Date(healthCache.at).toISOString(), checks: healthCache.checks });
});

app.get('/api/plan', async (req, res) => {
    const { fromLat, fromLon, toLat, toLon, time, date, modes, arriveBy } = req.query;
    if (!fromLat || !fromLon || !toLat || !toLon) {
        return res.status(400).json({ error: 'fromLat, fromLon, toLat, toLon are required.' });
    }
    const planDate = date || new Date().toISOString().slice(0, 10);
    const planTime = time || '8:00am';
    const planModes = modes || 'TRANSIT,WALK';

    try {
        const otpUrl = `${OTP_URL}/otp/routers/default/plan` +
            `?fromPlace=${fromLat},${fromLon}` +
            `&toPlace=${toLat},${toLon}` +
            `&time=${encodeURIComponent(planTime)}` +
            `&date=${planDate}` +
            `&mode=${planModes}` +
            `&numItineraries=5` +
            `&walkReluctance=5` +
            `&maxWalkDistance=1500` +
            // Optional: plan to arrive by `time` instead of leaving at it
            (arriveBy === 'true' ? '&arriveBy=true' : '');

        const otpRes = await fetch(otpUrl, { headers: { 'User-Agent': 'WayGo/1.0' } });
        if (!otpRes.ok) return res.status(502).json({ error: 'OTP request failed.' });

        const data = await otpRes.json();
        const itineraries = (data.plan?.itineraries || []).map(it => ({
            duration: it.duration,
            startTime: it.startTime,
            endTime: it.endTime,
            walkDistance: Math.round(it.walkDistance),
            transfers: it.transfers,
            legs: it.legs.map(leg => ({
                mode: leg.mode,
                startTime: leg.startTime,
                endTime: leg.endTime,
                duration: Math.round(leg.duration),
                distance: Math.round(leg.distance),
                from: { name: leg.from.name, lat: leg.from.lat, lon: leg.from.lon, stopCode: leg.from.stopCode },
                to:   { name: leg.to.name,   lat: leg.to.lat,   lon: leg.to.lon,   stopCode: leg.to.stopCode   },
                routeShortName: leg.routeShortName || null,
                routeLongName:  leg.routeLongName  || null,
                routeColor:     leg.routeColor     || null,
                headsign:       leg.headsign       || null,
                tripId:         leg.tripId         || null,
                legGeometry:    leg.legGeometry?.points || null,
                steps: (leg.steps || []).map(s => ({
                    distance: Math.round(s.distance),
                    streetName: s.streetName,
                    relativeDirection: s.relativeDirection,
                    absoluteDirection: s.absoluteDirection
                }))
            }))
        }));

        const TRANSIT_MODES = new Set(['BUS','RAIL','TRAM','FERRY','SUBWAY','GONDOLA','FUNICULAR','CABLE_CAR']);
        const hasTransit = it => it.legs.some(l => TRANSIT_MODES.has(l.mode));

        // Put transit itineraries first; walk-only fall to the back
        const sorted = [
            ...itineraries.filter(hasTransit),
            ...itineraries.filter(it => !hasTransit(it))
        ];

        res.json({ itineraries: sorted });
    } catch (error) {
        console.error('plan failed:', error);
        res.status(500).json({ error: 'Failed to fetch journey plan.' });
    }
});

// The website: on Vercel this was a separate static build, here the API serves it too
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// A deploy or restart sends SIGTERM: finish the requests in flight, then close
process.on('SIGTERM', () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
});
