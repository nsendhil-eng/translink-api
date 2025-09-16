// script.js
const API_ENDPOINT = 'http://localhost:3001/api/departures';
const departuresList = document.getElementById('departures-list');
const lastUpdatedSpan = document.getElementById('last-updated');

/**
 * Converts a UTC date string to a formatted Brisbane time string (e.g., "2:45 PM")
 * @param {string} utcDateString - The ISO 8601 date string from the API
 * @returns {string} - The formatted local time
 */
function formatBrisbaneTime(utcDateString) {
    const date = new Date(utcDateString);
    const options = {
        hour: 'numeric',
        minute: 'numeric',
        hour12: true,
        timeZone: 'Australia/Brisbane'
    };
    return new Intl.DateTimeFormat('en-AU', options).format(date);
}

/**
 * Main function to fetch data from the backend and render it to the page
 */
async function fetchAndRenderDepartures() {
    try {
        const response = await fetch(API_ENDPOINT);
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        const departures = await response.json();

        // Clear previous content
        departuresList.innerHTML = '';

        if (departures.length === 0) {
            departuresList.innerHTML = '<div class="loading">No upcoming departures found.</div>';
            return;
        }

        departures.forEach(dep => {
            const vehicleIcon = dep.vehicleType === 'Bus' ? '🚌' : '🚆';
            const departureTime = formatBrisbaneTime(dep.departureTime);

            // Conditionally create the bus route info HTML
            const busInfoHtml = dep.destinationInfo
                ? `<div class="bus-route-info">📍 Get down at: ${dep.destinationInfo}</div>`
                : '';

            const departureElement = document.createElement('div');
            departureElement.className = 'departure';

            departureElement.innerHTML = `
                <div class="icon">${vehicleIcon}</div>
                <div class="details">
                    <div class="route-line">${dep.routeNumber} <span>to ${dep.headsign}</span></div>
                    <div class="stop-name">From: ${dep.stopName}</div>
                    ${busInfoHtml}
                </div>
                <div class="time">${departureTime}</div>
            `;
            departuresList.appendChild(departureElement);
        });
        
        // Update the "last updated" timestamp
        lastUpdatedSpan.textContent = new Date().toLocaleTimeString('en-AU');

    } catch (error) {
        console.error('Failed to fetch departures:', error);
        departuresList.innerHTML = '<div class="error">⚠️ Could not connect to the local server. Is it running?</div>';
    }
}

// --- INITIALIZATION ---

// 1. Fetch data immediately on page load
fetchAndRenderDepartures();

// 2. Then, set a timer to refresh the data every 10 seconds
setInterval(fetchAndRenderDepartures, 10000);