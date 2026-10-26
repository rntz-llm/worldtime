'use strict';
(() => {
  // ---------------------------------------------------------------------------
  // Data and saved settings

  const KEY_PLACES = 'worldtime.places';
  const KEY_HOUR12 = 'worldtime.hour12';
  const DEFAULT_IDS = ['America/Los_Angeles', 'America/New_York', 'Europe/London'];
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HOUR = 3600000;
  const RAD = Math.PI / 180;

  function zoneSupported(zone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
  }

  const PLACES = window.WT_PLACES
    .map(([id, name, zone, lat, lon, cc]) => ({ id, name, zone, lat, lon, cc }))
    .filter(p => zoneSupported(p.zone));
  const BY_ID = new Map(PLACES.map(p => [p.id, p]));

  const LOCAL_ZONE = (() => {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return z && zoneSupported(z) ? z : 'UTC';
  })();

  // A place for any IANA zone, used when the zone isn't in our list.
  function placeForZone(zone) {
    const known = BY_ID.get(zone);
    if (known) return known;
    return { id: zone, name: zone.split('/').pop().replace(/_/g, ' '), zone, lat: null, lon: null, cc: '' };
  }
  const LOCAL_PLACE = { ...placeForZone(LOCAL_ZONE), id: 'local' };

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
  };

  let selected = store.get(KEY_PLACES, null);
  if (!Array.isArray(selected)) selected = DEFAULT_IDS;
  selected = [...new Set(selected.filter(id => BY_ID.has(id)))];

  let hour12 = store.get(KEY_HOUR12, null);
  if (typeof hour12 !== 'boolean') {
    hour12 = !!new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12;
  }

  // Converter state. In "live" mode we show the current time. In "fixed" mode
  // we show the wall-clock time `wall` as read in the source place's zone.
  let mode = 'live';
  let wall = null; // { y, mo, d, h, mi }
  let sourceId = 'local';
  let linkedSource = null; // a source place from a shared link that isn't in `selected`

  // ---------------------------------------------------------------------------
  // Time zone arithmetic

  const partsFormatters = new Map();
  function zoneParts(zone, t) {
    let f = partsFormatters.get(zone);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
      partsFormatters.set(zone, f);
    }
    const o = {};
    for (const p of f.formatToParts(t)) o[p.type] = p.value;
    return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
  }

  // Minutes the zone is ahead of UTC at instant t.
  function offsetMinutes(zone, t) {
    const p = zoneParts(zone, t);
    const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    return Math.round((asUTC - Math.floor(t / 1000) * 1000) / 60000);
  }

  // The instant at which clocks in `zone` read the given wall time.
  function wallToInstant(zone, { y, mo, d, h, mi }) {
    const local = Date.UTC(y, mo - 1, d, h, mi);
    const o1 = offsetMinutes(zone, local);
    let t = local - o1 * 60000;
    const o2 = offsetMinutes(zone, t);
    if (o2 !== o1) {
      const t2 = local - o2 * 60000;
      if (offsetMinutes(zone, t2) === o2) t = t2;
    }
    return t;
  }

  const dayNumber = p => Date.UTC(p.y, p.mo - 1, p.d) / 86400000;
  const pad = n => String(n).padStart(2, '0');

  const timeFormatters = new Map();
  function formatTime(zone, t) {
    const key = zone + hour12;
    let f = timeFormatters.get(key);
    if (!f) {
      f = new Intl.DateTimeFormat(undefined, {
        timeZone: zone, hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12,
      });
      timeFormatters.set(key, f);
    }
    return f.format(t);
  }

  const dateFormatters = new Map();
  function formatDate(zone, t) {
    let f = dateFormatters.get(zone);
    if (!f) {
      f = new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' });
      dateFormatters.set(zone, f);
    }
    return f.format(t);
  }

  function formatUtcOffset(min) {
    if (min === 0) return 'UTC';
    const a = Math.abs(min);
    return 'UTC' + (min < 0 ? '−' : '+') + Math.floor(a / 60) + (a % 60 ? ':' + pad(a % 60) : '');
  }

  function formatRelative(min) {
    const a = Math.abs(min);
    const sign = min < 0 ? '−' : '+';
    const text = Math.floor(a / 60) + (a % 60 ? ':' + pad(a % 60) : '');
    return `${sign}${text} ${a === 60 ? 'HR' : 'HRS'}`;
  }

  // ---------------------------------------------------------------------------
  // The sun

  const norm180 = x => ((x % 360) + 540) % 360 - 180;

  // The point on Earth where the sun is directly overhead at instant t.
  function subsolarPoint(t) {
    const n = t / 86400000 - 10957.5; // days since J2000.0
    const L = 280.460 + 0.9856474 * n;
    const g = (357.528 + 0.9856003 * n) * RAD;
    const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
    const eps = (23.439 - 0.0000004 * n) * RAD;
    const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
    const gmst = 280.46061837 + 360.98564736629 * n;
    return { lat: decl / RAD, lon: norm180(ra / RAD - gmst) };
  }

  function sunElevation(lat, lon, sun) {
    const s = Math.sin(lat * RAD) * Math.sin(sun.lat * RAD) +
      Math.cos(lat * RAD) * Math.cos(sun.lat * RAD) * Math.cos((lon - sun.lon) * RAD);
    return Math.asin(s) / RAD;
  }

  function isDaytime(place, t) {
    if (place.lat == null) {
      const h = zoneParts(place.zone, t).h;
      return h >= 6 && h < 18;
    }
    return sunElevation(place.lat, place.lon, subsolarPoint(t)) > -0.833;
  }

  // Sunrise and sunset on the local calendar day containing instant t.
  // Each is an instant, or 'up'/'down' when the sun doesn't cross the horizon.
  const sunCache = new Map();
  function sunTimes(place, t) {
    const p = zoneParts(place.zone, t);
    const key = `${place.id}|${p.y}-${p.mo}-${p.d}`;
    if (sunCache.has(key)) return sunCache.get(key);

    let noon = wallToInstant(place.zone, { ...p, h: 12, mi: 0 });
    for (let i = 0; i < 3; i++) {
      noon += norm180(subsolarPoint(noon).lon - place.lon) / 15 * HOUR;
    }
    const sinH0 = Math.sin(-0.833 * RAD);
    const lat = place.lat * RAD;
    const crossing = dir => {
      let at = noon;
      for (let i = 0; i < 3; i++) {
        const decl = subsolarPoint(at).lat * RAD;
        const c = (sinH0 - Math.sin(lat) * Math.sin(decl)) / (Math.cos(lat) * Math.cos(decl));
        if (c > 1) return 'down';
        if (c < -1) return 'up';
        at = noon + dir * Math.acos(c) / RAD / 15 * HOUR;
      }
      return at;
    };
    const result = { rise: crossing(-1), set: crossing(1) };
    if (sunCache.size > 500) sunCache.clear();
    sunCache.set(key, result);
    return result;
  }

  // SVG path (map coordinates: x = lon + 180, y = 90 - lat) covering the night side.
  function nightPaths(t) {
    const sun = subsolarPoint(t);
    let decl = sun.lat;
    if (Math.abs(decl) < 0.05) decl = decl < 0 ? -0.05 : 0.05;
    const tanD = Math.tan(decl * RAD);
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 1) {
      const lat = Math.atan(-Math.cos((lon - sun.lon) * RAD) / tanD) / RAD;
      pts.push(`${lon + 180} ${(90 - lat).toFixed(2)}`);
    }
    const line = 'M' + pts.join('L');
    // When the north pole is lit, night is the region south of the line.
    const edgeY = decl > 0 ? 190 : -10;
    return { line, area: `${line}L360 ${edgeY}L0 ${edgeY}Z` };
  }

  // ---------------------------------------------------------------------------
  // Converter helpers

  const sourcePlace = () =>
    sourceId === 'local' ? LOCAL_PLACE : (BY_ID.get(sourceId) && selected.includes(sourceId) ? BY_ID.get(sourceId) : linkedSource || LOCAL_PLACE);

  const currentInstant = () => mode === 'live' ? Date.now() : wallToInstant(sourcePlace().zone, wall);

  function setFixed(newWall) {
    mode = 'fixed';
    wall = newWall;
    writeHash();
    renderAll();
  }

  function setLive() {
    mode = 'live';
    wall = null;
    linkedSource = null;
    writeHash();
    renderAll();
  }

  function writeHash() {
    let hash = '';
    if (mode === 'fixed') {
      const src = sourcePlace();
      const z = src.id === 'local' ? LOCAL_ZONE : src.id;
      const w = wall;
      hash = '#' + new URLSearchParams({
        t: `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`, z,
      }).toString();
    }
    if (location.hash !== hash) {
      history.replaceState(null, '', hash || location.pathname + location.search);
    }
  }

  function readHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(params.get('t') || '');
    if (!m) return false;
    const z = params.get('z') || LOCAL_ZONE;
    let place = BY_ID.get(z);
    if (!place && zoneSupported(z)) place = placeForZone(z);
    if (!place) return false;
    if (place.zone === LOCAL_ZONE && (z === LOCAL_ZONE || !selected.includes(z))) {
      sourceId = 'local';
      linkedSource = null;
    } else {
      sourceId = place.id;
      linkedSource = selected.includes(place.id) ? null : place;
    }
    mode = 'fixed';
    wall = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
    return true;
  }

  // ---------------------------------------------------------------------------
  // DOM

  const $ = id => document.getElementById(id);
  const els = {
    map: $('map'), land: $('land'), meridians: $('meridians'), night: $('night'),
    terminator: $('terminator'), pins: $('pins'), cards: $('cards'), empty: $('empty'),
    status: $('status'), statusText: $('status-text'),
    time: $('conv-time'), date: $('conv-date'), zone: $('conv-zone'), now: $('conv-now'),
    fmt12: $('fmt-12'), fmt24: $('fmt-24'), add: $('add-btn'),
    dialog: $('add-dialog'), search: $('search'), results: $('results'), dialogClose: $('dialog-close'),
  };

  function svgEl(tag, attrs, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  // Static map layers.
  els.land.setAttribute('d', window.WT_LAND);
  for (let x = 30; x < 360; x += 30) svgEl('line', { x1: x, x2: x, y1: 0, y2: 180 }, els.meridians);

  function buildClock() {
    const svg = svgEl('svg', { class: 'clock', viewBox: '-50 -50 100 100', 'aria-hidden': 'true' });
    svgEl('circle', { class: 'face', r: 49 }, svg);
    for (let i = 1; i <= 12; i++) {
      const a = i * 30 * RAD;
      const num = svgEl('text', { class: 'num', x: (38 * Math.sin(a)).toFixed(2), y: (-38 * Math.cos(a)).toFixed(2) }, svg);
      num.textContent = i;
    }
    const hour = svgEl('line', { class: 'hand', x1: 0, y1: 0, x2: 0, y2: -23, 'stroke-width': 3.6 }, svg);
    const minute = svgEl('line', { class: 'hand', x1: 0, y1: 0, x2: 0, y2: -35, 'stroke-width': 2.4 }, svg);
    svgEl('circle', { class: 'hub', r: 2.8 }, svg);
    const sec = svgEl('g', {}, svg);
    svgEl('line', { class: 'sec', x1: 0, y1: 10, x2: 0, y2: -42 }, sec);
    svgEl('circle', { class: 'sec-hub', r: 1.6 }, sec);
    return { svg, hour, minute, sec };
  }

  const cards = new Map(); // place id -> card refs

  function buildCard(place) {
    const card = el('article', 'card');
    const clock = buildClock();
    card.appendChild(clock.svg);
    const title = el('div', 'card-title');
    const date = el('div', 'card-date');
    const line = el('div', 'card-line');
    const rise = el('div', 'card-line');
    const set = el('div', 'card-line');
    const remove = el('button', 'card-remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${place.name}`);
    remove.title = 'Remove';
    remove.addEventListener('click', () => removePlace(place.id));
    card.append(title, date, line, rise, set, remove);
    return { card, clock, title, date, line, rise, set };
  }

  function updateHands(refs, place, t) {
    const p = zoneParts(place.zone, t);
    const sec = mode === 'live' ? p.s : 0;
    refs.clock.hour.setAttribute('transform', `rotate(${(p.h % 12 + p.mi / 60 + sec / 3600) * 30})`);
    refs.clock.minute.setAttribute('transform', `rotate(${(p.mi + sec / 60) * 6})`);
    refs.clock.sec.setAttribute('transform', `rotate(${sec * 6})`);
    refs.clock.sec.classList.toggle('hide', mode !== 'live');
  }

  function updateCard(refs, place, t, ref) {
    updateHands(refs, place, t);
    refs.clock.svg.classList.toggle('night', !isDaytime(place, t));

    const p = zoneParts(place.zone, t);
    const rp = zoneParts(ref.zone, t);
    const dd = dayNumber(p) - dayNumber(rp);
    const dayWord = dd === 0 ? 'Today' : dd === 1 ? 'Tomorrow' : dd === -1 ? 'Yesterday' : formatDate(place.zone, t);
    const rel = offsetMinutes(place.zone, t) - offsetMinutes(ref.zone, t);

    refs.title.textContent = `${place.name}, ${formatTime(place.zone, t)}`;
    refs.date.textContent = mode === 'fixed' ? formatDate(place.zone, t) : '';
    refs.date.hidden = mode !== 'fixed';
    refs.line.textContent = `${dayWord}, ${formatRelative(rel)}`;
    refs.card.title = `${place.zone} (${formatUtcOffset(offsetMinutes(place.zone, t))})`;

    if (place.lat == null) {
      refs.rise.textContent = formatUtcOffset(offsetMinutes(place.zone, t));
      refs.set.textContent = '';
      return;
    }
    const s = sunTimes(place, t);
    if (s.rise === 'up' || s.set === 'up') {
      refs.rise.textContent = 'Sun up all day';
      refs.set.textContent = '';
    } else if (s.rise === 'down' || s.set === 'down') {
      refs.rise.textContent = 'Sun down all day';
      refs.set.textContent = '';
    } else {
      refs.rise.textContent = `Sunrise: ${formatTime(place.zone, s.rise)}`;
      refs.set.textContent = `Sunset: ${formatTime(place.zone, s.set)}`;
    }
  }

  function sortedPlaces(t) {
    return selected.map(id => BY_ID.get(id)).map(p => ({ p, o: offsetMinutes(p.zone, t) }))
      .sort((a, b) => a.o - b.o || (a.p.lon ?? 0) - (b.p.lon ?? 0) || a.p.name.localeCompare(b.p.name))
      .map(x => x.p);
  }

  let lastRenderedMinute = null;

  function renderAll() {
    const t = currentInstant();
    lastRenderedMinute = Math.floor(t / 60000);
    const places = sortedPlaces(t);
    const ref = mode === 'live' ? LOCAL_PLACE : sourcePlace();

    // Cards, in offset order. Only move nodes that are out of place, so focus survives.
    for (const [id, refs] of cards) {
      if (!selected.includes(id)) { refs.card.remove(); cards.delete(id); }
    }
    places.forEach((place, i) => {
      let refs = cards.get(place.id);
      if (!refs) { refs = buildCard(place); cards.set(place.id, refs); }
      if (els.cards.children[i] !== refs.card) els.cards.insertBefore(refs.card, els.cards.children[i] || null);
      updateCard(refs, place, t, ref);
    });
    els.empty.hidden = places.length > 0;

    renderMap(places, t);
    renderConverter(t);
  }

  function tickHands() {
    const t = Date.now();
    for (const id of selected) {
      const refs = cards.get(id);
      if (refs) updateHands(refs, BY_ID.get(id), t);
    }
  }

  // ---------------------------------------------------------------------------
  // Map

  const MAP_TOP = 6, MAP_HEIGHT = 150; // viewBox rows, in degrees of latitude

  function renderMap(places, t) {
    const { line, area } = nightPaths(t);
    els.night.setAttribute('d', area);
    els.terminator.setAttribute('d', line);

    els.pins.textContent = '';
    for (const place of places) {
      if (place.lat == null) continue;
      const pin = el('div', 'pin');
      const y = Math.min(Math.max((90 - place.lat - MAP_TOP) / MAP_HEIGHT, 0.01), 0.99);
      pin.style.left = `${(place.lon + 180) / 360 * 100}%`;
      pin.style.top = `${y * 100}%`;
      pin.append(el('span', 'pin-dot'));
      const label = el('span', 'pin-label');
      label.append(el('b', '', place.name), el('span', '', formatTime(place.zone, t)));
      pin.append(label);
      els.pins.append(pin);
    }
    layoutLabels();
  }

  // Put each label beside its dot, choosing the side that overlaps least.
  function layoutLabels() {
    const W = els.pins.clientWidth, H = els.pins.clientHeight;
    if (!W) return;
    const pins = [...els.pins.children].map(pin => ({
      pin,
      label: pin.lastChild,
      x: parseFloat(pin.style.left) / 100 * W,
      y: parseFloat(pin.style.top) / 100 * H,
    }));
    const dot = W < 600 ? 4 : 5;
    const taken = pins.map(p => ({ x: p.x - dot, y: p.y - dot, w: dot * 2, h: dot * 2 }));
    const overlap = (a, b) =>
      Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

    for (const p of pins) {
      const w = p.label.offsetWidth, h = p.label.offsetHeight;
      const lineH = h / 2;
      const gap = dot + 3;
      const candidates = [
        [gap, -lineH / 2, false], [-gap - w, -lineH / 2, true],
        [gap, dot, false], [-gap - w, dot, true],
        [gap, -h - dot + 2, false], [-gap - w, -h - dot + 2, true],
      ];
      let best = null;
      for (const [dx, dy, left] of candidates) {
        const r = { x: p.x + dx, y: p.y + dy, w, h };
        let score = taken.reduce((s, o) => s + overlap(r, o), 0);
        const inside = overlap(r, { x: 0, y: 0, w: W, h: H });
        score += (w * h - inside) * 2;
        if (!best || score < best.score) best = { score, dx, dy, left, r };
        if (score === 0) break;
      }
      p.label.style.left = `${best.dx}px`;
      p.label.style.top = `${best.dy}px`;
      p.label.classList.toggle('left', best.left);
      taken.push(best.r);
    }
  }

  new ResizeObserver(layoutLabels).observe(els.map);

  // ---------------------------------------------------------------------------
  // Converter controls

  let zoneOptionsKey = '';

  function renderConverter(t) {
    const options = [LOCAL_PLACE, ...sortedPlaces(t)];
    if (linkedSource && !selected.includes(linkedSource.id)) options.push(linkedSource);
    const key = options.map(p => p.id).join(',');
    if (key !== zoneOptionsKey) {
      zoneOptionsKey = key;
      els.zone.textContent = '';
      for (const p of options) {
        const o = el('option', '', p.id === 'local' ? `Local time (${p.name})` : p.name);
        o.value = p.id;
        els.zone.append(o);
      }
    }
    const src = sourcePlace();
    els.zone.value = src.id;

    const p = mode === 'live' ? zoneParts(src.zone, t) : wall;
    const timeValue = `${pad(p.h)}:${pad(p.mi)}`;
    const dateValue = `${String(p.y).padStart(4, '0')}-${pad(p.mo)}-${pad(p.d)}`;
    // Don't overwrite a field while someone is typing in it.
    if (document.activeElement !== els.time && els.time.value !== timeValue) els.time.value = timeValue;
    if (document.activeElement !== els.date && els.date.value !== dateValue) els.date.value = dateValue;

    els.status.className = 'status ' + mode;
    els.statusText.textContent = mode === 'live' ? 'Live' : 'Chosen time';
    els.now.hidden = mode === 'live';
  }

  function onConverterInput() {
    const tm = /^(\d{2}):(\d{2})/.exec(els.time.value);
    if (!tm) return;
    const src = sourcePlace();
    let date;
    const dm = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(els.date.value);
    if (dm) {
      date = { y: +dm[1], mo: +dm[2], d: +dm[3] };
    } else {
      const today = zoneParts(src.zone, Date.now());
      date = { y: today.y, mo: today.mo, d: today.d };
    }
    setFixed({ ...date, h: +tm[1], mi: +tm[2] });
  }

  els.time.addEventListener('input', onConverterInput);
  els.date.addEventListener('input', onConverterInput);
  els.date.addEventListener('change', onConverterInput);
  els.time.addEventListener('blur', () => renderAll());
  els.date.addEventListener('blur', () => renderAll());
  els.zone.addEventListener('change', () => {
    // Keep the typed wall-clock time; read it in the newly chosen zone.
    sourceId = els.zone.value;
    if (sourceId !== (linkedSource && linkedSource.id)) linkedSource = null;
    if (mode === 'fixed') writeHash();
    renderAll();
  });
  els.now.addEventListener('click', setLive);

  // ---------------------------------------------------------------------------
  // 12/24 hour toggle

  function renderFormatToggle() {
    els.fmt12.setAttribute('aria-pressed', String(hour12));
    els.fmt24.setAttribute('aria-pressed', String(!hour12));
  }
  function setHour12(v) {
    hour12 = v;
    store.set(KEY_HOUR12, v);
    renderFormatToggle();
    renderAll();
  }
  els.fmt12.addEventListener('click', () => setHour12(true));
  els.fmt24.addEventListener('click', () => setHour12(false));

  // ---------------------------------------------------------------------------
  // Adding and removing places

  function saveSelection() { store.set(KEY_PLACES, selected); }

  function addPlace(id) {
    if (selected.includes(id)) return;
    selected.push(id);
    if (linkedSource && linkedSource.id === id) linkedSource = null;
    saveSelection();
    renderAll();
  }

  function removePlace(id) {
    if (sourceId === id) {
      // Keep showing the same moment, now described in local time.
      if (mode === 'fixed') {
        const t = currentInstant();
        const p = zoneParts(LOCAL_ZONE, t);
        wall = { y: p.y, mo: p.mo, d: p.d, h: p.h, mi: p.mi };
      }
      sourceId = 'local';
      if (mode === 'fixed') writeHash();
    }
    selected = selected.filter(x => x !== id);
    saveSelection();
    renderAll();
  }

  const ALIASES = {
    GB: 'uk united kingdom britain great britain england scotland wales northern ireland',
    US: 'usa us united states america',
    AE: 'uae emirates',
    KR: 'south korea',
    KP: 'north korea',
    NL: 'holland netherlands',
    CZ: 'czech republic czechia',
    RU: 'russia',
    CN: 'china prc',
    TW: 'taiwan',
  };
  const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  let searchIndex = null;
  function buildSearchIndex() {
    const regionNames = [];
    for (const loc of [undefined, 'en']) {
      try { regionNames.push(new Intl.DisplayNames(loc, { type: 'region' })); } catch { /* unsupported */ }
    }
    const zoneNames = new Map();
    const y = new Date().getUTCFullYear();
    const samples = [Date.UTC(y, 0, 15), Date.UTC(y, 6, 15)];
    const zoneText = zone => {
      if (!zoneNames.has(zone)) {
        const words = [zone.replace(/[_/]/g, ' ')];
        for (const style of ['long', 'short']) {
          try {
            const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: style });
            for (const s of samples) {
              const part = f.formatToParts(s).find(x => x.type === 'timeZoneName');
              if (part) words.push(part.value);
            }
          } catch { /* unsupported */ }
        }
        if (zone === 'UTC') words.push('gmt zulu coordinated universal time');
        zoneNames.set(zone, words.join(' '));
      }
      return zoneNames.get(zone);
    };
    searchIndex = PLACES.map(p => {
      const country = p.cc ? regionNames.map(r => { try { return r.of(p.cc); } catch { return ''; } }) : [];
      return {
        place: p,
        name: fold(p.name),
        text: fold([p.name, country.join(' '), ALIASES[p.cc] || '', p.cc, zoneText(p.zone)].join(' ')),
        country: country[0] || '',
      };
    });
  }

  function renderResults() {
    if (!searchIndex) buildSearchIndex();
    const q = fold(els.search.value.trim());
    const tokens = q.split(/\s+/).filter(Boolean);
    const rank = e => {
      if (!q) return 0;
      if (e.name.startsWith(q)) return 0;
      if (e.name.split(/[\s,-]+/).some(w => w.startsWith(q))) return 1;
      if (e.name.includes(q)) return 2;
      return 3;
    };
    const matches = searchIndex
      .filter(e => tokens.every(tok => e.text.includes(tok)))
      .map(e => ({ e, r: rank(e) }))
      // Ties go to each zone's principal city (e.g. "japan" lists Tokyo before Kyoto).
      .sort((a, b) => a.r - b.r ||
        (b.e.place.id === b.e.place.zone) - (a.e.place.id === a.e.place.zone) ||
        a.e.place.name.localeCompare(b.e.place.name))
      .slice(0, 200);

    els.results.textContent = '';
    if (!matches.length) {
      els.results.append(el('li', 'r-none', 'No matches'));
      return;
    }
    const t = Date.now();
    for (const { e } of matches) {
      const p = e.place;
      const li = el('li');
      const btn = el('button');
      btn.type = 'button';
      const main = el('span', 'r-main');
      main.append(el('span', 'r-name', p.name));
      const added = selected.includes(p.id);
      const sub = [e.country, p.zone.replace(/_/g, ' ')].filter(Boolean).join(' · ');
      main.append(el('span', 'r-sub', added ? `Added · ${sub}` : sub));
      btn.append(main, el('span', 'r-time', `${formatTime(p.zone, t)} · ${formatUtcOffset(offsetMinutes(p.zone, t))}`));
      btn.disabled = added;
      btn.addEventListener('click', () => {
        addPlace(p.id);
        els.dialog.close();
      });
      li.append(btn);
      els.results.append(li);
    }
  }

  els.add.addEventListener('click', () => {
    els.search.value = '';
    renderResults();
    els.dialog.showModal();
    els.search.focus();
  });
  els.search.addEventListener('input', renderResults);
  els.search.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      // A search field would otherwise just clear itself on the first Escape.
      ev.preventDefault();
      els.dialog.close();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const first = els.results.querySelector('button:not([disabled])');
      if (first) first.click();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      const first = els.results.querySelector('button:not([disabled])');
      if (first) first.focus();
    }
  });
  els.results.addEventListener('keydown', ev => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const buttons = [...els.results.querySelectorAll('button:not([disabled])')];
    const i = buttons.indexOf(document.activeElement);
    const next = ev.key === 'ArrowDown' ? buttons[i + 1] : buttons[i - 1];
    if (next) next.focus(); else if (ev.key === 'ArrowUp') els.search.focus();
  });
  els.dialogClose.addEventListener('click', () => els.dialog.close());
  els.dialog.addEventListener('click', ev => { if (ev.target === els.dialog) els.dialog.close(); });

  // ---------------------------------------------------------------------------
  // Start

  window.addEventListener('hashchange', () => {
    if (readHash()) renderAll(); else if (mode === 'fixed') setLive();
  });
  window.addEventListener('storage', ev => {
    if (ev.key !== KEY_PLACES) return;
    const next = store.get(KEY_PLACES, selected);
    if (Array.isArray(next)) { selected = [...new Set(next.filter(id => BY_ID.has(id)))]; renderAll(); }
  });

  readHash();
  renderFormatToggle();
  renderAll();

  function tick() {
    if (mode === 'live') {
      if (Math.floor(Date.now() / 60000) !== lastRenderedMinute) renderAll(); else tickHands();
    }
    setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
  }
  tick();
})();
