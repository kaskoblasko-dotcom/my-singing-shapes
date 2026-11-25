// My Singing Shapes — game server (accounts, cloud saves, friends, visits, likes, gifts)
// Runs on Render: set DATABASE_URL to your Render Postgres connection string.
// Without DATABASE_URL it uses an in-memory store (handy for local testing; data is lost on restart).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const GIFTS = { coins: 1000, food: 200 };
const MAX_SAVE = 2 * 1024 * 1024;

// ---------------- password + token helpers ----------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}
const newToken = () => crypto.randomBytes(32).toString('hex');
function newCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 8; i++) s += A[crypto.randomInt(A.length)]; return s; }
const today = () => new Date().toISOString().slice(0, 10);

// ---------------- storage: Postgres ----------------
function pgStore(url) {
  const { Pool } = require('pg');
  const local = /localhost|127\.0\.0\.1/.test(url);
  const internal = !/\./.test((url.split('@')[1] || '').split(/[:/]/)[0]); // Render internal hostnames have no dots
  const pool = new Pool({ connectionString: url, ssl: local || internal ? false : { rejectUnauthorized: false } });
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;
  return {
    async init() {
      await q(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, code TEXT UNIQUE NOT NULL, level INT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS saves (user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS friend_requests (from_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (from_id, to_id));
        CREATE TABLE IF NOT EXISTS friends (user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, friend_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (user_id, friend_id));
        CREATE TABLE IF NOT EXISTS likes (from_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, island TEXT NOT NULL, PRIMARY KEY (from_id, to_id, island));
        CREATE TABLE IF NOT EXISTS gifts (id SERIAL PRIMARY KEY, from_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, amount INT NOT NULL, day DATE NOT NULL, claimed BOOLEAN NOT NULL DEFAULT false, UNIQUE (from_id, to_id, day));`);
    },
    createUser: (u, pass, code) => one('INSERT INTO users (username, pass, code) VALUES ($1,$2,$3) RETURNING *', [u, pass, code]),
    userByName: u => one('SELECT * FROM users WHERE username=$1', [u]),
    userById: id => one('SELECT * FROM users WHERE id=$1', [id]),
    userByCode: c => one('SELECT * FROM users WHERE code=$1', [c]),
    addSession: (t, uid) => q('INSERT INTO sessions (token, user_id) VALUES ($1,$2)', [t, uid]),
    sessionUser: t => one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1', [t]),
    delSession: t => q('DELETE FROM sessions WHERE token=$1', [t]),
    getSave: async uid => { const r = await one('SELECT data FROM saves WHERE user_id=$1', [uid]); return r ? r.data : null; },
    putSave: async (uid, data, level) => { await q('INSERT INTO saves (user_id, data, updated_at) VALUES ($1,$2,now()) ON CONFLICT (user_id) DO UPDATE SET data=$2, updated_at=now()', [uid, data]); await q('UPDATE users SET level=$2 WHERE id=$1', [uid, level]); },
    addRequest: (a, b) => q('INSERT INTO friend_requests (from_id, to_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [a, b]),
    hasRequest: async (a, b) => !!(await one('SELECT 1 FROM friend_requests WHERE from_id=$1 AND to_id=$2', [a, b])),
    delRequest: (a, b) => q('DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2', [a, b]),
    incoming: async uid => (await q('SELECT u.id, u.username, u.level FROM friend_requests r JOIN users u ON u.id=r.from_id WHERE r.to_id=$1 ORDER BY r.created_at', [uid])).rows,
    outgoing: async uid => (await q('SELECT u.id, u.username, u.level FROM friend_requests r JOIN users u ON u.id=r.to_id WHERE r.from_id=$1 ORDER BY r.created_at', [uid])).rows,
    addFriend: async (a, b) => { await q('INSERT INTO friends VALUES ($1,$2) ON CONFLICT DO NOTHING', [a, b]); await q('INSERT INTO friends VALUES ($1,$2) ON CONFLICT DO NOTHING', [b, a]); },
    delFriend: async (a, b) => { await q('DELETE FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)', [a, b]); },
    areFriends: async (a, b) => !!(await one('SELECT 1 FROM friends WHERE user_id=$1 AND friend_id=$2', [a, b])),
    friends: async uid => (await q('SELECT u.id, u.username, u.level FROM friends f JOIN users u ON u.id=f.friend_id WHERE f.user_id=$1 ORDER BY u.username', [uid])).rows,
    addLike: (a, b, isl) => q('INSERT INTO likes VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [a, b, isl]),
    likeCounts: async uid => { const o = {}; (await q('SELECT island, COUNT(*)::int n FROM likes WHERE to_id=$1 GROUP BY island', [uid])).rows.forEach(r => o[r.island] = r.n); return o; },
    myLikes: async (a, b) => (await q('SELECT island FROM likes WHERE from_id=$1 AND to_id=$2', [a, b])).rows.map(r => r.island),
    addGift: async (a, b, kind, amount, day) => (await q('INSERT INTO gifts (from_id, to_id, kind, amount, day) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id', [a, b, kind, amount, day])).rowCount > 0,
    gifts: async uid => (await q('SELECT g.id, g.kind, g.amount, u.username AS from_name FROM gifts g JOIN users u ON u.id=g.from_id WHERE g.to_id=$1 AND NOT g.claimed ORDER BY g.id', [uid])).rows,
    giftedToday: async (uid, day) => (await q('SELECT to_id FROM gifts WHERE from_id=$1 AND day=$2', [uid, day])).rows.map(r => r.to_id),
    claimGift: (id, uid) => one('UPDATE gifts SET claimed=true WHERE id=$1 AND to_id=$2 AND NOT claimed RETURNING kind, amount', [id, uid]),
  };
}

// ---------------- storage: in-memory (local testing) ----------------
function memStore() {
  const users = [], sessions = new Map(), saves = new Map(), reqs = [], fr = new Set(), likes = new Set(), gifts = [];
  let uid = 1, gid = 1;
  const pub = u => u && { id: u.id, username: u.username, level: u.level };
  return {
    async init() {},
    async createUser(username, pass, code) { if (users.some(u => u.username === username)) throw Object.assign(new Error('dup'), { code: '23505' }); const u = { id: uid++, username, pass, code, level: 1 }; users.push(u); return u; },
    async userByName(n) { return users.find(u => u.username === n) || null; },
    async userById(id) { return users.find(u => u.id === id) || null; },
    async userByCode(c) { return users.find(u => u.code === c) || null; },
    async addSession(t, id) { sessions.set(t, id); },
    async sessionUser(t) { const id = sessions.get(t); return id ? users.find(u => u.id === id) : null; },
    async delSession(t) { sessions.delete(t); },
    async getSave(id) { return saves.get(id) || null; },
    async putSave(id, data, level) { saves.set(id, data); users.find(u => u.id === id).level = level; },
    async addRequest(a, b) { if (!reqs.some(r => r.a === a && r.b === b)) reqs.push({ a, b }); },
    async hasRequest(a, b) { return reqs.some(r => r.a === a && r.b === b); },
    async delRequest(a, b) { const i = reqs.findIndex(r => r.a === a && r.b === b); if (i >= 0) reqs.splice(i, 1); },
    async incoming(id) { return reqs.filter(r => r.b === id).map(r => pub(users.find(u => u.id === r.a))); },
    async outgoing(id) { return reqs.filter(r => r.a === id).map(r => pub(users.find(u => u.id === r.b))); },
    async addFriend(a, b) { fr.add(a + ':' + b); fr.add(b + ':' + a); },
    async delFriend(a, b) { fr.delete(a + ':' + b); fr.delete(b + ':' + a); },
    async areFriends(a, b) { return fr.has(a + ':' + b); },
    async friends(id) { return users.filter(u => fr.has(id + ':' + u.id)).map(pub); },
    async addLike(a, b, i) { likes.add(`${a}:${b}:${i}`); },
    async likeCounts(id) { const o = {}; for (const k of likes) { const [, b, i] = k.split(':'); if (+b === id) o[i] = (o[i] || 0) + 1; } return o; },
    async myLikes(a, b) { return [...likes].filter(k => k.startsWith(`${a}:${b}:`)).map(k => k.split(':')[2]); },
    async addGift(a, b, kind, amount, day) { if (gifts.some(g => g.a === a && g.b === b && g.day === day)) return false; gifts.push({ id: gid++, a, b, kind, amount, day, claimed: false }); return true; },
    async gifts(id) { return gifts.filter(g => g.b === id && !g.claimed).map(g => ({ id: g.id, kind: g.kind, amount: g.amount, from_name: users.find(u => u.id === g.a).username })); },
    async giftedToday(id, day) { return gifts.filter(g => g.a === id && g.day === day).map(g => g.b); },
    async claimGift(gidv, id) { const g = gifts.find(x => x.id === gidv && x.b === id && !x.claimed); if (!g) return null; g.claimed = true; return { kind: g.kind, amount: g.amount }; },
  };
}

const db = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : memStore();

// ---------------- http helpers ----------------
function send(res, status, obj) { const body = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(body); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_SAVE + 1024) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const publicUser = u => ({ id: u.id, username: u.username, code: u.code, level: u.level });
const validName = n => typeof n === 'string' && /^[a-z0-9_]{3,16}$/.test(n);

// simple per-IP limiter for login/signup
const hits = new Map();
function limited(ip, key, max, windowMs) {
  const k = ip + key, t = Date.now(), arr = (hits.get(k) || []).filter(x => t - x < windowMs); arr.push(t); hits.set(k, arr); return arr.length > max;
}

async function auth(req, body) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (body && body.token);
  if (!token) return null;
  return db.sessionUser(token);
}

// ---------------- routes ----------------
const routes = {
  'POST /api/signup': async (req, body) => {
    if (limited(req.socket.remoteAddress, 'signup', 10, 60 * 60 * 1000)) return [429, { error: 'Too many sign-ups. Try again later.' }];
    const username = String(body.username || '').trim().toLowerCase(), password = String(body.password || '');
    if (!validName(username)) return [400, { error: 'Username must be 3-16 letters, numbers or _' }];
    if (password.length < 6) return [400, { error: 'Password must be at least 6 characters' }];
    let user;
    for (let i = 0; i < 5 && !user; i++) {
      try { user = await db.createUser(username, hashPassword(password), newCode()); }
      catch (e) { if (e.code === '23505' && /username/.test(e.detail || e.constraint || 'username')) { if (await db.userByName(username)) return [409, { error: 'That username is taken' }]; } else throw e; }
    }
    const token = newToken(); await db.addSession(token, user.id);
    return [200, { token, user: publicUser(user), save: null }];
  },
  'POST /api/login': async (req, body) => {
    if (limited(req.socket.remoteAddress, 'login', 20, 15 * 60 * 1000)) return [429, { error: 'Too many attempts. Wait a few minutes.' }];
    const username = String(body.username || '').trim().toLowerCase(), user = await db.userByName(username);
    if (!user || !checkPassword(String(body.password || ''), user.pass)) return [401, { error: 'Wrong username or password' }];
    const token = newToken(); await db.addSession(token, user.id);
    return [200, { token, user: publicUser(user), save: await db.getSave(user.id), likes: await db.likeCounts(user.id) }];
  },
  'POST /api/logout': async (req, body, me, token) => { if (token) await db.delSession(token); return [200, { ok: true }]; },
  'GET /api/me': async (req, body, me) => [200, { user: publicUser(me), save: await db.getSave(me.id), likes: await db.likeCounts(me.id) }],
  'POST /api/save': async (req, body, me) => {
    const data = body.data; if (!data || typeof data !== 'object') return [400, { error: 'No save data' }];
    await db.putSave(me.id, data, Math.max(1, Math.min(999, parseInt(data.level) || 1)));
    return [200, { ok: true, at: Date.now() }];
  },
  'GET /api/friends': async (req, body, me) => {
    const [friends, incoming, outgoing, gifts, gifted, likes] = await Promise.all([db.friends(me.id), db.incoming(me.id), db.outgoing(me.id), db.gifts(me.id), db.giftedToday(me.id, today()), db.likeCounts(me.id)]);
    return [200, { me: publicUser(me), friends, incoming, outgoing, gifts, giftedToday: gifted, likes }];
  },
  'POST /api/friends/request': async (req, body, me) => {
    const qv = String(body.query || '').trim(); if (!qv) return [400, { error: 'Enter a username or friend code' }];
    const other = (await db.userByName(qv.toLowerCase())) || (await db.userByCode(qv.toUpperCase()));
    if (!other) return [404, { error: 'No player found with that name or code' }];
    if (other.id === me.id) return [400, { error: "That's you!" }];
    if (await db.areFriends(me.id, other.id)) return [400, { error: `You're already friends with ${other.username}` }];
    if (body.invite) { await db.delRequest(other.id, me.id); await db.delRequest(me.id, other.id); await db.addFriend(me.id, other.id); return [200, { ok: true, friended: other.username }]; } // opened their invite link
    if (await db.hasRequest(other.id, me.id)) { await db.delRequest(other.id, me.id); await db.addFriend(me.id, other.id); return [200, { ok: true, friended: other.username }]; }
    await db.addRequest(me.id, other.id); return [200, { ok: true, sent: other.username }];
  },
  'POST /api/friends/respond': async (req, body, me) => {
    const from = parseInt(body.id); if (!(await db.hasRequest(from, me.id))) return [404, { error: 'Request not found' }];
    await db.delRequest(from, me.id); if (body.accept) await db.addFriend(me.id, from);
    return [200, { ok: true }];
  },
  'POST /api/friends/cancel': async (req, body, me) => { await db.delRequest(me.id, parseInt(body.id)); return [200, { ok: true }]; },
  'POST /api/friends/remove': async (req, body, me) => { await db.delFriend(me.id, parseInt(body.id)); return [200, { ok: true }]; },
  'GET /api/visit': async (req, body, me, token, url) => {
    const id = parseInt(url.searchParams.get('id'));
    if (!(await db.areFriends(me.id, id))) return [403, { error: 'You can only visit friends' }];
    const u = await db.userById(id), save = await db.getSave(id);
    return [200, { user: publicUser(u), save, likes: await db.likeCounts(id), myLikes: await db.myLikes(me.id, id) }];
  },
  'POST /api/like': async (req, body, me) => {
    const id = parseInt(body.id), island = String(body.island || '').slice(0, 24);
    if (!(await db.areFriends(me.id, id))) return [403, { error: 'You can only like friends\' islands' }];
    await db.addLike(me.id, id, island); return [200, { ok: true, likes: await db.likeCounts(id) }];
  },
  'POST /api/gift': async (req, body, me) => {
    const id = parseInt(body.id), kind = body.kind === 'food' ? 'food' : 'coins';
    if (!(await db.areFriends(me.id, id))) return [403, { error: 'You can only gift friends' }];
    if (!(await db.addGift(me.id, id, kind, GIFTS[kind], today()))) return [400, { error: 'You already sent them a gift today' }];
    return [200, { ok: true }];
  },
  'POST /api/gifts/claim': async (req, body, me) => {
    const g = await db.claimGift(parseInt(body.id), me.id); if (!g) return [404, { error: 'Gift not found' }];
    return [200, { ok: true, kind: g.kind, amount: g.amount }];
  },
};
const PUBLIC_ROUTES = new Set(['POST /api/signup', 'POST /api/login']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const key = `${req.method} ${url.pathname}`, fn = routes[key];
      if (!fn) return send(res, 404, { error: 'Not found' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      const h = req.headers.authorization || '', token = h.startsWith('Bearer ') ? h.slice(7) : body.token;
      let me = null;
      if (!PUBLIC_ROUTES.has(key)) { me = await auth(req, body); if (!me) return send(res, 401, { error: 'Please log in again' }); }
      const [status, obj] = await fn(req, body, me, token, url);
      return send(res, status, obj);
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    // static files
    let file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(full).toLowerCase(), types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' }); res.end(data);
    });
  } catch (e) {
    console.error(e); send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
});

db.init().then(() => server.listen(PORT, () => console.log(`My Singing Shapes server on :${PORT} (${process.env.DATABASE_URL ? 'Postgres' : 'in-memory store'})`)))
  .catch(e => { console.error('Database init failed:', e); process.exit(1); });
