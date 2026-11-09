// A cleaned copy of Translink's TripUpdates feed for the journey planner (OTP), which trusts
// whatever it's given.
//  - Translink marks most trains in service REPLACEMENT even though they're timetabled trips
//    (often just a platform change). OTP rejects those, so they're relabelled SCHEDULED.
//  - A big delay is dropped when the vehicle physically couldn't reach the stop in the time the
//    feed gives ("leaving Moggill now", with the bus 15 km away). The planner then uses the
//    timetable for that trip, which is better than planning around a false 35 minutes.
//    A vehicle merely far from its first stop isn't dropped: finishing an earlier run and
//    starting late is real, and the feed's predicted time then leaves room for the trip there.
const { metres } = require('./sqlite-data');
const { toNum, isFreshFix } = require('./realtime');

const REPLACEMENT = 5;              // TripDescriptor.ScheduleRelationship
const SCHEDULED = 0;
const MIN_DELAY_TO_DOUBT_S = 300;   // small delays do no harm even if wrong
const NEAR_STOP_M = 1500;           // GPS noise, depots and laybys
const FASTEST_M_PER_S = 30;         // about 108 km/h: nothing here is reliably faster

/** The largest delay anywhere on the trip, either direction, in seconds */
function biggestDelay(update) {
    let max = 0;
    for (const s of update.stopTimeUpdate || []) {
        max = Math.max(max, Math.abs(s.arrival?.delay || 0), Math.abs(s.departure?.delay || 0));
    }
    return max;
}

/** Whether the feed's own time at the vehicle's current stop is out of reach from where the vehicle is */
function isImpossible(update, vehicle, stops, nowS) {
    if (!vehicle?.position || !isFreshFix(vehicle.timestamp, nowS)) return false;
    if (biggestDelay(update) < MIN_DELAY_TO_DOUBT_S) return false;
    const seq = vehicle.currentStopSequence;
    const i = stops.findIndex(s => s.stop_sequence === seq);
    const at = (update.stopTimeUpdate || []).find(s => s.stopSequence === seq);
    if (i < 0 || !at) return false;
    const predicted = toNum(at.departure?.time) || toNum(at.arrival?.time);
    if (!predicted) return false;
    const away = metres(vehicle.position.latitude, vehicle.position.longitude, stops[i].lat, stops[i].lon);
    // Between stops, it can be up to a stop-gap away without being wrong
    const gap = i > 0 ? metres(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon) : 0;
    const margin = NEAR_STOP_M + gap;
    return away > margin + Math.max(0, predicted - nowS) * FASTEST_M_PER_S;
}

/**
 * @param entities      the feed's entities; never modified (the same objects serve other endpoints)
 * @param stopsOfTrip   trip id -> [{ stop_sequence, lat, lon }], [] when it isn't in the timetable
 * @param vehicleOfTrip trip id -> VehiclePosition, or undefined
 */
function cleanTripUpdates(entities, { stopsOfTrip, vehicleOfTrip, nowS }) {
    const stats = { relabelled: 0, dropped: 0, passed: 0 };
    const entity = [];
    for (const e of entities) {
        const update = e.tripUpdate;
        const tripId = update?.trip?.tripId;
        if (!tripId) { entity.push(e); continue; }
        const vehicle = vehicleOfTrip(tripId);
        const replacement = update.trip.scheduleRelationship === REPLACEMENT;
        // Only look up the stops of trips that might change: this runs over every trip in the feed
        const stops = replacement || (vehicle && biggestDelay(update) >= MIN_DELAY_TO_DOUBT_S) ? stopsOfTrip(tripId) : [];
        if (stops.length && isImpossible(update, vehicle, stops, nowS)) { stats.dropped++; continue; }
        if (replacement && stops.length) {
            stats.relabelled++;
            entity.push({ ...e, tripUpdate: { ...update, trip: { ...update.trip, scheduleRelationship: SCHEDULED } } });
            continue;
        }
        stats.passed++;
        entity.push(e);
    }
    return { entity, stats };
}

module.exports = { cleanTripUpdates, isImpossible };
