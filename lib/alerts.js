// Translink service alerts: tidying the feed's text, and deciding when an alert matters.

// Translink sends no severity, so rank by effect
const ALERT_EFFECT_RANK = {
    NO_SERVICE: 100, REDUCED_SERVICE: 90, SIGNIFICANT_DELAYS: 85, DETOUR: 80,
    MODIFIED_SERVICE: 60, STOP_MOVED: 40, ACCESSIBILITY_ISSUE: 30, ADDITIONAL_SERVICE: 20
};
const ALERT_KIND = {
    NO_SERVICE: 'disruption', REDUCED_SERVICE: 'disruption', SIGNIFICANT_DELAYS: 'disruption', DETOUR: 'disruption',
    MODIFIED_SERVICE: 'change', STOP_MOVED: 'stopMoved', ACCESSIBILITY_ISSUE: 'accessibility', ADDITIONAL_SERVICE: 'extra'
};
const LONG_RUNNING_S = 30 * 24 * 3600;
const ALERT_UPCOMING_S = 24 * 3600;
// Delay alerts describe a single incident; Translink sometimes never closes them
// (e.g. "9:07pm … delayed up to 10 minutes" still open two days later)
const OPEN_DELAY_MAX_S = 12 * 3600;

// Route ids carry a timetable version ("BRIP-4997"); alerts may name a newer version than
// our database holds, so match on the code before it
const routeCode = (id) => String(id).replace(/-\d+$/, '');

// The feed's text is HTML flattened without spacing: "in briefStart: 11:30pm…OctoberEnd:".
// Break where a lowercase letter, digit or punctuation runs straight into a capitalised
// word — except Scottish/Irish name prefixes like MacGregor or McDowall.
function cleanAlertText(text) {
    if (!text) return '';
    return text
        .replace(/([a-z0-9.)!?:])(?=[A-Z][a-z])/g, (m, ch, offset, s) => {
            const before = s.slice(Math.max(0, offset - 3), offset + 1);
            return /(^|[^A-Za-z])(Mc|Mac)$/.test(before) ? ch : ch + '\n';
        })
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** One feed entity (decoded with enums as strings, longs as numbers) -> our alert record */
function parseAlertEntity(e) {
    const a = e.alert;
    const text = (t) => t?.translation?.find(x => !x.language || x.language.startsWith('en'))?.text || t?.translation?.[0]?.text || '';
    const informed = a.informedEntity || [];
    return {
        id: e.id,
        header: cleanAlertText(text(a.headerText)).replace(/\n/g, ' '),
        description: cleanAlertText(text(a.descriptionText)),
        url: text(a.url) || null,
        cause: a.cause || 'UNKNOWN_CAUSE',
        effect: a.effect || 'UNKNOWN_EFFECT',
        periods: (a.activePeriod || []).map(p => ({ start: p.start || null, end: p.end || null })),
        routeCodes: new Set(informed.filter(x => x.routeId).map(x => routeCode(x.routeId))),
        stopIds: new Set(informed.filter(x => x.stopId).map(x => x.stopId)),
        routeCount: informed.filter(x => x.routeId).length
    };
}

// When an alert applies (now, or within 24 h as "upcoming") and how much it matters;
// null if it's not relevant at this time
function alertWindow(a, now) {
    const periods = a.periods.length ? a.periods : [{ start: null, end: null }];
    const current = periods.find(p => (!p.start || p.start <= now) && (!p.end || p.end >= now));
    const next = current ? null : periods
        .filter(p => p.start && p.start > now && p.start - now <= ALERT_UPCOMING_S)
        .sort((x, y) => x.start - y.start)[0];
    const period = current || next;
    if (!period) return null;
    if (a.effect === 'SIGNIFICANT_DELAYS' && !period.end && period.start && now - period.start > OPEN_DELAY_MAX_S) return null;

    const firstStart = Math.min(...a.periods.map(p => p.start || now));
    const longRunning = now - firstStart > LONG_RUNNING_S;
    const status = current ? 'active' : 'upcoming';
    let priority = ALERT_EFFECT_RANK[a.effect] ?? 10;
    if (longRunning) priority -= 50;      // background conditions never crowd out news
    if (status === 'upcoming') priority -= 5;
    return { status, priority, longRunning, period };
}

function alertJson(a, w, extra) {
    return {
        id: a.id,
        header: a.header,
        description: a.description,
        url: a.url,
        cause: a.cause,
        effect: a.effect,
        kind: ALERT_KIND[a.effect] || 'info',
        status: w.status,
        priority: w.priority,
        longRunning: w.longRunning,
        activeFrom: w.period.start ? new Date(w.period.start * 1000).toISOString() : null,
        activeUntil: w.period.end ? new Date(w.period.end * 1000).toISOString() : null,
        routeCount: a.routeCount,
        ...extra
    };
}

module.exports = { routeCode, cleanAlertText, parseAlertEntity, alertWindow, alertJson, ALERT_EFFECT_RANK, ALERT_KIND };
