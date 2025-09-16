// index.js (UPDATED with canBoardDebark filter)

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

const DEFAULT_URLS = {
  bus: 'https://jp.translink.com.au/api/stop/timetable/001951',
  trainP2: 'https://jp.translink.com.au/api/stop/timetable/600284',
  trainP4: 'https://jp.translink.com.au/api/stop/timetable/600286',
};

const BUS_ROUTE_INFO = { '411': 'Adelaide Street Stop 22 (13 mins travel)', '460': 'Roma Street busway station', '412': 'Ann Street Stop 7 (King George Square)', '454': 'Roma Street busway station', '425': 'Adelaide Street Stop 22 (13 mins travel)', '417': 'Adelaide Street Stop 22 (14 mins travel)', '435': 'Adelaide Street Stop 22 (13 mins travel)', '444': 'King George Square station (10 mins travel)', '415': 'Adelaide Street Stop 22 (13 mins travel)', '445': 'Adelaide Street Stop 22 (13 mins travel)', '453': 'Roma Street busway station',};

const fetchOptions = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  }
};

app.get('/api/departures', async (req, res) => {
  let urlsToFetch = [];
  const stopIds = req.query.stops;

  if (stopIds) {
    const ids = stopIds.split(',');
    urlsToFetch = ids.map(id => `https://jp.translink.com.au/api/stop/timetable/${id}`);
  } else {
    urlsToFetch = Object.values(DEFAULT_URLS);
  }

  if (urlsToFetch.length === 0) {
    return res.json([]);
  }
  
  try {
    const requests = urlsToFetch.map(url => fetch(url, fetchOptions));
    const responses = await Promise.all(requests);

    const successfulResponses = responses.filter(r => r.ok);
    if(successfulResponses.length < responses.length){
        console.warn('Some API requests may have failed.');
    }
    const data = await Promise.all(successfulResponses.map(r => r.json()));
    
    let allDepartures = [];

    data.forEach(stopData => {
      const stopName = stopData.name;
      const vehicleType = stopName.toLowerCase().includes('station') ? 'Train' : 'Bus';
      
      if (stopData.departures) {
        stopData.departures.forEach(dep => {
          // --- CHANGE IS HERE ---
          // NEW: Only include services where boarding is possible ("Both")
          if (dep.canBoardDebark === 'Both') {
            const routeIdParts = dep.routeId.split(':');
            const routeNumber = routeIdParts[routeIdParts.length - 1];
            allDepartures.push({
              stopName: stopName, vehicleType: vehicleType, routeNumber: routeNumber, headsign: dep.headsign,
              scheduledDepartureUtc: dep.scheduledDepartureUtc,
              expectedDepartureUtc: dep.realtime ? dep.realtime.expectedDepartureUtc : null,
              departureDescription: dep.departureDescription,
              destinationInfo: vehicleType === 'Bus' ? (BUS_ROUTE_INFO[routeNumber] || null) : null
            });
          }
        });
      }
    });

    allDepartures.sort((a, b) => new Date(a.scheduledDepartureUtc) - new Date(b.scheduledDepartureUtc));
    res.json(allDepartures);

  } catch (error) {
    console.error('A critical error occurred:', error);
    res.status(500).json({ 
      message: 'The server failed to process the request.',
      error_details: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});