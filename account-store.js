const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'sector8.sqlite');

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

function createStore() {
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
      created_at INTEGER NOT NULL
    );
  `);

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
      surrenderByPlayerId: entry.surrenderByPlayerId || null
    };

    if (payload.matchKey) {
      const existing = db.prepare('SELECT id FROM match_history WHERE match_key = ?').get(payload.matchKey);
      if (existing) return existing.id;
    }

    const info = db.prepare(`
      INSERT INTO match_history (
        match_key, player1_id, player2_id, player1_name, player2_name,
        winner, loser, result, player1_get_rating, player2_get_rating,
        player1_level, player2_level, started_time, ended_time, time_taken,
        surrender_by_player_id, created_at
    ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      payload.matchKey || null,
      payload.player1Id,
      payload.player2Id,
      payload.player1Name,
      payload.player2Name,
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
      ts
    );
    return info.lastInsertRowid;
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
    adjustExperience
  };
}

module.exports = {
  createStore,
  calculateRatingDelta,
  formatFriendCode,
  normalizePlayerId,
  normalizeFriendCode,
  sanitizeDisplayName
};
