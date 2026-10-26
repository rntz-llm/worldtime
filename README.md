# World Clock

A static web page, modelled on the macOS Clock app's World Clock, that shows the
time in several places at once:

- a world map with the day/night line and a pin for each city,
- an analog clock per city (white by day, black by night) with its offset from
  your time and today's sunrise and sunset,
- a converter: type a time (and optionally a date) in any of your cities, or in
  your local time, and every clock shows that moment instead of now. "Back to
  now" returns to the live view. A converted time is kept in the URL, so you
  can share the link.

Click **+** to add a city; search by city, country or time zone name (e.g.
"Paris", "Japan", "UK", "Pacific Standard"). Hover a card and click **×** to
remove it. The chosen cities and the 12/24-hour setting are saved in your
browser's `localStorage`; nothing is sent anywhere. The default cities are Los
Angeles, New York and London.

## Running it

There is no build step. Open `site/index.html` in a browser, or serve the
`site` directory with any static file server:

    python3 -m http.server -d site 8000

Pushing to `main` deploys `site/` to GitHub Pages via
`.github/workflows/pages.yml` (set *Settings → Pages → Source* to
"GitHub Actions").

## Files

- `site/index.html`, `site/style.css`, `site/app.js`: the page.
- `site/data/places.js`: the city list: every zone in the IANA time zone
  database's `zone.tab` (with its principal city's coordinates) plus some
  other well-known cities.
- `site/data/land.js`: land outlines from Natural Earth (public domain), as an
  SVG path.
- `scripts/build-data.js`: regenerates both data files (`npm install && npm run
  build-data`).
- `test/browser-test.js`: an end-to-end test in headless Chromium using
  Playwright (`npm test`).

Time zone rules come from the browser (`Intl`), so they are as current as the
browser. Sunrise, sunset and the day/night line use a standard low-precision
solar formula and are good to a minute or two.
