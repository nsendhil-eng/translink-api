// Rules for reading Translink's GTFS-RT feeds: when a service is really due at a stop,
// whether it has already been, and whether it's running at all. Pure functions only
// (no fetching, no database), so they can be tested against recorded feeds.
//
// `nowS` arguments are Unix seconds and default to the current time.

// GTFS-RT enum values (decoded feeds keep numbers)
const TRIP_CANCELED = 3;        // TripDescriptor.ScheduleRelationship.CANCELED
const STOP_SKIPPED = 1;         // StopTimeUpdate.ScheduleRelationship.SKIPPED

// A GPS fix older than this isn't "where the bus is": buses linked to a trip before it
// starts (parked, on layover) keep reporting a position from long ago
const VEHICLE_STALE_S = 180;

const BRISBANE_TZ = 'Australia/Brisbane';
const BRISBANE_UTC_OFFSET_H = 10;   // Queensland has no daylight saving

const nowSeconds = () => Date.now() / 1000;

/** protobufjs gives 64-bit fields as Long objects; everything else as numbers */
function toNum(v) {
    if (v == null) return null;
    if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// --- Service day and timetable times ------------------------------------------

/** Today's GTFS service day in Brisbane: { dateString: 'YYYYMMDD', dayOfWeek: 'monday', year, month (0-based), day } */
function serviceDay(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: BRISBANE_TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long'
    }).formatToParts(now);
    const part = (type) => parts.find(p => p.type === type)?.value || '';
    const dateString = `${part('year')}${part('month')}${part('day')}`;
    return {
        dateString,
        dayOfWeek: part('weekday').toLowerCase(),
        year: parseInt(dateString.substring(0, 4), 10),
        month: parseInt(dateString.substring(4, 6), 10) - 1,
        day: parseInt(dateString.substring(6, 8), 10)
    };
}

/** A GTFS time ("25:15:00" — may pass 24h) on the service day, as a UTC Date */
function scheduledUtc(day, gtfsTime) {
    const [h, m, s] = gtfsTime.split(':').map(Number);
    const d = new Date(Date.UTC(day.year, day.month, day.day));
    d.setUTCHours(h - BRISBANE_UTC_OFFSET_H, m, s);
    return d;
}

/** "14:05" in Brisbane time */
const formatBrisbane = (utcDate) =>
    new Intl.DateTimeFormat('en-AU', { timeZone: BRISBANE_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(utcDate);

// --- Live time at a stop --------------------------------------------------------

/** The event to read at a stop: its departure if that says anything, else its arrival (last stops only send arrivals) */
function stopEvent(stu) {
    if (!stu) return null;
    const dep = stu.departure;
    if (dep && (dep.time != null || dep.delay != null)) return dep;
    const arr = stu.arrival;
    if (arr && (arr.time != null || arr.delay != null)) return arr;
    return null;
}

/**
 * When the service is really due at this stop.
 *  1. the stop's own update: its predicted time, else its delay
 *  2. otherwise the latest earlier stop's delay carried forward (GTFS-RT propagation),
 *     so countdowns past the next updated stop stay live
 *  3. otherwise the timetable
 * Returns { estimatedUtc: Date, isRealtime, delaySeconds (null unless realtime) }.
 */
function liveStopTime(stopTimeUpdates, stopSequence, scheduled) {
    const stus = stopTimeUpdates || [];
    let estimated = null;

    const own = stopEvent(stus.find(u => u.stopSequence === stopSequence));
    if (own?.time != null) estimated = new Date(toNum(own.time) * 1000);
    else if (own?.delay != null) estimated = new Date(scheduled.getTime() + toNum(own.delay) * 1000);
    else {
        const prior = stus
            .filter(u => u.stopSequence < stopSequence && stopEvent(u)?.delay != null)
            .sort((a, b) => b.stopSequence - a.stopSequence)[0];
        if (prior) estimated = new Date(scheduled.getTime() + toNum(stopEvent(prior).delay) * 1000);
    }

    if (!estimated) return { estimatedUtc: scheduled, isRealtime: false, delaySeconds: null };
    return {
        estimatedUtc: estimated,
        isRealtime: true,
        delaySeconds: Math.round((estimated - scheduled) / 1000)
    };
}

// --- Running or not -------------------------------------------------------------

const isTripCancelled = (tripUpdate) => tripUpdate?.trip?.scheduleRelationship === TRIP_CANCELED;

const isStopSkipped = (stopTimeUpdates, stopSequence) =>
    (stopTimeUpdates || []).some(u => u.stopSequence === stopSequence && u.scheduleRelationship === STOP_SKIPPED);

// --- Vehicle fixes ----------------------------------------------------------------

/** Seconds since the GPS fix, or null if the feed gave no timestamp */
function fixAgeSeconds(timestamp, nowS = nowSeconds()) {
    const ts = toNum(timestamp);
    return ts ? Math.max(0, Math.round(nowS - ts)) : null;
}

/** A fix with no timestamp counts as fresh (we can't tell otherwise) */
function isFreshFix(timestamp, nowS = nowSeconds()) {
    const ts = toNum(timestamp);
    return !ts || nowS - ts <= VEHICLE_STALE_S;
}

/**
 * Translink sometimes has two vehicles claiming one trip (e.g. two ferries, one at stop 11
 * and one already past stop 16). Should `candidate` replace `current`? Fresh fixes first,
 * then the one furthest behind: wrongly treating a trip as passed hides a service that's
 * still coming.
 */
function preferVehicle(candidate, current, nowS = nowSeconds()) {
    if (!current) return true;
    const fc = isFreshFix(candidate.timestamp, nowS), fo = isFreshFix(current.timestamp, nowS);
    if (fc !== fo) return fc;
    return (candidate.currentStopSequence ?? Infinity) < (current.currentStopSequence ?? Infinity);
}

/** The vehicle's own fresh position says it's beyond this stop */
function vehiclePassedStop(vehicle, stopSequence, nowS = nowSeconds()) {
    return vehicle?.currentStopSequence != null &&
        vehicle.currentStopSequence > stopSequence &&
        isFreshFix(vehicle.timestamp, nowS);
}

/**
 * Has this trip already been and gone at this stop?
 *  - the vehicle's own (fresh) position wins: Translink sometimes keeps sending
 *    predictions for stops a vehicle has already left (a ferry heading to stop 5 still
 *    "due" at stop 4)
 *  - otherwise, Translink drops stops a vehicle has passed from its TripUpdate, so updates
 *    that start after this stop mean it's gone — even when the timetable says it's still due
 * Cancelled trips have no live progress; callers skip this check for them.
 */
function passedPerFeed(stopTimeUpdates, stopSequence, vehicle, nowS = nowSeconds()) {
    if (vehiclePassedStop(vehicle, stopSequence, nowS)) return true;
    if (!stopTimeUpdates || !stopTimeUpdates.length) return false;
    const first = Math.min(...stopTimeUpdates.map(u => u.stopSequence).filter(n => n != null));
    return Number.isFinite(first) && stopSequence < first;
}

module.exports = {
    TRIP_CANCELED, STOP_SKIPPED, VEHICLE_STALE_S, BRISBANE_TZ,
    toNum, serviceDay, scheduledUtc, formatBrisbane,
    stopEvent, liveStopTime,
    isTripCancelled, isStopSkipped,
    fixAgeSeconds, isFreshFix, preferVehicle, vehiclePassedStop, passedPerFeed
};
