// EQ + RS Talk Vote — ballot relay and 6:00 AM watcher (Cloudflare Worker)
//
// Binding:  BALLOTS (KV namespace "eq-rs-talk-vote")
// Vars:     SEASON, ROUND, BUDGET, SLOTS, CLOSES_AT, ALLOWED_ORIGIN, TALKS_URL,
//           PINS (JSON array of talk ids), ANONYMOUS ("true"/"false"), TRELLO_LIST_ID,
//           ORG_WEIGHTS (optional JSON, e.g. {"EQ":1,"RS":1,"BISHOP":0.5})
// Secrets:  VOTERS (JSON {token: {name, org}}), ADMIN_KEY,
//           DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN,
//           TRELLO_KEY, TRELLO_TOKEN
//
// Holds no phone numbers, emails, or addresses. Ballots hold talk ids and points only.

const headers = (origin) => ({
  'content-type': 'application/json',
  'access-control-allow-origin': origin,
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
});
const json = (body, status, origin) =>
  new Response(JSON.stringify(body), { status, headers: headers(origin) });

function cfg(env) {
  return {
    season: env.SEASON,
    round: Number(env.ROUND || 1),
    budget: Number(env.BUDGET),
    slots: Number(env.SLOTS),
    closesAt: Date.parse(env.CLOSES_AT),
    pins: JSON.parse(env.PINS || '[]'),
    voters: JSON.parse(env.VOTERS || '{}'),
    anonymous: env.ANONYMOUS === 'true',
    orgWeights: { EQ: 1, RS: 1, BISHOP: 0.5, ...JSON.parse(env.ORG_WEIGHTS || '{}') },
  };
}
const ballotKey = (c, token) => `ballot:${c.season}:r${c.round}:${token}`;
const finalKey = (c) => `final:${c.season}:r${c.round}`;
const runoffKey = (c, round) => `runoff:${c.season}:r${round}`;

// Talks eligible this round: all talks in round 1; only the runoff list afterward.
async function eligibleTalks(env, c) {
  // TALKS_URL may contain {season}, so each season reads its own talk list.
  const r = await fetch(env.TALKS_URL.replace('{season}', encodeURIComponent(c.season)), { cf: { cacheTtl: 300 } });
  if (!r.ok) throw new Error(`talks.json unavailable (${r.status})`);
  const data = await r.json();
  const all = (data.talks || data).map((t) => t.id);
  if (c.round === 1) return all;
  const runoff = JSON.parse((await env.BALLOTS.get(runoffKey(c, c.round))) || '[]');
  return all.filter((id) => runoff.includes(id));
}

function validate(body, c, eligible) {
  const points = body.points || {};
  const ok = new Set(eligible);
  let sum = 0;
  for (const [id, p] of Object.entries(points)) {
    if (!ok.has(id)) return `Unknown talk: ${id}`;
    if (!Number.isInteger(p) || p < 0 || p > 5) return 'Points must be whole numbers from 0 to 5.';
    if (c.pins.includes(id) && p > 0) return 'Pinned talks are already in and take no points.';
    sum += p;
  }
  if (sum > c.budget) return `Over budget: ${sum} of ${c.budget} points.`;
  // 90% of the budget, but never more than this round's talks can hold (5 points each).
  const floor = Math.min(Math.ceil(0.9 * c.budget), 5 * eligible.filter((id) => !c.pins.includes(id)).length);
  if (sum < floor) return `Please spend at least ${floor} of your ${c.budget} points.`;
  const keepers = body.keepers || [];
  if (c.round > 1 && keepers.length) return 'Keepers apply only in the first round.';
  if (keepers.length > 2) return 'At most two Keepers.';
  if (keepers.some((id) => points[id] !== 5)) return 'Each Keeper must carry 5 points.';
  return null;
}

async function listBallots(env, c) {
  const prefix = `ballot:${c.season}:r${c.round}:`;
  const out = [];
  let cursor;
  do {
    const page = await env.BALLOTS.list({ prefix, cursor });
    for (const k of page.keys) {
      const v = await env.BALLOTS.get(k.name);
      if (v) out.push(JSON.parse(v));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// Each group's ballots share that group's weight (ORG_WEIGHTS; EQ and RS 1 each, the bishop 0.5 by default),
// however many in the group actually voted. Only groups with at least one ballot count, so missing voters
// never break the tally: the weights are rescaled over whoever voted.
// score = weighted average points per ballot. Ties: supporters, then largest single gift, then talk id.
function tally(ballots, c, eligible) {
  const perOrg = {};
  for (const b of ballots) perOrg[b.org] = (perOrg[b.org] || 0) + 1;
  const weightOf = (org) => (org in c.orgWeights ? c.orgWeights[org] : 1);
  const totalWeight = Object.keys(perOrg).reduce((sum, org) => sum + weightOf(org), 0) || 1;
  const rows = new Map(
    eligible.map((id) => [id, { id, score: 0, rawPoints: 0, supporters: 0, maxSingle: 0, keepers: 0, pinned: c.pins.includes(id) }]),
  );
  for (const b of ballots) {
    const w = weightOf(b.org) / totalWeight / perOrg[b.org];
    for (const [id, p] of Object.entries(b.points)) {
      const r = rows.get(id);
      if (!r || !p) continue;
      r.score += p * w;
      r.rawPoints += p;
      r.supporters += 1;
      r.maxSingle = Math.max(r.maxSingle, p);
    }
    for (const id of b.keepers || []) if (rows.has(id)) rows.get(id).keepers += 1;
  }
  const ranked = [...rows.values()]
    .map((r) => ({ ...r, score: Math.round(r.score * 1000) / 1000 }))
    .sort(
      (a, b) =>
        b.pinned - a.pinned ||
        Number(b.keepers > 0) - Number(a.keepers > 0) ||
        b.score - a.score ||
        b.supporters - a.supporters ||
        b.maxSingle - a.maxSingle ||
        a.id.localeCompare(b.id),
    );
  const supported = ranked.filter((r) => r.pinned || r.keepers || r.rawPoints > 0);
  const shortfall = Math.max(0, c.slots - supported.length);
  return {
    perOrg,
    ranked,
    supportedCount: supported.length,
    shortfall,
    runoffNeeded: shortfall > 0,
    unsupported: ranked.filter((r) => !supported.includes(r)).map((r) => r.id),
  };
}

async function dropboxToken(env) {
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.DROPBOX_REFRESH_TOKEN,
      client_id: env.DROPBOX_APP_KEY,
      client_secret: env.DROPBOX_APP_SECRET,
    }),
  });
  if (!r.ok) throw new Error(`Dropbox token refresh failed (${r.status})`);
  return (await r.json()).access_token;
}

// Paths are relative to the app's own App Folder (/Apps/<app name>/ in Jason's Dropbox).
async function dropboxPut(env, path, obj) {
  const token = await dropboxToken(env);
  const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true }),
    },
    body: JSON.stringify(obj, null, 2),
  });
  if (!r.ok) throw new Error(`Dropbox upload failed (${r.status}): ${await r.text()}`);
}

async function trelloCard(env, name, desc) {
  const u = new URL('https://api.trello.com/1/cards');
  u.search = new URLSearchParams({
    idList: env.TRELLO_LIST_ID, key: env.TRELLO_KEY, token: env.TRELLO_TOKEN, name, desc, pos: 'top',
  }).toString();
  const r = await fetch(u, { method: 'POST' });
  if (!r.ok) throw new Error(`Trello card failed (${r.status})`);
}

function denverHour(now = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', hourCycle: 'h23' }).format(now),
  );
}

// opts: { ignoreHour, dryRun }
async function watch(env, opts = {}) {
  const c = cfg(env);
  if (!opts.ignoreHour && denverHour() !== 6) return { status: 'skipped', reason: 'not 6 AM in Denver' };
  if (!opts.dryRun && (await env.BALLOTS.get(finalKey(c)))) return { status: 'skipped', reason: 'already finalized' };

  const ballots = await listBallots(env, c);
  const voterCount = Object.keys(c.voters).length;
  const closed = Date.now() >= c.closesAt;
  if (!opts.dryRun && ballots.length < voterCount && !closed) {
    return { status: 'waiting', ballotsIn: ballots.length, voters: voterCount };
  }

  const eligible = await eligibleTalks(env, c);
  const t = tally(ballots, c, eligible);
  const label = (b, i) => (c.anonymous ? `${b.org} voter ${i + 1}` : b.name);
  const results = {
    season: c.season,
    round: c.round,
    generatedAt: new Date().toISOString(),
    closedEarly: ballots.length >= voterCount && !closed,
    ballotsIn: ballots.length,
    voters: voterCount,
    slots: c.slots,
    budget: c.budget,
    pins: c.pins,
    ...t,
    ballots: ballots.map((b, i) => ({ voter: label(b, i), org: b.org, points: b.points, keepers: b.keepers || [] })),
  };
  if (opts.dryRun) return { status: 'dry-run', results };

  await dropboxPut(env, `/${c.season}/results-round${c.round}.json`, results);
  if (t.runoffNeeded) {
    await env.BALLOTS.put(runoffKey(c, c.round + 1), JSON.stringify(t.unsupported));
    await trelloCard(
      env,
      `Talk vote: runoff needed (round ${c.round + 1})`,
      `${t.supportedCount} talks have support for ${c.slots} Sundays (short ${t.shortfall}). ` +
        `Results are in Dropbox: ${c.season}/results-round${c.round}.json. Ask Zion Claude: "Talk schedule" ` +
        `to weigh a two-Sunday talk versus a runoff. (Talk Vote watcher)`,
    );
  } else {
    await trelloCard(
      env,
      'Talk votes are in',
      `${ballots.length} of ${voterCount} ballots; ${t.supportedCount} talks supported for ${c.slots} Sundays. ` +
        `Results are in Dropbox: ${c.season}/results-round${c.round}.json. Say "Talk schedule" to Zion Claude. (Talk Vote watcher)`,
    );
  }
  await env.BALLOTS.put(finalKey(c), results.generatedAt);
  return { status: 'finalized', supportedCount: t.supportedCount, runoffNeeded: t.runoffNeeded };
}

export default {
  async fetch(req, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(origin) });
    const url = new URL(req.url);
    const c = cfg(env);

    try {
      // Voter: load own ballot and the round's settings.
      if (url.pathname === '/api/ballot' && req.method === 'GET') {
        const token = url.searchParams.get('t') || '';
        const voter = c.voters[token];
        if (!voter) return json({ error: 'This link is not recognized.' }, 403, origin);
        const saved = await env.BALLOTS.get(ballotKey(c, token));
        const open = Date.now() < c.closesAt && !(await env.BALLOTS.get(finalKey(c)));
        return json(
          {
            firstName: voter.name.split(' ')[0], org: voter.org, season: c.season, round: c.round,
            budget: c.budget, closesAt: new Date(c.closesAt).toISOString(), pins: c.pins,
            eligible: await eligibleTalks(env, c), open, saved: saved ? JSON.parse(saved) : null,
          },
          200, origin,
        );
      }

      // Voter: submit or change a ballot while voting is open.
      if (url.pathname === '/api/ballot' && req.method === 'POST') {
        const body = await req.json();
        const voter = c.voters[body.t || ''];
        if (!voter) return json({ error: 'This link is not recognized.' }, 403, origin);
        if (Date.now() >= c.closesAt || (await env.BALLOTS.get(finalKey(c)))) {
          return json({ error: 'Voting has closed for this round.' }, 409, origin);
        }
        const error = validate(body, c, await eligibleTalks(env, c));
        if (error) return json({ error }, 400, origin);
        const record = {
          name: voter.name, org: voter.org, submittedAt: new Date().toISOString(),
          points: Object.fromEntries(Object.entries(body.points).filter(([, p]) => p > 0)),
          keepers: body.keepers || [], triage: body.triage || {},
        };
        await env.BALLOTS.put(ballotKey(c, body.t), JSON.stringify(record));
        return json({ ok: true, submittedAt: record.submittedAt }, 200, origin);
      }

      // Jason only: who has voted (names only, never points), and dry or real runs.
      if (url.pathname.startsWith('/api/admin/')) {
        if (!env.ADMIN_KEY || url.searchParams.get('k') !== env.ADMIN_KEY) return json({ error: 'Not allowed.' }, 403, origin);
        if (url.pathname === '/api/admin/status') {
          const ballots = await listBallots(env, c);
          const voted = new Set(ballots.map((b) => b.name));
          return json(
            {
              season: c.season, round: c.round, closesAt: new Date(c.closesAt).toISOString(),
              ballotsIn: ballots.length, voters: Object.keys(c.voters).length,
              waitingOn: Object.values(c.voters).filter((v) => !voted.has(v.name)).map((v) => v.name),
              finalized: Boolean(await env.BALLOTS.get(finalKey(c))),
            },
            200, origin,
          );
        }
        if (url.pathname === '/api/admin/test-dropbox') {
          const path = `/${c.season}/hello.json`;
          await dropboxPut(env, path, { hello: 'from the Talk Vote Worker', at: new Date().toISOString() });
          return json({ ok: true, wrote: `/Apps/EQ RS Talk Vote${path}` }, 200, origin);
        }
        if (url.pathname === '/api/admin/test-trello') {
          await trelloCard(env, 'Talk Vote test card (safe to delete)', 'Posted by the Talk Vote Worker to confirm the Trello connection.');
          return json({ ok: true, posted: 'Test card at the top of the Inbox list' }, 200, origin);
        }
        if (url.pathname === '/api/admin/run') {
          const dryRun = url.searchParams.get('dry') !== '0';
          return json(await watch(env, { ignoreHour: true, dryRun }), 200, origin);
        }
      }
      return json({ error: 'Not found.' }, 404, origin);
    } catch (e) {
      return json({ error: e.message }, 500, origin);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      watch(env).then(
        (r) => console.log(JSON.stringify(r)),
        (e) => console.error(e.stack || e.message),
      ),
    );
  },
};
