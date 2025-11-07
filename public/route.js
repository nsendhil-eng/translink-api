document.addEventListener('DOMContentLoaded', () => {
    function getCookie(name) {
        const nameEQ = name + "=";
        const ca = document.cookie.split(';');
        for(let i=0; i < ca.length; i++) {
            let c = ca[i];
            while (c.charAt(0)==' ') c = c.substring(1,c.length);
            if (c.indexOf(nameEQ) == 0) return JSON.parse(c.substring(nameEQ.length,c.length));
        }
        return null;
    }

    const params = new URLSearchParams(window.location.search);
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:';
    const VERCEL_URL = 'https://transit.sn-app.space';
    const LOCAL_URL = 'http://localhost:3001';
    const BASE_URL = isLocal ? LOCAL_URL : VERCEL_URL;
    const routeShapeEndpoint = `${BASE_URL}/api/route-shape`;
    const routeInfoEndpoint = `${BASE_URL}/api/route-info`;
    const departuresEndpoint = `${BASE_URL}/api/departures`;
    const stopsForRouteEndpoint = `${BASE_URL}/api/stops-for-route`;
    const tripDetailsEndpoint = `${BASE_URL}/api/trip-details`;

    const routeId = params.get('route_id');
    const shapeId = params.get('shape_id');
    const headsign = params.get('headsign');

    const mapStatus = document.getElementById('map-status');
    const routeMapOverlay = document.getElementById('route-map-overlay');
    const departureInfoContainer = document.getElementById('departure-info-container');

    if (!routeId || !shapeId || !headsign) {
        return;
    }

    const map = L.map('map').setView([-27.4698, 153.0251], 12); // Centered on Brisbane
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    let routeStops = [];
    let routeInfo = {};
    let userLocation = null;
    let nearestStopMarker = null;
    const routeLayer = L.featureGroup().addTo(map);

    // --- NEW: Fetch all route data in parallel ---
    Promise.all([
        fetch(`${routeInfoEndpoint}?route_id=${routeId}`).then(res => res.json()),
        fetch(`${routeShapeEndpoint}?shape_id=${shapeId}`).then(res => res.json()),
        fetch(`${stopsForRouteEndpoint}?route_id=${routeId}&headsign=${encodeURIComponent(headsign)}`).then(res => res.json())
    ]).then(([info, geojson, stops]) => {
        routeInfo = info;
        routeStops = stops;

        // 1. Update UI with fetched info
        const routeColor = routeInfo.route_color || '0284c7';
        routeMapOverlay.querySelector('#route-overlay-number').textContent = routeInfo.route_short_name;
        routeMapOverlay.querySelector('#route-overlay-headsign').textContent = `to ${headsign}`;
        routeMapOverlay.querySelector('#route-overlay-number').style.backgroundColor = `#${routeColor}`;
        routeMapOverlay.classList.remove('hidden');

        // 2. Draw route shape
        if (geojson) {
            if (geojson) {
                const routeLine = L.geoJSON(geojson, { style: { color: `#${routeColor}`, weight: 5, opacity: 0.8 } });
                routeLayer.addLayer(routeLine);
                map.fitBounds(routeLayer.getBounds().pad(0.1));
            }
        }

        // 3. Draw stop markers
        stops.forEach(stop => {
            const stopMarker = L.circleMarker([stop.latitude, stop.longitude], {
                radius: 2,
                color: '#ffffff',
                fillColor: '#ffffff',
                fillOpacity: 0.7
            }).bindPopup(`<b>${stop.name}</b>`);
            routeLayer.addLayer(stopMarker);
        });

        // 4. Get user location
        const locationFromCookie = getCookie('userLocation');
        if (locationFromCookie) {
            userLocation = { lat: locationFromCookie.lat, lon: locationFromCookie.lon };
            highlightNearestStop(userLocation.lat, userLocation.lon);
        }

        // Then, get a fresh location to update.
        getFreshUserLocation();

    }).catch(err => {
        console.error('Failed to load route details:', err);
    });

    // This function is now split into two parts.
    // One that uses cookie data instantly, and one that gets a fresh location.

    function getFreshUserLocation() {
        if (!navigator.geolocation) {
            console.log('Geolocation is not supported by your browser.');
            return;
        }

        mapStatus.textContent = 'Locating you...';
        mapStatus.classList.remove('hidden');

        const geoOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 };

        navigator.geolocation.getCurrentPosition(
            (position) => {
                const userLat = position.coords.latitude;
                const userLon = position.coords.longitude;

                mapStatus.classList.add('hidden');

                // Update user location and re-highlight
                userLocation = { lat: userLat, lon: userLon };
                L.marker([userLat, userLon]).addTo(map).bindPopup('Your Location').openPopup();

                if (routeStops.length > 0) {
                    highlightNearestStop(userLat, userLon);
                }
            },
            () => {
                mapStatus.textContent = 'Could not get your location.';
                setTimeout(() => mapStatus.classList.add('hidden'), 3000);
            },
            geoOptions
        );
    }

    function highlightNearestStop(userLat, userLon) {
        let nearestStop = null;
        let minDistance = Infinity;

        routeStops.forEach(stop => {
            const distance = getDistance(userLat, userLon, stop.latitude, stop.longitude);
            if (distance < minDistance) {
                minDistance = distance;
                nearestStop = stop;
            }
        });

        if (nearestStop) {
            const popupContent = `
                <div class="text-center">
                    <div class="text-xs font-bold text-blue-400 mb-1 uppercase tracking-wider">Nearest Stop</div>
                    <div class="font-semibold text-base text-white">${nearestStop.name}</div>
                </div>
            `;
            
            // If a marker already exists, remove it before adding a new one.
            if (nearestStopMarker) {
                nearestStopMarker.remove();
            }

            nearestStopMarker = L.circleMarker([nearestStop.latitude, nearestStop.longitude], {
                radius: 10,
                color: '#1d4ed8',
                fillColor: '#2563eb',
                fillOpacity: 1,
                pane: 'markerPane' // Ensure it's in the right pane
            }).bindPopup(popupContent, { className: 'nearest-stop-popup', offset: [0, -10] }).addTo(map).openPopup();
            
            // Add a pulse animation to the marker's element
            if (nearestStopMarker._path) {
                nearestStopMarker._path.classList.add('pulse');
            }

            fetchDepartureAndNextStop(nearestStop);
        }
    }

    // Haversine formula
    function getDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // Radius of the earth in km
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c; // Distance in km
    }

    async function fetchDepartureAndNextStop(stop) {
        if (!stop || !stop.stop_code) return;

        departureInfoContainer.innerHTML = `<p class="text-center text-gray-500">Checking for next departure...</p>`;

        try {
            const departuresRes = await fetch(`${departuresEndpoint}?stops=${stop.stop_code}`);
            const departures = await departuresRes.json();
            const nextDeparture = departures.find(dep => dep.routeNumber === routeInfo.route_short_name && dep.headsign === headsign);

            if (!nextDeparture) {
                departureInfoContainer.innerHTML = `<p class="text-center text-gray-500">No upcoming departures found for this route at the nearest stop.</p>`;
                return;
            }

            // Fetch upcoming stops for this trip
            const tripDetailsRes = await fetch(`${tripDetailsEndpoint}?trip_id=${nextDeparture.trip_id}&stop_sequence=${nextDeparture.stop_sequence}`);
            const upcomingStopsList = await tripDetailsRes.json();

            const dueInText = formatTimeRemaining(nextDeparture.secondsUntilDeparture);
            const scheduledTime = formatBrisbaneTime(nextDeparture.scheduledDepartureUtc);
            const expectedTime = formatBrisbaneTime(nextDeparture.expectedDepartureUtc);
            const expectedHTML = nextDeparture.expectedDepartureUtc && (expectedTime !== scheduledTime) ? `<span class="font-semibold text-green-400">Expected: ${expectedTime}</span>` : '';

            let upcomingStopsHTML = '';
            if (upcomingStopsList.length > 0) {
                upcomingStopsHTML = `
                    <ol class="relative border-l border-gray-700 space-y-4">
                        ${upcomingStopsList.map(stop => `
                            <li class="ml-4">
                                <div class="absolute w-3 h-3 bg-gray-500 rounded-full mt-1.5 -left-1.5 border border-gray-900 bg-gray-700"></div>
                                <p class="text-base font-medium text-white">${stop.stop_name}</p>
                            </li>
                        `).join('')}
                    </ol>
                `;
            } else {
                upcomingStopsHTML = `<p class="text-gray-400">This is the last stop on the trip.</p>`;
            }

            departureInfoContainer.innerHTML = `
                <div class="bg-gray-800 p-4 rounded-lg shadow-md space-y-6">
                    <div class="text-center">
                        <h3 class="text-lg font-bold text-white">Closest stop next departure from ${stop.name}</h3>
                        <p class="text-3xl font-bold text-blue-400 my-2">${dueInText}</p>
                        <p class="text-sm text-gray-300">Scheduled: ${scheduledTime} ${expectedHTML}</p>
                    </div>
                    <div class="border-t border-gray-700 pt-4"><h3 class="text-lg font-bold text-white mb-3">Upcoming Stops</h3>${upcomingStopsHTML}</div>
                </div>
            `;

        } catch (err) {
            console.error('Failed to fetch departure details:', err);
            departureInfoContainer.innerHTML = `<p class="text-center text-red-500">Could not load departure information.</p>`;
        }
    }

    // Helper functions from app.js
    const formatTimeRemaining = (totalSeconds) => totalSeconds <= 5 ? 'Now' : `${Math.round(totalSeconds / 60)} min`;
    const formatBrisbaneTime = (utcDateString) => !utcDateString ? '' : new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Australia/Brisbane' }).format(new Date(utcDateString));
});