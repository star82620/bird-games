// Leaderboard API for 夜鷹吃蟲.
// GET  /scores  -> { top: [{ name, score }] }
// POST /scores  { name, score } -> { rank, top }

const TOP_N = 10;
const NAME_MAX = 10;
// A 60-second night passes roughly 40 lamps at most, each with up to 17 insects nearby.
const MAX_SCORE = 800;
const RATE_WINDOW_SEC = 15;
const RATE_KEEP_SEC = 600;

const BLOCKED = [
  '幹你', '幹妳', '靠北', '靠杯', '雞掰', '機掰', '屌', '操你', '王八', '智障', '白癡', '白痴', '垃圾',
  'fuck', 'shit', 'bitch', 'dick', 'cunt', 'nigger'
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname !== '/scores') return json({ error: 'not_found' }, 404, cors);

    try {
      if (request.method === 'GET') return json({ top: await topScores(env) }, 200, cors);
      if (request.method === 'POST') return await submit(request, env, cors);
      return json({ error: 'method_not_allowed' }, 405, cors);
    } catch (err) {
      console.error(err);
      return json({ error: 'server_error' }, 500, cors);
    }
  }
};

function corsHeaders(request, env) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

async function topScores(env) {
  const { results } = await env.DB
    .prepare('SELECT name, score FROM scores ORDER BY score DESC, created_at ASC, id ASC LIMIT ?')
    .bind(TOP_N)
    .all();
  return results;
}

// Returns { name } on success or { error } with a code the game turns into a message.
function cleanName(raw) {
  if (typeof raw !== 'string') return { error: 'name_invalid' };
  const name = raw
    .normalize('NFKC')
    .replace(/[\p{C}\p{Z}]+/gu, ' ')
    .replace(/[<>&"'`]/g, '')
    .trim()
    .replace(/ +/g, ' ');
  const length = [...name].length;
  if (length < 1 || length > NAME_MAX) return { error: 'name_invalid' };
  const compact = name.toLowerCase().replace(/ /g, '');
  if (BLOCKED.some(word => compact.includes(word))) return { error: 'name_blocked' };
  return { name };
}

async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function submit(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400, cors);
  }

  const cleaned = cleanName(body && body.name);
  if (cleaned.error) return json({ error: cleaned.error }, 400, cors);

  const score = body.score;
  if (!Number.isInteger(score) || score < 1 || score > MAX_SCORE) {
    return json({ error: 'score_invalid' }, 400, cors);
  }

  // Rate limit by a salted hash of the IP; the raw IP is never stored and hashes expire after 10 minutes.
  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const ipHash = await sha256(`${env.IP_SALT || ''}:${ip}`);
  await env.DB.prepare('DELETE FROM recent_submits WHERE at < ?').bind(now - RATE_KEEP_SEC).run();
  const recent = await env.DB
    .prepare('SELECT 1 FROM recent_submits WHERE ip_hash = ? AND at > ? LIMIT 1')
    .bind(ipHash, now - RATE_WINDOW_SEC)
    .first();
  if (recent) return json({ error: 'too_fast' }, 429, cors);

  const [inserted] = await env.DB.batch([
    env.DB.prepare('INSERT INTO scores (name, score, created_at) VALUES (?, ?, ?)').bind(cleaned.name, score, now),
    env.DB.prepare('INSERT INTO recent_submits (ip_hash, at) VALUES (?, ?)').bind(ipHash, now)
  ]);
  const id = inserted.meta.last_row_id;

  // Same order as topScores: ties go to whoever got the score first.
  const { rank } = await env.DB
    .prepare(`SELECT COUNT(*) + 1 AS rank FROM scores
              WHERE score > ?1 OR (score = ?1 AND (created_at < ?2 OR (created_at = ?2 AND id < ?3)))`)
    .bind(score, now, id)
    .first();
  return json({ rank, top: await topScores(env) }, 201, cors);
}
