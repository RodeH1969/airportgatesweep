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
  const todayUTC = new Date().toISOString().slice(0, 10);
  let fl = flights.find(f => (f.scheduled_out || f.scheduled_off || '').startsWith(todayUTC) && f.progress_percent < 100);
  if (!fl) fl = flights.find(f => (f.progress_percent || 0) > 0 && f.progress_percent < 100);
  if (!fl) fl = flights.find(f => f.status === 'Scheduled');
  return fl || flights[0];
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
    return respond(200, headers, {
      code,
      from: fl.origin?.code_iata || fl.origin?.code || '???',
      to:   fl.destination?.code_iata || fl.destination?.code || '???',
      ...flightStatus(fl)
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
    return respond(200, headers, flightStatus(fl));
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
    if (flight) return respond(200, headers, { flight, entries: (store.flights || {})[flight] || {} });
    return respond(200, headers, { flights: store.flights || {} });
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

  return respond(404, headers, { error: 'Not found' });
};