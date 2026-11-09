// Phase 0 load test: a bare HTTP server answering the home screen's two questions from SQLite,
// hammered by many simultaneous clients. Is the server still quick when queries pause it?
//   node scripts/sqlite-phase0/load.js [concurrency] [seconds]
const http = require('http');
const { Timetable } = require('../../lib/sqlite-data');
const { activeServiceDays } = require('../../lib/realtime');

const conc = Number(process.argv[2] || 50), secs = Number(process.argv[3] || 10);
const before = process.memoryUsage().rss;
const tt = new Timetable('data/seq.sqlite');
const places = [[-27.4838, 152.9937], [-27.4658, 153.0195], [-27.4698, 153.0251], [-27.4766, 153.0203], [-27.5, 152.92],
    [-27.5947, 153.1236], [-28.0023, 153.431], [-26.659, 153.087], [-27.614, 152.759], [-27.526, 153.265]];

const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const lat = +u.searchParams.get('lat'), lon = +u.searchParams.get('lon');
    const stops = tt.stopsNearMe({ lat, lon, radius: 500, farRadius: 1200 });
    if (u.pathname === '/stops') return res.end(JSON.stringify(stops));
    const codes = [...new Set(stops.map(s => s.stop_code).filter(Boolean))];
    const deps = activeServiceDays(new Date()).flatMap(d => tt.scheduledDepartures(codes, d));
    res.end(JSON.stringify(deps.slice(0, 60)));
}).listen(0, async () => {
    const port = server.address().port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: conc });
    const get = (path) => new Promise((ok, fail) => http.get({ port, path, agent }, r => { r.resume(); r.on('end', ok); }).on('error', fail));
    const lat = [];
    let n = 0;
    const end = Date.now() + secs * 1000;
    const cpu0 = process.cpuUsage();
    await Promise.all(Array.from({ length: conc }, async (_, w) => {
        for (let i = w; Date.now() < end; i++) {
            const [a, b] = places[i % places.length];
            const t = performance.now();
            await get(`/${i % 2 ? 'stops' : 'departures'}?lat=${a}&lon=${b}`);
            lat.push(performance.now() - t); n++;
        }
    }));
    const cpu = process.cpuUsage(cpu0);
    lat.sort((x, y) => x - y);
    const p = (q) => lat[Math.floor(lat.length * q)].toFixed(1);
    console.log(`${conc} clients for ${secs}s: ${(n / secs).toFixed(0)} requests/s (client and server share one process)`);
    console.log(`  response time: median ${p(0.5)} ms, 99% under ${p(0.99)} ms, slowest ${lat[lat.length - 1].toFixed(1)} ms`);
    console.log(`  CPU ${((cpu.user + cpu.system) / 1000 / n).toFixed(2)} ms per request; memory ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB (Node alone ${(before / 1048576).toFixed(0)} MB)`);
    process.exit(0);
});
