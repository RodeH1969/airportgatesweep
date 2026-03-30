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
    req.on('error', (e) => resolve({ statusCode: 500, data: [] }));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Flight key helpers ───────────────────────────────────────────
function parseFlightKey(raw) {
  const str = (raw || '').toUpperCase();
  const m = str.match(/^([A-Z0-9]+)_(\d{4}-\d{2}-\d{2})$/);
  if (m) return { code: m[1], date: m[2] };
  return { code: str, date: '' };
}

function makeFlightKey(code, date) {
  return date ? `${code}_${date}` : code;
}

function codeFilter(code, date) {
  let f = `flight_code=eq.${encodeURIComponent(code)}`;
  if (date) f += `&flight_date=eq.${encodeURIComponent(date)}`;
  return f;
}

// ── DB helpers ───────────────────────────────────────────────────
async function getEntries(code, date) {
  const r = await sbRequest('GET', `entries?${codeFilter(code, date)}&order=created_at.asc&select=id,flight_code,flight_date,seat,dep_time,arr_time,mobile,created_at`);
  return Array.isArray(r.data) ? r.data : [];
}

async function getAllEntries() {
  const r = await sbRequest('GET', 'entries?order=created_at.asc&select=id,flight_code,flight_date,seat,dep_time,arr_time,mobile,created_at');
  return Array.isArray(r.data) ? r.data : [];
}

async function getBPFlags(code, date) {
  // Fetch only seat+dep+arr+whether boarding_pass is non-null - lightweight
  const r = await sbRequest('GET', `entries?${codeFilter(code, date)}&select=dep_time,arr_time,boarding_pass`);
  const rows = Array.isArray(r.data) ? r.data : [];
  const flags = {};
  rows.forEach(e => { flags[`${e.dep_time}|${e.arr_time}`] = !!e.boarding_pass; });
  return flags;
}

async function getAllBPFlags() {
  const r = await sbRequest('GET', 'entries?select=flight_code,flight_date,dep_time,arr_time,boarding_pass');
  const rows = Array.isArray(r.data) ? r.data : [];
  const flags = {};
  rows.forEach(e => {
    const fk = makeFlightKey(e.flight_code, e.flight_date);
    if (!flags[fk]) flags[fk] = {};
    flags[fk][`${e.dep_time}|${e.arr_time}`] = !!e.boarding_pass;
  });
  return flags;
}
async function insertEntry(entry) {
  return sbRequest('POST', 'entries', entry);
}

async function updateEntry(code, date, depTime, arrTime, updates) {
  const path = `entries?${codeFilter(code, date)}&dep_time=eq.${encodeURIComponent(depTime)}&arr_time=eq.${encodeURIComponent(arrTime)}`;
  return sbRequest('PATCH', path, updates);
}

async function deleteEntry(code, date, depTime, arrTime) {
  const path = `entries?${codeFilter(code, date)}&dep_time=eq.${encodeURIComponent(depTime)}&arr_time=eq.${encodeURIComponent(arrTime)}`;
  return sbRequest('DELETE', path, null);
}

async function getActuals(code, date) {
  const r = await sbRequest('GET', `actuals?${codeFilter(code, date)}`);
  return Array.isArray(r.data) && r.data.length ? r.data[0] : null;
}

async function upsertActuals(code, date, actualDep, actualArr) {
  await sbRequest('DELETE', `actuals?${codeFilter(code, date)}`, null);
  return sbRequest('POST', 'actuals', {
    flight_code: code,
    flight_date: date || '',
    actual_dep: actualDep || null,
    actual_arr: actualArr || null,
    updated_at: new Date().toISOString()
  });
}

async function getWinner(code, date) {
  const r = await sbRequest('GET', `winners?${codeFilter(code, date)}`);
  return Array.isArray(r.data) && r.data.length ? r.data[0] : null;
}

async function getAllWinners() {
  const r = await sbRequest('GET', 'winners?order=published_at.desc');
  return Array.isArray(r.data) ? r.data : [];
}

async function upsertWinner(code, date, winnerData) {
  await sbRequest('DELETE', `winners?${codeFilter(code, date)}`, null);
  return sbRequest('POST', 'winners', { flight_code: code, flight_date: date || '', ...winnerData });
}

// Auto-award winner when both actuals are available
async function maybeAwardWinner(code, date, depTime, arrTime) {
  const alreadyWon = await getWinner(code, date);
  if (alreadyWon) return alreadyWon; // already awarded
  const entries = await getEntries(code, date);
  if (!entries.length) return null;
  const scored = scoreEntries(entries, depTime, arrTime);
  const winner = scored[0];
  await upsertWinner(code, date, {
    winner_seat:  winner.seat,
    winner_dep:   winner.dep_time,
    winner_arr:   winner.arr_time,
    winner_score: winner.score,
    actual_dep:   depTime,
    actual_arr:   arrTime,
    all_scores:   JSON.stringify(scored.map(({ boarding_pass, ...s }) => s)),
    published_at: new Date().toISOString(),
    auto_awarded: true,
    cancelled:    false
  });
  console.log(`Winner awarded ${code} ${date}: Seat ${winner.seat} score ${winner.score}`);
  return winner;
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
    req.on('error', (e) => resolve({ statusCode: 500, body: '{}' }));
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

  const depTz = tzOffset(fl.origin?.timezone || 'Australia/Brisbane');
  const arrTz = tzOffset(fl.destination?.timezone || 'Australia/Brisbane');
  const depIso = fl.scheduled_out || fl.scheduled_off || fl.actual_out || fl.actual_off;

  return {
    state,
    status: fl.status || '',
    flight_date:   toLocalDate(depIso, depTz),
    actual_dep:    toLocalTime(fl.actual_out || fl.actual_off, depTz),
    actual_arr:    toLocalTime(fl.actual_in  || fl.actual_on,  arrTz),
    scheduled_dep: toLocalTime(fl.scheduled_out || fl.scheduled_off, depTz),
    scheduled_arr: toLocalTime(fl.scheduled_in  || fl.scheduled_on,  arrTz),
    estimated_dep: toLocalTime(fl.estimated_out || fl.estimated_off, depTz),
    estimated_arr: toLocalTime(fl.estimated_in  || fl.estimated_on,  arrTz),
  };
}

function getBestFlight(flights) {
  const now = new Date();
  // 1. In-progress flight
  let fl = flights.find(f => (f.progress_percent || 0) > 0 && f.progress_percent < 100);
  if (fl) return fl;
  // 2. Closest departure within -2h to +24h
  const candidates = flights.filter(f => {
    const dep = f.scheduled_out || f.scheduled_off;
    if (!dep) return false;
    const diff = (new Date(dep).getTime() - now.getTime()) / 3600000;
    return diff > -2 && diff < 24;
  });
  if (candidates.length) {
    candidates.sort((a, b) => {
      const at = new Date(a.scheduled_out || a.scheduled_off).getTime();
      const bt = new Date(b.scheduled_out || b.scheduled_off).getTime();
      return Math.abs(at - now) - Math.abs(bt - now);
    });
    return candidates[0];
  }
  return flights.find(f => f.status === 'Scheduled') || flights[0];
}

function scoreEntries(entries, actualDep, actualArr) {
  const adm = timeToMins(actualDep);
  const aam = timeToMins(actualArr);
  return entries.map(e => {
    const dm = timeToMins(e.dep_time);
    const am = timeToMins(e.arr_time);
    const depDiff = (adm !== null && dm !== null) ? Math.abs(dm - adm) : null;
    const arrDiff = (aam !== null && am !== null) ? Math.abs(am - aam) : null;
    const score   = (depDiff !== null && arrDiff !== null) ? depDiff + arrDiff : null;
    return { ...e, depDiff, arrDiff, score };
  }).sort((a, b) => (a.score ?? 9999) - (b.score ?? 9999));
}

function winnerResponse(w) {
  if (!w) return { announced: false };
  if (w.winner_seat === 'CANCELLED' || w.cancelled) return { announced: true, cancelled: true };
  return {
    announced: true,
    cancelled: false,
    winner: {
      winner:    { seat: w.winner_seat, dep: w.winner_dep, arr: w.winner_arr, score: w.winner_score },
      actualDep: w.actual_dep,
      actualArr: w.actual_arr,
      allScores: JSON.parse(w.all_scores || '[]'),
      publishedAt: w.published_at
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
    const { code, date } = parseFlightKey(flightMatch[1]);
    const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(code)}?max_pages=1`);
    if (fa.statusCode !== 200) return respond(fa.statusCode, H, { error: `FlightAware error ${fa.statusCode}` });
    const data = JSON.parse(fa.body);
    const flights = data.flights || [];
    if (!flights.length) return respond(404, H, { error: 'Flight not found — check the number' });
    const fl = getBestFlight(flights);
    const info = flightStatus(fl);
    const useDate = date || info.flight_date;
    // Overlay locked actuals from Supabase — these are always authoritative
    const actuals = await getActuals(code, useDate);
    if (actuals?.actual_dep) info.actual_dep = actuals.actual_dep;
    if (actuals?.actual_arr) info.actual_arr = actuals.actual_arr;
    info.flight_date = useDate;
    info.flight_key  = makeFlightKey(code, useDate);
    return respond(200, H, {
      code,
      from: fl.origin?.code_iata || fl.origin?.code || '???',
      to:   fl.destination?.code_iata || fl.destination?.code || '???',
      ...info
    });
  }

  // ── GET /status/:key — polls for departed/arrived, auto-locks, auto-awards ──
  const statusMatch = p.match(/^\/status\/([A-Z0-9_-]+)$/i);
  if (statusMatch && method === 'GET') {
    const { code, date } = parseFlightKey(statusMatch[1]);
    const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(code)}?max_pages=1`);
    if (fa.statusCode !== 200) return respond(fa.statusCode, H, { error: 'FA error' });
    const data = JSON.parse(fa.body);
    const fl = getBestFlight(data.flights || [{}]);
    const info = flightStatus(fl);
    const useDate = date || info.flight_date;

    // Always check Supabase actuals first — they are the locked truth
    const existing = await getActuals(code, useDate);

    // If FA has new data, lock it permanently (never overwrite existing with null)
    const newDep = info.actual_dep || existing?.actual_dep || null;
    const newArr = info.actual_arr || existing?.actual_arr || null;

    if (newDep || newArr) {
      const hasNew = (newDep && !existing?.actual_dep) || (newArr && !existing?.actual_arr);
      if (hasNew) {
        await upsertActuals(code, useDate, newDep, newArr);
        console.log(`Locked actuals ${code} ${useDate}: dep=${newDep} arr=${newArr}`);
      }
      // Auto-award winner when both times are locked
      if (newDep && newArr) {
        await maybeAwardWinner(code, useDate, newDep, newArr);
      }
    }

    return respond(200, H, {
      ...info,
      actual_dep: newDep,
      actual_arr: newArr,
      flight_key: makeFlightKey(code, useDate)
    });
  }

  // ── GET /picks/:key ───────────────────────────────────────────
  const getPicksMatch = p.match(/^\/picks\/([A-Z0-9_-]+)$/i);
  if (getPicksMatch && method === 'GET') {
    const { code, date } = parseFlightKey(getPicksMatch[1]);
    const entries = await getEntries(code, date);
    const result = {};
    entries.forEach(e => { result[`${e.dep_time}|${e.arr_time}`] = e.seat; });
    return respond(200, H, result);
  }

  // ── GET /picks/:key/dep/:time ─────────────────────────────────
  const depPicksMatch = p.match(/^\/picks\/([A-Z0-9_-]+)\/dep\/(.+)$/i);
  if (depPicksMatch && method === 'GET') {
    const { code, date } = parseFlightKey(depPicksMatch[1]);
    const depTime = decodeURIComponent(depPicksMatch[2]);
    const entries = await getEntries(code, date);
    const taken = {};
    entries.filter(e => e.dep_time === depTime).forEach(e => { taken[e.arr_time] = e.seat; });
    return respond(200, H, taken);
  }

  // ── POST /picks/:key — submit entry ──────────────────────────
  const postPicksMatch = p.match(/^\/picks\/([A-Z0-9_-]+)$/i);
  if (postPicksMatch && method === 'POST') {
    const { code, date } = parseFlightKey(postPicksMatch[1]);
    const { dep, arr, seat } = JSON.parse(event.body || '{}');
    if (!dep || !arr || !seat) return respond(400, H, { error: 'Need dep, arr, seat' });
    const existing = await getEntries(code, date);
    const taken = existing.find(e => e.dep_time === dep && e.arr_time === arr);
    if (taken) return respond(409, H, { error: 'combo_taken', takenBy: taken.seat });
    const r = await insertEntry({
      flight_code: code, flight_date: date || '',
      seat, dep_time: dep, arr_time: arr,
      mobile: '', boarding_pass: null,
      created_at: new Date().toISOString()
    });
    if (r.statusCode !== 201) return respond(500, H, { error: 'Failed to save entry' });
    return respond(200, H, { ok: true });
  }

  // ── POST /picks/:key/update — add mobile + boarding pass ──────
  const updateMatch = p.match(/^\/picks\/([A-Z0-9_-]+)\/update$/i);
  if (updateMatch && method === 'POST') {
    const { code, date } = parseFlightKey(updateMatch[1]);
    const { dep, arr, mobile, boardingPass } = JSON.parse(event.body || '{}');
    await updateEntry(code, date, dep, arr, { mobile: mobile || '', boarding_pass: boardingPass || null });
    return respond(200, H, { ok: true });
  }

  // ── GET /winner/:key ──────────────────────────────────────────
  const winnerMatch = p.match(/^\/winner\/([A-Z0-9_-]+)$/i);
  if (winnerMatch && method === 'GET') {
    const { code, date } = parseFlightKey(winnerMatch[1]);
    const w = await getWinner(code, date);
    return respond(200, H, winnerResponse(w));
  }

  // ── GET /admin ────────────────────────────────────────────────
  const adminMatch = p.match(/^\/admin$/i);
  if (adminMatch && method === 'GET') {
    const qs = event.queryStringParameters || {};
    if (qs.key !== ADMIN_KEY) return respond(403, H, { error: 'Forbidden' });
    const flight = (qs.flight || '').toUpperCase();

    if (flight) {
      const { code, date } = parseFlightKey(flight);
      const [entries, actuals, winner] = await Promise.all([
        getEntries(code, date), getActuals(code, date), getWinner(code, date)
      ]);
      return respond(200, H, { flight, entries, actuals, winner });
    }

    const [allEntries, allWinnerRows, allBPFlags] = await Promise.all([getAllEntries(), getAllWinners(), getAllBPFlags()]);
    const flights = {};
    allEntries.forEach(e => {
      const fk = makeFlightKey(e.flight_code, e.flight_date);
      if (!flights[fk]) flights[fk] = [];
      const hasBP = !!(allBPFlags[fk] && allBPFlags[fk][`${e.dep_time}|${e.arr_time}`]);
      flights[fk].push({ ...e, has_boarding_pass: hasBP });
    });
    const winners = {};
    allWinnerRows.forEach(w => {
      const fk = makeFlightKey(w.flight_code, w.flight_date);
      winners[fk] = {
        cancelled:  w.winner_seat === 'CANCELLED' || !!w.cancelled,
        winner:     { seat: w.winner_seat, dep: w.winner_dep, arr: w.winner_arr, score: w.winner_score },
        actualDep:  w.actual_dep,
        actualArr:  w.actual_arr,
        allScores:  JSON.parse(w.all_scores || '[]'),
        publishedAt: w.published_at,
        flightDate: w.flight_date
      };
    });
    return respond(200, H, { flights, winners });
  }

  // ── POST /admin/winner — manual publish ───────────────────────
  if (p === '/admin/winner' && method === 'POST') {
    const body = JSON.parse(event.body || '{}');
    if (body.key !== ADMIN_KEY) return respond(403, H, { error: 'Forbidden' });
    const { flight, winner, actualDep, actualArr, allScores } = body;
    const { code, date } = parseFlightKey(flight);
    // Also lock actuals permanently
    await upsertActuals(code, date, actualDep, actualArr);
    await upsertWinner(code, date, {
      winner_seat: winner.seat, winner_dep: winner.dep,
      winner_arr: winner.arr,  winner_score: winner.score,
      actual_dep: actualDep,   actual_arr: actualArr,
      all_scores: JSON.stringify(allScores),
      published_at: new Date().toISOString(),
      auto_awarded: false, cancelled: false
    });
    return respond(200, H, { ok: true });
  }

  // ── POST /admin/lock — lock actuals + auto-award ──────────────
  if (p === '/admin/lock' && method === 'POST') {
    const body = JSON.parse(event.body || '{}');
    if (body.key !== ADMIN_KEY) return respond(403, H, { error: 'Forbidden' });
    const { flight, actual_dep, actual_arr } = body;
    const { code, date } = parseFlightKey(flight);
    // Never overwrite an existing locked value with null
    const existing = await getActuals(code, date);
    const newDep = actual_dep || existing?.actual_dep || null;
    const newArr = actual_arr || existing?.actual_arr || null;
    await upsertActuals(code, date, newDep, newArr);
    console.log(`Admin locked ${code} ${date}: dep=${newDep} arr=${newArr}`);
    let winnerSeat = null;
    if (newDep && newArr) {
      const w = await maybeAwardWinner(code, date, newDep, newArr);
      if (w) winnerSeat = w.seat;
    }
    return respond(200, H, { ok: true, actual_dep: newDep, actual_arr: newArr, winner: winnerSeat });
  }

  // ── POST /admin/cancel ────────────────────────────────────────
  if (p === '/admin/cancel' && method === 'POST') {
    const body = JSON.parse(event.body || '{}');
    if (body.key !== ADMIN_KEY) return respond(403, H, { error: 'Forbidden' });
    const { code, date } = parseFlightKey(body.flight || '');
    await upsertWinner(code, date, {
      winner_seat: 'CANCELLED', winner_dep: null, winner_arr: null, winner_score: null,
      actual_dep: null, actual_arr: null, all_scores: '[]',
      published_at: new Date().toISOString(), auto_awarded: false, cancelled: true
    });
    console.log(`Cancelled ${code} ${date}`);
    return respond(200, H, { ok: true });
  }

  // ── GET /admin/bp/:key/:dep/:arr ──────────────────────────────
  const bpMatch = p.match(/^\/admin\/bp\/([A-Z0-9_-]+)\/(.+)\/(.+)$/i);
  if (bpMatch && method === 'GET') {
    const qs = event.queryStringParameters || {};
    if (qs.key !== ADMIN_KEY) return respond(403, H, { error: 'Forbidden' });
    const { code, date } = parseFlightKey(bpMatch[1]);
    const dep = decodeURIComponent(bpMatch[2]);
    const arr = decodeURIComponent(bpMatch[3]);
    const r = await sbRequest('GET', `entries?${codeFilter(code, date)}&dep_time=eq.${encodeURIComponent(dep)}&arr_time=eq.${encodeURIComponent(arr)}&select=boarding_pass`);
    const entry = Array.isArray(r.data) && r.data.length ? r.data[0] : null;
    return respond(200, H, { boarding_pass: entry?.boarding_pass || null });
  }

  // ── DELETE /admin/picks/:key/:combo ───────────────────────────
  const deleteMatch = p.match(/^\/admin\/picks\/([A-Z0-9_-]+)\/(.+)$/i);
  if (deleteMatch && method === 'DELETE') {
    const qs = event.queryStringParameters || {};
    if (qs.key !== ADMIN_KEY) return respond(403, H, { error: 'Forbidden' });
    const { code, date } = parseFlightKey(deleteMatch[1]);
    const [dep, arr] = decodeURIComponent(deleteMatch[2]).split('|');
    await deleteEntry(code, date, dep, arr);
    return respond(200, H, { ok: true });
  }

  return respond(404, H, { error: 'Not found' });
};