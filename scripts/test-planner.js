#!/usr/bin/env node
/**
 * test-planner.js
 *
 * Runs a set of real Brisbane journeys through /api/plan and prints results
 * in a format easy to compare against the official Translink planner
 * at https://www.translink.com.au/plan-your-journey
 *
 * Usage:
 *   node scripts/test-planner.js                  # uses production API
 *   node scripts/test-planner.js --local          # uses localhost:3001
 *   node scripts/test-planner.js --time "8:30am"  # override time (default: now)
 */

const BASE_URL = process.argv.includes('--local')
    ? 'http://localhost:3001'
    : 'https://transit.sn-app.space';

// Override time if --time flag provided
const timeArg = (() => {
    const idx = process.argv.indexOf('--time');
    return idx !== -1 ? process.argv[idx + 1] : null;
})();

// ─── Test journeys ─────────────────────────────────────────────────────────
// A mix of bus, train, ferry, transfer routes across Brisbane
// Translink planner: https://www.translink.com.au/plan-your-journey
// Enter the same From/To to compare

const TEST_JOURNEYS = [
    {
        name: 'CBD → South Brisbane (bus)',
        from: { name: 'Queen Street Mall, Brisbane CBD', lat: -27.4698, lon: 153.0251 },
        to:   { name: 'South Brisbane Station',          lat: -27.4797, lon: 153.0181 },
        expectedModes: ['BUS'],
        notes: 'Short hop, expect routes like 60 / 61 / 199'
    },
    {
        name: 'Central Station → Brisbane Airport (train)',
        from: { name: 'Brisbane Central Station',    lat: -27.4645, lon: 153.0260 },
        to:   { name: 'Brisbane Airport (Domestic)', lat: -27.3842, lon: 153.1175 },
        expectedModes: ['RAIL'],
        notes: 'Airtrain — direct, no transfers. ~21 min'
    },
    {
        name: 'Fortitude Valley → University of Queensland (bus)',
        from: { name: 'Fortitude Valley Station', lat: -27.4566, lon: 153.0333 },
        to:   { name: 'UQ St Lucia',              lat: -27.4975, lon: 153.0137 },
        expectedModes: ['WALK', 'BUS'],
        notes: 'Express routes 169/412 — no transfer expected'
    },
    {
        name: 'City → Indooroopilly (train)',
        from: { name: 'Roma Street Station', lat: -27.4647, lon: 153.0174 },
        to:   { name: 'Indooroopilly Station', lat: -27.4997, lon: 152.9693 },
        expectedModes: ['RAIL', 'BUS'],
        notes: 'Ipswich/Springfield train OR direct bus 444 — ~20 min'
    },
    {
        name: 'North Quay → Kangaroo Point (ferry)',
        from: { name: 'North Quay Ferry Terminal', lat: -27.472707, lon: 153.022477 },
        to:   { name: 'Holman St Ferry Terminal, Kangaroo Point', lat: -27.465638, lon: 153.033444 },
        expectedModes: ['FERRY'],
        notes: 'CityFerry F1/F11 — direct ferry leg, ~10 min'
    },
    {
        name: 'Carindale → Myer Centre (bus)',
        from: { name: 'Carindale Shopping Centre', lat: -27.4999, lon: 153.1018 },
        to:   { name: 'Myer Centre, Queen St Mall', lat: -27.4698, lon: 153.0251 },
        expectedModes: ['BUS'],
        notes: 'Routes like 222/224 — possible transfer at Garden City'
    },
    {
        name: 'Toowong → Chermside (multi-mode)',
        from: { name: 'Toowong Station', lat: -27.4847, lon: 152.9821 },
        to:   { name: 'Chermside Bus Station', lat: -27.3879, lon: 153.0265 },
        expectedModes: ['RAIL', 'BUS'],
        notes: 'Train to city, then bus north — expect transfer at CBD'
    },
    {
        name: 'Springfield Central → Brisbane CBD (train)',
        from: { name: 'Springfield Central Station', lat: -27.6670, lon: 152.9178 },
        to:   { name: 'Brisbane Central Station',    lat: -27.4645, lon: 153.0260 },
        expectedModes: ['RAIL'],
        notes: 'Springfield line direct — ~45 min, no transfer'
    },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmtTime(epochMs) {
    const d = new Date(epochMs);
    let h = d.getHours(), m = d.getMinutes();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2,'0')} ${ap}`;
}

function fmtDuration(seconds) {
    const m = Math.round(seconds / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m/60)}h ${m%60}m`;
}

function nowDateAndTime() {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    let h = now.getHours(), m = now.getMinutes();
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    const time = `${h}:${String(m).padStart(2,'0')}${ap}`;
    return { date, time };
}

function renderItinerary(it, idx) {
    const legs = it.legs;
    const isTransit = m => ['BUS','RAIL','TRAM','FERRY','SUBWAY'].includes(m);
    const transitLegs = legs.filter(l => isTransit(l.mode));
    const walkM = it.walkDistance;
    const walkStr = walkM < 1000 ? `${walkM}m` : `${(walkM/1000).toFixed(1)}km`;

    const legSummary = legs.map(l => {
        if (isTransit(l.mode)) {
            const route = l.routeShortName || l.mode;
            const headsign = l.headsign ? ` → ${l.headsign}` : '';
            return `  [${l.mode}] ${route}${headsign}`;
        }
        return `  [WALK] ${Math.round(l.distance)}m`;
    }).join('\n');

    const boardAlights = transitLegs.map(l =>
        `  ${l.routeShortName || l.mode}: Board ${l.from.name} @ ${fmtTime(l.startTime)} | Alight ${l.to.name} @ ${fmtTime(l.endTime)}`
    ).join('\n');

    return [
        `  Option ${idx+1}: ${fmtTime(it.startTime)} → ${fmtTime(it.endTime)}  (${fmtDuration(it.duration)})`,
        `  Walk: ${walkStr} | Transfers: ${it.transfers}`,
        `  Legs:`,
        legSummary,
        boardAlights ? `  Stop details:\n${boardAlights}` : '',
    ].filter(Boolean).join('\n');
}

function qualityScore(it, journey) {
    const isTransit = m => ['BUS','RAIL','TRAM','FERRY','SUBWAY'].includes(m);
    const modes = it.legs.map(l => l.mode);
    const hasExpectedMode = journey.expectedModes.some(em => modes.includes(em));
    const onlyWalk = modes.every(m => m === 'WALK');
    if (onlyWalk) return '⚠️  WALK ONLY — no transit found';
    if (!hasExpectedMode) return `⚠️  Expected ${journey.expectedModes.join('/')} but got ${[...new Set(modes.filter(isTransit))].join('/')}`;
    return '✅ Looks correct';
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function runJourney(journey, date, time) {
    const url = `${BASE_URL}/api/plan?fromLat=${journey.from.lat}&fromLon=${journey.from.lon}&toLat=${journey.to.lat}&toLon=${journey.to.lon}&date=${date}&time=${encodeURIComponent(time)}`;
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        return { error: e.message };
    }
}

async function main() {
    const { date, time: nowTime } = nowDateAndTime();
    const time = timeArg || nowTime;

    console.log('═'.repeat(70));
    console.log('  Brisbane Transit — Planner Quality Test');
    console.log(`  API:  ${BASE_URL}`);
    console.log(`  Time: ${time} on ${date}`);
    console.log(`  Compare against: https://www.translink.com.au/plan-your-journey`);
    console.log('═'.repeat(70));

    let passed = 0, warned = 0, failed = 0;

    for (const journey of TEST_JOURNEYS) {
        console.log(`\n${'─'.repeat(70)}`);
        console.log(`📍 ${journey.name}`);
        console.log(`   From:  ${journey.from.name}`);
        console.log(`   To:    ${journey.to.name}`);
        console.log(`   Hint:  ${journey.notes}`);

        const data = await runJourney(journey, date, time);

        if (data.error) {
            console.log(`   ❌ ERROR: ${data.error}`);
            failed++;
            continue;
        }

        const itineraries = data.itineraries || [];
        if (!itineraries.length) {
            console.log('   ❌ No itineraries returned');
            failed++;
            continue;
        }

        // Show top 3 options
        console.log(`\n  Results (${itineraries.length} options):`);
        itineraries.slice(0, 3).forEach((it, i) => {
            console.log(renderItinerary(it, i));
            if (i === 0) {
                const score = qualityScore(it, journey);
                console.log(`  Quality: ${score}`);
                if (score.startsWith('✅')) passed++;
                else warned++;
            }
            console.log();
        });
    }

    console.log('═'.repeat(70));
    console.log(`  Summary: ${passed} ✅  ${warned} ⚠️   ${failed} ❌  (${TEST_JOURNEYS.length} journeys tested)`);
    console.log('═'.repeat(70));
    console.log('\nTo compare on Translink:');
    console.log('  https://www.translink.com.au/plan-your-journey');
    console.log('  Enter the same From/To and set the same departure time.\n');
}

main().catch(console.error);
