const https = require('https');

const FA_KEY    = 'rdqRteiLRjx3W113fMI6dLux7JzAHWeU';
const ADMIN_KEY = 'AGS2026admin';
const SB_URL    = 'udcriobsizpalijmwoxr.supabase.co';
const SB_KEY    = 'sb_secret_1Ih1D7T0GuHt-MkMNhjXkQ_KfxKGuPG';

// ── Supabase ─────────────────────────────────────────────────────
function sbRequest(method, path, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: SB_URL,
      path: '/rest/v1/' + path,
      method,
      headers: {
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      }
    };
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(opts, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(b) }); }
        catch(e) { resolve({ statusCode: res.statusCode, data: [] }); }
      });
    });
    req.on('error', () => resolve({ statusCode: 500, data: [] }));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Flight key: FLIGHTCODE_FROM_TO e.g. ZL6852_SYD_DBO ──────────
function makeFlightKey(code, from, to) {
  if (from && to) return `${code}_${from}_${to}`;
  return code;
}

function parseFlightKey(raw) {
  const str = (raw || '').toUpperCase();
  // Match FLIGHTCODE_FROM_TO e.g. ZL6852_SYD_DBO
  const m = str.match(/^([A-Z0-9]+)_([A-Z]{3})_([A-Z]{3})$/);
  if (m) return { code: m[1], from: m[2], to: m[3] };
  // Legacy date key fallback
  const m2 = str.match(/^([A-Z0-9]+)_(\d{4}-\d{2}-\d{2})$/);
  if (m2) return { code: m2[1], from: '', to: '', date: m2[2] };
  return { code: str, from: '', to: '', date: '' };
}

function routeFilter(code, from, to) {
  let f = `flight_code=eq.${encodeURIComponent(code)}`;
  if (from) f += `&route_from=eq.${encodeURIComponent(from)}`;
  if (to)   f += `&route_to=eq.${encodeURIComponent(to)}`;
  return f;
}

// ── DB helpers ───────────────────────────────────────────────────
async function getEntries(code, from, to) {
  const r = await sbRequest('GET', `entries?${routeFilter(code, from, to)}&order=created_at.asc&select=id,flight_code,flight_date,route_from,route_to,seat,dep_time,arr_time,mobile,created_at`);
  return Array.isArray(r.data) ? r.data : [];
}

async function getAllEntries() {
  const r = await sbRequest('GET', 'entries?order=created_at.asc&select=id,flight_code,flight_date,route_from,route_to,seat,dep_time,arr_time,mobile,created_at');
  return Array.isArray(r.data) ? r.data : [];
}

async function getAllBPFlags() {
  const r = await sbRequest('GET', 'entries?select=flight_code,route_from,route_to,dep_time,arr_time,boarding_pass');
  const rows = Array.isArray(r.data) ? r.data : [];
  const flags = {};
  rows.forEach(e => {
    const fk = makeFlightKey(e.flight_code, e.route_from, e.route_to);
    if (!flags[fk]) flags[fk] = {};
    flags[fk][`${e.dep_time}|${e.arr_time}`] = !!e.boarding_pass;
  });
  return flags;
}

async function insertEntry(entry) {
  return sbRequest('POST', 'entries', entry);
}

async function updateEntry(code, from, to, depTime, arrTime, updates) {
  const path = `entries?${routeFilter(code, from, to)}&dep_time=eq.${encodeURIComponent(depTime)}&arr_time=eq.${encodeURIComponent(arrTime)}`;
  return sbRequest('PATCH', path, updates);
}

async function deleteEntryDB(code, from, to, depTime, arrTime) {
  const path = `entries?${routeFilter(code, from, to)}&dep_time=eq.${encodeURIComponent(depTime)}&arr_time=eq.${encodeURIComponent(arrTime)}`;
  return sbRequest('DELETE', path, null);
}

async function getActuals(code, from, to) {
  const r = await sbRequest('GET', `actuals?${routeFilter(code, from, to)}`);
  return Array.isArray(r.data) && r.data.length ? r.data[0] : null;
}

async function upsertActuals(code, from, to, date, actualDep, actualArr) {
  await sbRequest('DELETE', `actuals?${routeFilter(code, from, to)}`, null);
  return sbRequest('POST', 'actuals', {
    flight_code: code,
    flight_date: date || '',
    route_from:  from || '',
    route_to:    to   || '',
    actual_dep:  actualDep || null,
    actual_arr:  actualArr || null,
    updated_at:  new Date().toISOString()
  });
}

async function getWinner(code, from, to) {
  const r = await sbRequest('GET', `winners?${routeFilter(code, from, to)}`);
  return Array.isArray(r.data) && r.data.length ? r.data[0] : null;
}

async function getAllWinners() {
  const r = await sbRequest('GET', 'winners?order=published_at.desc');
  return Array.isArray(r.data) ? r.data : [];
}

async function upsertWinner(code, from, to, date, winnerData) {
  await sbRequest('DELETE', `winners?${routeFilter(code, from, to)}`, null);
  return sbRequest('POST', 'winners', {
    flight_code: code,
    flight_date: date || '',
    route_from:  from || '',
    route_to:    to   || '',
    ...winnerData
  });
}

// Exact match only — dep AND arr must be exactly right
async function maybeAwardWinner(code, from, to, date, depTime, arrTime, routeFromCity, routeToCity, schedDep, schedArr) {
  const alreadyWon = await getWinner(code, from, to);
  if (alreadyWon) return alreadyWon;
  const entries = await getEntries(code, from, to);
  if (!entries.length) return null;
  const scored = scoreEntries(entries, depTime, arrTime);
  if (!scored.length || scored[0].score === null) return null;

  const exactWinner = scored.find(e => e.depDiff === 0 && e.arrDiff === 0);

  await upsertWinner(code, from, to, date, {
    winner_seat:     exactWinner ? exactWinner.seat : 'NO_WINNER',
    winner_dep:      exactWinner ? exactWinner.dep_time : null,
    winner_arr:      exactWinner ? exactWinner.arr_time : null,
    winner_score:    exactWinner ? 0 : null,
    actual_dep:      depTime,
    actual_arr:      arrTime,
    all_scores:      JSON.stringify(scored.map(({ boarding_pass, ...s }) => s)),
    published_at:    new Date().toISOString(),
    auto_awarded:    true,
    cancelled:       false,
    route_from_city: routeFromCity || '',
    route_to_city:   routeToCity   || '',
    scheduled_dep:   schedDep || '',
    scheduled_arr:   schedArr || '',
    fa_flight_id:    ''
  });

  if (exactWinner) {
    console.log(`EXACT WINNER: ${code} ${from}-${to}: Seat ${exactWinner.seat}`);
  } else {
    console.log(`No exact winner: ${code} ${from}-${to}`);
  }
  return exactWinner || null;
}

// ── FlightAware ──────────────────────────────────────────────────
function fetchFA(faPath) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'aeroapi.flightaware.com',
      path: faPath,
      headers: { 'x-apikey': FA_KEY }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', () => resolve({ statusCode: 500, body: '{}' }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ statusCode: 504, body: '{}' }); });
  });
}

function toLocalTime(iso, offsetHours) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const local = new Date(d.getTime() + offsetHours * 3600000);
  return `${String(local.getUTCHours()).padStart(2,'0')}:${String(local.getUTCMinutes()).padStart(2,'0')}`;
}

function toLocalDate(iso, offsetHours) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const local = new Date(d.getTime() + offsetHours * 3600000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth()+1).padStart(2,'0')}-${String(local.getUTCDate()).padStart(2,'0')}`;
}

function tzOffset(ianaZone) {
  try {
    const now = new Date();
    const fmt = (tz) => now.toLocaleString('en-AU', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
    const [uh, um] = fmt('UTC').split(':').map(Number);
    const [lh, lm] = fmt(ianaZone).split(':').map(Number);
    let diff = (lh * 60 + lm) - (uh * 60 + um);
    if (diff < -720) diff += 1440;
    if (diff >  720) diff -= 1440;
    return diff / 60;
  } catch(e) { return 10; }
}

function timeToMins(t) {
  if (!t) return null;
  const clean = t.replace(/^[<>]\s*/, '');
  const parts = clean.split(':').map(Number);
  if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
  return parts[0] * 60 + parts[1];
}

function flightStatus(fl) {
  const status = (fl.status || '').toLowerCase();
  let state = 'scheduled';
  if (status.includes('cancel')) {
    state = 'cancelled';
  } else if (!!fl.actual_in || status.includes('arrived') || status.includes('gate arrival')) {
    state = 'arrived';
  } else if (
    !!fl.actual_out || !!fl.actual_off ||
    status.includes('departed') || status.includes('en route') ||
    status.includes('active') || status.includes('taxiing') ||
    status.includes('airborne') || fl.progress_percent > 0
  ) { state = 'departed'; }

  const depTz  = tzOffset(fl.origin?.timezone      || 'Australia/Brisbane');
  const arrTz  = tzOffset(fl.destination?.timezone  || 'Australia/Brisbane');
  const depIso = fl.scheduled_out || fl.scheduled_off || fl.actual_out || fl.actual_off;

  return {
    state,
    status:        fl.status || '',
    fa_flight_id:  fl.fa_flight_id || '',
    flight_date:   toLocalDate(depIso, depTz),
    actual_dep:    toLocalTime(fl.actual_out || fl.actual_off, depTz),
    actual_arr:    toLocalTime(fl.actual_in, arrTz),
    scheduled_dep: toLocalTime(fl.scheduled_out || fl.scheduled_off, depTz),
    scheduled_arr: toLocalTime(fl.scheduled_in  || fl.scheduled_on,  arrTz),
    estimated_dep: toLocalTime(fl.estimated_out || fl.estimated_off, depTz),
    estimated_arr: toLocalTime(fl.estimated_in  || fl.estimated_on,  arrTz),
  };
}

function getBestFlight(flights, fromCode, toCode) {
  const now = new Date();

  // If from/to specified, filter to exact route first
  let pool = flights;
  if (fromCode && toCode) {
    const exact = flights.filter(f =>
      (f.origin?.code_iata || f.origin?.code || '').toUpperCase() === fromCode &&
      (f.destination?.code_iata || f.destination?.code || '').toUpperCase() === toCode
    );
    if (exact.length) pool = exact;
  }

  // 1. In-progress
  let fl = pool.find(f => (f.progress_percent || 0) > 0 && f.progress_percent < 100);
  if (fl) return fl;

  // 2. Next upcoming (prefer future over past)
  const upcoming = pool.filter(f => {
    const dep = f.scheduled_out || f.scheduled_off;
    if (!dep) return false;
    const diff = (new Date(dep).getTime() - now.getTime()) / 3600000;
    return diff > -0.5 && diff < 24;
  });
  if (upcoming.length) {
    upcoming.sort((a, b) =>
      new Date(a.scheduled_out || a.scheduled_off) - new Date(b.scheduled_out || b.scheduled_off)
    );
    return upcoming[0];
  }

  // 3. Most recently completed
  const recent = pool.filter(f => {
    const dep = f.scheduled_out || f.scheduled_off;
    if (!dep) return false;
    const diff = (new Date(dep).getTime() - now.getTime()) / 3600000;
    return diff > -4 && diff <= -0.5;
  });
  if (recent.length) {
    recent.sort((a, b) =>
      new Date(b.scheduled_out || b.scheduled_off) - new Date(a.scheduled_out || a.scheduled_off)
    );
    return recent[0];
  }

  return pool[0] || flights[0];
}

function scoreEntries(entries, actualDep, actualArr) {
  const adm = timeToMins(actualDep);
  const aam = timeToMins(actualArr);
  return entries.map(e => {
    const dm      = timeToMins(e.dep_time);
    const am      = timeToMins(e.arr_time);
    const depDiff = (adm !== null && dm !== null) ? Math.abs(dm - adm) : null;
    const arrDiff = (aam !== null && am !== null) ? Math.abs(am - aam) : null;
    const score   = (depDiff !== null && arrDiff !== null) ? depDiff + arrDiff : null;
    return { ...e, depDiff, arrDiff, score };
  }).sort((a, b) => (a.score ?? 9999) - (b.score ?? 9999));
}

function winnerResponse(w) {
  if (!w) return { announced: false };
  if (w.winner_seat === 'CANCELLED' || w.cancelled) return { announced: true, cancelled: true };
  if (w.winner_seat === 'NO_WINNER') return {
    announced: true, cancelled: false, noWinner: true,
    actualDep: w.actual_dep, actualArr: w.actual_arr,
    allScores: JSON.parse(w.all_scores || '[]'), publishedAt: w.published_at
  };
  return {
    announced: true, cancelled: false, noWinner: false,
    winner: {
      winner:    { seat: w.winner_seat, dep: w.winner_dep, arr: w.winner_arr, score: w.winner_score },
      actualDep: w.actual_dep, actualArr: w.actual_arr,
      allScores: JSON.parse(w.all_scores || '[]'), publishedAt: w.published_at
    }
  };
}

const respond = (s, h, o) => ({ statusCode: s, headers: h, body: JSON.stringify(o) });

// ── Handler ──────────────────────────────────────────────────────
exports.handler = async (event) => {
  const H = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H, body: '' };

  const method = event.httpMethod;
  let p = '';
  try { p = new URL(event.rawUrl || event.path, 'https://x.x').pathname; } catch(e) { p = event.path || ''; }
  p = p.replace('/.netlify/functions/api', '');
  if (!p.startsWith('/')) p = '/' + p;

  // ── GET /flight/:key ──────────────────────────────────────────
  const flightMatch = p.match(/^\/flight\/([A-Z0-9_-]+)$/i);
  if (flightMatch && method === 'GET') {
    const { code, from, to } = parseFlightKey(flightMatch[1]);
    const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(code)}?max_pages=1`);
    if (fa.statusCode !== 200) return respond(fa.statusCode, H, { error: `FlightAware error ${fa.statusCode}` });
    const data = JSON.parse(fa.body);
    const flights = data.flights || [];
    if (!flights.length) return respond(404, H, { error: 'Flight not found — check the number' });
    const fl      = getBestFlight(flights, from, to);
    const info    = flightStatus(fl);
    const fromCode = fl.origin?.code_iata || fl.origin?.code || '';
    const toCode   = fl.destination?.code_iata || fl.destination?.code || '';
    const flightKey = makeFlightKey(code, fromCode, toCode);
    // Overlay locked actuals
    const actuals = await getActuals(code, fromCode, toCode);
    if (actuals?.actual_dep) info.actual_dep = actuals.actual_dep;
    if (actuals?.actual_arr) info.actual_arr = actuals.actual_arr;
    info.flight_date = info.flight_date || '';
    info.flight_key  = flightKey;
    return respond(200, H, {
      code,
      from: fromCode,
      to:   toCode,
      from_city: fl.origin?.city || '',
      to_city:   fl.destination?.city || '',
      ...info
    });
  }

  // ── GET /status/:key ─────────────────────────────────────────
  const statusMatch = p.match(/^\/status\/([A-Z0-9_-]+)$/i);
  if (statusMatch && method === 'GET') {
    const { code, from, to } = parseFlightKey(statusMatch[1]);
    const existing = await getActuals(code, from, to);

    const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(code)}?max_pages=1`);
    if (fa.statusCode !== 200) return respond(fa.statusCode, H, { error: 'FA error' });
    const data = JSON.parse(fa.body);
    const fl   = getBestFlight(data.flights || [], from, to);
    const info = flightStatus(fl);
    const fromCode = from || fl.origin?.code_iata || fl.origin?.code || '';
    const toCode   = to   || fl.destination?.code_iata || fl.destination?.code || '';
    const useDate  = info.flight_date || existing?.flight_date || '';

    const newDep = info.actual_dep || existing?.actual_dep || null;
    const newArr = info.actual_arr || existing?.actual_arr || null;

    if (newDep || newArr) {
      const hasNew = (newDep && !existing?.actual_dep) || (newArr && !existing?.actual_arr);
      if (hasNew) {
        await upsertActuals(code, fromCode, toCode, useDate, newDep, newArr);
      }
      if (newDep && newArr) {
        const depTz = tzOffset(fl.origin?.timezone || 'Australia/Brisbane');
        const arrTz = tzOffset(fl.destination?.timezone || 'Australia/Brisbane');
        await maybeAwardWinner(code, fromCode, toCode, useDate, newDep, newArr,
          fl.origin?.city || '', fl.destination?.city || '',
          toLocalTime(fl.scheduled_out || fl.scheduled_off, depTz) || '',
          toLocalTime(fl.scheduled_in  || fl.scheduled_on,  arrTz) || ''
        );
      }
    }

    return respond(200, H, {
      ...info,
      actual_dep: newDep,
      actual_arr: newArr,
      flight_key: makeFlightKey(code, fromCode, toCode)
    });
  }

  // ── GET /picks/:key ──────────────────────────────────────────
  const getPicksMatch = p.match(/^\/picks\/([A-Z0-9_-]+)$/i);
  if (getPicksMatch && method === 'GET') {
    const { code, from, to } = parseFlightKey(getPicksMatch[1]);
    const entries = await getEntries(code, from, to);
    const result = {};
    entries.forEach(e => { result[`${e.dep_time}|${e.arr_time}`] = e.seat; });
    return respond(200, H, result);
  }

  // ── GET /picks/:key/dep/:time ─────────────────────────────────
  const depPicksMatch = p.match(/^\/picks\/([A-Z0-9_-]+)\/dep\/(.+)$/i);
  if (depPicksMatch && method === 'GET') {
    const { code, from, to } = parseFlightKey(depPicksMatch[1]);
    const depTime = decodeURIComponent(depPicksMatch[2]);
    const entries = await getEntries(code, from, to);
    const taken   = {};
    entries.filter(e => e.dep_time === depTime).forEach(e => { taken[e.arr_time] = e.seat; });
    return respond(200, H, taken);
  }

  // ── POST /picks/:key ─────────────────────────────────────────
  const postPicksMatch = p.match(/^\/picks\/([A-Z0-9_-]+)$/i);
  if (postPicksMatch && method === 'POST') {
    const { code, from, to } = parseFlightKey(postPicksMatch[1]);
    const { dep, arr, seat, flight_date, from_city, to_city } = JSON.parse(event.body || '{}');
    if (!dep || !arr || !seat) return respond(400, H, { error: 'Need dep, arr, seat' });
    const existing = await getEntries(code, from, to);
    const taken    = existing.find(e => e.dep_time === dep && e.arr_time === arr);
    if (taken) return respond(409, H, { error: 'combo_taken', takenBy: taken.seat });
    const r = await insertEntry({
      flight_code: code,
      flight_date: flight_date || '',
      route_from:  from || '',
      route_to:    to   || '',
      seat, dep_time: dep, arr_time: arr,
      mobile: '', boarding_pass: null,
      created_at: new Date().toISOString()
    });
    if (r.statusCode !== 201) return respond(500, H, { error: 'Failed to save entry' });
    return respond(200, H, { ok: true });
  }

  // ── POST /picks/:key/update ───────────────────────────────────
  const updateMatch = p.match(/^\/picks\/([A-Z0-9_-]+)\/update$/i);
  if (updateMatch && method === 'POST') {
    const { code, from, to } = parseFlightKey(updateMatch[1]);
    const { dep, arr, mobile, boardingPass } = JSON.parse(event.body || '{}');
    await updateEntry(code, from, to, dep, arr, { mobile: mobile || '', boarding_pass: boardingPass || null });
    return respond(200, H, { ok: true });
  }

  // ── GET /winner/:key ─────────────────────────────────────────
  const winnerMatch = p.match(/^\/winner\/([A-Z0-9_-]+)$/i);
  if (winnerMatch && method === 'GET') {
    const { code, from, to } = parseFlightKey(winnerMatch[1]);
    const w = await getWinner(code, from, to);
    return respond(200, H, winnerResponse(w));
  }

  // ── GET /admin ────────────────────────────────────────────────
  const adminMatch = p.match(/^\/admin$/i);
  if (adminMatch && method === 'GET') {
    const qs = event.queryStringParameters || {};
    if (qs.key !== ADMIN_KEY) return respond(403, H, { error: 'Forbidden' });

    const [allEntries, allWinnerRows, allBPFlags] = await Promise.all([getAllEntries(), getAllWinners(), getAllBPFlags()]);
    const flights = {};
    allEntries.forEach(e => {
      const fk = makeFlightKey(e.flight_code, e.route_from, e.route_to);
      if (!flights[fk]) flights[fk] = [];
      const hasBP = !!(allBPFlags[fk] && allBPFlags[fk][`${e.dep_time}|${e.arr_time}`]);
      flights[fk].push({ ...e, has_boarding_pass: hasBP });
    });
    const winners = {};
    allWinnerRows.forEach(w => {
      const fk = makeFlightKey(w.flight_code, w.route_from, w.route_to);
      winners[fk] = {
        cancelled:     w.winner_seat === 'CANCELLED' || !!w.cancelled,
        noWinner:      w.winner_seat === 'NO_WINNER',
        winner:        { seat: w.winner_seat, dep: w.winner_dep, arr: w.winner_arr, score: w.winner_score },
        actualDep:     w.actual_dep,
        actualArr:     w.actual_arr,
        allScores:     JSON.parse(w.all_scores || '[]'),
        publishedAt:   w.published_at,
        flightDate:    w.flight_date,
        routeFrom:     w.route_from || '',
        routeTo:       w.route_to   || '',
        routeFromCity: w.route_from_city || '',
        routeToCity:   w.route_to_city   || '',
        scheduledDep:  w.scheduled_dep || '',
        scheduledArr:  w.scheduled_arr || ''
      };
    });
    return respond(200, H, { flights, winners });
  }

  // ── POST /admin/lock ──────────────────────────────────────────
  if (p === '/admin/lock' && method === 'POST') {
    const body = JSON.parse(event.body || '{}');
    if (body.key !== ADMIN_KEY) return respond(403, H, { error: 'Forbidden' });
    const { flight, actual_dep, actual_arr } = body;
    const { code, from, to } = parseFlightKey(flight);
    const existing = await getActuals(code, from, to);
    const newDep   = actual_dep || existing?.actual_dep || null;
    const newArr   = actual_arr || existing?.actual_arr || null;
    const useDate  = existing?.flight_date || '';
    await upsertActuals(code, from, to, useDate, newDep, newArr);
    let winnerSeat = null;
    if (newDep && newArr) {
      const w = await maybeAwardWinner(code, from, to, useDate, newDep, newArr, '', '', '', '');
      if (w) winnerSeat = w.seat;
    }
    return respond(200, H, { ok: true, actual_dep: newDep, actual_arr: newArr, winner: winnerSeat });
  }

  // ── POST /admin/cancel ────────────────────────────────────────
  if (p === '/admin/cancel' && method === 'POST') {
    const body = JSON.parse(event.body || '{}');
    if (body.key !== ADMIN_KEY) return respond(403, H, { error: 'Forbidden' });
    const { code, from, to } = parseFlightKey(body.flight || '');
    const existing = await getActuals(code, from, to);
    await upsertWinner(code, from, to, existing?.flight_date || '', {
      winner_seat: 'CANCELLED', winner_dep: null, winner_arr: null, winner_score: null,
      actual_dep: null, actual_arr: null, all_scores: '[]',
      published_at: new Date().toISOString(), auto_awarded: false, cancelled: true,
      route_from_city: '', route_to_city: '', scheduled_dep: '', scheduled_arr: '', fa_flight_id: ''
    });
    return respond(200, H, { ok: true });
  }

  // ── GET /admin/bp/:key/:dep/:arr ──────────────────────────────
  const bpMatch = p.match(/^\/admin\/bp\/([A-Z0-9_-]+)\/(.+)\/(.+)$/i);
  if (bpMatch && method === 'GET') {
    const qs = event.queryStringParameters || {};
    if (qs.key !== ADMIN_KEY) return respond(403, H, { error: 'Forbidden' });
    const { code, from, to } = parseFlightKey(bpMatch[1]);
    const dep = decodeURIComponent(bpMatch[2]);
    const arr = decodeURIComponent(bpMatch[3]);
    const r   = await sbRequest('GET', `entries?${routeFilter(code, from, to)}&dep_time=eq.${encodeURIComponent(dep)}&arr_time=eq.${encodeURIComponent(arr)}&select=boarding_pass`);
    const entry = Array.isArray(r.data) && r.data.length ? r.data[0] : null;
    return respond(200, H, { boarding_pass: entry?.boarding_pass || null });
  }

  // ── DELETE /admin/picks/:key/:combo ───────────────────────────
  const deleteMatch = p.match(/^\/admin\/picks\/([A-Z0-9_-]+)\/(.+)$/i);
  if (deleteMatch && method === 'DELETE') {
    const qs = event.queryStringParameters || {};
    if (qs.key !== ADMIN_KEY) return respond(403, H, { error: 'Forbidden' });
    const { code, from, to } = parseFlightKey(deleteMatch[1]);
    const [dep, arr] = decodeURIComponent(deleteMatch[2]).split('|');
    await deleteEntryDB(code, from, to, dep, arr);
    return respond(200, H, { ok: true });
  }

  // ── GET /results ──────────────────────────────────────────────
  if (p === '/results' && method === 'GET') {
    const allWinnerRows = await getAllWinners();
    const winners = allWinnerRows
      .filter(w => !w.cancelled && w.winner_seat && w.winner_seat !== 'NO_WINNER')
      .map(w => {
        let allScores = [];
        try { allScores = JSON.parse(w.all_scores || '[]').map(({ boarding_pass, ...s }) => s); } catch(e) {}
        return {
          flightCode:    w.flight_code,
          flightDate:    w.flight_date,
          routeFrom:     w.route_from || '',
          routeTo:       w.route_to   || '',
          routeFromCity: w.route_from_city || '',
          routeToCity:   w.route_to_city   || '',
          cancelled:     false,
          winner:        { seat: w.winner_seat, score: w.winner_score },
          actualDep:     w.actual_dep,
          actualArr:     w.actual_arr,
          allScores,
          publishedAt:   w.published_at
        };
      });
    return respond(200, H, { winners });
  }

  // ── GET /active ───────────────────────────────────────────────
  if (p === '/active' && method === 'GET') {
    const [allEntries, allWinnerRows] = await Promise.all([
      sbRequest('GET', 'entries?select=flight_code,flight_date,route_from,route_to,dep_time,arr_time,seat,created_at&order=created_at.asc'),
      sbRequest('GET', 'winners?select=flight_code,route_from,route_to')
    ]);
    const entries  = Array.isArray(allEntries.data)  ? allEntries.data  : [];
    const wonSet   = new Set(
      (Array.isArray(allWinnerRows.data) ? allWinnerRows.data : [])
        .map(w => makeFlightKey(w.flight_code, w.route_from, w.route_to))
    );
    const flights = {};
    entries.forEach(e => {
      const fk = makeFlightKey(e.flight_code, e.route_from, e.route_to);
      if (wonSet.has(fk)) return;
      if (!flights[fk]) flights[fk] = { code: e.flight_code, date: e.flight_date || '', from: e.route_from || '', to: e.route_to || '', picks: [] };
      flights[fk].picks.push({ seat: e.seat, dep: e.dep_time, arr: e.arr_time });
    });
    return respond(200, H, { flights: Object.values(flights) });
  }

  return respond(404, H, { error: 'Not found' });
};