const https = require('https');

const FA_KEY    = 'rdqRteiLRjx3W113fMI6dLux7JzAHWeU';
const ADMIN_KEY = 'AGS2026admin';
const GH_TOKEN  = process.env.GH_TOKEN;
const GH_OWNER  = 'RodeH1969';
const GH_REPO   = 'airportgatesweep';
const GH_FILE   = 'picks.json';

// ── GitHub storage helpers ───────────────────────────────────────
function ghRequest(method, path, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${GH_TOKEN}`,
        'User-Agent': 'AirportGateSweep',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      }
    };
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(opts, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        console.log('GH', method, path, res.statusCode);
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(b) }); }
        catch(e) { resolve({ statusCode: res.statusCode, data: {} }); }
      });
    });
    req.on('error', (e) => { console.error('GH error:', e.message); resolve({ statusCode: 500, data: {} }); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadPicks() {
  const r = await ghRequest('GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`);
  if (r.statusCode === 404) return { flights: {}, sha: null };
  try {
    const content = Buffer.from(r.data.content, 'base64').toString('utf8');
    return { ...JSON.parse(content), sha: r.data.sha };
  } catch(e) { return { flights: {}, sha: r.data?.sha || null }; }
}

async function savePicks(data, sha) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = { message: 'update picks', content };
  if (sha) body.sha = sha;
  return ghRequest('PUT', `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`, body);
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

function timeToMins(t) {
  if (!t) return null;
  const clean = t.replace(/^[<>]\s*/, '');
  const parts = clean.split(':').map(Number);
  if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
  return parts[0] * 60 + parts[1];
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

  // Active/in-progress flight wins immediately
  let fl = flights.find(f => (f.progress_percent || 0) > 0 && f.progress_percent < 100);
  if (fl) return fl;

  // Find the nearest upcoming or very recent flight (within last 2 hours)
  // Compare scheduled_out UTC timestamp to now
  const candidates = flights.filter(f => {
    const dep = f.scheduled_out || f.scheduled_off;
    if (!dep) return false;
    const depTime = new Date(dep).getTime();
    const diffHours = (depTime - now.getTime()) / (1000 * 60 * 60);
    // Include flights scheduled up to 24hrs in future or departed up to 2hrs ago
    return diffHours > -2 && diffHours < 24;
  });

  if (candidates.length) {
    // Sort by closest to now
    candidates.sort((a, b) => {
      const at = new Date(a.scheduled_out || a.scheduled_off).getTime();
      const bt = new Date(b.scheduled_out || b.scheduled_off).getTime();
      return Math.abs(at - now) - Math.abs(bt - now);
    });
    return candidates[0];
  }

  // Fallback: most recent scheduled
  const scheduled = flights.find(f => f.status === 'Scheduled');
  if (scheduled) return scheduled;

  return flights[0];
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
    const flInfo = flightStatus(fl);
    // Overlay locked actual times from store if available
    const store = await loadPicks();
    const locked = (store.actuals || {})[code] || {};
    if (locked.actual_dep) flInfo.actual_dep = locked.actual_dep;
    if (locked.actual_arr) flInfo.actual_arr = locked.actual_arr;

    return respond(200, headers, {
      code,
      from: fl.origin?.code_iata || fl.origin?.code || '???',
      to:   fl.destination?.code_iata || fl.destination?.code || '???',
      ...flInfo
    });
  }

  // GET /status/VA309 — also auto-locks actual times and awards winner
  const statusMatch = p.match(/^\/status\/([A-Z0-9]+)$/i);
  if (statusMatch && method === 'GET') {
    const code = statusMatch[1].toUpperCase();
    const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(code)}?max_pages=1`);
    if (fa.statusCode !== 200) return respond(fa.statusCode, headers, { error: 'FA error' });
    const data = JSON.parse(fa.body);
    const fl = getBestFlight(data.flights || [{}]);
    const status = flightStatus(fl);

    // Auto-lock actual times into picks.json the moment we get them
    if (status.actual_dep || status.actual_arr) {
      const store = await loadPicks();
      let changed = false;

      if (!store.actuals) store.actuals = {};
      if (!store.actuals[code]) store.actuals[code] = {};

      if (status.actual_dep && !store.actuals[code].actual_dep) {
        store.actuals[code].actual_dep = status.actual_dep;
        changed = true;
        console.log('Locked actual_dep for ' + code + ': ' + status.actual_dep);
      }
      if (status.actual_arr && !store.actuals[code].actual_arr) {
        store.actuals[code].actual_arr = status.actual_arr;
        changed = true;
        console.log('Locked actual_arr for ' + code + ': ' + status.actual_arr);
      }

      // Auto-award winner when both times are locked and not yet awarded
      if (store.actuals[code].actual_dep && store.actuals[code].actual_arr &&
          !(store.winners || {})[code]) {
        const entries = (store.flights || {})[code] || {};
        const entryList = Object.entries(entries);
        if (entryList.length > 0) {
          const adm = timeToMins(store.actuals[code].actual_dep);
          const aam = timeToMins(store.actuals[code].actual_arr);
          const scored = entryList.map(([combo, entry]) => {
            const e = typeof entry === 'object' ? entry : { seat: entry, dep: combo.split('|')[0], arr: combo.split('|')[1] };
            const dm = timeToMins(e.dep);
            const am = timeToMins(e.arr);
            const depDiff = (adm !== null && dm !== null) ? Math.abs(dm - adm) : 999;
            const arrDiff = (aam !== null && am !== null) ? Math.abs(am - aam) : 999;
            return { seat: e.seat, dep: e.dep, arr: e.arr, depDiff, arrDiff, score: depDiff + arrDiff };
          }).sort((a, b) => a.score - b.score);

          if (!store.winners) store.winners = {};
          store.winners[code] = {
            winner: scored[0],
            allScores: scored,
            actualDep: store.actuals[code].actual_dep,
            actualArr: store.actuals[code].actual_arr,
            publishedAt: new Date().toISOString(),
            autoAwarded: true
          };
          changed = true;
          console.log('Auto-awarded winner for ' + code + ': Seat ' + scored[0].seat);
        }
      }

      if (changed) {
        const sha = store.sha; delete store.sha;
        await savePicks(store, sha);
      }

      // Return actual times from locked store
      status.actual_dep = store.actuals[code].actual_dep || status.actual_dep;
      status.actual_arr = store.actuals[code].actual_arr || status.actual_arr;
    }

    return respond(200, headers, status);
  }

  // GET /picks/VA309
  const getPicksMatch = p.match(/^\/picks\/([A-Z0-9]+)$/i);
  if (getPicksMatch && method === 'GET') {
    const code = getPicksMatch[1].toUpperCase();
    const store = await loadPicks();
    return respond(200, headers, (store.flights || {})[code] || {});
  }

  // GET /picks/VA309/dep/09:11
  const depPicksMatch = p.match(/^\/picks\/([A-Z0-9]+)\/dep\/(.+)$/i);
  if (depPicksMatch && method === 'GET') {
    const code    = depPicksMatch[1].toUpperCase();
    const depTime = decodeURIComponent(depPicksMatch[2]);
    const store   = await loadPicks();
    const flightPicks = ((store.flights || {})[code]) || {};
    const arrTaken = {};
    for (const [combo, entry] of Object.entries(flightPicks)) {
      const [d, a] = combo.split('|');
      if (d === depTime) arrTaken[a] = typeof entry === 'object' ? entry.seat : entry;
    }
    return respond(200, headers, arrTaken);
  }

  // POST /picks/VA309
  const postPicksMatch = p.match(/^\/picks\/([A-Z0-9]+)$/i);
  if (postPicksMatch && method === 'POST') {
    const code = postPicksMatch[1].toUpperCase();
    const { dep, arr, seat, mobile } = JSON.parse(event.body || '{}');
    if (!dep || !arr || !seat) return respond(400, headers, { error: 'Need dep, arr, seat' });
    const store = await loadPicks();
    if (!store.flights) store.flights = {};
    if (!store.flights[code]) store.flights[code] = {};
    const combo = `${dep}|${arr}`;
    if (store.flights[code][combo]) {
      const takenBy = store.flights[code][combo].seat || store.flights[code][combo];
      return respond(409, headers, { error: 'combo_taken', takenBy });
    }
    store.flights[code][combo] = { seat, mobile: mobile || '', timestamp: new Date().toISOString(), dep, arr };
    const sha = store.sha;
    delete store.sha;
    await savePicks(store, sha);
    console.log(`Locked: ${code} | ${seat} → ${dep}/${arr}`);
    return respond(200, headers, { ok: true });
  }

  // GET /admin?key=AGS2026admin&flight=VA309
  const adminMatch = p.match(/^\/admin$/i);
  if (adminMatch && method === 'GET') {
    const key    = (event.queryStringParameters || {}).key || '';
    const flight = ((event.queryStringParameters || {}).flight || '').toUpperCase();
    if (key !== ADMIN_KEY) return respond(403, headers, { error: 'Forbidden' });
    const store = await loadPicks();
    if (flight) return respond(200, headers, { flight, entries: (store.flights || {})[flight] || {}, winners: store.winners || {}, actuals: store.actuals || {} });
    return respond(200, headers, { flights: store.flights || {}, winners: store.winners || {}, actuals: store.actuals || {} });
  }

  // DELETE /admin/picks/VA309/COMBO?key=...
  const deleteMatch = p.match(/^\/admin\/picks\/([A-Z0-9]+)\/(.+)$/i);
  if (deleteMatch && method === 'DELETE') {
    const key   = (event.queryStringParameters || {}).key || '';
    if (key !== ADMIN_KEY) return respond(403, headers, { error: 'Forbidden' });
    const code  = deleteMatch[1].toUpperCase();
    const combo = decodeURIComponent(deleteMatch[2]);
    const store = await loadPicks();
    if (store.flights?.[code]?.[combo]) {
      delete store.flights[code][combo];
      const sha = store.sha;
      delete store.sha;
      await savePicks(store, sha);
      return respond(200, headers, { ok: true });
    }
    return respond(404, headers, { error: 'Entry not found' });
  }

  // GET /winner/QF533
  const getWinnerMatch = p.match(/^\/winner\/([A-Z0-9]+)$/i);
  if (getWinnerMatch && method === 'GET') {
    const code = getWinnerMatch[1].toUpperCase();
    const store = await loadPicks();
    const winner = (store.winners || {})[code] || null;
    return respond(200, headers, winner ? { winner, announced: true } : { announced: false });
  }

  // POST /admin/winner
  if (p === '/admin/winner' && method === 'POST') {
    const body = JSON.parse(event.body || '{}');
    if (body.key !== ADMIN_KEY) return respond(403, headers, { error: 'Forbidden' });
    const { flight, winner, actualDep, actualArr, allScores } = body;
    const store = await loadPicks();
    if (!store.winners) store.winners = {};
    store.winners[flight] = { winner, actualDep, actualArr, allScores, publishedAt: new Date().toISOString() };
    const sha = store.sha; delete store.sha;
    await savePicks(store, sha);
    console.log('Winner published: ' + flight + ' seat ' + winner.seat);
    return respond(200, headers, { ok: true });
  }

  return respond(404, headers, { error: 'Not found' });
};