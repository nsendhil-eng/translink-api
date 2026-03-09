// plan.js — standalone journey planner for plan.html
// Dependencies: Leaflet (loaded in plan.html)

const BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:3001'
    : 'https://transit.sn-app.space';

const planState = {
    map: null,
    fromResult: null,
    toResult: null,
    itineraries: [],
    selectedIdx: null,
    sortMode: 'fastest',
    debounceTimer: null,
    polylines: [],
    markers: [],
    userLat: null,
    userLon: null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(epochMs) {
    const d = new Date(epochMs);
    let h = d.getHours(), m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function decodePolyline(encoded) {
    const pts = [];
    let idx = 0, lat = 0, lng = 0;
    while (idx < encoded.length) {
        let b, shift = 0, result = 0;
        do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lat += (result & 1) ? ~(result >> 1) : (result >> 1);
        shift = 0; result = 0;
        do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lng += (result & 1) ? ~(result >> 1) : (result >> 1);
        pts.push([lat / 1e5, lng / 1e5]);
    }
    return pts;
}

function legColor(leg) {
    return (leg.routeColor && leg.routeColor !== 'null') ? `#${leg.routeColor}` : '#2563eb';
}

function escapeHtml(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function shortName(displayName) {
    const parts = displayName.split(',').map(s => s.trim());
    const first = parts[0] || displayName;
    return /^\d+[A-Za-z]?(\/\d+)?$/.test(first) && parts[1] ? `${first} ${parts[1]}` : first;
}

// ─── Map ──────────────────────────────────────────────────────────────────────

function initMap() {
    planState.map = L.map('plan-map').setView([-27.47, 153.02], 12);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(planState.map);
}

function clearMapOverlays() {
    planState.polylines.forEach(p => p.remove());
    planState.markers.forEach(m => m.remove());
    planState.polylines = [];
    planState.markers = [];
}

function drawItinerary(itinerary) {
    clearMapOverlays();
    document.getElementById('map-hint').classList.add('hidden');
    const allPts = [];

    for (const leg of itinerary.legs) {
        if (!leg.legGeometry) continue;
        let pts;
        try { pts = decodePolyline(leg.legGeometry); } catch(e) { continue; }
        if (pts.length < 2) continue;
        allPts.push(...pts);

        const color = leg.isTransit ? legColor(leg) : '#888888';
        const poly = L.polyline(pts, {
            color,
            weight: leg.isTransit ? 5 : 3,
            opacity: leg.isTransit ? 0.9 : 0.55,
            dashArray: leg.isTransit ? null : '8 6',
        }).addTo(planState.map);
        planState.polylines.push(poly);
    }

    // Stop label markers for transit legs
    const seen = new Set();
    for (const leg of itinerary.legs.filter(l => l.isTransit)) {
        const color = legColor(leg);
        for (const { pt, label } of [
            { pt: [leg.from.lat, leg.from.lon], label: leg.from.name },
            { pt: [leg.to.lat,   leg.to.lon],   label: leg.to.name   },
        ]) {
            const key = pt.join(',');
            if (seen.has(key)) continue;
            seen.add(key);
            const icon = L.divIcon({
                html: `<div class="plan-stop-marker">
                    <div class="plan-stop-label">${escapeHtml(label)}</div>
                    <div class="plan-stop-stem"></div>
                    <div class="plan-stop-dot" style="background:${color}"></div>
                </div>`,
                className: '',
                iconSize: [130, 44],
                iconAnchor: [65, 44],
            });
            planState.markers.push(L.marker(pt, { icon }).addTo(planState.map));
        }
    }

    if (allPts.length >= 2) {
        planState.map.fitBounds(L.latLngBounds(allPts), { padding: [50, 50] });
    }
}

// ─── Nominatim search ─────────────────────────────────────────────────────────

async function nominatimSearch(q) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&countrycodes=au&viewbox=151.5,-28.5,154.0,-26.0&bounded=0`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'BrisbaneTransit/1.0' } });
    return res.json();
}

function renderSuggestions(results, field) {
    const el = document.getElementById(`plan-${field}-suggestions`);
    if (!results.length) { el.classList.add('hidden'); return; }
    el.innerHTML = results.map((r, i) => `
        <div class="plan-suggestion-item flex items-start gap-3 px-4 py-3 cursor-pointer
                    hover:bg-blue-50 dark:hover:bg-gray-700 border-b border-gray-100
                    dark:border-gray-700 last:border-0"
             data-lat="${r.lat}" data-lon="${r.lon}"
             data-display="${escapeHtml(r.display_name)}">
            <svg class="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd"/>
            </svg>
            <div class="min-w-0">
                <div class="text-sm font-medium text-gray-900 dark:text-white truncate">${escapeHtml(shortName(r.display_name))}</div>
                <div class="text-xs text-gray-500 dark:text-gray-400 truncate">${escapeHtml(r.display_name.split(',').slice(1,3).join(',').trim())}</div>
            </div>
        </div>`).join('');
    el.classList.remove('hidden');
}

function hideSuggestions(field) {
    document.getElementById(`plan-${field}-suggestions`)?.classList.add('hidden');
}

function debouncedSearch(field, query) {
    clearTimeout(planState.debounceTimer);
    if (query.trim().length < 3) { hideSuggestions(field); return; }
    planState.debounceTimer = setTimeout(async () => {
        const results = await nominatimSearch(query);
        renderSuggestions(results, field);
    }, 350);
}

function selectSuggestion(field, lat, lon, displayName) {
    const result = { lat: parseFloat(lat), lon: parseFloat(lon), displayName };
    if (field === 'from') {
        planState.fromResult = result;
        document.getElementById('plan-from-input').value = shortName(displayName);
        hideSuggestions('from');
        if (!planState.toResult) document.getElementById('plan-to-input').focus();
    } else {
        planState.toResult = result;
        document.getElementById('plan-to-input').value = shortName(displayName);
        hideSuggestions('to');
    }
    if (planState.fromResult && planState.toResult) fetchPlan();
}

// ─── Plan fetch ───────────────────────────────────────────────────────────────

async function fetchPlan() {
    const { fromResult, toResult } = planState;
    if (!fromResult || !toResult) return;

    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    let h = now.getHours(), m = now.getMinutes();
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    const time = `${h}:${String(m).padStart(2,'0')}${ampm}`;

    const url = `${BASE_URL}/api/plan?fromLat=${fromResult.lat}&fromLon=${fromResult.lon}&toLat=${toResult.lat}&toLon=${toResult.lon}&date=${date}&time=${encodeURIComponent(time)}`;

    showLoading();
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('Plan request failed');
        const data = await res.json();
        planState.itineraries = (data.itineraries || []).map(it => ({
            ...it,
            legs: it.legs.map(leg => ({
                ...leg,
                isTransit: ['BUS','RAIL','TRAM','FERRY','SUBWAY','TRANSIT'].includes(leg.mode)
            }))
        }));
        planState.selectedIdx = null;
        renderResults();
    } catch (e) {
        document.getElementById('results-content').innerHTML = `
            <p class="text-center text-red-500 dark:text-red-400 py-8 px-4">
                Could not load journey options. Please try again.
            </p>`;
    }
}

// ─── Results rendering ────────────────────────────────────────────────────────

function showLoading() {
    clearMapOverlays();
    planState.selectedIdx = null;
    document.getElementById('results-content').innerHTML = `
        <div class="flex justify-center items-center py-16">
            <div class="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600"></div>
        </div>`;
}

function sorted() {
    const list = [...planState.itineraries];
    return planState.sortMode === 'fastest'
        ? list.sort((a, b) => a.duration - b.duration)
        : list.sort((a, b) => a.walkDistance - b.walkDistance);
}

function renderResults() {
    const list = sorted();
    const el = document.getElementById('results-content');

    if (!list.length) {
        el.innerHTML = `<p class="text-center text-gray-500 dark:text-gray-400 py-8">No routes found.</p>`;
        return;
    }

    el.innerHTML = `
        <div class="flex gap-2 mb-1">
            <button id="sort-fastest" class="plan-sort-btn ${planState.sortMode==='fastest' ? 'plan-sort-active' : 'plan-sort-inactive'}">⚡ Fastest</button>
            <button id="sort-walking" class="plan-sort-btn ${planState.sortMode==='walking' ? 'plan-sort-active' : 'plan-sort-inactive'}">🚶 Least walking</button>
        </div>
        ${list.map((it, i) => renderCard(it, i)).join('')}`;

    el.querySelector('#sort-fastest').addEventListener('click', () => { planState.sortMode = 'fastest'; renderResults(); });
    el.querySelector('#sort-walking').addEventListener('click', () => { planState.sortMode = 'walking'; renderResults(); });

    el.querySelectorAll('.plan-card').forEach(card => {
        card.addEventListener('click', () => {
            const i = parseInt(card.dataset.idx);
            if (planState.selectedIdx === i) {
                planState.selectedIdx = null;
                clearMapOverlays();
                document.getElementById('map-hint').classList.remove('hidden');
            } else {
                planState.selectedIdx = i;
                drawItinerary(sorted()[i]);
            }
            renderResults();
            // Scroll card into view on mobile
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
    });
}

function renderCard(it, i) {
    const sel = planState.selectedIdx === i;
    const walkText = it.walkDistance < 1000 ? `${it.walkDistance}m walk` : `${(it.walkDistance/1000).toFixed(1)}km walk`;
    const transferText = it.transfers === 0 ? 'No transfers' : it.transfers === 1 ? '1 transfer' : `${it.transfers} transfers`;
    const durationMins = Math.round(it.duration / 60);

    const chips = it.legs.map(leg => {
        if (leg.isTransit) {
            const bg = legColor(leg);
            return `<span class="plan-mode-chip" style="background:${bg}">${escapeHtml(leg.routeShortName || leg.mode)}</span>`;
        }
        if (leg.mode === 'WALK') return `<span class="text-gray-400 text-sm">🚶</span>`;
        return '';
    }).join(`<span class="text-gray-300 dark:text-gray-600 text-xs px-0.5">›</span>`);

    return `
        <div class="plan-card bg-white dark:bg-gray-800 rounded-xl shadow cursor-pointer
                    hover:shadow-md transition-all ${sel ? 'plan-card-selected' : ''}" data-idx="${i}">
            <div class="p-4">
                <div class="flex items-start justify-between gap-3">
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-bold text-blue-600 dark:text-blue-400 mb-1.5">
                            ${formatTime(it.startTime)} → ${formatTime(it.endTime)}
                        </div>
                        <div class="flex flex-wrap items-center gap-1 mb-2">${chips}</div>
                        <div class="text-xs text-gray-500 dark:text-gray-400">${walkText} · ${transferText}</div>
                    </div>
                    <div class="flex-shrink-0 text-right">
                        <div class="text-2xl font-bold text-gray-900 dark:text-white">${durationMins}<span class="text-sm font-normal ml-0.5">min</span></div>
                        <svg class="w-4 h-4 ml-auto text-gray-400 mt-1 transition-transform ${sel ? 'rotate-180' : ''}"
                             fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                        </svg>
                    </div>
                </div>
            </div>
            ${sel ? `<div class="border-t border-gray-100 dark:border-gray-700">${renderTimeline(it)}</div>` : ''}
        </div>`;
}

function renderTimeline(it) {
    const legRows = it.legs.map((leg, i) => {
        const isLast = i === it.legs.length - 1;
        const color = leg.isTransit ? legColor(leg) : '#9ca3af';
        const durationMins = Math.round(leg.duration / 60);
        let content;

        if (leg.isTransit) {
            const bg = legColor(leg);
            const name = escapeHtml(leg.routeShortName || leg.mode);
            const headsign = escapeHtml(leg.headsign || leg.routeLongName || '');
            content = `
                <div class="flex items-center gap-2 mb-1 flex-wrap">
                    <span class="plan-mode-chip flex-shrink-0" style="background:${bg}">${name}</span>
                    <span class="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate flex-1 min-w-0">${headsign}</span>
                    <span class="text-xs text-gray-400 flex-shrink-0">${durationMins} min</span>
                </div>
                <div class="text-xs text-gray-500 dark:text-gray-400">Board&ensp;${escapeHtml(leg.from.name)}</div>
                <div class="text-xs text-gray-500 dark:text-gray-400">Alight&ensp;${escapeHtml(leg.to.name)}&ensp;·&ensp;${formatTime(leg.endTime)}</div>`;
        } else {
            const dist = leg.distance < 1000 ? `${leg.distance}m` : `${(leg.distance/1000).toFixed(1)}km`;
            const street = leg.steps?.[0]?.streetName?.trim() || 'path';
            content = `
                <div class="flex items-center gap-2">
                    <span class="text-sm font-medium text-gray-700 dark:text-gray-300">🚶 Walk ${dist}</span>
                    <span class="ml-auto text-xs text-gray-400">${durationMins} min</span>
                </div>
                <div class="text-xs text-gray-500 dark:text-gray-400">${escapeHtml(street)}</div>`;
        }

        return `
            <div class="flex gap-3 px-4 py-2">
                <div class="w-14 flex-shrink-0 pt-0.5 text-right">
                    <span class="text-xs font-bold text-gray-700 dark:text-gray-300">${formatTime(leg.startTime)}</span>
                </div>
                <div class="flex flex-col items-center flex-shrink-0 mt-1.5 w-3">
                    <div class="w-2.5 h-2.5 rounded-full" style="background:${color}"></div>
                    ${!isLast ? `<div class="w-0.5 flex-1 mt-1 min-h-[28px]" style="background:${color}55"></div>` : ''}
                </div>
                <div class="flex-1 min-w-0 pb-3">${content}</div>
            </div>`;
    }).join('');

    // Destination row
    const last = it.legs[it.legs.length - 1];
    const dest = escapeHtml(planState.toResult?.displayName ? shortName(planState.toResult.displayName) : last.to.name);
    const endRow = `
        <div class="flex gap-3 px-4 pt-1 pb-4">
            <div class="w-14 flex-shrink-0 text-right">
                <span class="text-xs font-bold text-gray-700 dark:text-gray-300">${formatTime(last.endTime)}</span>
            </div>
            <div class="flex items-start flex-shrink-0 mt-1.5 w-3">
                <div class="w-3 h-3 rounded-full bg-gray-600 dark:bg-gray-300"></div>
            </div>
            <div class="flex-1 min-w-0 font-semibold text-sm text-gray-800 dark:text-gray-200">${dest}</div>
        </div>`;

    return legRows + endRow;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
    initMap();

    // User location
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            planState.userLat = pos.coords.latitude;
            planState.userLon = pos.coords.longitude;
        });
    }

    // Use my location button
    document.getElementById('plan-use-location').addEventListener('click', () => {
        if (planState.userLat) {
            planState.fromResult = { lat: planState.userLat, lon: planState.userLon, displayName: 'My Location' };
            document.getElementById('plan-from-input').value = 'My Location';
            hideSuggestions('from');
            if (!planState.toResult) document.getElementById('plan-to-input').focus();
            else fetchPlan();
        }
    });

    // Swap
    document.getElementById('plan-swap-btn').addEventListener('click', () => {
        [planState.fromResult, planState.toResult] = [planState.toResult, planState.fromResult];
        document.getElementById('plan-from-input').value = planState.fromResult ? shortName(planState.fromResult.displayName) : '';
        document.getElementById('plan-to-input').value   = planState.toResult   ? shortName(planState.toResult.displayName)   : '';
        if (planState.fromResult && planState.toResult) fetchPlan();
    });

    // Input events
    ['from', 'to'].forEach(field => {
        const input = document.getElementById(`plan-${field}-input`);
        input.addEventListener('input', e => {
            if (field === 'from') planState.fromResult = null;
            else planState.toResult = null;
            debouncedSearch(field, e.target.value);
        });
        input.addEventListener('focus', () => {
            if (input.value.trim().length >= 3) debouncedSearch(field, input.value);
        });

        // Suggestion clicks
        document.getElementById(`plan-${field}-suggestions`).addEventListener('click', e => {
            const item = e.target.closest('.plan-suggestion-item');
            if (!item) return;
            selectSuggestion(field, item.dataset.lat, item.dataset.lon, item.dataset.display);
        });
    });

    // Close suggestions on outside click
    document.addEventListener('click', e => {
        if (!e.target.closest('#plan-from-input') && !e.target.closest('#plan-from-suggestions')) hideSuggestions('from');
        if (!e.target.closest('#plan-to-input')   && !e.target.closest('#plan-to-suggestions'))   hideSuggestions('to');
    });
}

document.addEventListener('DOMContentLoaded', init);
