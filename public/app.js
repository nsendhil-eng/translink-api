const state = {
    isLocal: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:',
    VERCEL_URL: 'https://transit.sn-app.space',
    LOCAL_URL: 'http://localhost:3001',
    get BASE_URL() { return this.isLocal ? this.LOCAL_URL : this.VERCEL_URL; },
    get API_ENDPOINT() { return `${this.BASE_URL}/api/departures`; },
    get findNearMeEndpoint() { return `${this.BASE_URL}/api/stops-near-me`; },
    get searchEndpoint() { return `${this.BASE_URL}/api/search`; },
    get tripDetailsEndpoint() { return `${this.BASE_URL}/api/trip-details`; },
    get stopsForRouteEndpoint() { return `${this.BASE_URL}/api/stops-for-route`; },
    get routeShapeEndpoint() { return `${this.BASE_URL}/api/route-shape`; },
    GRAPHHOPPER_API_KEY: 'c83491d0-8e78-4539-9920-2690e1a91b57',
    
    // DOM Elements
    departuresContainer: document.getElementById('departures-container'),
    currentTimeEl: document.getElementById('currentTime'),
    lastUpdatedEl: document.getElementById('last-updated'),
    searchInput: document.getElementById('stop-search-input'),
    suggestionsContainer: document.getElementById('autocomplete-suggestions'),
    selectedStopsContainer: document.getElementById('selected-stops-container'),
    findNearMeBtn: document.getElementById('find-near-me-btn'),
    searchOptionsContainer: document.getElementById('search-options'),
    favoritesContainer: document.getElementById('favorites-container'),
    mapContainer: document.getElementById('map'),

    // App State
    ALL_STOPS_DATA: [ { name: 'Auchenflower Station, platform 2', id: '600284', stop_code: '600284' }, { name: 'Auchenflower Station, platform 4', id: '600286', stop_code: '600286' }, { name: 'Auchenflower stop 10/11, Milton Rd', id: '001951', stop_code: '001951' }],
    selectedStops: [],
    searchDebounceTimer: null,
    lastSearchCoords: null,
    currentRadius: 500,
    activeTypes: [],
    cachedPosition: null,
    positionCacheTimestamp: null,
    CACHE_DURATION_MS: 60 * 1000,
    map: null,
    stopMarkers: [],
    walkingRouteLayer: null,
    routeShapeLayer: null,
    routeStartMarker: null,
    routeEndMarker: null,
};

const VEHICLE_ICONS = {
    Bus: `<svg class="w-7 h-7" fill="#000000" viewBox="0 0 128 128" version="1.1" xml:space="preserve" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g id="Bus"><path d="M99.1,40H28.9c-3.2,0-5.9,2.6-5.9,5.8v29.5c0,3.2,2.6,5.8,5.9,5.8h3.2c0.5,3.9,3.9,7,7.9,7s7.4-3.1,7.9-7h34.1   c0.5,3.9,3.9,7,7.9,7s7.4-3.1,7.9-7h1.2c3.2,0,5.9-2.6,5.9-5.8V45.8C105,42.6,102.4,40,99.1,40z M43,47v9.9L39.4,63H25V47H43z    M40,86c-3.3,0-6-2.7-6-6s2.7-6,6-6s6,2.7,6,6S43.3,86,40,86z M90,86c-3.3,0-6-2.7-6-6s2.7-6,6-6s6,2.7,6,6S93.3,86,90,86z    M103,75.2c0,2.1-1.7,3.8-3.9,3.8h-1.2c0-0.1,0-0.2-0.1-0.4c0-0.1,0-0.2-0.1-0.3c0-0.2-0.1-0.3-0.1-0.5c0-0.1,0-0.2-0.1-0.3   c-0.1-0.2-0.2-0.5-0.3-0.7c0,0,0,0,0,0c-0.1-0.2-0.2-0.4-0.3-0.6c0-0.1-0.1-0.1-0.1-0.2c-0.1-0.1-0.2-0.3-0.3-0.4   c-0.1-0.1-0.1-0.2-0.2-0.2c-0.1-0.1-0.2-0.2-0.3-0.4c-0.1-0.1-0.1-0.2-0.2-0.2c-0.1-0.1-0.2-0.2-0.3-0.3c-0.1-0.1-0.2-0.2-0.2-0.2   c-0.1-0.1-0.2-0.2-0.3-0.3c-0.1-0.1-0.2-0.1-0.3-0.2c-0.1-0.1-0.2-0.2-0.3-0.2c-0.1-0.1-0.2-0.1-0.3-0.2c-0.1-0.1-0.2-0.1-0.4-0.2   c-0.1-0.1-0.2-0.1-0.3-0.2c-0.1-0.1-0.3-0.1-0.4-0.2c-0.1,0-0.2-0.1-0.3-0.1c-0.1-0.1-0.3-0.1-0.4-0.1c-0.1,0-0.2-0.1-0.3-0.1   c-0.1,0-0.3-0.1-0.4-0.1c-0.1,0-0.2-0.1-0.3-0.1c-0.2,0-0.3-0.1-0.5-0.1c-0.1,0-0.2,0-0.3,0c-0.3,0-0.5,0-0.8,0s-0.5,0-0.8,0   c-0.1,0-0.2,0-0.3,0c-0.2,0-0.3,0-0.5,0.1c-0.1,0-0.2,0-0.3,0.1c-0.1,0-0.3,0.1-0.4,0.1c-0.1,0-0.2,0.1-0.3,0.1   c-0.1,0-0.3,0.1-0.4,0.1c-0.1,0-0.2,0.1-0.3,0.1c-0.1,0.1-0.3,0.1-0.4,0.2C86.2,73,86.1,73,86,73.1c-0.1,0.1-0.2,0.1-0.4,0.2   c-0.1,0.1-0.2,0.1-0.3,0.2c-0.1,0.1-0.2,0.2-0.3,0.2c-0.1,0.1-0.2,0.1-0.3,0.2c-0.1,0.1-0.2,0.2-0.3,0.3   c-0.1,0.1-0.2,0.1-0.2,0.2c-0.1,0.1-0.2,0.2-0.3,0.3c-0.1,0.1-0.1,0.2-0.2,0.2c-0.1,0.1-0.2,0.2-0.3,0.4c-0.1,0.1-0.1,0.2-0.2,0.2   c-0.1,0.1-0.2,0.3-0.3,0.4c0,0.1-0.1,0.1-0.1,0.2c-0.1,0.2-0.2,0.4-0.3,0.6c0,0,0,0,0,0c-0.1,0.2-0.2,0.5-0.3,0.7c0,0.1,0,0.2-0.1,0.3   c0,0.2-0.1,0.3-0.1,0.5c0,0.1,0,0.2-0.1,0.3c0,0.1,0,0.2-0.1,0.4H47.9c0-0.1,0-0.2-0.1-0.4c0-0.1,0-0.2-0.1-0.3c0-0.2-0.1-0.3-0.1-0.5   c0-0.1,0-0.2-0.1-0.3c-0.1-0.2-0.2-0.5-0.3-0.7c0,0,0,0,0,0c-0.1-0.2-0.2-0.4-0.3-0.6c0-0.1-0.1-0.1-0.1-0.2   c-0.1-0.1-0.2-0.3-0.3-0.4c-0.1-0.1-0.1-0.2-0.2-0.2c-0.1-0.1-0.2-0.2-0.3-0.4c-0.1-0.1-0.1-0.2-0.2-0.2c-0.1-0.1-0.2-0.2-0.3-0.3   c-0.1-0.1-0.2-0.2-0.2-0.2c-0.1-0.1-0.2-0.2-0.3-0.3c-0.1-0.1-0.2-0.1-0.3-0.2c-0.1-0.1-0.2-0.2-0.3-0.2c-0.1-0.1-0.2-0.1-0.3-0.2   c-0.1-0.1-0.2-0.1-0.4-0.2c-0.1-0.1-0.2-0.1-0.3-0.2c-0.1-0.1-0.3-0.1-0.4-0.2c-0.1,0-0.2-0.1-0.3-0.1c-0.1-0.1-0.3-0.1-0.4-0.1   c-0.1,0-0.2-0.1-0.3-0.1c-0.1,0-0.3-0.1-0.4-0.1c-0.1,0-0.2-0.1-0.3-0.1c-0.2,0-0.3-0.1-0.5-0.1c-0.1,0-0.2,0-0.3,0   c-0.3,0-0.5,0-0.8,0s-0.5,0-0.8,0c-0.1,0-0.2,0-0.3,0c-0.2,0-0.3,0-0.5,0.1c-0.1,0-0.2,0-0.3,0.1c-0.1,0-0.3,0.1-0.4,0.1   c-0.1,0-0.2,0.1-0.3,0.1c-0.1,0-0.3,0.1-0.4,0.1c-0.1,0-0.2,0.1-0.3,0.1c-0.1,0.1-0.3,0.1-0.4,0.2C36.2,73,36.1,73,36,73.1   c-0.1,0.1-0.2,0.1-0.4,0.2c-0.1,0.1-0.2,0.1-0.3,0.2c-0.1,0.1-0.2,0.2-0.3,0.2c-0.1,0.1-0.2,0.1-0.3,0.2c-0.1,0.1-0.2,0.2-0.3,0.3   c-0.1,0.1-0.2,0.1-0.2,0.2c-0.1,0.1-0.2,0.2-0.3,0.3c-0.1,0.1-0.1,0.2-0.2,0.2c-0.1,0.1-0.2,0.2-0.3,0.4c-0.1,0.1-0.1,0.2-0.2,0.2   c-0.1,0.1-0.2,0.3-0.3,0.4c0,0.1-0.1,0.1-0.1,0.2c-0.1,0.2-0.2,0.4-0.3,0.6c0,0,0,0,0,0c-0.1,0.2-0.2,0.5-0.3,0.7   c0,0.1,0,0.2-0.1,0.3c0,0.2-0.1,0.3-0.1,0.5c0,0.1,0,0.2-0.1,0.3c0,0.1,0,0.2-0.1,0.4h-3.2c-2.1,0-3.9-1.7-3.9-3.8V65h15   c0.4,0,0.7-0.2,0.9-0.5l4-6.9c0.1-0.2,0.1-0.3,0.1-0.5V47h3v12c0,0.6,0.4,1,1,1h48c0.6,0,1-0.4,1-1V47h2v-2h-3H49H25.1   c0.4-1.7,1.9-3,3.8-3h70.2c2.1,0,3.9,1.7,3.9,3.8V75.2z M96,47v11H86V47H96z M84,58H74V47h10V58z M72,58H62V47h10V58z M60,58H50V47   h10V58z"/></g></svg>`,
    Train: `<svg class="w-7 h-7" version="1.1" id="_x32_" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"  xml:space="preserve"><style type="text/css">.st0{fill:#000000;}</style><g><path class="st0" d="M431.665,356.848V147.207c0-48.019-38.916-86.944-86.943-86.944h-40.363l4.812-42.824h8.813c9.435,0,17.508,5.74,20.965,13.898l16.06-6.779V24.55C348.929,10.124,334.641,0.018,317.984,0L193.999,0.009c-16.639,0.009-30.928,10.116-37.016,24.541l16.06,6.796c3.466-8.166,11.539-13.906,20.956-13.897h8.823l4.81,42.815h-40.354c-48.01,0-86.942,38.924-86.942,86.944v209.641c0,36.403,26.483,66.736,61.208,72.773L87.011,512h48.488l22.378-33.823h196.264L376.519,512h48.47l-54.516-82.379C405.182,423.576,431.665,393.252,431.665,356.848z M291.621,17.44l-4.803,42.824h-61.635l-4.819-42.815L291.621,17.44z M180.715,99.299h150.57v25.095h-150.57V99.299z M135.413,180.409c0-10.917,8.839-19.773,19.756-19.773h201.664c10.916,0,19.773,8.856,19.773,19.773v65.96c0,10.917-8.857,19.764-19.773,19.764H155.168c-10.916,0-19.756-8.847-19.756-19.764V180.409z M154.232,378.495c-12.739,0-23.06-10.321-23.06-23.043c0-12.739,10.321-23.052,23.06-23.052c12.722,0,23.043,10.313,23.043,23.052C177.275,368.174,166.954,378.495,154.232,378.495z M172.421,456.19l16.844-25.461h133.471l16.844,25.461H172.421z M357.768,378.495c-12.722,0-23.043-10.321-23.043-23.043c0-12.739,10.321-23.052,23.043-23.052c12.739,0,23.06,10.313,23.06,23.052C380.828,368.174,370.507,378.495,357.768,378.495z"/></g></svg>`,
    Ferry: `<svg class="w-7 h-7" version="1.1" id="_x32_" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"  xml:space="preserve"><style type="text/css">.st0{fill:#000000;}</style><g><rect x="168.256" y="213.47" class="st0" width="28.074" height="28.066"/><rect x="231.627" y="213.47" class="st0" width="28.074" height="28.066"/><rect x="295.006" y="213.47" class="st0" width="28.074" height="28.066"/><rect x="358.378" y="213.47" class="st0" width="28.074" height="28.066"/><path class="st0" d="M77.866,357.45l3.073-1.849c3.975-2.334,9.273-5.252,15.936-7.672c9.335-3.419,19.778-5.167,30.977-5.167c12.785,0,24.284,2.164,34.566,6.447c6.847,2.842,12.123,6.046,15.974,8.394l2.511,1.51c1.994,1.171,3.196,1.779,4.228,2.157c0.8,0.284,2.464,0.886,6.916,0.893c4.683-0.015,6.324-0.686,7.41-1.124c1.417-0.578,3.62-1.91,6.408-3.589l3.072-1.849c3.974-2.334,9.274-5.252,15.935-7.672c9.335-3.419,19.78-5.167,30.978-5.167c12.777,0,24.268,2.164,34.558,6.439c6.832,2.842,12.092,6.038,15.935,8.38l2.542,1.524c2.018,1.186,3.212,1.795,4.244,2.172c0.778,0.278,2.449,0.879,6.909,0.886c4.674-0.015,6.315-0.686,7.401-1.124c1.417-0.578,3.62-1.91,6.408-3.589l3.074-1.849c3.974-2.334,9.273-5.252,15.935-7.672c9.334-3.419,19.778-5.167,30.977-5.167c12.785,0,24.276,2.164,34.566,6.439c6.839,2.842,12.108,6.046,15.951,8.38l2.534,1.524c2.01,1.179,3.203,1.787,4.251,2.172c0.778,0.278,2.45,0.879,6.917,0.886c4.675-0.015,6.316-0.686,7.402-1.124c1.424-0.578,3.612-1.903,6.384-3.574l3.096-1.864c3.466-2.033,7.987-4.49,13.478-6.693l11.229-79.984H471.18l4.498-0.924l-11.152-54.283h-34.266l-15.774-47.32h-36.052v-63.88H314.16l-10.066,63.88h-50.81l13.802-55.208h-42.283l-31.547,55.208h-41.121L85.252,268.924H22.35l54.669,89.027C77.32,357.773,77.551,357.642,77.866,357.45z M160.708,182.169h41.698l31.547-55.207h12.939l-13.809,55.207h170.034l15.774,47.321h32.772l8.103,39.434H104.468L160.708,182.169z M60.137,300.317H469.3l-2.072,14.788H69.217L60.137,300.317z"/><path class="st0" d="M488.956,370.165c-4.713,1.71-8.618,3.828-11.937,5.776c-5.007,2.973-8.665,5.391-12.693,7.032c-4.036,1.632-8.641,2.818-16.328,2.849c-6.824-0.015-11.245-0.986-14.965-2.318c-2.788-1.017-5.261-2.311-8.034-3.944c-4.136-2.403-8.988-5.73-15.68-8.51c-6.694-2.781-15.019-4.66-25.339-4.629c-9.173-0.016-16.76,1.44-23.044,3.743c-4.706,1.71-8.611,3.828-11.93,5.776c-5.007,2.973-8.672,5.391-12.693,7.032c-4.036,1.632-8.649,2.818-16.328,2.849c-6.824-0.015-11.237-0.986-14.957-2.318c-2.788-1.017-5.252-2.311-8.025-3.944c-4.136-2.403-8.98-5.73-15.673-8.51c-6.694-2.781-15.012-4.66-25.332-4.629c-9.172-0.016-16.759,1.44-23.044,3.743c-4.706,1.71-8.61,3.828-11.93,5.776c-5.007,2.973-8.672,5.391-12.693,7.032c-4.036,1.632-8.649,2.818-16.336,2.849c-6.824-0.015-11.237-0.986-14.95-2.318c-2.796-1.017-5.26-2.311-8.04-3.944c-4.129-2.403-8.973-5.73-15.674-8.51c-6.686-2.781-15.012-4.66-25.332-4.629c-9.172-0.016-16.76,1.44-23.044,3.743c-4.706,1.71-8.611,3.828-11.93,5.776c-5.006,2.973-8.672,5.391-12.693,7.032c-4.036,1.632-8.65,2.818-16.328,2.849c-6.824-0.015-11.237-0.986-14.957-2.318c-2.796-1.017-5.26-2.311-8.034-3.944c-4.136-2.403-8.98-5.73-15.68-8.51c-6.694-2.781-15.019-4.66-25.332-4.629v23.66c6.824,0.015,11.237,0.986,14.956,2.318c2.789,1.017,5.26,2.311,8.034,3.944c4.136,2.395,8.981,5.73,15.681,8.51c6.685,2.781,15.011,4.66,25.332,4.629c9.181,0.016,16.759-1.44,23.044-3.743c4.705-1.718,8.611-3.827,11.93-5.776c5.006-2.974,8.672-5.392,12.692-7.032c4.036-1.632,8.649-2.819,16.328-2.85c6.824,0.015,11.238,0.986,14.957,2.318c2.788,1.017,5.26,2.311,8.034,3.944c4.136,2.395,8.98,5.73,15.673,8.51c6.693,2.781,15.019,4.66,25.332,4.629c9.181,0.016,16.767-1.44,23.052-3.743c4.705-1.71,8.611-3.827,11.93-5.776c5.006-2.974,8.672-5.392,12.692-7.032c4.036-1.632,8.65-2.819,16.328-2.85c6.824,0.015,11.237,0.986,14.95,2.318c2.789,1.017,5.26,2.311,8.033,3.944c4.136,2.395,8.981,5.73,15.674,8.51c6.686,2.781,15.011,4.66,25.331,4.629c9.173,0.016,16.76-1.44,23.044-3.743c4.706-1.718,8.611-3.827,11.93-5.776c5.006-2.974,8.664-5.392,12.693-7.032c4.036-1.632,8.649-2.819,16.328-2.85c6.823,0.015,11.245,0.986,14.964,2.318c2.789,1.017,5.26,2.311,8.034,3.944c4.136,2.403,8.981,5.738,15.681,8.51c6.693,2.781,15.019,4.66,25.339,4.629c9.18,0.016,16.76-1.44,23.044-3.743c4.706-1.718,8.618-3.827,11.93-5.776c5.014-2.974,8.672-5.392,12.701-7.032c4.028-1.632,8.642-2.819,16.328-2.85v-23.66C502.819,366.407,495.241,367.863,488.956,370.165z"/></g></svg>`
};

const WALKING_MAN_ICON = `<svg width="25px" height="25px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-labelledby="walkingIconTitle" stroke="#808080" stroke-width="1" stroke-linecap="square" stroke-linejoin="miter" color="#000000"> <title id="walkingIconTitle">Walking</title> <circle cx="13" cy="5" r="1"/> <path d="M15 20L14 17L11 14M11 14L12 9M11 14L8 20M12 9L15 12L17 13M12 9L9 11L8 14"/> </svg>`;

function setCookie(name, value, days) {
    let expires = "";
    if (days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + (JSON.stringify(value) || "")  + expires + "; path=/";
}

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

function initMap(lat, lon) {
    state.mapContainer.classList.remove('hidden');
    if (state.map) {
        state.map.setView([lat, lon], 15);
    } else {
        state.map = L.map('map').setView([lat, lon], 15);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 20
        }).addTo(state.map);
    }

    const userIcon = L.divIcon({
        html: `<div class="w-4 h-4 bg-blue-600 rounded-full pulse"></div>`,
        className: 'user-location-marker',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
    });

    L.marker([lat, lon], { icon: userIcon }).addTo(state.map)
        .bindPopup('Your current location.')
        .openPopup();
}

function getStopVehicleType(stop) {
    if (!stop.route_types || stop.route_types.length === 0) return 'Bus'; // Default
    if (stop.route_types.includes(4)) return 'Ferry';
    if (stop.route_types.some(rt => [0, 1, 2].includes(rt))) return 'Train';
    if (stop.route_types.includes(3)) return 'Bus';
    return 'Bus'; // Fallback default
}

function formatDuration(seconds) {
    const minutes = Math.round(seconds / 60);
    return `${minutes} min walk`;
}

function formatDistance(meters) {
    if (meters === null || meters === undefined) return '';
    if (meters < 1000) {
        return `${Math.round(meters)} m`;
    }
    return `${(meters / 1000).toFixed(1)} km`;
}

async function getWalkingDirections(stopLat, stopLon) {
    if (!state.cachedPosition) {
        alert('Could not get your current location for directions.');
        return;
    }
    const { latitude: userLat, longitude: userLon } = state.cachedPosition.coords;
    if (state.GRAPHHOPPER_API_KEY === 'YOUR_GRAPHHOPPER_API_KEY') {
        alert('Please add your GraphHopper API key to the script to enable walking directions.');
        return;
    }
    const url = `https://graphhopper.com/api/1/route?point=${userLat},${userLon}&point=${stopLat},${stopLon}&vehicle=foot&key=${state.GRAPHHOPPER_API_KEY}&points_encoded=false`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.paths && data.paths.length > 0) {
            if (state.walkingRouteLayer) state.walkingRouteLayer.remove();
            const path = data.paths[0];
            const routeLine = path.points;
            const distance = path.distance; // in meters
            const duration = path.time; // in milliseconds

            state.walkingRouteLayer = L.geoJSON(routeLine, { style: { color: '#888888', weight: 5, opacity: 0.8, dashArray: '5, 10' } }).addTo(state.map);
            state.walkingRouteLayer.bindPopup(`<b>${formatDistance(distance)}</b> (${formatDuration(duration / 1000)})`).openPopup();

            state.map.fitBounds(state.walkingRouteLayer.getBounds(), { padding: [50, 50] });
        }
    } catch (error) {
        console.error('Failed to get walking directions:', error);
    }
}

function plotStopsOnMap(stops, options = {}) {
    const { highlightedStopCode = null, useDots = false } = options;
    state.stopMarkers.forEach(marker => marker.remove());
    state.stopMarkers = [];

    if (!state.map || stops.length === 0) return;

    const bounds = L.latLngBounds();
    if (state.cachedPosition && !useDots) { // Only include user location for non-route plots
        bounds.extend([state.cachedPosition.coords.latitude, state.cachedPosition.coords.longitude]);
    }

    stops.forEach(stop => {
        const isSelected = state.selectedStops.some(s => s.code === stop.stop_code);
        const isHighlighted = stop.stop_code === highlightedStopCode;
        const isDeemphasized = highlightedStopCode && !isHighlighted;

        let customIcon;
        if (useDots) {
            const dotColor = isHighlighted ? 'bg-white' : 'bg-gray-500';
            customIcon = L.divIcon({
                html: `<div class="w-2 h-2 ${dotColor} rounded-full ring-1 ring-gray-900/50 ${isDeemphasized ? 'opacity-40' : ''}"></div>`,
                className: 'custom-map-marker',
                iconSize: [8, 8],
                iconAnchor: [4, 4]
            });
        } else {
            const vehicleType = getStopVehicleType(stop);
            const iconSVG = VEHICLE_ICONS[vehicleType] || VEHICLE_ICONS.Bus;
            customIcon = L.divIcon({
                html: `<div class="p-1 bg-white rounded-full shadow-md ${isSelected ? 'marker-selected' : ''}">${iconSVG}</div>`,
                className: 'custom-map-marker',
                iconSize: [36, 36],
                iconAnchor: [18, 18]
            });
        }

        const popupContent = `
            <div class="font-semibold text-base flex items-center gap-2">${stop.name}
                <span class="walking-directions-btn" data-lat="${stop.latitude}" data-lon="${stop.longitude}" onclick="event.stopPropagation(); getWalkingDirections(${stop.latitude}, ${stop.longitude})">${WALKING_MAN_ICON}</span></div>
            <div class="text-sm text-gray-300 mt-1">
                <span class="font-medium">Routes:</span> ${formatServicingRoutes(stop.servicing_routes, stop.route_directions)}
            </div>`;

        const marker = L.marker([stop.latitude, stop.longitude], { icon: customIcon }).addTo(state.map).bindPopup(popupContent);
        
        // Add a click listener to the marker itself to allow selection
        marker.on('click', () => {
            // Simulate clicking a suggestion item to add/remove the stop
            handleStopSelection(stop);
        });

        marker.stopCode = stop.stop_code;
        state.stopMarkers.push(marker);
        bounds.extend([stop.latitude, stop.longitude]);
    });

    if (!useDots) {
        // Only auto-fit bounds for general searches, not for route displays
        // as that is handled separately.
        state.map.fitBounds(bounds, { padding: [50, 50] });
    }
}

function initializeMapWithUserLocation() {
    navigator.geolocation.getCurrentPosition(position => {
        initMap(position.coords.latitude, position.coords.longitude);
    }, () => {
        initMap(-27.4698, 153.0251);
    }, { enableHighAccuracy: true });
}

function formatBrisbaneTime(utcDateString) {
    if (!utcDateString) return 'N/A';
    const date = new Date(utcDateString);
    return new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: 'numeric', hour12: true, timeZone: 'Australia/Brisbane' }).format(date);
}

function formatTimeRemaining(totalSeconds) {
    if (totalSeconds <= 5) { return 'Now'; }
    if (totalSeconds < 300) {
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        if (minutes > 0) { return `${minutes} min ${seconds} sec`; }
        return `${seconds} sec`;
    }
    const roundedMinutes = Math.round(totalSeconds / 60);
    return `${roundedMinutes} min`;
}

function createDepartureCardHTML(dep) {
    const dueInText = formatTimeRemaining(dep.secondsUntilDeparture);
    const scheduledTime = formatBrisbaneTime(dep.scheduledDepartureUtc);
    const expectedTime = formatBrisbaneTime(dep.expectedDepartureUtc);
    const expectedHTML = dep.expectedDepartureUtc && (expectedTime !== scheduledTime) ? `<div class="font-semibold text-green-600 dark:text-green-400">Expected: ${expectedTime}</div>` : '';
    
    const urlParams = new URLSearchParams(window.location.search);
    const isDebug = urlParams.get('debug') === 'true';
    const debugHTML = isDebug ? `
        <div class="mt-2 text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 p-1 rounded">
            <p>Sch: ${dep.scheduledDepartureUtc}</p><p>Exp: ${dep.expectedDepartureUtc || 'N/A'}</p>
        </div>` : '';

    let cardContentHTML = '';

    if (dep.vehicleType === 'Train') {
        const trainLine = dep.routeLongName ? dep.routeLongName.split(' - ').pop() : dep.headsign;
        const routeColor = dep.routeColor;
        const routeTextColor = dep.routeTextColor;
        const styles = (routeColor && routeTextColor) ? `style="background-color: #${routeColor}; color: #${routeTextColor};"` : '';
        const fallbackClass = (!routeColor || !routeTextColor) ? 'bg-green-600' : '';
        cardContentHTML = `<div class="flex items-start gap-4 w-full">
            <div class="flex-shrink-0 text-white w-10 h-12 rounded-lg flex items-center justify-center text-3xl font-bold ${fallbackClass}" ${styles}>${VEHICLE_ICONS.Train}</div>
            <div class="flex-grow">
                <p class="text-lg font-semibold text-gray-900 dark:text-white">${trainLine}</p>
                <h3 class="text-sm sm:text-lg font-medium text-gray-600 dark:text-gray-400">${dep.headsign}</h3>
                <p class="text-sm sm:text-lg font-medium text-gray-600 dark:text-gray-400">${dep.stopName}</p>
            </div>
            <div class="text-right flex-shrink-0">
                <div class="font-semibold text-gray-700 dark:text-gray-300">Scheduled: ${scheduledTime}</div>${expectedHTML}
                <div class="text-xl font-bold text-blue-600 dark:text-blue-400 mt-1">${dueInText}</div>${debugHTML}</div></div>`;
    } else {
        const iconContent = dep.vehicleType === 'Ferry' ? VEHICLE_ICONS.Ferry : dep.routeNumber;
        let iconBgColor = 'bg-blue-500';
        const routeColor = dep.routeColor;
        const routeTextColor = dep.routeTextColor;
        const styles = (routeColor && routeTextColor) ? `style="background-color: #${routeColor}; color: #${routeTextColor};"` : '';
        if (dep.vehicleType === 'Ferry') iconBgColor = dep.routeColor;
        cardContentHTML = `<div class="flex items-start gap-4 w-full"><div class="flex-shrink-0 ${iconBgColor} text-white w-12 h-12 rounded-lg flex items-center justify-center text-lg font-bold" ${styles}>${iconContent}</div><div class="flex-grow"><p class="text-lg font-semibold text-gray-900 dark:text-white">${dep.headsign}</p><h3 class="text-sm sm:text-lg font-medium text-gray-600 dark:text-gray-400">${dep.stopName}</h3></div><div class="text-right flex-shrink-0"><div class="font-semibold text-gray-700 dark:text-gray-300">Scheduled: ${scheduledTime}</div>${expectedHTML}<div class="text-xl font-bold text-blue-600 dark:text-blue-400 mt-1">${dueInText}</div>${debugHTML}</div></div>`;
    }
    return `
        ${cardContentHTML}
        <div class="w-full flex justify-end mt-2">
            <button class="more-details-btn text-sm text-blue-500 font-semibold" data-trip-id="${dep.trip_id}" data-stop-sequence="${dep.stop_sequence}">More ↓</button>
        </div>
        <div class="trip-details-container mt-2 pt-2 border-t border-gray-200 dark:border-gray-700 hidden"></div>
    `;
}

function renderDepartures(departures) {
    const container = state.departuresContainer;
    const existingCards = new Map();
    container.querySelectorAll('.departure-card').forEach(card => {
        existingCards.set(card.dataset.tripId, card);
    });

    const incomingTripIds = new Set();

    departures.forEach((dep, index) => {
        incomingTripIds.add(dep.trip_id);
        const cardHTML = createDepartureCardHTML(dep);

        if (existingCards.has(dep.trip_id)) {
            // Update existing card
            const card = existingCards.get(dep.trip_id);
            card.innerHTML = cardHTML;
            card.style.order = index; // Use flexbox order for sorting
            existingCards.delete(dep.trip_id); // Mark as processed
        } else {
            // Add new card
            const card = document.createElement('div');
            card.className = 'bg-white dark:bg-gray-800 p-4 rounded-xl shadow-lg flex flex-col departure-card';
            card.dataset.tripId = dep.trip_id;
            card.innerHTML = cardHTML;
            card.style.order = index;
            container.appendChild(card);
        }
    });

    // Remove old cards that are no longer in the departures list
    existingCards.forEach(card => card.remove());

    if (departures.length === 0) {
        container.innerHTML = `<div class="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-lg text-center"><p class="text-lg font-medium">No upcoming services found.</p></div>`;
    }
}

async function fetchAndRenderDepartures() {
    let url = state.API_ENDPOINT;
    if (state.selectedStops.length > 0) {
        const stopCodes = state.selectedStops.map(stop => stop.code).join(',');
        url += `?stops=${stopCodes}`;
    }
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        const upcomingDepartures = await response.json();
        
        state.lastUpdatedEl.textContent = `Last updated: ${new Date().toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
        
        renderDepartures(upcomingDepartures);

    } catch (error) {
        console.error('Failed to fetch departures:', error);
        state.departuresContainer.innerHTML = `<div class="bg-yellow-100 p-4 rounded-lg" role="alert"><p class="font-bold">Could Not Load Departures</p><p>${error.message}</p></div>`;
    }
}

function updateCurrentTime() {
     const now = new Date();
     state.currentTimeEl.textContent = now.toLocaleTimeString('en-AU', { weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Australia/Brisbane' });
}

function groupStops(stops) {
    const grouped = new Map();
    const result = [];
    const processedParents = new Set();
    stops.forEach(stop => {
        if (stop.parent_station) {
            if (!grouped.has(stop.parent_station)) {
                const parent = { is_parent: true, id: stop.parent_station, name: stop.parent_station_name || 'Station', children: [] };
                grouped.set(stop.parent_station, parent);
            }
            grouped.get(stop.parent_station).children.push(stop);
        }
    });
    stops.forEach(stop => {
        if (stop.parent_station) {
            if (!processedParents.has(stop.parent_station)) { result.push(grouped.get(stop.parent_station)); processedParents.add(stop.parent_station); }
        } else {
            if (!grouped.has(stop.id)) { result.push(stop); }
        }
    });
    return result;
}

function formatServicingRoutes(routesText, directionsJson) {
    if (!routesText) return 'N/A';
    if (!directionsJson) return routesText;
    return routesText.split(', ').map(route => {
        const directions = directionsJson[route];
        if (directions) {
            const hasInbound = directions.includes('Inbound');
            const hasOutbound = directions.includes('Outbound');
            if (hasInbound && hasOutbound) return `${route}&nbsp;↕`;
            if (hasInbound) return `${route}&nbsp;↑`;
            if (hasOutbound) return `${route}&nbsp;↓`;
        }
        return route;
    }).join(', ');
}

function renderSelectedStopTags() {
    state.selectedStopsContainer.innerHTML = '';
    if (state.selectedStops.length > 0) {
        const saveFavBtn = document.createElement('button');
        saveFavBtn.id = 'save-favorite-btn';
        saveFavBtn.className = 'text-2xl hover:text-yellow-400 transition-colors';
        saveFavBtn.title = 'Save as favorite';
        saveFavBtn.innerHTML = '⭐';
        state.selectedStopsContainer.appendChild(saveFavBtn);
    }
    state.selectedStops.forEach(stop => {
        const tag = document.createElement('div');
        tag.className = 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 text-sm font-semibold px-3 py-1 rounded-full flex items-center gap-2';
        tag.innerHTML = `<span>${stop.name}</span><button data-code="${stop.code}" class="remove-tag-btn font-bold">×</button>`;
        state.selectedStopsContainer.appendChild(tag);
    });
}

function renderFavoritesDropdown() {
    const favorites = getCookie('favoriteStops') || {};
    if (Object.keys(favorites).length === 0) {
        state.favoritesContainer.innerHTML = '';
        return;
    }

    const favoriteNames = Object.keys(favorites);
    state.favoritesContainer.innerHTML = `
        <button id="favorites-btn" class="bg-yellow-400 hover:bg-yellow-500 text-gray-800 font-bold py-2 px-4 rounded-lg">My Favs</button>
        <div id="favorites-dropdown" class="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-800 border rounded-lg shadow-xl z-20 hidden">
            ${favoriteNames.map(name => `<a href="#" class="block px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 favorite-list-item" data-name="${name}">${name}</a>`).join('')}
        </div>
    `;
}

function saveCurrentSelectionAsFavorite() {
    if (state.selectedStops.length === 0) {
        alert('Please select at least one stop to save as a favorite.');
        return;
    }
    const favName = prompt('Enter a name for this favorite list:');
    if (favName) {
        const favorites = getCookie('favoriteStops') || {};
        favorites[favName] = state.selectedStops.map(s => ({ code: s.code, name: s.name }));
        setCookie('favoriteStops', favorites, 365);
        alert(`Favorite "${favName}" saved!`);
        renderFavoritesDropdown();
    }
}

function loadFavorite(name) {
    const favorites = getCookie('favoriteStops');
    if (favorites && favorites[name]) {
        state.selectedStops = favorites[name];
        renderSelectedStopTags();
        fetchAndRenderDepartures();
    }
}

function renderSuggestions(results) {
    results.stops.forEach(stop => {
        if (!state.ALL_STOPS_DATA.some(s => s.id === stop.id)) { state.ALL_STOPS_DATA.push(stop); }
    });
    const groupedStops = groupStops(results.stops);
    state.suggestionsContainer.innerHTML = '';
    if (groupedStops.length > 0) {
        state.suggestionsContainer.innerHTML = `
            <div class="flex justify-between items-center p-2 border-b dark:border-gray-700">
                <p class="text-xs text-gray-500 dark:text-gray-400">Click a stop to add or remove it.</p>
                <button id="close-suggestions-btn" class="text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 font-bold text-xl">&times;</button>
            </div>`;
        
        const stopsHeader = document.createElement('div');
        stopsHeader.className = 'p-2 bg-gray-100 dark:bg-gray-700 text-sm font-bold text-gray-600 dark:text-gray-300';
        stopsHeader.textContent = 'Stops';
        state.suggestionsContainer.appendChild(stopsHeader);

        groupedStops.forEach(item => {
            const isSelected = (stopCode) => state.selectedStops.some(s => s.code === stopCode);
            const selectedClass = (stopCode) => isSelected(stopCode) ? 'suggestion-selected' : '';
            const selectedText = (stopCode) => isSelected(stopCode) ? '' : 'hidden';

            if (item.is_parent) {
                const groupEl = document.createElement('div');
                groupEl.className = 'border-b dark:border-gray-700';
                groupEl.innerHTML = `<div class="flex justify-between items-center cursor-pointer parent-toggle p-3"><div class="font-bold">${item.name}</div><div class="flex items-center"><span class="walking-directions-btn" data-lat="${item.children[0].latitude}" data-lon="${item.children[0].longitude}" onclick="event.stopPropagation(); getWalkingDirections(${item.children[0].latitude}, ${item.children[0].longitude})">${WALKING_MAN_ICON}</span><div class="text-blue-500 font-bold text-lg expand-icon ml-2">+</div></div></div><div class="pl-4 hidden child-container">${item.children.map(child => `<div class="p-2 cursor-pointer suggestion-item child-stop ${selectedClass(child.stop_code)}" data-id="${child.id}" data-code="${child.stop_code}"><div class="flex justify-between items-center"><div class="font-semibold">${child.name}</div><div class="selection-status text-green-600 font-bold ${selectedText(child.stop_code)}">✓ Selected</div></div><div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Routes: ${formatServicingRoutes(child.servicing_routes, child.route_directions)}</div></div>`).join('')}</div>`;
                state.suggestionsContainer.appendChild(groupEl);
            } else {
                const itemEl = document.createElement('div');
                itemEl.className = `p-3 cursor-pointer suggestion-item border-b dark:border-gray-700 ${selectedClass(item.stop_code)}`;
                itemEl.dataset.id = item.id;
                itemEl.dataset.code = item.stop_code;
                itemEl.innerHTML = `<div class="flex justify-between items-center"><div class="font-semibold">${item.name}</div><div class="flex items-center gap-2"><div class="selection-status text-green-600 font-bold ${selectedText(item.stop_code)}">✓ Selected</div><span class="walking-directions-btn" data-lat="${item.latitude}" data-lon="${item.longitude}" onclick="event.stopPropagation(); getWalkingDirections(${item.latitude}, ${item.longitude})">${WALKING_MAN_ICON}</span></div></div><div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Routes: ${formatServicingRoutes(item.servicing_routes, item.route_directions)}</div>`;
                state.suggestionsContainer.appendChild(itemEl);
            }
        });
    }

    if (results.routes && results.routes.length > 0) {
        const routesHeader = document.createElement('div');
        routesHeader.className = 'p-2 bg-gray-100 dark:bg-gray-700 text-sm font-bold text-gray-600 dark:text-gray-300';
        routesHeader.textContent = 'Routes';
        state.suggestionsContainer.appendChild(routesHeader);

        results.routes.forEach(route => {
            const itemEl = document.createElement('div');
            itemEl.className = 'p-3 cursor-pointer suggestion-item route-suggestion border-b dark:border-gray-700';
            itemEl.dataset.routeId = route.route_id;
            itemEl.dataset.headsign = route.trip_headsign;
            itemEl.dataset.shapeId = route.shape_id;
            itemEl.dataset.routeColor = route.route_color || '3b82f6'; // Default to blue
            itemEl.innerHTML = `<div class="font-semibold">${route.route_short_name} ${route.trip_headsign}</div><div class="text-xs text-gray-500 dark:text-gray-400 mt-1">${route.route_long_name}</div>`;
            state.suggestionsContainer.appendChild(itemEl);
        });
    }

    if (groupedStops.length > 0 || (results.routes && results.routes.length > 0)) {
        state.suggestionsContainer.classList.remove('hidden');
    } else {
        state.suggestionsContainer.innerHTML = `<div class="p-3 text-center text-gray-500">No stops found.</div>`;
        state.suggestionsContainer.classList.remove('hidden');
    }
}

async function performNearbySearch() {
    if (!state.lastSearchCoords) return;
    const { latitude, longitude } = state.lastSearchCoords;
    const radius = state.currentRadius;
    const types = state.activeTypes.length > 0 ? state.activeTypes.join(',') : '';
    state.findNearMeBtn.querySelector('span').textContent = 'Searching...';
    state.findNearMeBtn.disabled = true;
    try {
        const response = await fetch(`${state.findNearMeEndpoint}?lat=${latitude}&lon=${longitude}&radius=${radius}&types=${types}`);
        if (!response.ok) {
            console.error("Server returned an error:", response.status, await response.text());
            state.suggestionsContainer.innerHTML = `<div class="p-3 text-center text-red-500">Error fetching stops from server.</div>`;
            state.suggestionsContainer.classList.remove('hidden');
            return;
        }
        const nearbyStops = await response.json();
        renderSuggestions({ stops: nearbyStops, routes: [] });
        plotStopsOnMap(nearbyStops);
        const searchFurtherBtn = document.createElement('div');
        searchFurtherBtn.id = 'search-further-btn';
        searchFurtherBtn.className = 'p-3 text-center text-blue-600 dark:text-blue-400 font-semibold cursor-pointer suggestion-item';
        const nextRadiusKm = (state.currentRadius + 500) / 1000;
        searchFurtherBtn.textContent = `Search further (${nextRadiusKm}km)`;
        state.suggestionsContainer.appendChild(searchFurtherBtn);
    } catch (error) {
        console.error('Error fetching nearby stops:', error);
    } finally {
        state.findNearMeBtn.querySelector('span').textContent = 'Near Me';
        state.findNearMeBtn.disabled = false;
        state.searchOptionsContainer.classList.remove('hidden');
    }
}

function findNearestStop(stops) {
    if (!state.cachedPosition || stops.length === 0) return null;

    const userLat = state.cachedPosition.coords.latitude;
    const userLon = state.cachedPosition.coords.longitude;

    // Simple distance calculation (Haversine formula is more accurate but this is fine for sorting)
    const distance = (lat1, lon1, lat2, lon2) => Math.sqrt(Math.pow(lat2 - lat1, 2) + Math.pow(lon2 - lon1, 2));

    let nearestStop = null;
    let minDistance = Infinity;

    stops.forEach(stop => {
        const d = distance(userLat, userLon, stop.latitude, stop.longitude); // stop.latitude might be undefined
        if (d < minDistance) {
            minDistance = d;
            nearestStop = stop;
        }
    });

    return nearestStop;
}

function handleStopSelection(stop) {
    if (!stop) return;
    const isSelected = state.selectedStops.some(s => s.code === stop.stop_code);

    if (!isSelected) {
        state.selectedStops.push({ code: stop.stop_code, name: stop.name });
    } else {
        state.selectedStops = state.selectedStops.filter(s => s.code !== stop.stop_code);
    }

    renderSelectedStopTags();
    fetchAndRenderDepartures();

    // Update visual state in suggestions list and on map
    const suggestionItem = state.suggestionsContainer.querySelector(`.suggestion-item[data-code="${stop.stop_code}"]`);
    if (suggestionItem) suggestionItem.classList.toggle('suggestion-selected');
    if (suggestionItem) suggestionItem.querySelector('.selection-status')?.classList.toggle('hidden');
    const marker = state.stopMarkers.find(m => m.stopCode === stop.stop_code);
    if (marker) marker.getElement()?.querySelector('.p-1').classList.toggle('marker-selected');
}

function addEventListeners() {
    state.searchInput.addEventListener('input', () => {
        clearTimeout(state.searchDebounceTimer);
        const query = state.searchInput.value.trim();
        if (query.length < 3) { state.suggestionsContainer.classList.add('hidden'); return; }
        state.searchDebounceTimer = setTimeout(() => {
            fetch(`${state.searchEndpoint}?q=${encodeURIComponent(query)}`)
                .then(response => response.json())
                .then(results => renderSuggestions(results));
        }, 300);
    });

    state.suggestionsContainer.addEventListener('click', async (e) => {
        const suggestionItem = e.target.closest('.suggestion-item');
        const parentToggle = e.target.closest('.parent-toggle');
        const closeBtn = e.target.closest('#close-suggestions-btn');
        const routeSuggestion = e.target.closest('.route-suggestion');

        if (e.target.id === 'search-further-btn') {
            state.currentRadius += 500;
            performNearbySearch();
            return;
        }
        if (closeBtn) {
            state.suggestionsContainer.classList.add('hidden');
            return;
        }
        if (routeSuggestion) {
            const { routeId, headsign, shapeId, routeColor } = routeSuggestion.dataset;
            try {
                // Fetch stops and shape in parallel
                const [stopsResponse, shapeResponse] = await Promise.all([
                    fetch(`${state.stopsForRouteEndpoint}?route_id=${routeId}&headsign=${encodeURIComponent(headsign)}`),
                    fetch(`${state.routeShapeEndpoint}?shape_id=${shapeId}`)
                ]);

                const stopsForRoute = await stopsResponse.json();
                const routeShape = await shapeResponse.json();

                if (state.routeShapeLayer) state.routeShapeLayer.remove();
                if (state.routeStartMarker) state.routeStartMarker.remove();
                if (state.routeEndMarker) state.routeEndMarker.remove();

                if (routeShape && routeShape.coordinates && routeShape.coordinates.length > 1) {
                    const startCoords = routeShape.coordinates[0];
                    const endCoords = routeShape.coordinates[routeShape.coordinates.length - 1];

                    const startIcon = L.divIcon({ html: '🟢', className: 'route-endpoint-marker', iconSize: [20, 20], iconAnchor: [10, 10] });
                    const endIcon = L.divIcon({ html: '🔴', className: 'route-endpoint-marker', iconSize: [20, 20], iconAnchor: [10, 10] });

                    // Leaflet uses [lat, lon], GeoJSON uses [lon, lat]
                    state.routeStartMarker = L.marker([startCoords[1], startCoords[0]], { icon: startIcon, zIndexOffset: 1000 }).addTo(state.map).bindPopup('Route Start');
                    state.routeEndMarker = L.marker([endCoords[1], endCoords[0]], { icon: endIcon, zIndexOffset: 1000 }).addTo(state.map).bindPopup('Route End');
                }

                stopsForRoute.forEach(stop => {
                    if (!state.ALL_STOPS_DATA.some(s => s.id === stop.id)) { state.ALL_STOPS_DATA.push(stop); }
                });

                if (routeShape) {
                    state.routeShapeLayer = L.geoJSON(routeShape, { style: { color: `#${routeColor}`, weight: 4, opacity: 0.7 } }).addTo(state.map);
                }
                
                // Don't add to selected stops, just find the nearest and plot
                const nearestStop = findNearestStop(stopsForRoute);
                
                state.searchInput.value = '';
                state.suggestionsContainer.classList.add('hidden');
                plotStopsOnMap(stopsForRoute, { highlightedStopCode: nearestStop ? nearestStop.stop_code : null, useDots: true });
                
                if (nearestStop) {
                    state.map.setView([nearestStop.latitude, nearestStop.longitude], 16);
                } else if (state.routeShapeLayer) {
                    // If no nearest stop but we have a shape, fit the map to the shape
                    state.map.fitBounds(state.routeShapeLayer.getBounds());
                }
            } catch (error) {
                console.error('Error fetching stops for route:', error);
                alert('Could not load stops for the selected route.');
            }
        } else if (suggestionItem) {
            const stopId = suggestionItem.dataset.id;
            const stop = state.ALL_STOPS_DATA.find(s => s.id === stopId);
            handleStopSelection(stop);
        }
        if (parentToggle) {
            const childContainer = parentToggle.nextElementSibling;
            const icon = parentToggle.querySelector('.expand-icon');
            childContainer.classList.toggle('hidden');
            icon.textContent = childContainer.classList.contains('hidden') ? '+' : '−';
        }
    });
    
    state.selectedStopsContainer.addEventListener('click', (e) => {
        if (e.target.matches('.remove-tag-btn')) {
            const stopCodeToRemove = e.target.dataset.code;
            state.selectedStops = state.selectedStops.filter(stop => stop.code !== stopCodeToRemove);
            renderSelectedStopTags();
            fetchAndRenderDepartures();
            const deselectedItem = state.suggestionsContainer.querySelector(`[data-code="${stopCodeToRemove}"]`);
            if (deselectedItem) { 
                deselectedItem.classList.remove('suggestion-selected');
                deselectedItem.querySelector('.selection-status').classList.add('hidden');
            }
            const marker = state.stopMarkers.find(m => m.stopCode === stopCodeToRemove);
            if (marker) marker.getElement().querySelector('.p-1').classList.remove('marker-selected');
        }
        if (e.target.id === 'save-favorite-btn') saveCurrentSelectionAsFavorite();
    });

    state.findNearMeBtn.addEventListener('click', () => {
        if (!navigator.geolocation) { return alert('Geolocation is not supported by your browser.'); }
        
        if (state.cachedPosition && state.positionCacheTimestamp && (new Date() - state.positionCacheTimestamp < state.CACHE_DURATION_MS)) {
            state.lastSearchCoords = state.cachedPosition.coords;
            state.currentRadius = 500;
            state.activeTypes = [];
            document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('filter-btn-active'));
            performNearbySearch();
            return;
        }

        state.findNearMeBtn.querySelector('span').textContent = 'Acquiring GPS...';
        state.findNearMeBtn.disabled = true;
        state.currentRadius = 500;
        state.activeTypes = [];
        document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('filter-btn-active'));
        const geoOptions = { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 };

        navigator.geolocation.getCurrentPosition(
            (position) => {
                state.cachedPosition = position;
                state.positionCacheTimestamp = new Date();
                state.lastSearchCoords = position.coords;
                performNearbySearch();
            },
            (error) => {
                alert('Unable to retrieve your location. Please grant permission.');
                state.findNearMeBtn.querySelector('span').textContent = 'Near Me';
                state.findNearMeBtn.disabled = false;
            },
            geoOptions
        );
    });
    
    state.searchOptionsContainer.addEventListener('click', (e) => {
        if (e.target.matches('.filter-btn')) {
            e.target.classList.toggle('filter-btn-active');
            state.activeTypes = [];
            document.querySelectorAll('.filter-btn.filter-btn-active').forEach(btn => {
                state.activeTypes.push(...btn.dataset.type.split(','));
            });
            state.currentRadius = 500;
            performNearbySearch();
        }
    });

    state.favoritesContainer.addEventListener('click', (e) => {
        const dropdown = document.getElementById('favorites-dropdown');
        if (e.target.id === 'favorites-btn') {
            dropdown?.classList.toggle('hidden');
        } else if (e.target.classList.contains('favorite-list-item')) {
            e.preventDefault();
            const favName = e.target.dataset.name;
            loadFavorite(favName);
            dropdown?.classList.add('hidden');
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('section')) {
            state.suggestionsContainer.classList.add('hidden');
        }
    });
    
    state.departuresContainer.addEventListener('click', async (e) => {
        if (e.target.closest('.walking-directions-btn')) {
            const btn = e.target.closest('.walking-directions-btn');
            getWalkingDirections(parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lon));
        }
        if (e.target.matches('.more-details-btn')) {
            const button = e.target;
            const detailsContainer = button.closest('.flex-col').querySelector('.trip-details-container');
            const isHidden = detailsContainer.classList.toggle('hidden');
            if (!isHidden) {
                button.textContent = 'Loading...';
                const { tripId, stopSequence } = button.dataset;
                try {
                    const response = await fetch(`${state.tripDetailsEndpoint}?trip_id=${tripId}&stop_sequence=${stopSequence}`);
                    const upcomingStops = await response.json();
                    if (upcomingStops.length > 0) {
                        detailsContainer.innerHTML = `<p class="font-semibold text-sm mb-1">Upcoming Stops:</p><ol class="list-decimal list-inside text-sm text-gray-600 dark:text-gray-400 space-y-1">${upcomingStops.map(stop => `<li>${stop.stop_name}</li>`).join('')}</ol>`;
                    } else {
                        detailsContainer.innerHTML = `<p class="text-sm text-gray-500">This is the last stop.</p>`;
                    }
                    button.textContent = 'Less ↑';
                } catch (error) {
                    detailsContainer.innerHTML = `<p class="text-sm text-red-500">Could not load trip details.</p>`;
                    button.textContent = 'Retry';
                }
            } else {
                button.textContent = 'More ↓';
            }
        }
    });
}

function init() {
    // Set flex on the container for the order property to work
    state.departuresContainer.style.display = 'flex';
    state.departuresContainer.style.flexDirection = 'column';

    addEventListeners();
    initializeMapWithUserLocation();
    renderFavoritesDropdown();
    updateCurrentTime();
    fetchAndRenderDepartures();
    setInterval(updateCurrentTime, 1000);
    setInterval(fetchAndRenderDepartures, 10000);
}

document.addEventListener('DOMContentLoaded', init);