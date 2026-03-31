// Auto-poller: runs every 2 minutes via Netlify scheduled functions
// Checks FlightAware for all active flights, locks times, awards winners automatically.

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

// Award winner for a flight — always uses code+date as canonical key
async function maybeAwardWinner(code, date, faId, depTime, arrTime, routeFrom, routeTo, routeFromCity, routeToCity, schedDep, schedArr) {
  const byCode = `flight_code=eq.${encodeURIComponent(code)}&flight_date=eq.${encodeURIComponent(date)}`;

  // Check not already awarded
  const existingW = await sbRequest('GET', `winners?${byCode}`);
  if (Array.isArray(existingW.data) && existingW.data.length) {
    console.log(`[poller] Winner already awarded for ${code}_${date}`);
    return;
  }

  // Get entries by code+date (covers all entries regardless of fa_flight_id)
  const entriesRes = await sbRequest('GET',
    `entries?${byCode}&order=created_at.asc&select=id,flight_code,flight_date,fa_flight_id,seat,dep_time,arr_time,mobile,created_at`
  );
  const entries = Array.isArray(entriesRes.data) ? entriesRes.data : [];
  if (!entries.length) { console.log(`[poller] No entries for ${code}_${date}`); return; }

  const scored = scoreEntries(entries, depTime, arrTime);
  const winner = scored[0];
  if (winner.score === null) { console.log(`[poller] Cannot score yet for ${code}_${date}`); return; }

  await sbRequest('DELETE', `winners?${byCode}`, null);
  await sbRequest('POST', 'winners', {
    flight_code:  code,
    flight_date:  date,
    fa_flight_id: faId || '',
    winner_seat:  winner.seat,
    winner_dep:   winner.dep_time,
    winner_arr:   winner.arr_time,
    winner_score: winner.score,
    actual_dep:   depTime,
    actual_arr:   arrTime,
    all_scores:   JSON.stringify(scored.map(({ boarding_pass, ...s }) => s)),
    published_at:  new Date().toISOString(),
    auto_awarded:  true,
    cancelled:     false,
    route_from:    routeFrom    || '',
    route_to:      routeTo      || '',
    route_from_city: routeFromCity || '',
    route_to_city:   routeToCity   || '',
    scheduled_dep: schedDep    || '',
    scheduled_arr: schedArr    || ''
  });
  console.log(`[poller] *** WINNER: ${code}_${date} → Seat ${winner.seat} score ${winner.score}m ***`);
}

async function pollAllActiveFlights() {
  console.log('[poller] Poll run at', new Date().toISOString());

  // 1. Get all entries — just code+date+fa_flight_id
  const entriesRes = await sbRequest('GET',
    'entries?order=created_at.asc&select=flight_code,flight_date,fa_flight_id,scheduled_out_utc'
  );
  const allEntries = Array.isArray(entriesRes.data) ? entriesRes.data : [];
  if (!allEntries.length) { console.log('[poller] No entries'); return; }

  // 2. Get all decided flights — keyed by code_date (the ONE true canonical key)
  const winnersRes = await sbRequest('GET', 'winners?select=flight_code,flight_date');
  const wonSet = new Set(
    (Array.isArray(winnersRes.data) ? winnersRes.data : [])
      .map(w => `${w.flight_code}_${w.flight_date}`)
  );

  // 3. Build unique flights to poll — always keyed by code_date
  const toCheck = new Map();
  allEntries.forEach(e => {
    const key = `${e.flight_code}_${e.flight_date || ''}`;
    if (!toCheck.has(key)) {
      toCheck.set(key, {
        code:     e.flight_code,
        date:     e.flight_date || '',
        faId:     e.fa_flight_id || '',
        schedUtc: e.scheduled_out_utc || ''
      });
    }
  });

  console.log(`[poller] ${toCheck.size} flights to check, ${wonSet.size} already decided`);

  for (const [key, { code, date, faId, schedUtc }] of toCheck) {
    // Skip if already decided
    if (wonSet.has(key)) { console.log(`[poller] Skip ${key} — decided`); continue; }

    try {
      const byCode = `flight_code=eq.${encodeURIComponent(code)}&flight_date=eq.${encodeURIComponent(date)}`;

      // Get existing locked actuals
      const actRes  = await sbRequest('GET', `actuals?${byCode}`);
      const existing = Array.isArray(actRes.data) && actRes.data.length ? actRes.data[0] : null;

      // If both times already locked → just make sure winner is awarded
      if (existing?.actual_dep && existing?.actual_arr) {
        console.log(`[poller] ${key}: both locked, checking winner`);
        await maybeAwardWinner(code, date, faId, existing.actual_dep, existing.actual_arr);
        continue;
      }

      // Query FlightAware
      // If we have a fa_flight_id, query it directly — exact leg, no ambiguity
      let fl = null;
      if (faId) {
        const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(faId)}`);
        if (fa.statusCode === 200) {
          const d = JSON.parse(fa.body);
          fl = Array.isArray(d.flights) ? d.flights[0] : null;
          // Validate it's the right flight
          if (fl && fl.fa_flight_id && fl.fa_flight_id !== faId) fl = null;
        }
      }

      // Fallback: search by code, match by date
      if (!fl) {
        const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(code)}?max_pages=1`);
        if (fa.statusCode !== 200) {
          console.log(`[poller] FA error ${fa.statusCode} for ${code}`);
          continue;
        }
        const d = JSON.parse(fa.body);
        const flights = d.flights || [];
        // Match priority:
        // 1. Exact fa_flight_id match
        // 2. scheduled_out_utc match (most reliable for multi-leg same-day flights)
        // 3. Date match fallback
        // 4. Only flight if single result
        fl = flights.find(f => faId && f.fa_flight_id === faId)
          || (schedUtc ? flights.find(f => (f.scheduled_out || f.scheduled_off || '') === schedUtc) : null)
          || flights.find(f => {
               const depIso = f.scheduled_out || f.scheduled_off || f.actual_out || f.actual_off;
               if (!depIso) return false;
               const tz = tzOffset(f.origin?.timezone || 'Australia/Brisbane');
               return toLocalDate(depIso, tz) === date;
             })
          || (flights.length === 1 ? flights[0] : null);
      }

      if (!fl) { console.log(`[poller] No FA match for ${key}`); continue; }

      const depTz   = tzOffset(fl.origin?.timezone      || 'Australia/Brisbane');
      const arrTz   = tzOffset(fl.destination?.timezone  || 'Australia/Brisbane');
      const gotDep  = toLocalTime(fl.actual_out || fl.actual_off, depTz);
      const gotArr  = toLocalTime(fl.actual_in  || fl.actual_on,  arrTz);
      const useFaId = fl.fa_flight_id || faId;

      // Never overwrite a locked value with null
      const depToSave = gotDep || existing?.actual_dep || null;
      const arrToSave = gotArr || existing?.actual_arr || null;

      console.log(`[poller] ${key}: dep=${depToSave||'—'} arr=${arrToSave||'—'}`);

      // Lock if we have new data
      const depIsNew = depToSave && depToSave !== existing?.actual_dep;
      const arrIsNew = arrToSave && arrToSave !== existing?.actual_arr;

      if (depIsNew || arrIsNew) {
        console.log(`[poller] LOCKING ${key}: dep=${depToSave} arr=${arrToSave||'pending'}`);
        await sbRequest('DELETE', `actuals?${byCode}`, null);
        await sbRequest('POST', 'actuals', {
          flight_code:  code,
          flight_date:  date,
          fa_flight_id: useFaId,
          actual_dep:   depToSave,
          actual_arr:   arrToSave || null,
          updated_at:   new Date().toISOString()
        });
      }

      // Award winner if both times known
      if (depToSave && arrToSave) {
        const routeFrom = fl.origin?.code_iata || fl.origin?.code || '';
        const routeTo   = fl.destination?.code_iata || fl.destination?.code || '';
        const routeFromCity = fl.origin?.city || '';
        const routeToCity   = fl.destination?.city || '';
        const schedDep  = toLocalTime(fl.scheduled_out || fl.scheduled_off, depTz) || '';
        const schedArr  = toLocalTime(fl.scheduled_in  || fl.scheduled_on,  arrTz) || '';
        await maybeAwardWinner(code, date, useFaId, depToSave, arrToSave, routeFrom, routeTo, routeFromCity, routeToCity, schedDep, schedArr);
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