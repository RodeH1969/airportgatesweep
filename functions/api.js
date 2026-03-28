const https = require('https');
const { getDeployStore } = require('@netlify/blobs');

const FA_KEY    = 'rdqRteiLRjx3W113fMI6dLux7JzAHWeU';
const ADMIN_KEY = 'AGS2026admin';

function getStore(context) {
  return getDeployStore({ name: 'picks', deployID: context.deployID, siteID: context.siteID, token: context.token });
}

async function loadPicks(store, code) {
  try { return (await store.get(code, { type: 'json' })) || {}; }
  catch(e) { console.log('loadPicks error:', e.message); return {}; }
}

async function savePicks(store, code, picks) {
  try { await store.setJSON(code, picks); return true; }
  catch(e) { console.error('savePicks error:', e.message); return false; }
}

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

exports.handler = async (event, context) => {
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

  const store = getStore(context);

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
    const picks = await loadPicks(store, code);
    return respond(200, headers, picks);
  }

  // GET /picks/VA309/dep/09:11
  const depPicksMatch = p.match(/^\/picks\/([A-Z0-9]+)\/dep\/(.+)$/i);
  if (depPicksMatch && method === 'GET') {
    const code    = depPicksMatch[1].toUpperCase();
    const depTime = decodeURIComponent(depPicksMatch[2]);
    const picks   = await loadPicks(store, code);
    const arrTaken = {};
    for (const [combo, entry] of Object.entries(picks)) {
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
    const picks = await loadPicks(store, code);
    const combo = `${dep}|${arr}`;
    if (picks[combo]) {
      const takenBy = picks[combo].seat || picks[combo];
      return respond(409, headers, { error: 'combo_taken', takenBy });
    }
    picks[combo] = { seat, mobile: mobile || '', timestamp: new Date().toISOString(), dep, arr };
    const saved = await savePicks(store, code, picks);
    console.log(`Locked: ${code} | ${seat} → ${dep}/${arr} | saved: ${saved}`);
    return respond(200, headers, { ok: true });
  }

  // GET /admin?key=AGS2026admin&flight=VA309
  const adminMatch = p.match(/^\/admin$/i);
  if (adminMatch && method === 'GET') {
    const key    = (event.queryStringParameters || {}).key || '';
    const flight = ((event.queryStringParameters || {}).flight || '').toUpperCase();
    if (key !== ADMIN_KEY) return respond(403, headers, { error: 'Forbidden' });
    if (flight) {
      const picks = await loadPicks(store, flight);
      return respond(200, headers, { flight, entries: picks });
    }
    // Return all flights — list all keys in store
    try {
      const { blobs } = await store.list();
      const flights = {};
      for (const blob of blobs) {
        flights[blob.key] = await loadPicks(store, blob.key);
      }
      return respond(200, headers, { flights });
    } catch(e) {
      return respond(200, headers, { flights: {} });
    }
  }

  // DELETE /admin/picks/VA309/COMBO?key=...
  const deleteMatch = p.match(/^\/admin\/picks\/([A-Z0-9]+)\/(.+)$/i);
  if (deleteMatch && method === 'DELETE') {
    const key   = (event.queryStringParameters || {}).key || '';
    if (key !== ADMIN_KEY) return respond(403, headers, { error: 'Forbidden' });
    const code  = deleteMatch[1].toUpperCase();
    const combo = decodeURIComponent(deleteMatch[2]);
    const picks = await loadPicks(store, code);
    if (picks[combo]) {
      delete picks[combo];
      await savePicks(store, code, picks);
      return respond(200, headers, { ok: true, deleted: combo });
    }
    return respond(404, headers, { error: 'Entry not found' });
  }

  console.log('No route matched:', p);
  return respond(404, headers, { error: 'Not found' });
};