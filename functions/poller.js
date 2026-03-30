// ── Auto-poller: runs every 2 minutes via Netlify scheduled functions ──
// Uses fa_flight_id as the unique key — solves multi-leg same-code flights.
// ZL6852 SYD->DBO and ZL6852 DBO->BHQ get different fa_flight_ids.
// Once a dep time is locked it is NEVER overwritten.

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

async function maybeAwardWinner(code, date, faId, depTime, arrTime) {
  // Check not already awarded for this specific leg
  const filter = faId
    ? `fa_flight_id=eq.${encodeURIComponent(faId)}`
    : `flight_code=eq.${encodeURIComponent(code)}&flight_date=eq.${encodeURIComponent(date)}`;

  const existing = await sbRequest('GET', `winners?${filter}`);
  if (Array.isArray(existing.data) && existing.data.length) {
    console.log(`[poller] Winner already awarded for ${code} [${faId}]`);
    return;
  }

  // Get entries for this specific leg
  const entriesRes = await sbRequest('GET',
    `entries?${filter}&order=created_at.asc&select=id,flight_code,flight_date,fa_flight_id,seat,dep_time,arr_time,mobile,created_at`
  );
  const entries = Array.isArray(entriesRes.data) ? entriesRes.data : [];
  if (!entries.length) { console.log(`[poller] No entries for ${code} [${faId}]`); return; }

  const scored = scoreEntries(entries, depTime, arrTime);
  const winner = scored[0];
  if (winner.score === null) { console.log(`[poller] Cannot score yet for ${code}`); return; }

  // Delete any existing winner record then insert
  await sbRequest('DELETE', `winners?${filter}`, null);
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
    published_at: new Date().toISOString(),
    auto_awarded: true,
    cancelled:    false
  });
  console.log(`[poller] *** WINNER: ${code}_${date} [${faId}] → Seat ${winner.seat} score ${winner.score}m ***`);
}

async function pollAllActiveFlights() {
  console.log('[poller] Poll run at', new Date().toISOString());

  // 1. Get all unique active flights from entries (fa_flight_id + code + date)
  const entriesRes = await sbRequest('GET',
    'entries?order=created_at.asc&select=flight_code,flight_date,fa_flight_id'
  );
  const entries = Array.isArray(entriesRes.data) ? entriesRes.data : [];
  if (!entries.length) { console.log('[poller] No entries'); return; }

  // 2. Get all decided flights
  const winnersRes = await sbRequest('GET', 'winners?select=flight_code,flight_date,fa_flight_id,cancelled');
  const wonSet = new Set(
    (Array.isArray(winnersRes.data) ? winnersRes.data : [])
      .map(w => w.fa_flight_id || `${w.flight_code}_${w.flight_date}`)
  );

  // 3. Build unique flights to check — keyed by fa_flight_id (most reliable) or code_date
  const toCheck = new Map();
  entries.forEach(e => {
    const key = e.fa_flight_id || `${e.flight_code}_${e.flight_date || ''}`;
    if (!toCheck.has(key)) toCheck.set(key, { code: e.flight_code, date: e.flight_date || '', faId: e.fa_flight_id || '' });
  });

  console.log(`[poller] ${toCheck.size} flights to check, ${wonSet.size} already decided`);

  for (const [key, { code, date, faId }] of toCheck) {
    if (wonSet.has(key)) { console.log(`[poller] Skip ${key} — decided`); continue; }

    try {
      // Check existing actuals
      const actFilter = faId
        ? `fa_flight_id=eq.${encodeURIComponent(faId)}`
        : `flight_code=eq.${encodeURIComponent(code)}&flight_date=eq.${encodeURIComponent(date)}`;
      const actRes  = await sbRequest('GET', `actuals?${actFilter}`);
      const existing = Array.isArray(actRes.data) && actRes.data.length ? actRes.data[0] : null;

      // If both locked, just check winner
      if (existing?.actual_dep && existing?.actual_arr) {
        await maybeAwardWinner(code, date, faId, existing.actual_dep, existing.actual_arr);
        continue;
      }

      // Query FlightAware — use fa_flight_id directly if we have it (EXACT leg, no ambiguity)
      let fl = null;
      if (faId) {
        const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(faId)}`);
        if (fa.statusCode === 200) {
          const d = JSON.parse(fa.body);
          fl = (d.flights || [d])[0] || null;
        }
      }
      // Fallback to code search
      if (!fl) {
        const fa = await fetchFA(`/aeroapi/flights/${encodeURIComponent(code)}?max_pages=1`);
        if (fa.statusCode !== 200) { console.log(`[poller] FA error ${fa.statusCode} for ${code}`); continue; }
        const d       = JSON.parse(fa.body);
        const flights = d.flights || [];
        // Match by fa_flight_id if possible, else by date
        fl = flights.find(f => f.fa_flight_id === faId) ||
             flights.find(f => {
               const depIso = f.scheduled_out || f.scheduled_off || f.actual_out;
               if (!depIso) return false;
               const tz     = tzOffset(f.origin?.timezone || 'Australia/Brisbane');
               return toLocalDate(depIso, tz) === date;
             }) ||
             flights[0];
      }

      if (!fl) { console.log(`[poller] No FA data for ${key}`); continue; }

      const depTz  = tzOffset(fl.origin?.timezone      || 'Australia/Brisbane');
      const arrTz  = tzOffset(fl.destination?.timezone  || 'Australia/Brisbane');
      const newDep = toLocalTime(fl.actual_out || fl.actual_off, depTz) || existing?.actual_dep || null;
      const newArr = toLocalTime(fl.actual_in  || fl.actual_on,  arrTz) || existing?.actual_arr || null;
      const useFaId = fl.fa_flight_id || faId;

      console.log(`[poller] ${key}: dep=${newDep||'—'} arr=${newArr||'—'}`);

      // Lock dep the moment it appears — NEVER overwrite with null
      const depToSave = newDep || existing?.actual_dep || null;
      const arrToSave = newArr || existing?.actual_arr || null;

      if (depToSave !== existing?.actual_dep || arrToSave !== existing?.actual_arr) {
        if (depToSave) {
          console.log(`[poller] LOCKING ${key}: dep=${depToSave} arr=${arrToSave||'pending'}`);
          await sbRequest('DELETE', `actuals?${actFilter}`, null);
          await sbRequest('POST', 'actuals', {
            flight_code:  code,
            flight_date:  date,
            fa_flight_id: useFaId,
            actual_dep:   depToSave,
            actual_arr:   arrToSave || null,
            updated_at:   new Date().toISOString()
          });
        }
      }

      // Award winner if both known
      if (depToSave && arrToSave) {
        await maybeAwardWinner(code, date, useFaId, depToSave, arrToSave);
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