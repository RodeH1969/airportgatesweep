const https = require('https');

const FA_KEY     = 'rdqRteiLRjx3W113fMI6dLux7JzAHWeU';
const ADMIN_KEY  = 'AGS2026admin';
const SB_URL     = 'udcriobsizpalijmwoxr.supabase.co';
const SB_KEY     = 'sb_secret_1Ih1D7T0GuHt-MkMNhjXkQ_KfxKGuPG';

// ── Supabase REST helpers ────────────────────────────────────────
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
        'Prefer': method === 'POST' ? 'return=representation' : 'return=representation'
      }
    };
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(opts, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        console.log('SB', method, path, res.statusCode);
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(b) }); }
        catch(e) { resolve({ statusCode: res.statusCode, data: [] }); }
      });
    });
    req.on('error', (e) => { console.error('SB error:', e.message); resolve({ statusCode: 500, data: [] }); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function getEntries(flightCode) {
  const r = await sbRequest('GET', `entries?flight_code=eq.${encodeURIComponent(flightCode)}&order=created_at.asc`);
  return Array.isArray(r.data) ? r.data : [];
}

async function getAllEntries() {
  const r = await sbRequest('GET', 'entries?order=created_at.asc');
  return Array.isArray(r.data) ? r.data : [];
}

async function insertEntry(entry) {
  return sbRequest('POST', 'entries', entry);
}

async function updateEntry(flightCode, depTime, arrTime, updates) {
  const path = `entries?flight_code=eq.${encodeURIComponent(flightCode)}&dep_time=eq.${encodeURIComponent(depTime)}&arr_time=eq.${encodeURIComponent(arrTime)}`;
  return sbRequest('PATCH', path, updates);
}

async function deleteEntry(flightCode, depTime, arrTime) {
  const path = `entries?flight_code=eq.${encodeURIComponent(flightCode)}&dep_time=eq.${encodeURIComponent(depTime)}&arr_time=eq.${encodeURIComponent(arrTime)}`;
  return sbRequest('DELETE', path, null);
}

async function getActuals(flightCode) {
  const r = await sbRequest('GET', `actuals?flight_code=eq.${encodeURIComponent(flightCode)}`);
  return Array.isArray(r.data) && r.data.length ? r.data[0] : null;
}

async function upsertActuals(flightCode, actualDep, actualArr) {
  return sbRequest('POST', 'actuals', {
    flight_code: flightCode,
    actual_dep: actualDep || null,
    actual_arr: actualArr || null,
    updated_at: new Date().toISOString()
  });
}

async function getWinner(flightCode) {
  const r = await sbRequest('GET', `winners?flight_code=eq.${encodeURIComponent(flightCode)}`);
  return Array.isArray(r.data) && r.data.length ? r.data[0] : null;
}

async function upsertWinner(flightCode, winnerData) {
  return sbRequest('POST', 'winners', { flight_code: flightCode, ...winnerData });
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
    req.on('error', (e) => resolve({ statusCode: 500, body: JSON.stringify({ error: e.message }) }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ statusCode: 504, body: '{}' }); });
  });
}

function toLocalTime(iso, offsetHours) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const local = new Date(d.getTime() + offsetHours * 60 * 60 * 1000);
  return `${String(local.getUTCHours()).padStart(2,'0')}:${String(local.getUTCMinutes()).padStart(2,'0')}`;
}

function tzOffset(ianaZone) {
  try {
    const now = new Date();
    const utc   = now.toLocaleString('en-AU', { timeZone: 'UTC',    hour12: false, hour: '2-digit', minute: '2-digit' });
    const local = now.toLocaleString('en-AU', { timeZone: ianaZone, hour12: false, hour: '2-digit', minute: '2-digit' });
    const [uh, um] = utc.split(':').map(Number);
    const [lh, lm] = local.split(':').map(Number);
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
  if (!!fl.actual_in || status.includes('arrived') || status.includes('gate arrival')) {
    state = 'arrived';
  } else if (
    !!fl.actual_out || !!fl.actual_off ||
    status.includes('departed') || status.includes('en route') ||
    status.includes('active')   || status.includes('taxiing') ||
    status.includes('airborne') || fl.progress_percent > 0
  ) { state = 'departed'; }
  const depTz = tzOffset(fl.origin?.timezone      || 'Australia/Brisbane');
  const arrTz = tzOffset(fl.destination?.timezone || 'Australia/Brisbane');
  return {
    state, status: fl.status || '',
    actual_dep:    toLocalTime(fl.actual_out    || fl.actual_off, depTz),
    actual_arr:    toLocalTime(fl.actual_in     || fl.actual_on,  arrTz),
    scheduled_dep: toLocalTime(fl.scheduled_out || fl.scheduled_off, depTz),
    scheduled_arr: toLocalTime(fl.scheduled_in  || fl.scheduled_on,  arrTz),
    estimated_dep: toLocalTime(fl.estimated_out || fl.estimated_off, depTz),
    estimated_arr: toLocalTime(fl.estimated_in  || fl.estimated_on,  arrTz),
  };
}

function getBestFlight(flights) {
  const now = new Date();
  let fl = flights.find(f => (f.progress_percent || 0) > 0 && f.progress_percent < 100);
  if (fl) return fl;
  const candidates = flights.filter(f => {
    const dep = f.scheduled_out || f.scheduled_off;
    if (!dep) return false;
    const diffHours = (new Date(dep).getTime() - now.getTime()) / (1000 * 60 * 60);
    return diffHours > -2 && diffHours < 24;
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

const respond = (statusCode, headers, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

// ── Main handler ─────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const method = event.httpMethod;
  let p = '';
  try { p = new URL(event.rawUrl || event.path, 'https://x.x').pathname; } catch(e) { p = event.path || ''; }
  p = p.replace('/.netlify/functions/api', '');
  if (!p.startsWith('/')) p = '/' + p;
  console.log('PATH:', p, method);

  // GET /flight/VA309
  const flightMatch = p.match(/^\/flight\/([A-Z0-9]+)$/i);
  if (flightMatch && method === 'GET') {
    const code = flightMatch[1].toUpperCase();
    const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(code)}?max_pages=1`);
    if (fa.statusCode !== 200) return respond(fa.statusCode, headers, { error: `FlightAware error ${fa.statusCode}` });
    const data = JSON.parse(fa.body);
    const flights = data.flights || [];
    if (!flights.length) return respond(404, headers, { error: 'Flight not found — check the number' });
    const fl = getBestFlight(flights);
    // Overlay locked actuals from Supabase
    const actuals = await getActuals(code);
    const info = flightStatus(fl);
    if (actuals?.actual_dep) info.actual_dep = actuals.actual_dep;
    if (actuals?.actual_arr) info.actual_arr = actuals.actual_arr;
    return respond(200, headers, {
      code,
      from: fl.origin?.code_iata || fl.origin?.code || '???',
      to:   fl.destination?.code_iata || fl.destination?.code || '???',
      ...info
    });
  }

  // GET /status/VA309
  const statusMatch = p.match(/^\/status\/([A-Z0-9]+)$/i);
  if (statusMatch && method === 'GET') {
    const code = statusMatch[1].toUpperCase();
    const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(code)}?max_pages=1`);
    if (fa.statusCode !== 200) return respond(fa.statusCode, headers, { error: 'FA error' });
    const data = JSON.parse(fa.body);
    const fl = getBestFlight(data.flights || [{}]);
    const status = flightStatus(fl);

    // Auto-lock actual times into Supabase
    if (status.actual_dep || status.actual_arr) {
      const existing = await getActuals(code);
      const needsUpdate = !existing || 
        (status.actual_dep && !existing.actual_dep) || 
        (status.actual_arr && !existing.actual_arr);
      
      if (needsUpdate) {
        const newDep = status.actual_dep || existing?.actual_dep || null;
        const newArr = status.actual_arr || existing?.actual_arr || null;
        await upsertActuals(code, newDep, newArr);
        console.log(`Locked actuals for ${code}: dep=${newDep} arr=${newArr}`);

        // Auto-award winner when both locked
        if (newDep && newArr) {
          const alreadyWon = await getWinner(code);
          if (!alreadyWon) {
            const entries = await getEntries(code);
            if (entries.length > 0) {
              const scored = scoreEntries(entries, newDep, newArr);
              const winner = scored[0];
              await upsertWinner(code, {
                winner_seat: winner.seat,
                winner_dep:  winner.dep_time,
                winner_arr:  winner.arr_time,
                winner_score: winner.score,
                actual_dep: newDep,
                actual_arr: newArr,
                all_scores: JSON.stringify(scored),
                published_at: new Date().toISOString(),
                auto_awarded: true
              });
              console.log(`Auto-awarded winner for ${code}: Seat ${winner.seat} score ${winner.score}`);
              status.winner = winner;
            }
          }
        }
        status.actual_dep = newDep;
        status.actual_arr = newArr;
      } else if (existing) {
        status.actual_dep = existing.actual_dep || status.actual_dep;
        status.actual_arr = existing.actual_arr || status.actual_arr;
      }
    }
    return respond(200, headers, status);
  }

  // GET /picks/VA309
  const getPicksMatch = p.match(/^\/picks\/([A-Z0-9]+)$/i);
  if (getPicksMatch && method === 'GET') {
    const code = getPicksMatch[1].toUpperCase();
    const entries = await getEntries(code);
    const result = {};
    entries.forEach(e => { result[`${e.dep_time}|${e.arr_time}`] = e.seat; });
    return respond(200, headers, result);
  }

  // GET /picks/VA309/dep/09:11
  const depPicksMatch = p.match(/^\/picks\/([A-Z0-9]+)\/dep\/(.+)$/i);
  if (depPicksMatch && method === 'GET') {
    const code    = depPicksMatch[1].toUpperCase();
    const depTime = decodeURIComponent(depPicksMatch[2]);
    const entries = await getEntries(code);
    const arrTaken = {};
    entries.filter(e => e.dep_time === depTime).forEach(e => { arrTaken[e.arr_time] = e.seat; });
    return respond(200, headers, arrTaken);
  }

  // POST /picks/VA309
  const postPicksMatch = p.match(/^\/picks\/([A-Z0-9]+)$/i);
  if (postPicksMatch && method === 'POST') {
    const code = postPicksMatch[1].toUpperCase();
    const { dep, arr, seat } = JSON.parse(event.body || '{}');
    if (!dep || !arr || !seat) return respond(400, headers, { error: 'Need dep, arr, seat' });
    
    // Check combo not taken
    const existing = await getEntries(code);
    const taken = existing.find(e => e.dep_time === dep && e.arr_time === arr);
    if (taken) return respond(409, headers, { error: 'combo_taken', takenBy: taken.seat });

    // Insert new entry
    const r = await insertEntry({
      flight_code: code,
      seat,
      dep_time: dep,
      arr_time: arr,
      mobile: '',
      boarding_pass: null,
      created_at: new Date().toISOString()
    });
    if (r.statusCode !== 201) {
      console.error('Insert failed:', r.statusCode, JSON.stringify(r.data));
      return respond(500, headers, { error: 'Failed to save entry' });
    }
    console.log(`Saved: ${code} | ${seat} → ${dep}/${arr}`);
    return respond(200, headers, { ok: true });
  }

  // POST /picks/VA309/update — add mobile + boarding pass
  const updateMatch = p.match(/^\/picks\/([A-Z0-9]+)\/update$/i);
  if (updateMatch && method === 'POST') {
    const code = updateMatch[1].toUpperCase();
    const { dep, arr, seat, mobile, boardingPass } = JSON.parse(event.body || '{}');
    await updateEntry(code, dep, arr, {
      mobile: mobile || '',
      boarding_pass: boardingPass || null
    });
    return respond(200, headers, { ok: true });
  }

  // GET /winner/VA309
  const winnerMatch = p.match(/^\/winner\/([A-Z0-9]+)$/i);
  if (winnerMatch && method === 'GET') {
    const code = winnerMatch[1].toUpperCase();
    const winner = await getWinner(code);
    if (!winner) return respond(200, headers, { announced: false });
    return respond(200, headers, {
      announced: true,
      winner: {
        winner: { seat: winner.winner_seat, dep: winner.winner_dep, arr: winner.winner_arr, score: winner.winner_score, depDiff: null, arrDiff: null },
        actualDep: winner.actual_dep,
        actualArr: winner.actual_arr,
        allScores: JSON.parse(winner.all_scores || '[]'),
        publishedAt: winner.published_at
      }
    });
  }

  // GET /admin
  const adminMatch = p.match(/^\/admin$/i);
  if (adminMatch && method === 'GET') {
    const key    = (event.queryStringParameters || {}).key || '';
    const flight = ((event.queryStringParameters || {}).flight || '').toUpperCase();
    if (key !== ADMIN_KEY) return respond(403, headers, { error: 'Forbidden' });

    if (flight) {
      const entries  = await getEntries(flight);
      const actuals  = await getActuals(flight);
      const winner   = await getWinner(flight);
      return respond(200, headers, { flight, entries, actuals, winner });
    }

    const allEntries = await getAllEntries();
    const flights = {};
    allEntries.forEach(e => {
      if (!flights[e.flight_code]) flights[e.flight_code] = [];
      flights[e.flight_code].push(e);
    });
    return respond(200, headers, { flights });
  }

  // POST /admin/winner — manual publish
  if (p === '/admin/winner' && method === 'POST') {
    const body = JSON.parse(event.body || '{}');
    if (body.key !== ADMIN_KEY) return respond(403, headers, { error: 'Forbidden' });
    const { flight, winner, actualDep, actualArr, allScores } = body;
    await upsertWinner(flight, {
      winner_seat: winner.seat,
      winner_dep:  winner.dep,
      winner_arr:  winner.arr,
      winner_score: winner.score,
      actual_dep: actualDep,
      actual_arr: actualArr,
      all_scores: JSON.stringify(allScores),
      published_at: new Date().toISOString(),
      auto_awarded: false
    });
    return respond(200, headers, { ok: true });
  }

  // DELETE /admin/picks
  const deleteMatch = p.match(/^\/admin\/picks\/([A-Z0-9]+)\/(.+)$/i);
  if (deleteMatch && method === 'DELETE') {
    const key   = (event.queryStringParameters || {}).key || '';
    if (key !== ADMIN_KEY) return respond(403, headers, { error: 'Forbidden' });
    const code  = deleteMatch[1].toUpperCase();
    const combo = decodeURIComponent(deleteMatch[2]);
    const [dep, arr] = combo.split('|');
    await deleteEntry(code, dep, arr);
    return respond(200, headers, { ok: true });
  }

  return respond(404, headers, { error: 'Not found' });
};