const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('node:https');
const { URL } = require('node:url');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'sector8.sqlite');
const SUPABASE_CONFIG_PATH = path.join(ROOT, 'supabase.local.json');

const SAFE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PLAYER_ID_LENGTH = 14;
const FRIEND_CODE_LENGTH = 12;
const LEVEL_EXP_PER_LEVEL = 100;
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function now() {
  return Date.now();
}

function normalizePlayerId(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function normalizeFriendCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function formatFriendCode(code) {
  const normalized = normalizeFriendCode(code);
  if (normalized.length !== FRIEND_CODE_LENGTH) return normalized;
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}`;
}

function sanitizeDisplayName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 24);
}

function safeId(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += SAFE_ALPHABET[bytes[i] % SAFE_ALPHABET.length];
  }
  return out;
}

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const normalizedPin = String(pin || '').trim();
  const digest = crypto.scryptSync(normalizedPin, salt, 64).toString('hex');
  return { salt, hash: digest };
}

function verifyPin(pin, salt, hash) {
  const candidate = hashPin(pin, salt).hash;
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
}

function applyExperience(level, exp, gained) {
  let nextLevel = level;
  let nextExp = exp + gained;
  while (nextExp >= LEVEL_EXP_PER_LEVEL) {
    nextExp -= LEVEL_EXP_PER_LEVEL;
    nextLevel += 1;
  }
  return { level: nextLevel, exp: nextExp };
}

function adjustExperience(level, exp, delta) {
  if (!delta) return { level, exp };
  if (delta > 0) return applyExperience(level, exp, delta);

  let nextLevel = level;
  let nextExp = exp + delta;
  while (nextExp < 0 && nextLevel > 1) {
    nextLevel -= 1;
    nextExp += LEVEL_EXP_PER_LEVEL;
  }
  if (nextExp < 0) nextExp = 0;
  return { level: nextLevel, exp: nextExp };
}

function calculateRatingDelta(playerRating, opponentRating, didWin) {
  const base = 10;
  const diff = Math.round((opponentRating - playerRating) / 100);
  return didWin ? base + diff : -(base + Math.round((playerRating - opponentRating) / 100));
}

function loadSupabaseConfig() {
  if (!fs.existsSync(SUPABASE_CONFIG_PATH)) return {};
  try {
    const raw = fs.readFileSync(SUPABASE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function createSupabaseClient() {
  const config = loadSupabaseConfig();
  const supabaseUrl = String(process.env.SUPABASE_URL || config.SUPABASE_URL || config.supabaseUrl || '').trim();
  const supabaseKey = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    config.SUPABASE_SERVICE_ROLE_KEY ||
    config.SUPABASE_SERVICE_KEY ||
    config.supabaseServiceRoleKey ||
    ''
  ).trim();
  if (!supabaseUrl || !supabaseKey) return null;

  const origin = new URL(supabaseUrl).origin;

  function request(method, pathname, { query = {}, body = null, prefer = 'return=representation' } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(pathname, origin);
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) {
          value.forEach(item => url.searchParams.append(key, String(item)));
        } else {
          url.searchParams.append(key, String(value));
        }
      }

      const headers = {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Accept: 'application/json'
      };
      if (prefer) headers.Prefer = prefer;
      let payload = null;
      if (body !== null && body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }

      const req = https.request(url, { method, headers }, res => {
        const chunks = [];
        res.setEncoding('utf8');
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = chunks.join('');
          let data = null;
          if (text) {
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
          }
          if (res.statusCode >= 400) {
            const message = typeof data === 'object' && data
              ? data.message || data.error || data.details || text || `supabase_request_failed_${res.statusCode}`
              : text || `supabase_request_failed_${res.statusCode}`;
            const error = new Error(message);
            error.status = res.statusCode;
            error.response = data;
            return reject(error);
          }
          resolve({ status: res.statusCode, data });
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('supabase_request_timeout')));
      if (payload) req.write(payload);
      req.end();
    });
  }

  return { request };
}

function createSupabaseStore() {
  const client = createSupabaseClient();
  if (!client) return null;

  function rowToProfile(row) {
    if (!row) return null;
    return {
      id: row.id,
      playerId: row.player_id,
      name: row.name,
      friendCode: formatFriendCode(row.friend_code),
      level: row.level,
      exp: row.exp,
      nextLevelExp: Math.max(0, LEVEL_EXP_PER_LEVEL - row.exp),
      rating: row.rating,
      pinFailCount: row.pin_fail_count,
      pinLockedUntil: row.pin_locked_until,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastLoginAt: row.last_login_at
    };
  }

  async function selectOne(table, query = {}) {
    const response = await client.request('GET', `/rest/v1/${table}`, {
      query: { select: '*', ...query }
    });
    return Array.isArray(response.data) ? response.data[0] || null : null;
  }

  async function selectMany(table, query = {}) {
    const response = await client.request('GET', `/rest/v1/${table}`, {
      query: { select: '*', ...query }
    });
    return Array.isArray(response.data) ? response.data : [];
  }

  async function updateRows(table, query, body) {
    const response = await client.request('PATCH', `/rest/v1/${table}`, {
      query,
      body
    });
    return Array.isArray(response.data) ? response.data : [];
  }

  async function insertRows(table, body, query = {}) {
    const response = await client.request('POST', `/rest/v1/${table}`, {
      query,
      body
    });
    return Array.isArray(response.data) ? response.data : [];
  }

  async function deleteRows(table, query) {
    await client.request('DELETE', `/rest/v1/${table}`, {
      query,
      prefer: 'return=minimal'
    });
  }

  async function getPlayerRowById(id) {
    const numericId = Number(id);
    if (!Number.isFinite(numericId) || numericId <= 0) return null;
    return selectOne('players', { id: `eq.${numericId}` });
  }

  async function getPlayerRowByPlayerId(playerId) {
    const normalized = normalizePlayerId(playerId);
    if (!normalized) return null;
    return selectOne('players', { player_id_norm: `eq.${normalized}` });
  }

  async function getPlayerRowByFriendCode(friendCode) {
    const normalized = normalizeFriendCode(friendCode);
    if (!normalized) return null;
    return selectOne('players', { friend_code: `eq.${normalized}` });
  }

  async function getPlayerRowByName(name) {
    const cleanName = sanitizeDisplayName(name);
    if (!cleanName) return null;
    return selectOne('players', { name_norm: `eq.${cleanName.toUpperCase()}` });
  }

  async function getPlayersByIds(ids) {
    const uniqueIds = [...new Set(ids.map(value => Number(value)).filter(value => Number.isFinite(value) && value > 0))];
    if (!uniqueIds.length) return [];
    return selectMany('players', { id: `in.(${uniqueIds.join(',')})` });
  }

  async function getFriendPair(aId, bId) {
    const low = Math.min(Number(aId), Number(bId));
    const high = Math.max(Number(aId), Number(bId));
    return { low, high };
  }

  async function areFriends(aId, bId) {
    const { low, high } = await getFriendPair(aId, bId);
    const row = await selectOne('friends', {
      or: `(and(player1_id.eq.${low},player2_id.eq.${high}),and(player1_id.eq.${high},player2_id.eq.${low}))`
    });
    return Boolean(row);
  }

  async function hasMatchHistoryByKey(matchKey) {
    const key = String(matchKey || '').trim();
    if (!key) return null;
    return selectOne('match_history', { match_key: `eq.${key}` });
  }

  async function createSession(playerId, deviceLabel = null) {
    const token = crypto.randomBytes(32).toString('hex');
    const ts = now();
    await insertRows('auth_sessions', {
      token,
      player_id: playerId,
      created_at: ts,
      last_seen_at: ts,
      expires_at: ts + SESSION_TTL_MS,
      device_label: deviceLabel
    }, {});
    return token;
  }

  async function getSession(token) {
    const sessionToken = String(token || '').trim();
    if (!sessionToken) return null;
    const session = await selectOne('auth_sessions', { token: `eq.${sessionToken}` });
    if (!session) return null;
    if (Number(session.expires_at) <= now()) {
      await deleteRows('auth_sessions', { token: `eq.${sessionToken}` });
      return null;
    }
    await updateRows('auth_sessions', { token: `eq.${sessionToken}` }, { last_seen_at: now() });
    const profile = rowToProfile(await getPlayerRowById(session.player_id));
    if (!profile) return null;
    return { token: session.token, profile };
  }

  async function deleteSession(token) {
    const sessionToken = String(token || '').trim();
    if (!sessionToken) return;
    await deleteRows('auth_sessions', { token: `eq.${sessionToken}` });
  }

  async function registerPlayer({ name, pin }) {
    const cleanName = sanitizeDisplayName(name);
    const cleanPin = String(pin || '').trim();
    if (!cleanName || cleanName.length > 24) {
      return { ok: false, error: 'name_invalid' };
    }
    if (!/^\d{4}$/.test(cleanPin)) {
      return { ok: false, error: 'pin_invalid' };
    }

    for (let attempt = 0; attempt < 100; attempt++) {
      const playerId = safeId(PLAYER_ID_LENGTH);
      const friendCode = safeId(FRIEND_CODE_LENGTH);
      const existingId = await getPlayerRowByPlayerId(playerId);
      const existingCode = await getPlayerRowByFriendCode(friendCode);
      if (existingId || existingCode) continue;

      const { salt, hash } = hashPin(cleanPin);
      const ts = now();
      try {
        const rows = await insertRows('players', {
          player_id: playerId,
          player_id_norm: playerId,
          name: cleanName,
          name_norm: cleanName.toUpperCase(),
          pin_salt: salt,
          pin_hash: hash,
          friend_code: friendCode,
          level: 1,
          exp: 0,
          rating: 1500,
          pin_fail_count: 0,
          pin_locked_until: 0,
          created_at: ts,
          updated_at: ts,
          last_login_at: ts
        }, { select: '*' });
        const row = rows[0];
        if (!row) continue;
        const token = await createSession(row.id);
        return { ok: true, profile: rowToProfile(row), token };
      } catch (error) {
        if (String(error.message || '').includes('duplicate')) continue;
        throw error;
      }
    }

    throw new Error('failed_to_generate_unique_player');
  }

  async function loginPlayer({ playerId, pin, deviceLabel = null }) {
    const normalized = normalizePlayerId(playerId);
    const cleanPin = String(pin || '').trim();
    if (!normalized || !/^\d{4}$/.test(cleanPin)) {
      return { ok: false, error: 'credentials_invalid' };
    }

    const row = await getPlayerRowByPlayerId(normalized);
    if (!row) {
      return { ok: false, error: 'credentials_invalid' };
    }

    const ts = now();
    const ok = verifyPin(cleanPin, row.pin_salt, row.pin_hash);
    if (!ok) {
      await updateRows('players', { id: `eq.${row.id}` }, {
        pin_fail_count: Number(row.pin_fail_count || 0) + 1,
        pin_locked_until: 0,
        updated_at: ts
      });
      return { ok: false, error: 'credentials_invalid' };
    }

    await updateRows('players', { id: `eq.${row.id}` }, {
      pin_fail_count: 0,
      pin_locked_until: 0,
      last_login_at: ts,
      updated_at: ts
    });
    const token = await createSession(row.id, deviceLabel);
    return { ok: true, profile: rowToProfile(await getPlayerRowById(row.id)), token };
  }

  async function restoreSession(token) {
    if (!token) return { ok: false, error: 'missing' };
    const session = await getSession(token);
    if (!session) return { ok: false, error: 'invalid' };
    return { ok: true, profile: session.profile };
  }

  async function logoutSession(token) {
    if (token) await deleteSession(token);
    return { ok: true };
  }

  async function getPlayerById(id) {
    return rowToProfile(await getPlayerRowById(id));
  }

  async function getPlayerByPlayerId(playerId) {
    return rowToProfile(await getPlayerRowByPlayerId(playerId));
  }

  async function getPlayerByFriendCode(friendCode) {
    return rowToProfile(await getPlayerRowByFriendCode(friendCode));
  }

  async function getPlayerByName(name) {
    return rowToProfile(await getPlayerRowByName(name));
  }

  async function updatePlayerName(playerId, name) {
    const cleanName = sanitizeDisplayName(name);
    if (!cleanName) return { ok: false, error: 'name_invalid' };
    const ts = now();
    const rows = await updateRows('players', { id: `eq.${playerId}` }, {
      name: cleanName,
      name_norm: cleanName.toUpperCase(),
      updated_at: ts
    });
    return { ok: true, profile: rowToProfile(rows[0] || await getPlayerRowById(playerId)) };
  }

  async function adjustPlayerProgress(playerId, ratingDelta = 0, expDelta = 0) {
    const row = await getPlayerRowById(playerId);
    if (!row) return { ok: false, error: 'not_found' };
    const levelState = adjustExperience(row.level, row.exp, Number(expDelta || 0));
    const ts = now();
    const rows = await updateRows('players', { id: `eq.${playerId}` }, {
      level: levelState.level,
      exp: levelState.exp,
      rating: Number(row.rating || 0) + Number(ratingDelta || 0),
      updated_at: ts
    });
    return { ok: true, profile: rowToProfile(rows[0] || await getPlayerRowById(playerId)) };
  }

  async function deletePlayerById(playerId) {
    const row = await getPlayerRowById(playerId);
    if (!row) return { ok: false, error: 'not_found' };
    await deleteRows('players', { id: `eq.${playerId}` });
    return { ok: true, profile: rowToProfile(row) };
  }

  async function listFriends(playerId) {
    const rows = await selectMany('friends', {
      or: `(player1_id.eq.${playerId},player2_id.eq.${playerId})`,
      order: 'created_at.desc'
    });
    const friendIds = rows.map(row => Number(row.player1_id) === Number(playerId) ? row.player2_id : row.player1_id);
    const players = await getPlayersByIds(friendIds);
    const playerMap = new Map(players.map(player => [player.id, player]));
    return rows.map(row => {
      const friendId = Number(row.player1_id) === Number(playerId) ? row.player2_id : row.player1_id;
      const friend = playerMap.get(friendId);
      if (!friend) return null;
      return {
        id: friend.id,
        playerId: friend.player_id,
        name: friend.name,
        friendCode: formatFriendCode(friend.friend_code),
        level: friend.level,
        exp: friend.exp,
        rating: friend.rating,
        friendSince: row.created_at,
        lastLoginAt: friend.last_login_at
      };
    }).filter(Boolean);
  }

  async function listFriendRequests(playerId) {
    const rows = await selectMany('friend_requests', {
      or: `(sender_player_id.eq.${playerId},receiver_player_id.eq.${playerId})`,
      order: 'created_at.desc'
    });
    const ids = [...new Set(rows.flatMap(row => [Number(row.sender_player_id), Number(row.receiver_player_id)]).filter(value => Number.isFinite(value) && value > 0))];
    const players = await getPlayersByIds(ids);
    const playerMap = new Map(players.map(player => [player.id, player]));
    return rows.map(row => {
      const sender = playerMap.get(Number(row.sender_player_id));
      const receiver = playerMap.get(Number(row.receiver_player_id));
      if (!sender || !receiver) return null;
      return {
        id: row.id,
        status: row.status,
        createdAt: row.created_at,
        respondedAt: row.responded_at,
        sender: {
          id: sender.id,
          name: sender.name,
          friendCode: formatFriendCode(sender.friend_code)
        },
        receiver: {
          id: receiver.id,
          name: receiver.name,
          friendCode: formatFriendCode(receiver.friend_code)
        }
      };
    }).filter(Boolean);
  }

  async function sendFriendRequest(senderPlayerId, friendCode) {
    const sender = await getPlayerById(senderPlayerId);
    const receiver = await getPlayerByFriendCode(friendCode);
    if (!sender) return { ok: false, error: 'sender_missing' };
    if (!receiver) return { ok: false, error: 'receiver_missing' };
    if (sender.id === receiver.id) return { ok: false, error: 'self' };
    if (await areFriends(sender.id, receiver.id)) return { ok: false, error: 'already_friend' };

    const existing = await selectOne('friend_requests', {
      or: `(and(sender_player_id.eq.${sender.id},receiver_player_id.eq.${receiver.id}),and(sender_player_id.eq.${receiver.id},receiver_player_id.eq.${sender.id}))`,
      order: 'created_at.desc'
    });
    if (existing && existing.status === 'pending') return { ok: false, error: 'pending' };
    if (existing && existing.status === 'accepted') return { ok: false, error: 'already_friend' };

    const ts = now();
    const rows = await insertRows('friend_requests', {
      sender_player_id: sender.id,
      receiver_player_id: receiver.id,
      status: 'pending',
      created_at: ts,
      responded_at: null
    }, { select: 'id' });
    return { ok: true, requestId: rows[0]?.id || null };
  }

  async function respondFriendRequest(receiverPlayerId, requestId, action) {
    const row = await selectOne('friend_requests', { id: `eq.${Number(requestId)}` });
    if (!row) return { ok: false, error: 'not_found' };
    if (Number(row.receiver_player_id) !== Number(receiverPlayerId)) return { ok: false, error: 'forbidden' };
    if (row.status !== 'pending') return { ok: false, error: 'already_handled' };
    const ts = now();

    if (action === 'accept') {
      const pair = await getFriendPair(row.sender_player_id, row.receiver_player_id);
      try {
        await insertRows('friends', {
          player1_id: pair.low,
          player2_id: pair.high,
          created_at: ts
        }, { select: 'player1_id' });
      } catch (error) {
        if (!String(error.message || '').includes('duplicate')) throw error;
      }
      await updateRows('friend_requests', { id: `eq.${row.id}` }, {
        status: 'accepted',
        responded_at: ts
      });
      return { ok: true, status: 'accepted' };
    }

    if (action === 'reject') {
      await updateRows('friend_requests', { id: `eq.${row.id}` }, {
        status: 'rejected',
        responded_at: ts
      });
      return { ok: true, status: 'rejected' };
    }

    return { ok: false, error: 'invalid_action' };
  }

  async function listRecentMatches(playerId, limit = 20) {
    return selectMany('match_history', {
      or: `(player1_id.eq.${playerId},player2_id.eq.${playerId})`,
      order: 'started_time.desc',
      limit: Math.max(1, Math.min(50, Number(limit) || 20))
    });
  }

  async function recordMatchHistory(entry) {
    const ts = now();
    const startedTime = Number(entry.startedTime || ts);
    const endedTime = Number(entry.endedTime || ts);
    const payload = {
      match_key: String(entry.matchKey || '') || null,
      player1_id: entry.player1Id || null,
      player2_id: entry.player2Id || null,
      player1_name: sanitizeDisplayName(entry.player1Name || 'PLAYER 1'),
      player2_name: sanitizeDisplayName(entry.player2Name || 'PLAYER 2'),
      match_type: String(entry.matchType || 'unknown'),
      winner: String(entry.winner || ''),
      loser: String(entry.loser || ''),
      result: String(entry.result || 'win'),
      player1_get_rating: Number(entry.player1RatingDelta || 0),
      player2_get_rating: Number(entry.player2RatingDelta || 0),
      player1_level: Number(entry.player1Level || 1),
      player2_level: Number(entry.player2Level || 1),
      started_time: startedTime,
      ended_time: endedTime,
      time_taken: Number(entry.timeTaken || Math.max(0, endedTime - startedTime)),
      surrender_by_player_id: entry.surrenderByPlayerId || null,
      winner_player_id: entry.winnerPlayerId || null,
      loser_player_id: entry.loserPlayerId || null,
      player1_start_rating: Number(entry.player1StartRating || 0),
      player2_start_rating: Number(entry.player2StartRating || 0),
      created_at: ts,
      summary_json: entry.summaryJson || null,
      replay_json: entry.replayJson || null
    };

    if (payload.match_key) {
      const existing = await hasMatchHistoryByKey(payload.match_key);
      if (existing) return existing.id;
    }

    const rows = await insertRows('match_history', payload, { select: 'id' });
    return rows[0]?.id || null;
  }

  async function updatePlayerProgress(playerId, ratingDelta, expGain = 50) {
    const row = await getPlayerRowById(playerId);
    if (!row) return null;
    const levelState = applyExperience(row.level, row.exp, expGain);
    const ts = now();
    const rows = await updateRows('players', { id: `eq.${playerId}` }, {
      level: levelState.level,
      exp: levelState.exp,
      rating: Number(row.rating || 0) + Number(ratingDelta || 0),
      updated_at: ts
    });
    return rowToProfile(rows[0] || await getPlayerRowById(playerId));
  }

  return {
    db: null,
    backend: 'supabase',
    createSession,
    deleteSession,
    getSession,
    registerPlayer,
    loginPlayer,
    restoreSession,
    logoutSession,
    getPlayerById,
    getPlayerByPlayerId,
    getPlayerByFriendCode,
    getPlayerByName,
    updatePlayerName,
    adjustPlayerProgress,
    deletePlayerById,
    listFriends,
    listFriendRequests,
    sendFriendRequest,
    respondFriendRequest,
    recordMatchHistory,
    listRecentMatches,
    updatePlayerProgress,
    calculateRatingDelta,
    normalizePlayerId,
    normalizeFriendCode,
    formatFriendCode,
    sanitizeDisplayName,
    applyExperience,
    adjustExperience,
    hasMatchHistoryByKey
  };
}

function createSqliteStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL UNIQUE,
      player_id_norm TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      pin_salt TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      friend_code TEXT NOT NULL UNIQUE,
      level INTEGER NOT NULL DEFAULT 1,
      exp INTEGER NOT NULL DEFAULT 0,
      rating INTEGER NOT NULL DEFAULT 1500,
      pin_fail_count INTEGER NOT NULL DEFAULT 0,
      pin_locked_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      player_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      device_label TEXT,
      FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS friend_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_player_id INTEGER NOT NULL,
      receiver_player_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      responded_at INTEGER,
      FOREIGN KEY (sender_player_id) REFERENCES players(id) ON DELETE CASCADE,
      FOREIGN KEY (receiver_player_id) REFERENCES players(id) ON DELETE CASCADE,
      UNIQUE(sender_player_id, receiver_player_id)
    );

    CREATE TABLE IF NOT EXISTS friends (
      player1_id INTEGER NOT NULL,
      player2_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (player1_id, player2_id),
      FOREIGN KEY (player1_id) REFERENCES players(id) ON DELETE CASCADE,
      FOREIGN KEY (player2_id) REFERENCES players(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS match_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_key TEXT UNIQUE,
      player1_id INTEGER,
      player2_id INTEGER,
      player1_name TEXT NOT NULL,
      player2_name TEXT NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'unknown',
      winner TEXT NOT NULL,
      loser TEXT NOT NULL,
      result TEXT NOT NULL,
      player1_get_rating INTEGER NOT NULL,
      player2_get_rating INTEGER NOT NULL,
      player1_level INTEGER NOT NULL,
      player2_level INTEGER NOT NULL,
      started_time INTEGER NOT NULL,
      ended_time INTEGER NOT NULL,
      time_taken INTEGER NOT NULL,
      surrender_by_player_id INTEGER,
      created_at INTEGER NOT NULL,
      summary_json TEXT,
      replay_json TEXT,
      winner_player_id INTEGER,
      loser_player_id INTEGER,
      player1_start_rating INTEGER,
      player2_start_rating INTEGER
    );
  `);

  try { db.exec('ALTER TABLE match_history ADD COLUMN summary_json TEXT;'); } catch {}
  try { db.exec('ALTER TABLE match_history ADD COLUMN replay_json TEXT;'); } catch {}
  try { db.exec('ALTER TABLE match_history ADD COLUMN winner_player_id INTEGER;'); } catch {}
  try { db.exec('ALTER TABLE match_history ADD COLUMN loser_player_id INTEGER;'); } catch {}
  try { db.exec('ALTER TABLE match_history ADD COLUMN player1_start_rating INTEGER;'); } catch {}
  try { db.exec('ALTER TABLE match_history ADD COLUMN player2_start_rating INTEGER;'); } catch {}
  try { db.exec("ALTER TABLE match_history ADD COLUMN match_type TEXT NOT NULL DEFAULT 'unknown';"); } catch {}

  function withTransaction(fn) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      db.exec('COMMIT;');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  }

  function rowToProfile(row) {
    if (!row) return null;
    return {
      id: row.id,
      playerId: row.player_id,
      name: row.name,
      friendCode: formatFriendCode(row.friend_code),
      level: row.level,
      exp: row.exp,
      nextLevelExp: Math.max(0, LEVEL_EXP_PER_LEVEL - row.exp),
      rating: row.rating,
      pinFailCount: row.pin_fail_count,
      pinLockedUntil: row.pin_locked_until,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastLoginAt: row.last_login_at
    };
  }

  function generateUniqueCode(length, column) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = safeId(length);
      const exists = db.prepare(`SELECT 1 FROM players WHERE ${column} = ?`).get(candidate);
      if (!exists) return candidate;
    }
    throw new Error(`failed to generate unique ${column}`);
  }

  function createSession(playerId, deviceLabel = null) {
    const token = crypto.randomBytes(32).toString('hex');
    const ts = now();
    db.prepare(`
      INSERT INTO auth_sessions (token, player_id, created_at, last_seen_at, expires_at, device_label)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(token, playerId, ts, ts, ts + SESSION_TTL_MS, deviceLabel);
    return token;
  }

  function getSession(token) {
    const row = db.prepare(`
      SELECT s.token, s.player_id, s.created_at, s.last_seen_at, s.expires_at,
             p.*
      FROM auth_sessions s
      JOIN players p ON p.id = s.player_id
      WHERE s.token = ?
    `).get(token);
    if (!row) return null;
    if (row.expires_at <= now()) {
      db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
      return null;
    }
    db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token = ?').run(now(), token);
    return {
      token: row.token,
      profile: rowToProfile(row)
    };
  }

  function deleteSession(token) {
    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
  }

  function registerPlayer({ name, pin }) {
    const cleanName = sanitizeDisplayName(name);
    const cleanPin = String(pin || '').trim();
    if (!cleanName || cleanName.length > 24) {
      return { ok: false, error: 'name_invalid' };
    }
    if (!/^\d{4}$/.test(cleanPin)) {
      return { ok: false, error: 'pin_invalid' };
    }

    return withTransaction(() => {
      const playerId = generateUniqueCode(PLAYER_ID_LENGTH, 'player_id_norm');
      const friendCode = generateUniqueCode(FRIEND_CODE_LENGTH, 'friend_code');
      const { salt, hash } = hashPin(cleanPin);
      const ts = now();
      const result = db.prepare(`
        INSERT INTO players (
          player_id, player_id_norm, name, name_norm, pin_salt, pin_hash, friend_code,
          level, exp, rating, pin_fail_count, pin_locked_until, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 1500, 0, 0, ?, ?)
      `).run(playerId, playerId, cleanName, cleanName.toUpperCase(), salt, hash, friendCode, ts, ts);

      const row = db.prepare('SELECT * FROM players WHERE id = ?').get(result.lastInsertRowid);
      const token = createSession(row.id);
      db.prepare('UPDATE players SET last_login_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, row.id);
      return { ok: true, profile: rowToProfile(row), token };
    });
  }

  function loginPlayer({ playerId, pin, deviceLabel = null }) {
    const normalized = normalizePlayerId(playerId);
    const cleanPin = String(pin || '').trim();
    if (!normalized || !/^\d{4}$/.test(cleanPin)) {
      return { ok: false, error: 'credentials_invalid' };
    }

    const row = db.prepare('SELECT * FROM players WHERE player_id_norm = ?').get(normalized);
    if (!row) {
      return { ok: false, error: 'credentials_invalid' };
    }

    const ts = now();
    const ok = verifyPin(cleanPin, row.pin_salt, row.pin_hash);
    if (!ok) {
      const failCount = row.pin_fail_count + 1;
      db.prepare(`
        UPDATE players
        SET pin_fail_count = ?, pin_locked_until = 0, updated_at = ?
        WHERE id = ?
      `).run(failCount, ts, row.id);
      return { ok: false, error: 'credentials_invalid' };
    }

    db.prepare(`
      UPDATE players
      SET pin_fail_count = 0, pin_locked_until = 0, last_login_at = ?, updated_at = ?
      WHERE id = ?
    `).run(ts, ts, row.id);
    const token = createSession(row.id, deviceLabel);
    const fresh = db.prepare('SELECT * FROM players WHERE id = ?').get(row.id);
    return { ok: true, profile: rowToProfile(fresh), token };
  }

  function restoreSession(token) {
    if (!token) return { ok: false, error: 'missing' };
    const session = getSession(token);
    if (!session) return { ok: false, error: 'invalid' };
    return { ok: true, profile: session.profile };
  }

  function logoutSession(token) {
    if (token) deleteSession(token);
    return { ok: true };
  }

  function getPlayerById(id) {
    const row = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
    return rowToProfile(row);
  }

  function getPlayerByPlayerId(playerId) {
    const row = db.prepare('SELECT * FROM players WHERE player_id_norm = ?').get(normalizePlayerId(playerId));
    return rowToProfile(row);
  }

  function getPlayerByFriendCode(friendCode) {
    const row = db.prepare('SELECT * FROM players WHERE friend_code = ?').get(normalizeFriendCode(friendCode));
    return rowToProfile(row);
  }

  function getPlayerByName(name) {
    const cleanName = sanitizeDisplayName(name);
    if (!cleanName) return null;
    const row = db.prepare('SELECT * FROM players WHERE name_norm = ?').get(cleanName.toUpperCase());
    return rowToProfile(row);
  }

  function updatePlayerName(playerId, name) {
    const cleanName = sanitizeDisplayName(name);
    if (!cleanName) return { ok: false, error: 'name_invalid' };
    const ts = now();
    db.prepare(`
      UPDATE players
      SET name = ?, name_norm = ?, updated_at = ?
      WHERE id = ?
    `).run(cleanName, cleanName.toUpperCase(), ts, playerId);
    return { ok: true, profile: rowToProfile(db.prepare('SELECT * FROM players WHERE id = ?').get(playerId)) };
  }

  function adjustPlayerProgress(playerId, ratingDelta = 0, expDelta = 0) {
    const row = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
    if (!row) return { ok: false, error: 'not_found' };
    const levelState = adjustExperience(row.level, row.exp, Number(expDelta || 0));
    const ts = now();
    db.prepare(`
      UPDATE players
      SET level = ?, exp = ?, rating = rating + ?, updated_at = ?
      WHERE id = ?
    `).run(levelState.level, levelState.exp, Number(ratingDelta || 0), ts, playerId);
    return { ok: true, profile: rowToProfile(db.prepare('SELECT * FROM players WHERE id = ?').get(playerId)) };
  }

  function deletePlayerById(playerId) {
    const row = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
    if (!row) return { ok: false, error: 'not_found' };
    withTransaction(() => {
      db.prepare('DELETE FROM players WHERE id = ?').run(playerId);
      db.prepare('DELETE FROM match_history WHERE player1_id = ? OR player2_id = ?').run(playerId, playerId);
    });
    return { ok: true, profile: rowToProfile(row) };
  }

  function getFriendRowPair(aId, bId) {
    const low = Math.min(aId, bId);
    const high = Math.max(aId, bId);
    return { low, high };
  }

  function areFriends(aId, bId) {
    const { low, high } = getFriendRowPair(aId, bId);
    return Boolean(db.prepare('SELECT 1 FROM friends WHERE player1_id = ? AND player2_id = ?').get(low, high));
  }

  function listFriends(playerId) {
    const rows = db.prepare(`
      SELECT
        p.id,
        p.player_id,
        p.name,
        p.friend_code,
        p.level,
        p.exp,
        p.rating,
        p.last_login_at,
        f.created_at AS friend_since
      FROM friends f
      JOIN players p ON p.id = CASE WHEN f.player1_id = ? THEN f.player2_id ELSE f.player1_id END
      WHERE f.player1_id = ? OR f.player2_id = ?
      ORDER BY f.created_at DESC
    `).all(playerId, playerId, playerId);
    return rows.map(row => ({
      id: row.id,
      playerId: row.player_id,
      name: row.name,
      friendCode: formatFriendCode(row.friend_code),
      level: row.level,
      exp: row.exp,
      rating: row.rating,
      friendSince: row.friend_since,
      lastLoginAt: row.last_login_at
    }));
  }

  function listFriendRequests(playerId) {
    const rows = db.prepare(`
      SELECT
        fr.id,
        fr.sender_player_id,
        fr.receiver_player_id,
        fr.status,
        fr.created_at,
        fr.responded_at,
        s.name AS sender_name,
        s.friend_code AS sender_friend_code,
        r.name AS receiver_name,
        r.friend_code AS receiver_friend_code
      FROM friend_requests fr
      JOIN players s ON s.id = fr.sender_player_id
      JOIN players r ON r.id = fr.receiver_player_id
      WHERE fr.sender_player_id = ? OR fr.receiver_player_id = ?
      ORDER BY fr.created_at DESC
    `).all(playerId, playerId);
    return rows.map(row => ({
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      respondedAt: row.responded_at,
      sender: {
        id: row.sender_player_id,
        name: row.sender_name,
        friendCode: formatFriendCode(row.sender_friend_code)
      },
      receiver: {
        id: row.receiver_player_id,
        name: row.receiver_name,
        friendCode: formatFriendCode(row.receiver_friend_code)
      }
    }));
  }

  function sendFriendRequest(senderPlayerId, friendCode) {
    const sender = getPlayerById(senderPlayerId);
    const receiver = getPlayerByFriendCode(friendCode);
    if (!sender) return { ok: false, error: 'sender_missing' };
    if (!receiver) return { ok: false, error: 'receiver_missing' };
    if (sender.id === receiver.id) return { ok: false, error: 'self' };
    if (areFriends(sender.id, receiver.id)) return { ok: false, error: 'already_friend' };

    const exists = db.prepare(`
      SELECT id, status FROM friend_requests
      WHERE (sender_player_id = ? AND receiver_player_id = ?)
         OR (sender_player_id = ? AND receiver_player_id = ?)
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sender.id, receiver.id, receiver.id, sender.id);
    if (exists && exists.status === 'pending') return { ok: false, error: 'pending' };
    if (exists && exists.status === 'accepted') return { ok: false, error: 'already_friend' };

    const ts = now();
    const info = db.prepare(`
      INSERT INTO friend_requests (sender_player_id, receiver_player_id, status, created_at)
      VALUES (?, ?, 'pending', ?)
    `).run(sender.id, receiver.id, ts);
    return { ok: true, requestId: info.lastInsertRowid };
  }

  function respondFriendRequest(receiverPlayerId, requestId, action) {
    const row = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(requestId);
    if (!row) return { ok: false, error: 'not_found' };
    if (row.receiver_player_id !== receiverPlayerId) return { ok: false, error: 'forbidden' };
    if (row.status !== 'pending') return { ok: false, error: 'already_handled' };
    const ts = now();

    if (action === 'accept') {
      const pair = getFriendRowPair(row.sender_player_id, row.receiver_player_id);
      withTransaction(() => {
        db.prepare('UPDATE friend_requests SET status = ?, responded_at = ? WHERE id = ?').run('accepted', ts, requestId);
        db.prepare('INSERT OR IGNORE INTO friends (player1_id, player2_id, created_at) VALUES (?, ?, ?)')
          .run(pair.low, pair.high, ts);
      });
      return { ok: true, status: 'accepted' };
    }

    if (action === 'reject') {
      db.prepare('UPDATE friend_requests SET status = ?, responded_at = ? WHERE id = ?').run('rejected', ts, requestId);
      return { ok: true, status: 'rejected' };
    }

    return { ok: false, error: 'invalid_action' };
  }

  function listRecentMatches(playerId, limit = 20) {
    const rows = db.prepare(`
      SELECT *
      FROM match_history
      WHERE player1_id = ? OR player2_id = ?
      ORDER BY started_time DESC
      LIMIT ?
    `).all(playerId, playerId, limit);
    return rows;
  }

  function recordMatchHistory(entry) {
    const ts = now();
    const startedTime = Number(entry.startedTime || ts);
    const endedTime = Number(entry.endedTime || ts);
    const payload = {
      matchKey: String(entry.matchKey || ''),
      player1Id: entry.player1Id || null,
      player2Id: entry.player2Id || null,
      player1Name: sanitizeDisplayName(entry.player1Name || 'PLAYER 1'),
      player2Name: sanitizeDisplayName(entry.player2Name || 'PLAYER 2'),
      matchType: String(entry.matchType || 'unknown'),
      winner: String(entry.winner || ''),
      loser: String(entry.loser || ''),
      result: String(entry.result || 'win'),
      player1RatingDelta: Number(entry.player1RatingDelta || 0),
      player2RatingDelta: Number(entry.player2RatingDelta || 0),
      player1Level: Number(entry.player1Level || 1),
      player2Level: Number(entry.player2Level || 1),
      startedTime,
      endedTime,
      timeTaken: Number(entry.timeTaken || Math.max(0, endedTime - startedTime)),
      surrenderByPlayerId: entry.surrenderByPlayerId || null,
      winnerPlayerId: entry.winnerPlayerId || null,
      loserPlayerId: entry.loserPlayerId || null,
      player1StartRating: Number(entry.player1StartRating || 0),
      player2StartRating: Number(entry.player2StartRating || 0),
      summaryJson: entry.summaryJson || null,
      replayJson: entry.replayJson || null
    };

    if (payload.matchKey) {
      const existing = db.prepare('SELECT id FROM match_history WHERE match_key = ?').get(payload.matchKey);
      if (existing) return existing.id;
    }

    const info = db.prepare(`
      INSERT INTO match_history (
        match_key, player1_id, player2_id, player1_name, player2_name, match_type,
        winner, loser, result, player1_get_rating, player2_get_rating,
        player1_level, player2_level, started_time, ended_time, time_taken,
        surrender_by_player_id, created_at, summary_json, replay_json,
        winner_player_id, loser_player_id, player1_start_rating, player2_start_rating
    ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      payload.matchKey || null,
      payload.player1Id,
      payload.player2Id,
      payload.player1Name,
      payload.player2Name,
      payload.matchType,
      payload.winner,
      payload.loser,
      payload.result,
      payload.player1RatingDelta,
      payload.player2RatingDelta,
      payload.player1Level,
      payload.player2Level,
      payload.startedTime,
      payload.endedTime,
      payload.timeTaken,
      payload.surrenderByPlayerId,
      ts,
      payload.summaryJson ? JSON.stringify(payload.summaryJson) : null,
      payload.replayJson ? JSON.stringify(payload.replayJson) : null,
      payload.winnerPlayerId,
      payload.loserPlayerId,
      payload.player1StartRating,
      payload.player2StartRating
    );
    return info.lastInsertRowid;
  }

  function hasMatchHistoryByKey(matchKey) {
    const key = String(matchKey || '').trim();
    if (!key) return null;
    return db.prepare('SELECT id FROM match_history WHERE match_key = ?').get(key);
  }

  function updatePlayerProgress(playerId, ratingDelta, expGain = 50) {
    const row = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
    if (!row) return null;
    const levelState = applyExperience(row.level, row.exp, expGain);
    const ts = now();
    db.prepare(`
      UPDATE players
      SET level = ?, exp = ?, rating = rating + ?, updated_at = ?
      WHERE id = ?
    `).run(levelState.level, levelState.exp, ratingDelta, ts, playerId);
    return rowToProfile(db.prepare('SELECT * FROM players WHERE id = ?').get(playerId));
  }

  return {
    db,
    createSession,
    deleteSession,
    getSession,
    registerPlayer,
    loginPlayer,
    restoreSession,
    logoutSession,
    getPlayerById,
    getPlayerByPlayerId,
    getPlayerByFriendCode,
    getPlayerByName,
    updatePlayerName,
    adjustPlayerProgress,
    deletePlayerById,
    listFriends,
    listFriendRequests,
    sendFriendRequest,
    respondFriendRequest,
    recordMatchHistory,
    listRecentMatches,
    updatePlayerProgress,
    calculateRatingDelta,
    normalizePlayerId,
    normalizeFriendCode,
    formatFriendCode,
    sanitizeDisplayName,
    applyExperience,
    adjustExperience,
    hasMatchHistoryByKey
  };
}

function createStore() {
  const supabaseStore = createSupabaseStore();
  if (!supabaseStore) {
    throw new Error('Supabase configuration is required. Set supabase.local.json or SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  }
  return supabaseStore;
}

module.exports = {
  createStore,
  createSupabaseStore,
  calculateRatingDelta,
  formatFriendCode,
  normalizePlayerId,
  normalizeFriendCode,
  sanitizeDisplayName
};
