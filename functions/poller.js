// Auto-poller: runs every 2 minutes
// Uses flight_code + route_from + route_to as unique key
// ZL6852_SYD_DBO and ZL6852_DBO_BHQ are completely separate contests

const https = require('https');

const FA_KEY = 'rdqRteiLRjx3W113fMI6dLux7JzAHWeU';
const SB_URL = 'udcriobsizpalijmwoxr.supabase.co';
const SB_KEY = 'sb_secret_1Ih1D7T0GuHt-MkMNhjXkQ_KfxKGuPG';

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
    req.setTimeout(12000, () => { req.destroy(); resolve({ statusCode: 504, body: '{}' }); });
  });
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

function timeToMins(t) {
  if (!t) return null;
  const clean = t.replace(/^[<>]\s*/, '');
  const parts = clean.split(':').map(Number);
  if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
  return parts[0] * 60 + parts[1];
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

function routeFilter(code, from, to) {
  return `flight_code=eq.${encodeURIComponent(code)}&route_from=eq.${encodeURIComponent(from)}&route_to=eq.${encodeURIComponent(to)}`;
}

async function maybeAwardWinner(code, from, to, date, depTime, arrTime, fromCity, toCity, schedDep, schedArr) {
  const filter = routeFilter(code, from, to);

  // Check already awarded
  const existingW = await sbRequest('GET', `winners?${filter}`);
  if (Array.isArray(existingW.data) && existingW.data.length) {
    console.log(`[poller] Winner already awarded for ${code}_${from}_${to}`);
    return;
  }

  // Get entries
  const entriesRes = await sbRequest('GET',
    `entries?${filter}&order=created_at.asc&select=id,flight_code,flight_date,route_from,route_to,seat,dep_time,arr_time,mobile,created_at`
  );
  const entries = Array.isArray(entriesRes.data) ? entriesRes.data : [];
  if (!entries.length) { console.log(`[poller] No entries for ${code}_${from}_${to}`); return; }

  const scored = scoreEntries(entries, depTime, arrTime);
  if (!scored.length || scored[0].score === null) { console.log(`[poller] Cannot score yet`); return; }

  const exactWinner = scored.find(e => e.depDiff === 0 && e.arrDiff === 0);

  await sbRequest('DELETE', `winners?${filter}`, null);
  await sbRequest('POST', 'winners', {
    flight_code:     code,
    flight_date:     date,
    route_from:      from,
    route_to:        to,
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
    route_from_city: fromCity || '',
    route_to_city:   toCity   || '',
    scheduled_dep:   schedDep || '',
    scheduled_arr:   schedArr || '',
    fa_flight_id:    ''
  });

  if (exactWinner) {
    console.log(`[poller] *** EXACT WINNER: ${code} ${from}->${to} Seat ${exactWinner.seat} ***`);
  } else {
    console.log(`[poller] No exact winner for ${code} ${from}->${to}`);
  }
}

async function pollAllActiveFlights() {
  console.log('[poller] Poll run at', new Date().toISOString());

  // 1. Get all entries — code + route_from + route_to
  const entriesRes = await sbRequest('GET',
    'entries?order=created_at.asc&select=flight_code,flight_date,route_from,route_to'
  );
  const allEntries = Array.isArray(entriesRes.data) ? entriesRes.data : [];
  if (!allEntries.length) { console.log('[poller] No entries'); return; }

  // 2. Get all decided — keyed by code_from_to
  const winnersRes = await sbRequest('GET', 'winners?select=flight_code,route_from,route_to');
  const wonSet = new Set(
    (Array.isArray(winnersRes.data) ? winnersRes.data : [])
      .map(w => `${w.flight_code}_${w.route_from}_${w.route_to}`)
  );

  // 3. Build unique flights
  const toCheck = new Map();
  allEntries.forEach(e => {
    const key = `${e.flight_code}_${e.route_from || ''}_${e.route_to || ''}`;
    if (!toCheck.has(key)) {
      toCheck.set(key, {
        code: e.flight_code,
        from: e.route_from || '',
        to:   e.route_to   || '',
        date: e.flight_date || ''
      });
    }
  });

  console.log(`[poller] ${toCheck.size} flights to check, ${wonSet.size} already decided`);

  for (const [key, { code, from, to, date }] of toCheck) {
    if (wonSet.has(key)) { console.log(`[poller] Skip ${key} — decided`); continue; }

    try {
      const filter = routeFilter(code, from, to);

      // Check existing actuals
      const actRes  = await sbRequest('GET', `actuals?${filter}`);
      const existing = Array.isArray(actRes.data) && actRes.data.length ? actRes.data[0] : null;

      // Both locked — check winner
      if (existing?.actual_dep && existing?.actual_arr) {
        console.log(`[poller] ${key}: both locked, checking winner`);
        await maybeAwardWinner(code, from, to, date, existing.actual_dep, existing.actual_arr, '', '', '', '');
        continue;
      }

      // Query FlightAware — search by code then filter by exact route
      const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(code)}?max_pages=1`);
      if (fa.statusCode !== 200) { console.log(`[poller] FA error for ${code}`); continue; }

      const faData  = JSON.parse(fa.body);
      const flights = faData.flights || [];

      // Find the leg matching our exact route (FROM → TO)
      const fl = flights.find(f => {
        const fFrom = (f.origin?.code_iata || f.origin?.code || '').toUpperCase();
        const fTo   = (f.destination?.code_iata || f.destination?.code || '').toUpperCase();
        return fFrom === from.toUpperCase() && fTo === to.toUpperCase();
      });

      if (!fl) { console.log(`[poller] No FA match for ${key}`); continue; }

      const depTz  = tzOffset(fl.origin?.timezone      || 'Australia/Brisbane');
      const arrTz  = tzOffset(fl.destination?.timezone  || 'Australia/Brisbane');
      const gotDep = toLocalTime(fl.actual_out || fl.actual_off, depTz);
      const gotArr = toLocalTime(fl.actual_in, arrTz); // gate arrival only
      const useDate = toLocalDate(fl.scheduled_out || fl.scheduled_off || fl.actual_out, depTz) || date;

      const depToSave = gotDep || existing?.actual_dep || null;
      const arrToSave = gotArr || existing?.actual_arr || null;

      console.log(`[poller] ${key}: dep=${depToSave||'—'} arr=${arrToSave||'—'}`);

      const depIsNew = depToSave && depToSave !== existing?.actual_dep;
      const arrIsNew = arrToSave && arrToSave !== existing?.actual_arr;

      if (depIsNew || arrIsNew) {
        console.log(`[poller] LOCKING ${key}: dep=${depToSave} arr=${arrToSave||'pending'}`);
        await sbRequest('DELETE', `actuals?${filter}`, null);
        await sbRequest('POST', 'actuals', {
          flight_code: code,
          flight_date: useDate,
          route_from:  from,
          route_to:    to,
          actual_dep:  depToSave,
          actual_arr:  arrToSave || null,
          updated_at:  new Date().toISOString()
        });
      }

      if (depToSave && arrToSave) {
        const schedDep = toLocalTime(fl.scheduled_out || fl.scheduled_off, depTz) || '';
        const schedArr = toLocalTime(fl.scheduled_in  || fl.scheduled_on,  arrTz) || '';
        await maybeAwardWinner(
          code, from, to, useDate, depToSave, arrToSave,
          fl.origin?.city || '', fl.destination?.city || '',
          schedDep, schedArr
        );
      }

    } catch(e) {
      console.error(`[poller] Error for ${key}:`, e.message);
    }
  }

  console.log('[poller] Done');
}

exports.handler = async () => {
  try {
    await pollAllActiveFlights();
    return { statusCode: 200, body: 'OK' };
  } catch(e) {
    console.error('[poller] Fatal:', e);
    return { statusCode: 500, body: e.message };
  }
};