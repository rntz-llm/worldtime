#!/usr/bin/env node
// Regenerates site/data/places.js and site/data/land.js.
//
//   npm install && npm run build-data
//
// places.js: every zone in the system's IANA zone.tab (with the coordinates of
// its principal city), plus a hand-picked list of other well-known cities.
// land.js: Natural Earth 1:50m land outlines (via the world-atlas package),
// simplified and projected to an equirectangular SVG path where
// x = longitude + 180 and y = 90 - latitude.
'use strict';
const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');

const OUT = path.join(__dirname, '..', 'site', 'data');
const ZONE_TAB = process.env.ZONE_TAB || '/usr/share/zoneinfo/zone.tab';

// [name, IANA zone, latitude, longitude, ISO country code]
const EXTRA_CITIES = [
  ['San Francisco', 'America/Los_Angeles', 37.77, -122.42, 'US'],
  ['Berkeley', 'America/Los_Angeles', 37.87, -122.27, 'US'],
  ['San Jose', 'America/Los_Angeles', 37.34, -121.89, 'US'],
  ['San Diego', 'America/Los_Angeles', 32.72, -117.16, 'US'],
  ['Seattle', 'America/Los_Angeles', 47.61, -122.33, 'US'],
  ['Portland', 'America/Los_Angeles', 45.52, -122.68, 'US'],
  ['Las Vegas', 'America/Los_Angeles', 36.17, -115.14, 'US'],
  ['Salt Lake City', 'America/Denver', 40.76, -111.89, 'US'],
  ['Austin', 'America/Chicago', 30.27, -97.74, 'US'],
  ['Dallas', 'America/Chicago', 32.78, -96.80, 'US'],
  ['Houston', 'America/Chicago', 29.76, -95.37, 'US'],
  ['Minneapolis', 'America/Chicago', 44.98, -93.27, 'US'],
  ['New Orleans', 'America/Chicago', 29.95, -90.07, 'US'],
  ['Atlanta', 'America/New_York', 33.75, -84.39, 'US'],
  ['Boston', 'America/New_York', 42.36, -71.06, 'US'],
  ['Washington, D.C.', 'America/New_York', 38.91, -77.04, 'US'],
  ['Philadelphia', 'America/New_York', 39.95, -75.17, 'US'],
  ['Pittsburgh', 'America/New_York', 40.44, -80.00, 'US'],
  ['Miami', 'America/New_York', 25.76, -80.19, 'US'],
  ['Montreal', 'America/Toronto', 45.50, -73.57, 'CA'],
  ['Ottawa', 'America/Toronto', 45.42, -75.70, 'CA'],
  ['Calgary', 'America/Edmonton', 51.05, -114.07, 'CA'],
  ['Fort-de-France', 'America/Martinique', 14.60, -61.07, 'MQ'],
  ['Rio de Janeiro', 'America/Sao_Paulo', -22.91, -43.17, 'BR'],
  ['Brasília', 'America/Sao_Paulo', -15.79, -47.88, 'BR'],
  ['Edinburgh', 'Europe/London', 55.95, -3.19, 'GB'],
  ['Manchester', 'Europe/London', 53.48, -2.24, 'GB'],
  ['Cambridge', 'Europe/London', 52.21, 0.12, 'GB'],
  ['Oxford', 'Europe/London', 51.75, -1.26, 'GB'],
  ['Barcelona', 'Europe/Madrid', 41.39, 2.17, 'ES'],
  ['Lyon', 'Europe/Paris', 45.76, 4.84, 'FR'],
  ['Munich', 'Europe/Berlin', 48.14, 11.58, 'DE'],
  ['Frankfurt', 'Europe/Berlin', 50.11, 8.68, 'DE'],
  ['Hamburg', 'Europe/Berlin', 53.55, 9.99, 'DE'],
  ['Geneva', 'Europe/Zurich', 46.20, 6.14, 'CH'],
  ['Milan', 'Europe/Rome', 45.46, 9.19, 'IT'],
  ['Kraków', 'Europe/Warsaw', 50.06, 19.94, 'PL'],
  ['Saint Petersburg', 'Europe/Moscow', 59.93, 30.34, 'RU'],
  ['Tel Aviv', 'Asia/Jerusalem', 32.09, 34.78, 'IL'],
  ['Abu Dhabi', 'Asia/Dubai', 24.45, 54.38, 'AE'],
  ['Mumbai', 'Asia/Kolkata', 19.08, 72.88, 'IN'],
  ['New Delhi', 'Asia/Kolkata', 28.61, 77.21, 'IN'],
  ['Bengaluru', 'Asia/Kolkata', 12.97, 77.59, 'IN'],
  ['Chennai', 'Asia/Kolkata', 13.08, 80.27, 'IN'],
  ['Hyderabad', 'Asia/Kolkata', 17.39, 78.49, 'IN'],
  ['Hanoi', 'Asia/Bangkok', 21.03, 105.85, 'VN'],
  ['Beijing', 'Asia/Shanghai', 39.90, 116.40, 'CN'],
  ['Shenzhen', 'Asia/Shanghai', 22.54, 114.06, 'CN'],
  ['Osaka', 'Asia/Tokyo', 34.69, 135.50, 'JP'],
  ['Kyoto', 'Asia/Tokyo', 35.01, 135.77, 'JP'],
  ['Canberra', 'Australia/Sydney', -35.28, 149.13, 'AU'],
  ['Wellington', 'Pacific/Auckland', -41.29, 174.78, 'NZ'],
  ['Cape Town', 'Africa/Johannesburg', -33.92, 18.42, 'ZA'],
];

const NAME_OVERRIDES = {
  'Asia/Ho_Chi_Minh': 'Ho Chi Minh City',
  'Antarctica/DumontDUrville': "Dumont d'Urville",
};

// zone.tab coordinates look like +DDMM+DDDMM or +DDMMSS+DDDMMSS.
function parseCoord(s, degDigits) {
  const sign = s[0] === '-' ? -1 : 1;
  const d = +s.slice(1, 1 + degDigits);
  const m = +s.slice(1 + degDigits, 3 + degDigits);
  const sec = +(s.slice(3 + degDigits) || 0);
  return +(sign * (d + m / 60 + sec / 3600)).toFixed(2);
}

function buildPlaces() {
  const places = [];
  for (const line of fs.readFileSync(ZONE_TAB, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [cc, coords, zone] = line.split('\t');
    const m = coords.match(/^([+-]\d+)([+-]\d+)$/);
    const lat = parseCoord(m[1], 2);
    const lon = parseCoord(m[2], 3);
    const name = NAME_OVERRIDES[zone] || zone.split('/').pop().replace(/_/g, ' ');
    places.push([zone, name, zone, lat, lon, cc]);
  }
  for (const [name, zone, lat, lon, cc] of EXTRA_CITIES) {
    places.push([zone + '|' + name, name, zone, lat, lon, cc]);
  }
  places.push(['UTC', 'UTC', 'UTC', null, null, '']);
  places.sort((a, b) => a[1].localeCompare(b[1]));
  const ids = new Set();
  for (const p of places) {
    if (ids.has(p[0])) throw new Error('duplicate place id ' + p[0]);
    ids.add(p[0]);
  }
  const body = places.map(p => JSON.stringify(p)).join(',\n');
  fs.writeFileSync(path.join(OUT, 'places.js'),
    '// Generated by scripts/build-data.js. [id, name, IANA zone, lat, lon, country]\n' +
    'window.WT_PLACES = [\n' + body + '\n];\n');
  console.log(`places.js: ${places.length} places`);
}

function buildLand() {
  const file = require.resolve('world-atlas/land-50m.json');
  const topo = JSON.parse(fs.readFileSync(file, 'utf8'));
  const land = topojson.feature(topo, topo.objects.land);
  const geoms = land.features ? land.features.map(f => f.geometry) : [land.geometry];
  const MIN_STEP = 0.3; // degrees; drop points closer than this to the previous one
  const ringPath = pts => 'M' + pts.map(([x, y]) => +x.toFixed(1) + ' ' + +y.toFixed(1)).join('L') + 'Z';
  let d = '';
  for (const g of geoms) {
    const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
    for (const ring of polys.flat()) {
      // Unwrap longitudes so rings crossing the antimeridian stay continuous
      // (x may leave 0..360; such rings are drawn again shifted by 360).
      const pts = [];
      let shift = 0, prevLon = null;
      for (const [lon, lat] of ring) {
        if (prevLon != null && Math.abs(lon - prevLon) > 180) shift += lon < prevLon ? 360 : -360;
        prevLon = lon;
        const x = lon + shift + 180, y = 90 - lat;
        const last = pts[pts.length - 1];
        if (last && Math.hypot(last[0] - x, last[1] - y) < MIN_STEP) continue;
        pts.push([x, y]);
      }
      if (pts.length < 4) continue;
      // A ring around a pole (Antarctica) ends 360 degrees from where it began:
      // close it along the edge of the map.
      if (shift !== 0) {
        const poleY = pts.reduce((s, p) => s + p[1], 0) / pts.length > 90 ? 180 : 0;
        pts.push([pts[pts.length - 1][0], poleY], [pts[0][0], poleY]);
      }
      const xs = pts.map(p => p[0]);
      d += ringPath(pts);
      if (Math.min(...xs) < 0) d += ringPath(pts.map(([x, y]) => [x + 360, y]));
      if (Math.max(...xs) > 360) d += ringPath(pts.map(([x, y]) => [x - 360, y]));
    }
  }
  fs.writeFileSync(path.join(OUT, 'land.js'),
    '// Generated by scripts/build-data.js from Natural Earth (public domain) via world-atlas.\n' +
    'window.WT_LAND = "' + d + '";\n');
  console.log(`land.js: ${d.length} bytes`);
}

buildPlaces();
buildLand();
