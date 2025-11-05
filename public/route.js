document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:';
    const VERCEL_URL = 'https://transit.sn-app.space';
    const LOCAL_URL = 'http://localhost:3001';
    const BASE_URL = isLocal ? LOCAL_URL : VERCEL_URL;
    const routeShapeEndpoint = `${BASE_URL}/api/route-shape`;
    const departuresEndpoint = `${BASE_URL}/api/departures`;
    const stopsForRouteEndpoint = `${BASE_URL}/api/stops-for-route`;
    const routeId = params.get('route_id');
    const shapeId = params.get('shape_id');
    const headsign = params.get('headsign');
    const routeShortName = params.get('route_short_name');
    const routeLongName = params.get('route_long_name');
    const routeColor = params.get('route_color') || '0284c7';

    const routeHeading = document.getElementById('route-heading');
    const mapStatus = document.getElementById('map-status');
    const routeMapOverlay = document.getElementById('route-map-overlay');
    const departureInfoContainer = document.getElementById('departure-info-container');


    if (!routeId || !shapeId || !headsign) {
        routeHeading.textContent = 'Error: Missing route information.';
        return;
    }

    routeHeading.innerHTML = `
        <span class="font-black">${routeShortName}</span>
        <span class="font-normal text-lg sm:text-xl ml-2">${routeLongName} to ${headsign}</span>
    `;

    // Setup map overlay
    routeMapOverlay.querySelector('#route-overlay-number').textContent = routeShortName;
    routeMapOverlay.querySelector('#route-overlay-headsign').textContent = `to ${headsign}`;
    routeMapOverlay.querySelector('#route-overlay-number').style.backgroundColor = `#${routeColor}`;
    routeMapOverlay.classList.remove('hidden');

    const map = L.map('map').setView([-27.4698, 153.0251], 12); // Centered on Brisbane
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    let routeStops = [];
    const routeLayer = L.featureGroup().addTo(map);

    // Fetch and draw the route shape
    fetch(`${routeShapeEndpoint}?shape_id=${shapeId}`)
        .then(res => res.json())
        .then(geojson => {
            if (geojson) {
                const routeLine = L.geoJSON(geojson, { style: { color: `#${routeColor}`, weight: 5, opacity: 0.8 } });
                routeLayer.addLayer(routeLine);
                map.fitBounds(routeLayer.getBounds().pad(0.1));
            }
        })
        .catch(err => console.error('Failed to fetch route shape:', err));

    // Fetch all stops for the route
    fetch(`${stopsForRouteEndpoint}?route_id=${routeId}&headsign=${encodeURIComponent(headsign)}`)
        .then(res => res.json())
        .then(stops => {
            routeStops = stops;
            stops.forEach(stop => {
                const stopMarker = L.circleMarker([stop.latitude, stop.longitude], {
                    radius: 4,
                    color: '#3388ff',
                    fillColor: '#3388ff',
                    fillOpacity: 0.8
                }).bindPopup(`<b>${stop.name}</b>`);
                routeLayer.addLayer(stopMarker);
            });

            // Now that stops are loaded, get user location
            getUserLocationAndHighlightNearest();
        })
        .catch(err => console.error('Failed to fetch stops for route:', err));


    function getUserLocationAndHighlightNearest() {
        if (!navigator.geolocation) {
            console.log('Geolocation is not supported by your browser.');
            return;
        }

        mapStatus.textContent = 'Locating you...';
        mapStatus.classList.remove('hidden');

        navigator.geolocation.getCurrentPosition(
            (position) => {
                const userLat = position.coords.latitude;
                const userLon = position.coords.longitude;

                mapStatus.classList.add('hidden');

                const userMarker = L.marker([userLat, userLon]).addTo(map)
                    .bindPopup('Your Location').openPopup();

                if (routeStops.length > 0) {
                    highlightNearestStop(userLat, userLon);
                } else {
                    // If stops haven't loaded yet, wait for them
                    // This is a fallback, usually the flow is correct
                    const checkStops = setInterval(() => {
                        if (routeStops.length > 0) {
                            clearInterval(checkStops);
                            highlightNearestStop(userLat, userLon);
                        }
                    }, 500);
                }
            },
            () => {
                mapStatus.textContent = 'Could not get your location.';
                setTimeout(() => mapStatus.classList.add('hidden'), 3000);
            }
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
            const nearestStopMarker = L.circleMarker([nearestStop.latitude, nearestStop.longitude], {
                radius: 10,
                color: '#1d4ed8',
                fillColor: '#2563eb',
                fillOpacity: 1
            }).bindPopup(`<b>Nearest Stop:</b><br>${nearestStop.name}`).addTo(map).openPopup();
            
            // Add a pulse animation to the marker's element
            if (nearestStopMarker._path) {
                nearestStopMarker._path.classList.add('pulse');
            }

            fetchNextDeparture(nearestStop);
        }
    }

    // Haversine formula to calculate distance between two lat/lon points
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

    function fetchNextDeparture(stop) {
        if (!stop || !stop.stop_code) return;

        departureInfoContainer.innerHTML = `<p class="text-center text-gray-500">Checking for next departure...</p>`;

        fetch(`${departuresEndpoint}?stops=${stop.stop_code}`)
            .then(res => res.json())
            .then(departures => {
                // Find the first departure that matches our specific route and headsign
                const nextDeparture = departures.find(dep => dep.routeNumber === routeShortName && dep.headsign === headsign);

                if (nextDeparture) {
                    const dueInText = formatTimeRemaining(nextDeparture.secondsUntilDeparture);
                    const scheduledTime = formatBrisbaneTime(nextDeparture.scheduledDepartureUtc);
                    const expectedTime = formatBrisbaneTime(nextDeparture.expectedDepartureUtc);
                    const expectedHTML = nextDeparture.expectedDepartureUtc && (expectedTime !== scheduledTime) ? `<span class="font-semibold text-green-400">Expected: ${expectedTime}</span>` : '';

                    departureInfoContainer.innerHTML = `
                        <div class="bg-gray-800 p-4 rounded-lg shadow-md text-center">
                            <h3 class="text-lg font-bold text-white">Next Departure from ${stop.name}</h3>
                            <p class="text-3xl font-bold text-blue-400 my-2">${dueInText}</p>
                            <p class="text-sm text-gray-300">Scheduled: ${scheduledTime} ${expectedHTML}</p>
                        </div>
                    `;
                } else {
                    departureInfoContainer.innerHTML = `<p class="text-center text-gray-500">No upcoming departures found for this route at the nearest stop.</p>`;
                }
            })
            .catch(err => {
                console.error('Failed to fetch departures:', err);
                departureInfoContainer.innerHTML = `<p class="text-center text-red-500">Could not load departure information.</p>`;
            });
    }

    // Helper functions from app.js
    const formatTimeRemaining = (totalSeconds) => totalSeconds <= 5 ? 'Now' : `${Math.round(totalSeconds / 60)} min`;
    const formatBrisbaneTime = (utcDateString) => !utcDateString ? '' : new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Australia/Brisbane' }).format(new Date(utcDateString));
});