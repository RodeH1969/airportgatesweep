const https = require('https');

const FA_KEY = 'rdqRteiLRjx3W113fMI6dLux7JzAHWeU';

// In-memory picks — persists while the function instance is warm (hours)
// Fine for a same-day game. { "VA309": { "09:11|11:10": "12A" } }
const picks = {};

function fetchFA(faPath) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'aeroapi.flightaware.com',
      path: faPath,
      headers: { 'x-apikey': FA_KEY }
    };
    const req = https.get(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log('FA response:', res.statusCode, faPath);
        resolve({ statusCode: res.statusCode, body });
      });
    });
    req.on('error', (e) => {
      console.error('FA network error:', e.message);
      resolve({ statusCode: 500, body: JSON.stringify({ error: e.message }) });
    });
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ statusCode: 504, body: JSON.stringify({ error: 'FlightAware timeout' }) });
    });
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
    state,
    status:        fl.status || '',
    actual_dep:    toLocalTime(fl.actual_out    || fl.actual_off, depTz),
    actual_arr:    toLocalTime(fl.actual_in     || fl.actual_on,  arrTz),
    scheduled_dep: toLocalTime(fl.scheduled_out || fl.scheduled_off, depTz),
    scheduled_arr: toLocalTime(fl.scheduled_in  || fl.scheduled_on,  arrTz),
    estimated_dep: toLocalTime(fl.estimated_out || fl.estimated_off, depTz),
    estimated_arr: toLocalTime(fl.estimated_in  || fl.estimated_on,  arrTz),
  };
}

const respond = (statusCode, headers, obj) => ({
  statusCode, headers, body: JSON.stringify(obj)
});

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const method = event.httpMethod;

  // Parse path — strip function prefix
  let p = '';
  try {
    const url = new URL(event.rawUrl || event.path, 'https://x.x');
    p = url.pathname;
  } catch(e) { p = event.path || ''; }
  p = p.replace('/.netlify/functions/api', '');
  if (!p.startsWith('/')) p = '/' + p;
  console.log('PATH:', p, 'METHOD:', method);

  // ── GET /flight/VA309 ──
  const flightMatch = p.match(/^\/flight\/([A-Z0-9]+)$/i);
  if (flightMatch && method === 'GET') {
    const code = flightMatch[1].toUpperCase();
    const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(code)}?max_pages=1`);
    if (fa.statusCode !== 200) {
      console.error('FA error:', fa.statusCode, fa.body.substring(0,200));
      return respond(fa.statusCode, headers, { error: `FlightAware error ${fa.statusCode}: ${fa.body.substring(0,150)}` });
    }
    let data;
    try { data = JSON.parse(fa.body); } catch(e) {
      return respond(500, headers, { error: 'Bad JSON from FlightAware' });
    }
    const flights = data.flights || [];
    console.log(`${flights.length} flights for ${code}`);
    if (!flights.length) return respond(404, headers, { error: 'Flight not found — check the number' });

    // Pick today's flight first, then active, then scheduled, then first
    const todayUTC = new Date().toISOString().slice(0, 10);
    let fl = flights.find(f => (f.scheduled_out || f.scheduled_off || '').startsWith(todayUTC) && f.progress_percent < 100);
    if (!fl) fl = flights.find(f => (f.progress_percent || 0) > 0 && f.progress_percent < 100);
    if (!fl) fl = flights.find(f => f.status === 'Scheduled');
    if (!fl) fl = flights[0];
    console.log(`Using: ${fl.fa_flight_id} "${fl.status}" progress=${fl.progress_percent}%`);

    return respond(200, headers, {
      code,
      from: fl.origin?.code_iata      || fl.origin?.code      || '???',
      to:   fl.destination?.code_iata || fl.destination?.code || '???',
      ...flightStatus(fl)
    });
  }

  // ── GET /status/VA309 ──
  const statusMatch = p.match(/^\/status\/([A-Z0-9]+)$/i);
  if (statusMatch && method === 'GET') {
    const code = statusMatch[1].toUpperCase();
    const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(code)}?max_pages=1`);
    if (fa.statusCode !== 200) return respond(fa.statusCode, headers, { error: 'FlightAware error' });
    const data = JSON.parse(fa.body);
    const fl = (data.flights || [])[0] || {};
    return respond(200, headers, flightStatus(fl));
  }

  // ── GET /picks/VA309 ──
  const getPicksMatch = p.match(/^\/picks\/([A-Z0-9]+)$/i);
  if (getPicksMatch && method === 'GET') {
    const code = getPicksMatch[1].toUpperCase();
    return respond(200, headers, picks[code] || {});
  }

  // ── GET /picks/VA309/dep/09:11 ──
  const depPicksMatch = p.match(/^\/picks\/([A-Z0-9]+)\/dep\/(.+)$/i);
  if (depPicksMatch && method === 'GET') {
    const code    = depPicksMatch[1].toUpperCase();
    const depTime = decodeURIComponent(depPicksMatch[2]);
    const flightPicks = picks[code] || {};
    const arrTaken = {};
    for (const [combo, seat] of Object.entries(flightPicks)) {
      const [d, a] = combo.split('|');
      if (d === depTime) arrTaken[a] = seat;
    }
    return respond(200, headers, arrTaken);
  }

  // ── POST /picks/VA309 ──
  const postPicksMatch = p.match(/^\/picks\/([A-Z0-9]+)$/i);
  if (postPicksMatch && method === 'POST') {
    const code = postPicksMatch[1].toUpperCase();
    const { dep, arr, seat } = JSON.parse(event.body || '{}');
    if (!dep || !arr || !seat) return respond(400, headers, { error: 'Need dep, arr, seat' });
    if (!picks[code]) picks[code] = {};
    const combo = `${dep}|${arr}`;
    if (picks[code][combo]) return respond(409, headers, { error: 'combo_taken', takenBy: picks[code][combo] });
    picks[code][combo] = seat;
    console.log(`Locked: ${code} | ${seat} → ${dep} / ${arr}`);
    return respond(200, headers, { ok: true });
  }

  console.log('No route matched for path:', p);
  return respond(404, headers, { error: 'Not found' });
};
