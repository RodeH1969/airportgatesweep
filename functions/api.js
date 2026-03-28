const https = require('https');

const FA_KEY   = 'rdqRteiLRjx3W113fMI6dLux7JzAHWeU';
const BIN_ID   = '69c74dc2b7ec241ddcb01bba';
const BIN_KEY  = '$2a$10$HRueT7j9AE07wM9ms0vDWuOHzS6T.mSg8SQ.SXTvf/nz5GgxwLEne';
const ADMIN_KEY = 'AGS2026admin';

// ── JSONBin helpers ──────────────────────────────────────────────
function jsonbinGet() {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'api.jsonbin.io',
      path: `/v3/b/${BIN_ID}/latest`,
      headers: { 'X-Master-Key': BIN_KEY, 'X-Bin-Meta': 'false' }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        console.log('JSONBin GET status:', res.statusCode, 'body:', body.substring(0, 200));
        try { resolve(JSON.parse(body)); }
        catch(e) { console.error('JSONBin parse error:', e.message); resolve({ flights: {} }); }
      });
    });
    req.on('error', (e) => { console.error('JSONBin GET error:', e.message); resolve({ flights: {} }); });
  });
}

function jsonbinPut(data) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'api.jsonbin.io',
      path: `/v3/b/${BIN_ID}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': BIN_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        console.log('JSONBin PUT status:', res.statusCode, 'body:', b.substring(0, 200));
        resolve(res.statusCode === 200);
      });
    });
    req.on('error', (e) => { console.error('JSONBin PUT error:', e.message); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ── FlightAware helper ───────────────────────────────────────────
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
  ) {
    state = 'departed';
  }
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

// ── Handler ──────────────────────────────────────────────────────
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

  // ── GET /flight/VA309 ──
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

  // ── GET /status/VA309 ──
  const statusMatch = p.match(/^\/status\/([A-Z0-9]+)$/i);
  if (statusMatch && method === 'GET') {
    const code = statusMatch[1].toUpperCase();
    const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(code)}?max_pages=1`);
    if (fa.statusCode !== 200) return respond(fa.statusCode, headers, { error: 'FA error' });
    const data = JSON.parse(fa.body);
    const fl = getBestFlight(data.flights || [{}]);
    return respond(200, headers, flightStatus(fl));
  }

  // ── GET /picks/VA309 ──
  const getPicksMatch = p.match(/^\/picks\/([A-Z0-9]+)$/i);
  if (getPicksMatch && method === 'GET') {
    const code = getPicksMatch[1].toUpperCase();
    const store = await jsonbinGet();
    return respond(200, headers, (store.flights || {})[code] || {});
  }

  // ── GET /picks/VA309/dep/09:11 ──
  const depPicksMatch = p.match(/^\/picks\/([A-Z0-9]+)\/dep\/(.+)$/i);
  if (depPicksMatch && method === 'GET') {
    const code    = depPicksMatch[1].toUpperCase();
    const depTime = decodeURIComponent(depPicksMatch[2]);
    const store   = await jsonbinGet();
    const flightPicks = ((store.flights || {})[code]) || {};
    const arrTaken = {};
    for (const [combo, entry] of Object.entries(flightPicks)) {
      const [d, a] = combo.split('|');
      if (d === depTime) arrTaken[a] = typeof entry === 'object' ? entry.seat : entry;
    }
    return respond(200, headers, arrTaken);
  }

  // ── POST /picks/VA309 ──
  const postPicksMatch = p.match(/^\/picks\/([A-Z0-9]+)$/i);
  if (postPicksMatch && method === 'POST') {
    const code = postPicksMatch[1].toUpperCase();
    const { dep, arr, seat, mobile } = JSON.parse(event.body || '{}');
    if (!dep || !arr || !seat) return respond(400, headers, { error: 'Need dep, arr, seat' });
    const store = await jsonbinGet();
    if (!store.flights) store.flights = {};
    if (!store.flights[code]) store.flights[code] = {};
    const combo = `${dep}|${arr}`;
    if (store.flights[code][combo]) {
      const takenBy = store.flights[code][combo].seat || store.flights[code][combo];
      return respond(409, headers, { error: 'combo_taken', takenBy });
    }
    store.flights[code][combo] = { seat, mobile: mobile || '', timestamp: new Date().toISOString(), dep, arr };
    await jsonbinPut(store);
    console.log(`Locked: ${code} | ${seat} → ${dep}/${arr}`);
    return respond(200, headers, { ok: true });
  }

  // ── GET /admin?key=AGS2026admin&flight=VA309 ──
  const adminMatch = p.match(/^\/admin$/i);
  if (adminMatch && method === 'GET') {
    const params = new URLSearchParams(event.rawQuery || event.queryStringParameters ? new URLSearchParams(event.queryStringParameters).toString() : '');
    const key    = (event.queryStringParameters || {}).key || '';
    const flight = ((event.queryStringParameters || {}).flight || '').toUpperCase();
    if (key !== ADMIN_KEY) return respond(403, headers, { error: 'Forbidden' });
    const store = await jsonbinGet();
    if (flight) {
      return respond(200, headers, { flight, entries: (store.flights || {})[flight] || {} });
    }
    return respond(200, headers, { flights: store.flights || {} });
  }

  // ── DELETE /admin/picks/VA309/COMBO?key=... ──
  const deleteMatch = p.match(/^\/admin\/picks\/([A-Z0-9]+)\/(.+)$/i);
  if (deleteMatch && method === 'DELETE') {
    const key   = (event.queryStringParameters || {}).key || '';
    if (key !== ADMIN_KEY) return respond(403, headers, { error: 'Forbidden' });
    const code  = deleteMatch[1].toUpperCase();
    const combo = decodeURIComponent(deleteMatch[2]);
    const store = await jsonbinGet();
    if (store.flights?.[code]?.[combo]) {
      delete store.flights[code][combo];
      await jsonbinPut(store);
      return respond(200, headers, { ok: true, deleted: combo });
    }
    return respond(404, headers, { error: 'Entry not found' });
  }

  console.log('No route matched:', p);
  return respond(404, headers, { error: 'Not found' });
};