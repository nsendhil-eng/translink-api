// Rate limiting: how many requests one caller may make a minute, by tier. Pure (the clock is passed
// in): tested in test/rate-limit.test.js. Counted in this server's memory, which is right for one
// server; several would need a shared counter.
//
// Limits are per IP and deliberately generous: mobile networks put many phones behind one address,
// so they catch scripts and runaway loops, not people. The expensive tier is everything that asks
// the trip planner or the address search on the Oracle server.

const WINDOW_MS = 60_000;

const TIERS = {
    // The planner and the address search: a phone on an open journey screen asks ~6 a minute
    expensive: { limit: 90, paths: ['/api/plan', '/api/stop-options', '/api/replan-from-trip', '/api/walk', '/api/eta', '/api/places'] },
    // Everything else: timetable and live feed reads, a few milliseconds each
    general: { limit: 600, paths: null }
};

/** The tier a path counts against */
function tierOf(path) {
    return TIERS.expensive.paths.includes(path) ? 'expensive' : 'general';
}

/**
 * The caller's address. Behind DigitalOcean's edge the socket is the proxy, so the platform's own
 * header is used (`do-connecting-ip`, set by the edge, which overwrites anything the caller sends);
 * then Cloudflare's; never the left end of X-Forwarded-For, which the caller can write.
 */
function clientIp(headers, socketIp) {
    const h = (k) => { const v = headers[k]; return (Array.isArray(v) ? v[0] : v || '').trim(); };
    return h('do-connecting-ip') || h('cf-connecting-ip') || forwardedPublic(h('x-forwarded-for')) || socketIp || 'unknown';
}

/** A private or loopback address: a proxy inside the platform, not a caller */
const isPrivate = (ip) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|::ffff:(10|127|192\.168)\.)/i.test(ip);

/**
 * The right-most public address in X-Forwarded-For: each proxy appends who it heard from, so the
 * right end is written by our own edge; the left end is whatever the caller claimed
 */
function forwardedPublic(xff) {
    const ips = xff.split(',').map(s => s.trim()).filter(Boolean);
    for (let i = ips.length - 1; i >= 0; i--) if (!isPrivate(ips[i])) return ips[i];
    return '';
}

/** Which header the address came from, for /api/health: shows the setup is reading the right one */
function clientIpSource(headers) {
    if (headers['do-connecting-ip']) return 'do-connecting-ip';
    if (headers['cf-connecting-ip']) return 'cf-connecting-ip';
    return forwardedPublic(String(headers['x-forwarded-for'] || '')) ? 'x-forwarded-for (right-most public)' : 'socket';
}

/**
 * Fixed one-minute windows per caller and tier. `check(ip, path, nowMs)` returns
 * { ok, tier, limit, remaining, retryAfterS }.
 */
function createLimiter({ tiers = TIERS, windowMs = WINDOW_MS, maxKeys = 50_000 } = {}) {
    const counts = new Map();   // "tier|ip" -> { start, n }
    const stats = { limited: { expensive: 0, general: 0 } };
    function check(ip, path, nowMs) {
        const tier = tierOf(path);
        const limit = tiers[tier].limit;
        const key = `${tier}|${ip}`;
        let c = counts.get(key);
        if (!c || nowMs - c.start >= windowMs) {
            c = { start: nowMs, n: 0 };
            counts.set(key, c);
            // Old windows go: memory stays bounded however many addresses call
            if (counts.size > maxKeys) for (const [k, v] of counts) { if (nowMs - v.start >= windowMs) counts.delete(k); }
        }
        c.n++;
        const ok = c.n <= limit;
        if (!ok) stats.limited[tier] = (stats.limited[tier] || 0) + 1;
        return { ok, tier, limit, remaining: Math.max(0, limit - c.n), retryAfterS: Math.max(1, Math.ceil((c.start + windowMs - nowMs) / 1000)) };
    }
    return { check, stats, size: () => counts.size };
}

module.exports = { createLimiter, tierOf, clientIp, clientIpSource, TIERS, WINDOW_MS };
