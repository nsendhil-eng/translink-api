// Journey Planner — plan.js
// Depends on: app.js (for window.state.map, state.BASE_URL), Leaflet

const planState = {
    fromResult: null,
    toResult: null,
    itineraries: [],
    selectedIdx: null,
    sortMode: 'fastest',
    activeField: null,
    debounceTimer: null,
    polylines: [],
    markers: [],
    userLat: null,
    userLon: null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function planFormatTime(epochMs) {
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

function hexToRgb(hex) {
    const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
    return `rgb(${r},${g},${b})`;
}

function legColor(leg) {
    if (!leg.isTransit) return '#888888';
    return leg.routeColor ? `#${leg.routeColor}` : '#2563eb';
}

// ─── Nominatim search ─────────────────────────────────────────────────────────

async function searchNominatim(q) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&countrycodes=au&viewbox=151.5,-28.5,154.0,-26.0&bounded=0`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'WayGoTransit/1.0' } });
    return res.json();
}

function shortName(displayName) {
    const parts = displayName.split(',').map(s => s.trim());
    const first = parts[0] || displayName;
    if (/^\d+[A-Za-z]?(\/\d+)?$/.test(first)) {
        return parts[1] ? `${first} ${parts[1]}` : first;
    }
    return first;
}

// ─── Suggestions UI ───────────────────────────────────────────────────────────

function renderSuggestions(results, field) {
    const el = document.getElementById(`plan-${field}-suggestions`);
    if (!results.length) { el.classList.add('hidden'); return; }
    el.innerHTML = results.map((r, i) => `
        <div class="plan-suggestion-item px-4 py-3 cursor-pointer hover:bg-blue-50 dark:hover:bg-gray-700 flex gap-3 items-start border-b border-gray-100 dark:border-gray-700 last:border-0"
             data-idx="${i}" data-display="${r.display_name.replace(/"/g,'&quot;')}"
             data-lat="${r.lat}" data-lon="${r.lon}">
            <svg class="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd"/>
            </svg>
            <div class="min-w-0">
                <div class="font-medium text-sm text-gray-900 dark:text-white truncate">${shortName(r.display_name)}</div>
                <div class="text-xs text-gray-500 dark:text-gray-400 truncate">${r.display_name.split(',').slice(1,3).join(',').trim()}</div>
            </div>
        </div>`).join('');
    el.classList.remove('hidden');
}

function hideSuggestions(field) {
    document.getElementById(`plan-${field}-suggestions`)?.classList.add('hidden');
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

    const base = state.BASE_URL;
    const url = `${base}/api/plan?fromLat=${fromResult.lat}&fromLon=${fromResult.lon}&toLat=${toResult.lat}&toLon=${toResult.lon}&date=${date}&time=${encodeURIComponent(time)}`;

    showPlanLoading();
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
        renderPlanResults();
    } catch (e) {
        showPlanError('Could not load journey options. Please try again.');
    }
}

// ─── Map drawing ──────────────────────────────────────────────────────────────

function clearPlanMap() {
    planState.polylines.forEach(p => p.remove());
    planState.markers.forEach(m => m.remove());
    planState.polylines = [];
    planState.markers = [];
}

function drawItineraryOnMap(itinerary) {
    if (!state.map) return;
    clearPlanMap();

    const allPts = [];
    for (const leg of itinerary.legs) {
        if (!leg.legGeometry) continue;
        let pts;
        try { pts = decodePolyline(leg.legGeometry); } catch(e) { continue; }
        if (pts.length < 2) continue;
        allPts.push(...pts);

        const color = legColor(leg);
        const polyline = L.polyline(pts, {
            color,
            weight: leg.isTransit ? 5 : 3,
            opacity: leg.isTransit ? 0.9 : 0.6,
            dashArray: leg.isTransit ? null : '8 6',
        }).addTo(state.map);
        planState.polylines.push(polyline);
    }

    // Stop markers for transit legs
    for (const leg of itinerary.legs.filter(l => l.isTransit)) {
        const color = legColor(leg);
        [
            { pt: [leg.from.lat, leg.from.lon], label: leg.from.name, type: 'board' },
            { pt: [leg.to.lat, leg.to.lon], label: leg.to.name, type: 'alight' }
        ].forEach(({ pt, label, type }) => {
            const icon = L.divIcon({
                html: `<div class="plan-stop-marker">
                    <div class="plan-stop-label">${escapeHtml(label)}</div>
                    <div class="plan-stop-stem"></div>
                    <div class="plan-stop-dot" style="background:${color}"></div>
                </div>`,
                className: '',
                iconSize: [120, 42],
                iconAnchor: [60, 42],
            });
            const marker = L.marker(pt, { icon }).addTo(state.map);
            planState.markers.push(marker);
        });
    }

    // Fit bounds
    if (allPts.length >= 2) {
        state.map.fitBounds(L.latLngBounds(allPts), { padding: [50, 50] });
    }
}

// ─── Results rendering ────────────────────────────────────────────────────────

function sortedItineraries() {
    const list = [...planState.itineraries];
    if (planState.sortMode === 'fastest') list.sort((a, b) => a.duration - b.duration);
    else list.sort((a, b) => a.walkDistance - b.walkDistance);
    return list;
}

function renderPlanResults() {
    const container = document.getElementById('departures-container');
    const sorted = sortedItineraries();

    if (!sorted.length) {
        container.innerHTML = `<p class="text-center text-gray-500 dark:text-gray-400 py-8">No routes found for this journey.</p>`;
        return;
    }

    container.innerHTML = `
        <div id="plan-sort-chips" class="flex gap-2 mb-3">
            <button id="sort-fastest" class="plan-sort-btn ${planState.sortMode==='fastest' ? 'plan-sort-active' : 'plan-sort-inactive'}">
                ⚡ Fastest
            </button>
            <button id="sort-walking" class="plan-sort-btn ${planState.sortMode==='walking' ? 'plan-sort-active' : 'plan-sort-inactive'}">
                🚶 Least walking
            </button>
        </div>
        <div id="plan-cards-list" class="space-y-3">
            ${sorted.map((it, i) => renderItineraryCard(it, i)).join('')}
        </div>`;

    document.getElementById('sort-fastest').addEventListener('click', () => { planState.sortMode = 'fastest'; renderPlanResults(); });
    document.getElementById('sort-walking').addEventListener('click', () => { planState.sortMode = 'walking'; renderPlanResults(); });

    container.querySelectorAll('.plan-card').forEach(card => {
        card.addEventListener('click', () => {
            const idx = parseInt(card.dataset.idx);
            planState.selectedIdx = planState.selectedIdx === idx ? null : idx;
            renderPlanResults();
            const it = sortedItineraries()[idx];
            if (planState.selectedIdx === idx) drawItineraryOnMap(it);
            else clearPlanMap();
        });
    });
}

function renderItineraryCard(it, i) {
    const isSelected = planState.selectedIdx === i;
    const walkM = it.walkDistance;
    const walkText = walkM < 1000 ? `${walkM}m walk` : `${(walkM/1000).toFixed(1)}km walk`;
    const transferText = it.transfers === 0 ? 'No transfers' : it.transfers === 1 ? '1 transfer' : `${it.transfers} transfers`;

    const modeChips = it.legs.map((leg, li) => {
        if (leg.isTransit) {
            const bg = leg.routeColor ? `#${leg.routeColor}` : '#2563eb';
            const name = leg.routeShortName || leg.mode;
            return `<span class="plan-mode-chip" style="background:${bg}">${escapeHtml(name)}</span>`;
        } else if (leg.mode === 'WALK') {
            return `<span class="plan-walk-icon">🚶</span>`;
        }
        return '';
    }).join(`<span class="text-gray-400 text-xs">›</span>`);

    const timeline = isSelected ? renderTimeline(it) : '';

    return `
        <div class="plan-card ${isSelected ? 'plan-card-selected' : ''} bg-white dark:bg-gray-800 rounded-xl shadow cursor-pointer hover:shadow-md transition-shadow"
             data-idx="${i}">
            <div class="p-4">
                <div class="flex items-start justify-between gap-3">
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-bold text-blue-600 dark:text-blue-400 mb-1.5">
                            ${planFormatTime(it.startTime)} → ${planFormatTime(it.endTime)}
                        </div>
                        <div class="flex flex-wrap items-center gap-1 mb-2">
                            ${modeChips}
                        </div>
                        <div class="text-xs text-gray-500 dark:text-gray-400">${walkText} · ${transferText}</div>
                    </div>
                    <div class="flex-shrink-0 text-right">
                        <div class="text-xl font-bold text-gray-900 dark:text-white">${Math.round(it.duration/60)} min</div>
                        <svg class="w-4 h-4 ml-auto text-gray-400 mt-1 transition-transform ${isSelected ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                        </svg>
                    </div>
                </div>
            </div>
            ${isSelected ? `<div class="border-t border-gray-100 dark:border-gray-700">${timeline}</div>` : ''}
        </div>`;
}

function renderTimeline(it) {
    const rows = it.legs.map((leg, i) => {
        const isLast = i === it.legs.length - 1;
        const color = legColor(leg);
        const timeStr = planFormatTime(leg.startTime);
        const durationMins = Math.round(leg.duration / 60);

        let content;
        if (leg.isTransit) {
            const bg = leg.routeColor ? `#${leg.routeColor}` : '#2563eb';
            const name = leg.routeShortName || leg.mode;
            const headsign = leg.headsign || leg.routeLongName || '';
            content = `
                <div class="flex items-center gap-2 mb-1">
                    <span class="plan-mode-chip" style="background:${bg}">${escapeHtml(name)}</span>
                    <span class="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">${escapeHtml(headsign)}</span>
                    <span class="ml-auto text-xs text-gray-400 flex-shrink-0">${durationMins} min</span>
                </div>
                <div class="text-xs text-gray-500 dark:text-gray-400">Board&nbsp; ${escapeHtml(leg.from.name)}</div>
                <div class="text-xs text-gray-500 dark:text-gray-400">Alight&nbsp; ${escapeHtml(leg.to.name)} · ${planFormatTime(leg.endTime)}</div>`;
        } else {
            const distM = leg.distance;
            const distText = distM < 1000 ? `${distM}m` : `${(distM/1000).toFixed(1)}km`;
            const street = leg.steps && leg.steps[0] ? leg.steps[0].streetName || 'path' : 'path';
            content = `
                <div class="flex items-center gap-2">
                    <span class="text-sm font-medium text-gray-700 dark:text-gray-300">🚶 Walk ${distText}</span>
                    <span class="ml-auto text-xs text-gray-400">${durationMins} min</span>
                </div>
                <div class="text-xs text-gray-500 dark:text-gray-400">${escapeHtml(street)}</div>`;
        }

        return `
            <div class="flex gap-3 px-4 py-2">
                <div class="flex flex-col items-center flex-shrink-0 w-14 pt-0.5">
                    <span class="text-xs font-bold text-gray-700 dark:text-gray-300 text-right w-full">${timeStr}</span>
                </div>
                <div class="flex flex-col items-center flex-shrink-0 mt-1.5">
                    <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${color}"></div>
                    ${!isLast ? `<div class="w-0.5 flex-1 mt-1 min-h-[28px]" style="background:${color}44"></div>` : ''}
                </div>
                <div class="flex-1 min-w-0 pb-3">${content}</div>
            </div>`;
    }).join('');

    // Final destination row
    const last = it.legs[it.legs.length - 1];
    const destName = planState.toResult?.displayName ? shortName(planState.toResult.displayName) : last.to.name;
    const endRow = `
        <div class="flex gap-3 px-4 py-2 pb-4">
            <div class="flex flex-col items-center flex-shrink-0 w-14 pt-0.5">
                <span class="text-xs font-bold text-gray-700 dark:text-gray-300 text-right w-full">${planFormatTime(last.endTime)}</span>
            </div>
            <div class="flex flex-col items-center flex-shrink-0 mt-1.5">
                <div class="w-3 h-3 rounded-full flex-shrink-0 bg-gray-700 dark:bg-gray-300"></div>
            </div>
            <div class="flex-1 min-w-0 pb-3">
                <span class="text-sm font-semibold text-gray-800 dark:text-gray-200">${escapeHtml(destName)}</span>
            </div>
        </div>`;

    return `<div class="divide-y-0">${rows}${endRow}</div>`;
}

function showPlanLoading() {
    document.getElementById('departures-container').innerHTML = `
        <div class="flex justify-center items-center py-12">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>`;
}

function showPlanError(msg) {
    document.getElementById('departures-container').innerHTML = `
        <p class="text-center text-red-500 py-8">${msg}</p>`;
}

// ─── Plan panel UI ───────────────────────────────────────────────────────────

function setPlanField(field, result) {
    if (field === 'from') {
        planState.fromResult = result;
        document.getElementById('plan-from-input').value = result ? shortName(result.displayName) : '';
    } else {
        planState.toResult = result;
        document.getElementById('plan-to-input').value = result ? shortName(result.displayName) : '';
    }
    hideSuggestions(field);
    if (planState.fromResult && planState.toResult) fetchPlan();
}

function swapPlanFields() {
    const tmpResult = planState.fromResult;
    planState.fromResult = planState.toResult;
    planState.toResult = tmpResult;
    document.getElementById('plan-from-input').value = planState.fromResult ? shortName(planState.fromResult.displayName) : '';
    document.getElementById('plan-to-input').value = planState.toResult ? shortName(planState.toResult.displayName) : '';
    if (planState.fromResult && planState.toResult) fetchPlan();
}

function debounceSearch(field, query) {
    clearTimeout(planState.debounceTimer);
    if (query.trim().length < 3) { hideSuggestions(field); return; }
    planState.debounceTimer = setTimeout(async () => {
        const results = await searchNominatim(query);
        renderSuggestions(results, field);
    }, 350);
}

function escapeHtml(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Initialisation ───────────────────────────────────────────────────────────

function openPlanMode() {
    document.getElementById('plan-panel').classList.remove('hidden');
    document.getElementById('top-header').querySelector('section').classList.add('hidden');
    document.getElementById('route-filters-container').classList.add('hidden');
    document.getElementById('direction-filters-container')?.classList.add('hidden');
    document.getElementById('plan-from-input').focus();

    // Pre-fill "My Location" if we have coords
    if (planState.userLat && !planState.fromResult) {
        planState.fromResult = { lat: planState.userLat, lon: planState.userLon, displayName: 'My Location' };
        document.getElementById('plan-from-input').value = 'My Location';
    }
}

function closePlanMode() {
    document.getElementById('plan-panel').classList.add('hidden');
    document.getElementById('top-header').querySelector('section').classList.remove('hidden');
    document.getElementById('route-filters-container').classList.remove('hidden');
    clearPlanMap();
    planState.fromResult = null;
    planState.toResult = null;
    planState.itineraries = [];
    planState.selectedIdx = null;
    document.getElementById('plan-from-input').value = '';
    document.getElementById('plan-to-input').value = '';
    document.getElementById('departures-container').innerHTML = '';
}

function initPlan() {
    // Get user location if available
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            planState.userLat = pos.coords.latitude;
            planState.userLon = pos.coords.longitude;
        });
    }

    // Plan button
    document.getElementById('plan-btn').addEventListener('click', openPlanMode);
    document.getElementById('plan-close-btn').addEventListener('click', closePlanMode);

    // Swap button
    document.getElementById('plan-swap-btn').addEventListener('click', swapPlanFields);

    // Use my location button
    document.getElementById('plan-use-location').addEventListener('click', () => {
        if (planState.userLat) {
            planState.fromResult = { lat: planState.userLat, lon: planState.userLon, displayName: 'My Location' };
            document.getElementById('plan-from-input').value = 'My Location';
            hideSuggestions('from');
            if (planState.toResult) fetchPlan();
        }
    });

    // From input
    const fromInput = document.getElementById('plan-from-input');
    fromInput.addEventListener('input', e => {
        planState.fromResult = null;
        debounceSearch('from', e.target.value);
    });
    fromInput.addEventListener('focus', () => {
        planState.activeField = 'from';
        if (fromInput.value.trim().length >= 3) debounceSearch('from', fromInput.value);
    });

    // To input
    const toInput = document.getElementById('plan-to-input');
    toInput.addEventListener('input', e => {
        planState.toResult = null;
        debounceSearch('to', e.target.value);
    });
    toInput.addEventListener('focus', () => {
        planState.activeField = 'to';
        if (toInput.value.trim().length >= 3) debounceSearch('to', toInput.value);
    });

    // Suggestion clicks (event delegation)
    ['from', 'to'].forEach(field => {
        document.getElementById(`plan-${field}-suggestions`).addEventListener('click', e => {
            const item = e.target.closest('.plan-suggestion-item');
            if (!item) return;
            setPlanField(field, {
                lat: parseFloat(item.dataset.lat),
                lon: parseFloat(item.dataset.lon),
                displayName: item.dataset.display,
            });
            // Move focus to the other field
            if (field === 'from' && !planState.toResult) document.getElementById('plan-to-input').focus();
        });
    });

    // Close suggestions on outside click
    document.addEventListener('click', e => {
        if (!e.target.closest('#plan-from-input') && !e.target.closest('#plan-from-suggestions')) hideSuggestions('from');
        if (!e.target.closest('#plan-to-input') && !e.target.closest('#plan-to-suggestions')) hideSuggestions('to');
    });
}

document.addEventListener('DOMContentLoaded', initPlan);
