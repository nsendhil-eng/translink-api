const state = {
    isLocal: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:',
    VERCEL_URL: 'https://transit.sn-app.space',
    LOCAL_URL: 'http://localhost:3001',
    get BASE_URL() { return this.isLocal ? this.LOCAL_URL : this.VERCEL_URL; },
    get API_ENDPOINT() { return `${this.BASE_URL}/api/departures`; },
    get findNearMeEndpoint() { return `${this.BASE_URL}/api/stops-near-me`; },
    get searchEndpoint() { return `${this.BASE_URL}/api/search`; },
    get tripDetailsEndpoint() { return `${this.BASE_URL}/api/trip-details`; },
    get stopsForRouteEndpoint() { return `${this.BASE_URL}/api/stops-for-route`; }, // This seems to be unused now, but let's keep it.
    get stopsForRouteAtStationEndpoint() { return `${this.BASE_URL}/api/stops-for-route-at-station`; },
    get routeShapeEndpoint() { return `${this.BASE_URL}/api/route-shape`; },
    get routesForStopsEndpoint() { return `${this.BASE_URL}/api/routes-for-stops`; },
    GRAPHHOPPER_API_KEY: 'c83491d0-8e78-4539-9920-2690e1a91b57',
    
    // DOM Elements
    departuresContainer: document.getElementById('departures-container'),
    currentTimeEl: document.getElementById('currentTime'),
    lastUpdatedEl: document.getElementById('last-updated'),
    searchInput: document.getElementById('stop-search-input'),
    suggestionsContainer: document.getElementById('autocomplete-suggestions'),
    suggestionsWrapper: document.getElementById('suggestions-wrapper'),
    selectedStopsContainer: document.getElementById('selected-stops-container'),
    findNearMeBtn: document.getElementById('find-near-me-btn'),
    searchOptionsContainer: document.getElementById('search-options'),
    favoritesContainer: document.getElementById('favorites-container'),
    mapContainer: document.getElementById('map'),
    mapOverlayText: document.getElementById('map-overlay-text'),
    routeFiltersContainer: document.getElementById('route-filters-container'),

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
    activeRouteSelection: null,
    activeRouteFilters: new Set(),
    departuresObserver: null,
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

function clearRouteDisplay() {
    if (state.routeShapeLayer) { state.routeShapeLayer.remove(); state.routeShapeLayer = null; }
    if (state.routeStartMarker) { state.routeStartMarker.remove(); state.routeStartMarker = null; }
    if (state.routeEndMarker) { state.routeEndMarker.remove(); state.routeEndMarker = null; }
    state.activeRouteSelection = null;
    state.mapOverlayText.classList.add('hidden');
    plotStopsOnMap(state.selectedStops.map(s => state.ALL_STOPS_DATA.find(db_s => db_s.stop_code === s.code)).filter(Boolean));
}
function plotStopsOnMap(stops, options = {}) {
    const { highlightedStopCode = null, useDots = false } = options;
    state.stopMarkers.forEach(marker => marker.remove());
    state.stopMarkers = [];

    // Add nearby stops to the plot list if they exist
    const allStopsToPlot = new Map(stops.map(s => [s.id, s]));
    state.nearbyStopsCache.forEach(stop => { if (!allStopsToPlot.has(stop.id)) allStopsToPlot.set(stop.id, stop); });

    if (!state.map || stops.length === 0) return;

    const bounds = L.latLngBounds();
    if (state.cachedPosition && !useDots) { // Only include user location for non-route plots
        bounds.extend([state.cachedPosition.coords.latitude, state.cachedPosition.coords.longitude]);
    }

    allStopsToPlot.forEach(stop => {
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
    requestUserLocation().then(position => {
        initMap(position.coords.latitude, position.coords.longitude);
        findAndSelectNearestStops(position.coords.latitude, position.coords.longitude);
    }).catch(() => {
        initMap(-27.4698, 153.0251); // Fallback to Brisbane center
        // Maybe show a message that location is needed for auto-selection
    });
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
    
    // Filter check
    if (state.activeRouteFilters.size > 0 && !state.activeRouteFilters.has(dep.routeNumber)) {
        return null;
    }

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
        cardContentHTML = `<div class="flex items-center gap-3 w-full">
            <div class="flex-shrink-0 text-white w-10 h-12 rounded-lg flex items-center justify-center text-2xl font-bold ${fallbackClass}" ${styles}>${VEHICLE_ICONS.Train}</div>
            <div class="flex-grow min-w-0">
                <p class="text-base font-semibold text-gray-900 dark:text-white truncate">${trainLine}</p>
                <h3 class="text-sm font-medium text-gray-600 dark:text-gray-400 truncate">${dep.headsign}</h3>
                <p class="text-xs font-medium text-gray-500 dark:text-gray-400 truncate">${dep.stopName}</p>
            </div>
            <div class="text-right flex-shrink-0">
                <div class="text-lg font-bold text-blue-600 dark:text-blue-400">${dueInText}</div>
                <div class="text-xs font-semibold text-gray-700 dark:text-gray-300 mt-1">Sch: ${scheduledTime}</div>${expectedHTML}${debugHTML}</div></div>`;
    } else {
        const iconContent = dep.vehicleType === 'Ferry' ? VEHICLE_ICONS.Ferry : dep.routeNumber;
        let iconBgColor = 'bg-blue-500';
        const routeColor = dep.routeColor;
        const routeTextColor = dep.routeTextColor;
        const styles = (routeColor && routeTextColor) ? `style="background-color: #${routeColor}; color: #${routeTextColor};"` : '';
        if (dep.vehicleType === 'Ferry') iconBgColor = dep.routeColor;
        cardContentHTML = `<div class="flex items-center gap-3 w-full"><div class="flex-shrink-0 ${iconBgColor} text-white w-12 h-12 rounded-lg flex items-center justify-center text-base font-bold" ${styles}>${iconContent}</div><div class="flex-grow min-w-0"><p class="text-base font-semibold text-gray-900 dark:text-white truncate">${dep.headsign}</p><h3 class="text-sm font-medium text-gray-600 dark:text-gray-400 truncate">${dep.stopName}</h3></div><div class="text-right flex-shrink-0"><div class="text-lg font-bold text-blue-600 dark:text-blue-400">${dueInText}</div><div class="text-xs font-semibold text-gray-700 dark:text-gray-300 mt-1">Sch: ${scheduledTime}</div>${expectedHTML}${debugHTML}</div></div>`;
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
    // Clear previous content, including any error messages or "no services" text.
    // This fixes the bug where an error message would persist after a successful fetch.
    state.departuresContainer.innerHTML = '';

    const container = state.departuresContainer;
    const existingCards = new Map();
    container.querySelectorAll('.departure-card').forEach(card => {
        existingCards.set(card.dataset.tripId, card);
    });
    
    const incomingTripIds = new Set();
    let visibleDepartures = 0;
    departures.forEach((dep, index) => {
        incomingTripIds.add(dep.trip_id);
        const cardHTML = createDepartureCardHTML(dep);

        if (!cardHTML) return; // Skip if filtered out
        visibleDepartures++;
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

    if (visibleDepartures === 0) {
        container.innerHTML = `<div class="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-lg text-center"><p class="text-lg font-medium">No upcoming services found for the selected stops and filters.</p></div>`;
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

async function updateAndRenderRouteFilters() {
    if (state.selectedStops.length === 0) {
        state.routeFiltersContainer.innerHTML = '';
        state.activeRouteFilters.clear();
        return;
    }

    const stopCodes = state.selectedStops.map(s => s.code).join(',');
    try {
        const response = await fetch(`${state.routesForStopsEndpoint}?stop_codes=${stopCodes}`);
        const routes = await response.json();

        // Prune active filters that are no longer relevant
        const relevantRouteNumbers = new Set(routes.map(r => r.route_short_name));
        state.activeRouteFilters.forEach(filter => {
            if (!relevantRouteNumbers.has(filter)) {
                state.activeRouteFilters.delete(filter);
            }
        });

        // Mobile-friendly dropdown filter
        const getIcon = (type) => {
            if (type === 3) return VEHICLE_ICONS.Bus;
            if (type === 4) return VEHICLE_ICONS.Ferry;
            return VEHICLE_ICONS.Train;
        };

        const activeFilterCount = state.activeRouteFilters.size;

        state.routeFiltersContainer.innerHTML = `
            <div class="flex flex-wrap gap-2 items-center relative">
                <span class="text-sm font-semibold text-gray-600 dark:text-gray-400 hidden md:inline">Filter by route:</span>
                
                <!-- Desktop: Inline buttons -->
                ${routes.map(route => `<button class="route-filter-btn hidden md:flex items-center gap-1.5 px-2.5 py-1 text-sm font-medium border rounded-full transition-colors ${state.activeRouteFilters.has(route.route_short_name) ? 'route-filter-active' : 'bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700'}" data-route-number="${route.route_short_name}">${getIcon(route.route_type)} ${route.route_short_name}</button>`).join('')}

                <!-- Mobile: Dropdown button -->
                <button id="mobile-filter-toggle" class="md:hidden flex items-center gap-2 px-4 py-2 text-sm font-medium border rounded-lg bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700">
                    Filter Routes ${activeFilterCount > 0 ? `<span class="bg-blue-600 text-white text-xs font-bold rounded-full h-5 w-5 flex items-center justify-center">${activeFilterCount}</span>` : ''}
                </button>
                <div id="mobile-filter-dropdown" class="absolute top-full left-0 mt-2 w-full bg-white dark:bg-gray-800 border rounded-lg shadow-xl z-30 hidden p-2 grid grid-cols-2 sm:grid-cols-3 gap-1 max-h-[50vh] overflow-y-auto">
                    ${routes.map(route => `<label class="flex items-center gap-3 p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"><input type="checkbox" class="route-filter-checkbox h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" data-route-number="${route.route_short_name}" ${state.activeRouteFilters.has(route.route_short_name) ? 'checked' : ''}> <span class="flex items-center gap-1.5">${getIcon(route.route_type)} ${route.route_short_name}</span></label>`).join('')}
                </div>
            </div>`;
    } catch (error) {
        console.error('Failed to fetch routes for filters:', error);
        state.routeFiltersContainer.innerHTML = `<p class="text-xs text-red-500">Could not load route filters.</p>`;
    }
}

function updateCurrentTime() {
     const now = new Date();
     state.currentTimeEl.textContent = now.toLocaleTimeString('en-AU', { weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Australia/Brisbane' });
}

function groupStops(stops) {
    const grouped = new Map();
    const stopMap = new Map(stops.map(s => [s.id, s]));

    // First, create all parent groups
    stops.forEach(stop => {
        if (stop.parent_station) {
            if (!grouped.has(stop.parent_station)) {
                // Find the actual parent stop object from the results
                const parentStop = stopMap.get(stop.parent_station);
                if (parentStop) {
                    // Use the parent stop object as the base for the group
                    const parentGroup = { ...parentStop, is_parent: true, children: [] };
                    grouped.set(stop.parent_station, parentGroup);
                }
            }
        }
    });

    // Then, populate children and identify standalone stops
    const standaloneStops = stops.filter(stop => {
        if (stop.parent_station && grouped.has(stop.parent_station)) {
            grouped.get(stop.parent_station).children.push(stop);
            return false; // This is a child, not standalone
        }
        // This is standalone if it's not a parent of a group that has been created
        return !grouped.has(stop.id);
    });

    return [...standaloneStops, ...Array.from(grouped.values())];
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
    if (state.selectedStops.length > 0) { // Only show these if there are stops
        const saveFavBtn = document.createElement('button');
        saveFavBtn.id = 'save-favorite-btn';
        saveFavBtn.className = 'text-2xl hover:text-yellow-400 transition-colors';
        saveFavBtn.title = 'Save as favorite';
        saveFavBtn.innerHTML = '⭐';
        state.selectedStopsContainer.appendChild(saveFavBtn);

        // Add Clear All button
        const clearAllBtn = document.createElement('button');
        clearAllBtn.id = 'clear-all-btn';
        clearAllBtn.className = 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 text-sm font-semibold px-3 py-1 rounded-full flex items-center gap-2 hover:bg-red-200 dark:hover:bg-red-800 transition-colors';
        clearAllBtn.title = 'Clear all selected stops';
        clearAllBtn.innerHTML = '<span>Clear All</span><span class="font-bold">×</span>';
        state.selectedStopsContainer.appendChild(clearAllBtn);
    }
    state.selectedStops.forEach(stop => { // stop is now {id, code, name}
        const tag = document.createElement('div');
        tag.className = 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 text-sm font-semibold px-3 py-1 rounded-full flex items-center gap-2';
        tag.innerHTML = `<span>${stop.name}</span><button data-id="${stop.id}" class="remove-tag-btn font-bold">×</button>`;
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
        <button id="favorites-btn" class="text-2xl hover:text-yellow-400 transition-colors" title="My Favorites">❤️</button>
        <div id="favorites-dropdown" class="absolute right-0 mt-2 w-56 bg-white dark:bg-gray-800 border rounded-lg shadow-xl z-[2000] hidden">
            <div class="p-2 font-bold text-sm border-b dark:border-gray-700">My Favorites</div>
            ${favoriteNames.map(name => `
                <div class="flex justify-between items-center px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700">
                    <a href="#" class="favorite-list-item flex-grow" data-name="${name}">${name}</a>
                    <button class="delete-favorite-btn ml-2 text-red-500 hover:text-red-700 font-bold" data-name="${name}" title="Delete favorite">&times;</button>
                </div>
            `).join('')}
        </div>
    `;
}

function saveCurrentSelectionAsFavorite() {
    if (state.selectedStops.length === 0) {
        alert('Please select at least one stop to save as a favorite.');
        return;
    }
    const favName = prompt('Enter a name for this favorite selection:');
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
        state.selectedStops = favorites[name]; // Favorites now store {id, code, name}
        renderSelectedStopTags();
        fetchAndRenderDepartures();
    }
}

function positionSuggestions() {
    const container = state.suggestionsContainer;
    const inputRect = state.searchInput.getBoundingClientRect();

    // Use fixed positioning relative to the viewport. This is more reliable,
    // especially on mobile where the virtual keyboard can affect layout.
    container.style.position = 'fixed';
    container.style.left = `${inputRect.left}px`;
    container.style.width = `${inputRect.width}px`;
    container.style.overflowY = 'auto';

    // Use the Visual Viewport API for better mobile keyboard handling.
    // It gives the dimensions of the viewport as it is currently visible to the user.
    const viewport = window.visualViewport || { height: window.innerHeight, offsetTop: 0 };
    const viewportTop = viewport.offsetTop;
    const viewportHeight = viewport.height;

    const spaceBelow = viewportHeight - (inputRect.bottom - viewportTop);
    const spaceAbove = inputRect.top - viewportTop;

    // Prefer positioning below unless there's significantly more space above.
    const positionBelow = spaceBelow >= 200 || spaceBelow > spaceAbove;

    if (positionBelow) {
        // Position below the input
        container.style.top = `${inputRect.bottom}px`;
        container.style.bottom = '';
        // Use a margin of 10px from the bottom of the visual viewport.
        container.style.maxHeight = `${spaceBelow - 10}px`;
    } else {
        // Position above the input
        container.style.top = '';
        container.style.bottom = `${viewportHeight - (inputRect.top - viewportTop)}px`;
        // Use a margin of 10px from the top of the visual viewport.
        container.style.maxHeight = `${spaceAbove - 10}px`;
    }
}
function renderSuggestions(results) {
    results.stops.forEach(stop => {
        if (!state.ALL_STOPS_DATA.some(s => s.id === stop.id)) { state.ALL_STOPS_DATA.push(stop); }
    });
    const groupedStops = groupStops(results.stops);
    state.suggestionsContainer.innerHTML = '';
    if (groupedStops.length > 0) {
        // Modernized header with SVG close icon
        state.suggestionsContainer.innerHTML = `
            <div class="flex justify-between items-center p-3 border-b border-gray-200 dark:border-gray-700">
                <p class="text-sm font-semibold text-gray-700 dark:text-gray-300">Search Results</p>
                <button id="close-suggestions-btn" class="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-600" title="Close">
                    <svg class="w-5 h-5 text-gray-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>`;
        
        const stopsHeader = document.createElement('div');
        stopsHeader.className = 'px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider';
        stopsHeader.textContent = 'Stops';
        state.suggestionsContainer.appendChild(stopsHeader);

        groupedStops.forEach(item => {
            const isSelected = (stopId) => state.selectedStops.some(s => s.id === stopId); // Use ID for checking.
            const selectedClass = (stopId) => isSelected(stopId) ? 'suggestion-selected' : 'hover:bg-gray-100 dark:hover:bg-gray-700';
            const selectedText = (stopId) => isSelected(stopId) ? '' : 'hidden';

            if (item.is_parent) {
                const groupEl = document.createElement('div');
                groupEl.className = 'border-b border-gray-200 dark:border-gray-700';
                groupEl.innerHTML = `
                    <div class="flex justify-between items-center cursor-pointer parent-toggle p-3 hover:bg-gray-100 dark:hover:bg-gray-700">
                        <div class="font-semibold text-gray-800 dark:text-gray-200">${item.name}</div>
                        <div class="flex items-center gap-3">
                            <span class="walking-directions-btn" data-lat="${item.latitude}" data-lon="${item.longitude}" onclick="event.stopPropagation(); getWalkingDirections(${item.latitude}, ${item.longitude})">${WALKING_MAN_ICON}</span>
                            <div class="expand-icon text-gray-400 dark:text-gray-500">
                                <svg class="w-5 h-5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                            </div>
                        </div>
                    </div>
                    <div class="pl-4 hidden child-container bg-gray-50 dark:bg-gray-800/50">
                        ${item.children.map(child => `<div class="p-3 cursor-pointer suggestion-item child-stop border-t border-gray-200 dark:border-gray-700 ${selectedClass(child.id)}" data-id="${child.id}" data-code="${child.stop_code}"><div class="flex justify-between items-center"><div class="font-medium">${child.name}</div><div class="selection-status text-white font-bold ${selectedText(child.id)}">✓</div></div><div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Routes: ${formatServicingRoutes(child.servicing_routes, child.route_directions)}</div></div>`).join('')}
                    </div>`;
                state.suggestionsContainer.appendChild(groupEl);
            } else {
                const itemEl = document.createElement('div');
                itemEl.className = `p-3 cursor-pointer suggestion-item border-b border-gray-200 dark:border-gray-700 ${selectedClass(item.id)}`;
                itemEl.dataset.id = item.id;
                itemEl.dataset.code = item.stop_code;
                itemEl.innerHTML = `<div class="flex justify-between items-center"><div class="font-medium">${item.name}</div><div class="flex items-center gap-3"><div class="selection-status text-white font-bold ${selectedText(item.id)}">✓</div><span class="walking-directions-btn" data-lat="${item.latitude}" data-lon="${item.longitude}" onclick="event.stopPropagation(); getWalkingDirections(${item.latitude}, ${item.longitude})">${WALKING_MAN_ICON}</span></div></div><div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Routes: ${formatServicingRoutes(item.servicing_routes, item.route_directions)}</div>`;
                state.suggestionsContainer.appendChild(itemEl);
            }
        });
    }

    if (results.routes && results.routes.length > 0) {
        const routesHeader = document.createElement('div');
        routesHeader.className = 'px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider';
        routesHeader.textContent = 'Routes';
        state.suggestionsContainer.appendChild(routesHeader);

        results.routes.forEach(route => {
            const li = document.createElement('div');
            li.className = 'suggestion-item border-b dark:border-gray-700';

            const params = new URLSearchParams({
                route_id: route.route_id,
                headsign: route.trip_headsign,
                shape_id: route.shape_id, // Still needed for drawing the map shape
            }); 

            const link = document.createElement('a');
            link.href = `route.html?${params.toString()}`;
            link.className = 'p-3 w-full flex justify-between items-center cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700';
            link.innerHTML = `
                <div>
                    <div class="font-medium">${route.route_short_name} ${route.trip_headsign}</div>
                    <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">${route.route_long_name}</div>
                </div>
                <span class="text-xs bg-gray-200 text-gray-800 dark:bg-gray-600 dark:text-gray-300 font-medium me-2 px-2.5 py-0.5 rounded-md">Route</span>
            `;
            li.appendChild(link);
            state.suggestionsContainer.appendChild(li);
        });
    }

    if (groupedStops.length > 0 || (results.routes && results.routes.length > 0)) {
        state.suggestionsWrapper.classList.remove('hidden');
        document.body.classList.add('suggestions-active');
    } else {
        state.suggestionsContainer.innerHTML = `<div class="p-4 text-center text-gray-500">No stops or routes found.</div>`;
        state.suggestionsWrapper.classList.remove('hidden');
        document.body.classList.add('suggestions-active');
    }
    positionSuggestions();
}

function updateSuggestionStates() {
    const isSelected = (stopId) => state.selectedStops.some(s => s.id === stopId); // This is correct, uses ID.

    document.querySelectorAll('.suggestion-item[data-id]').forEach(item => {
        const id = item.dataset.id; // Use data-id for the lookup.
        if (isSelected(id)) {
            item.classList.add('suggestion-selected', 'hover:bg-blue-700');
            item.querySelector('.selection-status')?.classList.remove('hidden');
        } else {
            item.classList.remove('suggestion-selected', 'hover:bg-blue-700');
            item.querySelector('.selection-status')?.classList.add('hidden');
        }
    });
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

        state.mapOverlayText.innerHTML = `<span>Showing stops near you</span>
            <button id="clear-map-overlay-btn" class="ml-2 flex-shrink-0 w-6 h-6 bg-red-600 text-white rounded-full flex items-center justify-center font-bold text-sm hover:bg-red-700" title="Clear map view">
                &times;
            </button>
        `;
        state.mapOverlayText.classList.remove('hidden');
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

    // If a parent station is selected, select all its children instead.
    if (stop.is_parent && stop.children && stop.children.length > 0) {
        stop.children.forEach(childStop => {
            const isChildSelected = state.selectedStops.some(s => s.id === childStop.id);
            if (!isChildSelected) {
                state.selectedStops.push({ id: childStop.id, code: childStop.stop_code, name: childStop.name });
            }
        });
    } else {
        // Handle individual stop selection
    const isSelected = state.selectedStops.some(s => s.id === stop.id);
    if (!isSelected) {
        state.selectedStops.push({ id: stop.id, code: stop.stop_code, name: stop.name });
    } else {
        state.selectedStops = state.selectedStops.filter(s => s.id !== stop.id);
    }
    }

    renderSelectedStopTags();
    updateAndRenderRouteFilters();
    fetchAndRenderDepartures();

    // Plot the newly selected/deselected stops on the map.
    // Use the unique ID for lookup to prevent ambiguity with shared stop_codes.
    const stopObjects = state.selectedStops.map(s => state.ALL_STOPS_DATA.find(db_s => db_s.id === s.id)).filter(Boolean);
    plotStopsOnMap(stopObjects);

    updateSuggestionStates();
}

async function findAndSelectNearestStops(lat, lon) {
    try {
        const response = await fetch(`${state.findNearMeEndpoint}?lat=${lat}&lon=${lon}&radius=500`);
        if (!response.ok) throw new Error('Failed to fetch nearby stops');
        
        const nearbyStops = await response.json();
        if (nearbyStops.length === 0) return;
        state.nearbyStopsCache = nearbyStops; // Cache the nearby stops
        
        let stopsToConsider = nearbyStops;
        const favoriteRoutes = getCookie('favoriteRoutes');

        if (favoriteRoutes && favoriteRoutes.length > 0) {
            const favoriteRoutesSet = new Set(favoriteRoutes);
            const relevantStops = nearbyStops.filter(stop => {
                if (!stop.servicing_routes) return false;
                const stopRoutes = stop.servicing_routes.split(', ');
                return stopRoutes.some(route => favoriteRoutesSet.has(route));
            });

            if (relevantStops.length > 0) {
                stopsToConsider = relevantStops;
            }
        }

        // Plot all nearby stops first so they appear on the map
        plotStopsOnMap(nearbyStops);

        let inboundStop = null;
        let outboundStop = null;
        // Find the best candidates for inbound and outbound
        for (const stop of stopsToConsider) {
            if (!stop.route_directions) continue;

            const directions = Object.values(stop.route_directions).flat();
            const hasInbound = directions.includes('Inbound');
            const hasOutbound = directions.includes('Outbound');
            if (hasInbound && !hasOutbound && !inboundStop) {
                inboundStop = stop;
            }
            if (hasOutbound && !hasInbound && !outboundStop) {
                outboundStop = stop;
            }
        }

        // Fallback: if we couldn't find clean in/out stops, pick the two closest.
        if (!inboundStop && stopsToConsider.length > 0) inboundStop = stopsToConsider[0];
        if (!outboundStop && stopsToConsider.length > 1) {
            outboundStop = stopsToConsider.find(s => s.id !== inboundStop.id) || null;
        }

        // Select the identified stops
        if (inboundStop) handleStopSelection(inboundStop);
        if (outboundStop && outboundStop.id !== inboundStop.id) handleStopSelection(outboundStop);

    } catch (error) {
        console.error('Error finding and selecting nearest stops:', error);
    }
}

function addEventListeners() {
    state.searchInput.addEventListener('input', () => {
        // When a new search is initiated, clear any existing route display from the map.
        // This resets the view to focus on the new search context.
        if (state.routeShapeLayer) {
            clearRouteDisplay();
        }

        clearTimeout(state.searchDebounceTimer);
        const query = state.searchInput.value.trim();
        if (query.length < 3) { state.suggestionsContainer.classList.add('hidden'); return; }
        state.searchDebounceTimer = setTimeout(async () => {
            // Ensure location is available for sorting, if possible
            if (!state.cachedPosition) await requestUserLocation(true);

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

        if (closeBtn) {
            state.suggestionsWrapper.classList.add('hidden');
            document.body.classList.remove('suggestions-active');
            return;
        }

        // Check if the item is a stop suggestion and not a route link
        const isStopItem = suggestionItem && suggestionItem.hasAttribute('data-id');

        if (isStopItem && !suggestionItem.classList.contains('route-suggestion') && !e.target.closest('.route-actions')) {
            const stopId = suggestionItem.dataset.id;
            const stop = state.ALL_STOPS_DATA.find(s => s.id === stopId);
            
            if (state.activeRouteSelection && stop.parent_station) {
                // This is a route context, and the user clicked a stop that is part of a larger station.
                // We need to find all stops at that station for the selected route and add them.
                const { routeId, headsign } = state.activeRouteSelection;
                const url = `${state.stopsForRouteAtStationEndpoint}?route_id=${routeId}&headsign=${encodeURIComponent(headsign)}&parent_station=${stop.parent_station}`;
                const response = await fetch(url);
                const stopsToSelect = await response.json();
                stopsToSelect.forEach(stopToAdd => handleStopSelection(stopToAdd));
                
                state.activeRouteSelection = null;
                state.searchInput.value = '';
                state.suggestionsWrapper.classList.add('hidden');
                document.body.classList.remove('suggestions-active');
                clearRouteDisplay();
                plotStopsOnMap(state.selectedStops.map(s => state.ALL_STOPS_DATA.find(db_s => db_s.stop_code === s.code)).filter(Boolean));
                return;
            } else {
                // This is a normal stop selection, or a route context with a standalone stop.
                handleStopSelection(stop);
            }
        }
        if (parentToggle) {
            const childContainer = parentToggle.nextElementSibling;
            const icon = parentToggle.querySelector('.expand-icon');
            icon.classList.toggle('rotate-180');
            childContainer.classList.toggle('hidden');
            // Re-calculate position after expanding/collapsing to handle height changes.
            positionSuggestions();
        }
    });
    
    state.selectedStopsContainer.addEventListener('click', (e) => {
        if (e.target.matches('.remove-tag-btn')) {
            const stopIdToRemove = e.target.dataset.id;
            // The dataset ID is a string, but the stop.id might be a number.
            // Using a non-strict comparison `!=` handles this type difference.
            // Alternatively, you could parse stopIdToRemove: `parseInt(stopIdToRemove, 10)`.
            state.selectedStops = state.selectedStops.filter(stop => stop.id != stopIdToRemove);
            clearRouteDisplay();
            renderSelectedStopTags();
            updateAndRenderRouteFilters();
            fetchAndRenderDepartures();
            updateSuggestionStates();
        }
        if (e.target.closest('#clear-all-btn')) clearAllStops();
        if (e.target.id === 'save-favorite-btn') saveCurrentSelectionAsFavorite();
    });

    state.findNearMeBtn.addEventListener('click', () => {
        if (!navigator.geolocation) { return alert('Geolocation is not supported by your browser.'); }
        
        if (state.cachedPosition && state.positionCacheTimestamp && (Date.now() - state.positionCacheTimestamp < state.CACHE_DURATION_MS)) {
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
                state.cachedPosition = { coords: { latitude: position.coords.latitude, longitude: position.coords.longitude } };
                state.positionCacheTimestamp = Date.now();
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
        } else if (e.target.classList.contains('delete-favorite-btn')) {
            e.preventDefault();
            const favName = e.target.dataset.name;
            if (confirm(`Are you sure you want to delete the favorite "${favName}"?`)) {
                const favorites = getCookie('favoriteStops') || {};
                delete favorites[favName];
                setCookie('favoriteStops', favorites, 365);
                alert(`Favorite "${favName}" deleted.`);
                renderFavoritesDropdown();
            }
        }
    });

    state.routeFiltersContainer.addEventListener('click', (e) => {
        const filterBtn = e.target.closest('.route-filter-btn');
        const mobileToggle = e.target.closest('#mobile-filter-toggle');
        const checkbox = e.target.closest('.route-filter-checkbox');

        // Handle mobile filter dropdown
        if (mobileToggle) {
            const dropdown = document.getElementById('mobile-filter-dropdown');
            const isHidden = dropdown.classList.contains('hidden');
            dropdown.classList.toggle('hidden');
            // Prevent body scroll when the filter dropdown is open
            document.body.classList.toggle('overflow-hidden', isHidden);
            return;
        }
        
        let routeNumber;
        if (filterBtn) {
            routeNumber = filterBtn.dataset.routeNumber;
        } else if (checkbox) {
            routeNumber = checkbox.dataset.routeNumber;
        }

        if (routeNumber) {
             if (state.activeRouteFilters.has(routeNumber)) {
                 state.activeRouteFilters.delete(routeNumber);
             } else {
                 state.activeRouteFilters.add(routeNumber);
             }
            // Re-render filters to update active states and then re-render departures
            updateAndRenderRouteFilters();
            fetchAndRenderDepartures(); // Re-render with the new filter
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#stop-search-input') && !e.target.closest('#autocomplete-suggestions')) {
            state.suggestionsWrapper.classList.add('hidden');
            document.body.classList.remove('suggestions-active');
        }
        // Close mobile filter dropdown if clicking outside
        const mobileFilterDropdown = document.getElementById('mobile-filter-dropdown');
        if (mobileFilterDropdown && !mobileFilterDropdown.classList.contains('hidden')) {
            if (!e.target.closest('#mobile-filter-toggle') && !e.target.closest('#mobile-filter-dropdown')) {
                mobileFilterDropdown.classList.add('hidden');
                document.body.classList.remove('overflow-hidden');
            }
        }
        // Clear map overlay if clear button is clicked
        if (e.target.id === 'clear-map-overlay-btn') {
            clearRouteDisplay();
        }
    });

    // Add a listener to reposition the suggestions if the viewport changes
    // (e.g., mobile keyboard appears/disappears).
    window.visualViewport?.addEventListener('resize', () => {
        if (!state.suggestionsWrapper.classList.contains('hidden')) {
            positionSuggestions();
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

function setupDeparturesObserver() {
    // Disconnect any existing observer
    if (state.departuresObserver) {
        state.departuresObserver.disconnect();
    }

    const sentinel = document.getElementById('scroll-sentinel'); // This is the observer target
    if (!sentinel) return; // Exit if the sentinel element isn't in the DOM

    const observerCallback = (entries) => {
        entries.forEach(entry => {
            // On mobile, when the sentinel is NOT intersecting the viewport (i.e., scrolled past it),
            // add the 'departures-expanded' class to the body.
            document.body.classList.toggle('departures-expanded', !entry.isIntersecting && window.innerWidth < 768);
        });
    };

    state.departuresObserver = new IntersectionObserver(observerCallback, {
        root: null, // Observe within the viewport
        threshold: 0
    });

    state.departuresObserver.observe(sentinel);
}

function clearAllStops() {
    state.selectedStops = [];
    state.activeRouteFilters.clear();
    clearRouteDisplay();
    renderSelectedStopTags();
    updateAndRenderRouteFilters();
    fetchAndRenderDepartures();
}

function requestUserLocation(isSilent = false) {
    return new Promise((resolve, reject) => {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(position => {
            setCookie('userLocation', JSON.stringify({lat: position.coords.latitude, lon: position.coords.longitude}), 1);
            state.cachedPosition = { coords: { latitude: position.coords.latitude, longitude: position.coords.longitude } };
            state.positionCacheTimestamp = Date.now();
            resolve(position);
        }, (error) => { if (!isSilent) { /* User denied or error, do nothing */ } reject(error); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    }
    });
}

function init() {
    // Set flex on the container for the order property to work
    state.departuresContainer.style.display = 'flex';
    state.departuresContainer.style.flexDirection = 'column';

    setupDeparturesObserver();

    addEventListeners();
    initializeMapWithUserLocation();
    renderFavoritesDropdown();
    requestUserLocation(true); // Proactively get user location silently
    updateCurrentTime();
    fetchAndRenderDepartures();
    setInterval(updateCurrentTime, 1000);
    setInterval(fetchAndRenderDepartures, 10000);
}

document.addEventListener('DOMContentLoaded', init);