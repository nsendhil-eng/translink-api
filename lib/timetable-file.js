// The API's copy of the timetable file (scripts/build-sqlite.js), kept current by lib/file-keeper.js.
//
//   TIMETABLE_URL   where manifest.json and the file are, e.g.
//                   https://github.com/nsendhil-eng/translink-api/releases/latest/download
//   TIMETABLE_FILE  or a local file to open as is (development, tests)
const { createFileKeeper } = require('./file-keeper');
const { Timetable } = require('./sqlite-data');

module.exports = createFileKeeper({
    prefix: 'seq',
    baseUrl: () => process.env.TIMETABLE_URL || null,
    localFile: () => process.env.TIMETABLE_FILE || null,
    open: (file) => new Timetable(file),
    extraStatus: (t) => ({ calendarEnd: t?.meta.calendar_end ?? null })
});
