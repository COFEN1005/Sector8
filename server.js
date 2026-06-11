/**
 * SECTOR-8: Information Collapse
 * WebSocket Server - Room / random / spectator / reconnect edition
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const {
    createStore,
    calculateRatingDelta,
    formatFriendCode,
    normalizeFriendCode,
    normalizePlayerId,
    sanitizeDisplayName
} = require('./account-store');

const root = __dirname;
const port = Number(process.env.PORT || 8787);
const MAX_SPECTATORS = 2;
const accountStore = createStore();

const rooms = new Map();
const clients = new Map();
let pendingRandomRoomId = null;
const pendingRandomRoomIds = { rank: null, normal: null };
const pendingMatchHistoryKeys = new Set();
let randomRoomSerial = 1;

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.txt': 'text/plain; charset=utf-8'
};

function createRoom(roomId, random = false) {
    const room = {
        id: roomId,
        random,
        randomTier: null,
        started: false,
        startConfig: null,
        history: [],
        profiles: { 1: null, 2: null },
        profileDetails: { 1: null, 2: null },
        seats: {
            1: { socket: null, token: crypto.randomUUID() },
            2: { socket: null, token: crypto.randomUUID() }
        },
        spectators: []
    };
    rooms.set(roomId, room);
    return room;
}

function roomSockets(room) {
    const sockets = [];
    if (room.seats[1].socket) sockets.push(room.seats[1].socket);
    if (room.seats[2].socket) sockets.push(room.seats[2].socket);
    room.spectators.forEach(spec => { if (spec.socket) sockets.push(spec.socket); });
    return sockets;
}

function getRoomSnapshot(room) {
    return {
        started: room.started,
        config: room.startConfig,
        history: room.history,
        profiles: room.profiles,
        profileDetails: room.profileDetails
    };
}

function countRandomWaitingPlayers(matchTier = 'rank') {
    const room = pendingRandomRoomIds[matchTier] ? rooms.get(pendingRandomRoomIds[matchTier]) : null;
    if (!room || room.started) return 0;
    return room.seats[1].socket && !room.seats[2].socket ? 1 : 0;
}

async function resolveDevPlayer(query) {
    const normalizedId = normalizePlayerId(query || '');
    if (normalizedId) {
        const byId = await accountStore.getPlayerByPlayerId(normalizedId);
        if (byId) return byId;
    }
    const byName = await accountStore.getPlayerByName(query || '');
    if (byName) return byName;
    return null;
}

function sendRandomQueueStatus(matchTier = 'rank') {
    const payload = { kind: 'queue_status', waiting: countRandomWaitingPlayers(matchTier), matchTier };
    rooms.forEach(room => {
        if (!room.random || room.randomTier !== matchTier) return;
        roomSockets(room).forEach(socket => sendFrame(socket, payload));
    });
}

function sendRoomProfiles(room) {
    const payload = { kind: 'room_profiles', profiles: room.profiles, profileDetails: room.profileDetails };
    roomSockets(room).forEach(socket => sendFrame(socket, payload));
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache'
    });
    res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => {
            raw += chunk;
            if (raw.length > 1_000_000) {
                reject(new Error('payload too large'));
                req.destroy();
            }
        });
        req.on('end', () => resolve(raw));
        req.on('error', reject);
    });
}

function readJsonBody(req) {
    return readRequestBody(req).then(raw => {
        if (!raw) return {};
        try {
            return JSON.parse(raw);
        } catch {
            throw new Error('invalid json');
        }
    });
}

function getBearerToken(req) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1].trim() : '';
}

function sendFrame(socket, payload) {
    if (!socket || socket.destroyed) return;
    const data = Buffer.from(JSON.stringify(payload));
    let header;

    if (data.length < 126) {
        header = Buffer.from([0x81, data.length]);
    } else if (data.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81; header[1] = 126;
        header.writeUInt16BE(data.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81; header[1] = 127;
        header.writeBigUInt64BE(BigInt(data.length), 2);
    }

    try { socket.write(Buffer.concat([header, data])); } catch {}
}

function sendClose(socket, code, reason) {
    if (!socket || socket.destroyed) return;
    const reasonBuffer = Buffer.from(reason || '');
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    try { socket.end(Buffer.concat([Buffer.from([0x88, payload.length]), payload])); } catch {}
}

function sendPong(socket, pingPayload) {
    if (!socket || socket.destroyed) return;
    const payload = pingPayload || Buffer.alloc(0);
    try { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); } catch {}
}

function readFrame(buffer) {
    if (buffer.length < 2) return null;
    const opcode = buffer[0] & 0x0f;

    let offset = 2;
    let length = buffer[1] & 0x7f;
    const masked = Boolean(buffer[1] & 0x80);

    if (length === 126) {
        if (buffer.length < 4) return null;
        length = buffer.readUInt16BE(2); offset = 4;
    } else if (length === 127) {
        if (buffer.length < 10) return null;
        length = Number(buffer.readBigUInt64BE(2)); offset = 10;
    }

    const maskOffset = offset;
    if (masked) offset += 4;
    if (buffer.length < offset + length) return null;

    const payload = Buffer.from(buffer.slice(offset, offset + length));
    const rest = buffer.slice(offset + length);
    if (masked) {
        const mask = buffer.slice(maskOffset, maskOffset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }

    if (opcode === 0x8) return { frame: { close: true }, rest };
    if (opcode === 0x9) return { frame: { ping: true, payload }, rest };
    if (opcode !== 0x1) return { frame: { ignored: true }, rest };

    try { return { frame: JSON.parse(payload.toString('utf8')), rest }; }
    catch { return { frame: null, rest }; }
}

function broadcast(senderSocket, payload, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    roomSockets(room).forEach(sock => {
        if (sock !== senderSocket) sendFrame(sock, payload);
    });
}

function findRoomByToken(token) {
    for (const room of rooms.values()) {
        for (const seatNo of [1, 2]) {
            const seat = room.seats[seatNo];
            if (seat.token === token) return { room, role: 'player', player: seatNo };
        }
        const spec = room.spectators.find(entry => entry.token === token);
        if (spec) return { room, role: 'spectator', token: spec.token };
    }
    return null;
}

function roomHasLiveConnections(room) {
    return roomSockets(room).some(sock => sock && !sock.destroyed);
}

function cleanupRoomIfEmpty(room) {
    if (roomHasLiveConnections(room)) return;
    if (!room.started) {
        if (pendingRandomRoomId === room.id) pendingRandomRoomId = null;
        if (room.randomTier && pendingRandomRoomIds[room.randomTier] === room.id) pendingRandomRoomIds[room.randomTier] = null;
        rooms.delete(room.id);
        if (room.randomTier) sendRandomQueueStatus(room.randomTier);
    }
}

function removeClient(socket) {
    const info = clients.get(socket);
    clients.delete(socket);
    if (!info) return;

    const room = rooms.get(info.roomId);
    if (!room) return;

    if (info.role === 'player' && info.player) {
        if (room.seats[info.player].socket === socket) room.seats[info.player].socket = null;
    } else if (info.role === 'spectator') {
        const spec = room.spectators.find(entry => entry.token === info.token);
        if (spec && spec.socket === socket) spec.socket = null;
    }

    cleanupRoomIfEmpty(room);
}

function replaceSocket(oldSocket, newSocket) {
    if (!oldSocket || oldSocket.destroyed) return;
    clients.delete(oldSocket);
    try { oldSocket.destroy(); } catch {}
}

function joinSpecificRoom(socket, roomId, desiredPlayer, token) {
    const room = rooms.get(roomId) || createRoom(roomId, false);

    if (token) {
        const matched = findRoomByToken(token);
        if (matched && matched.room.id === roomId) {
            if (matched.role === 'player') {
                replaceSocket(matched.room.seats[matched.player].socket, socket);
                matched.room.seats[matched.player].socket = socket;
                return { room: matched.room, role: 'player', player: matched.player, token: matched.room.seats[matched.player].token };
            }
            const spec = matched.room.spectators.find(entry => entry.token === token);
            replaceSocket(spec.socket, socket);
            spec.socket = socket;
            return { room: matched.room, role: 'spectator', player: null, token };
        }
    }

    if (desiredPlayer === 1 || desiredPlayer === 2) {
        const seat = room.seats[desiredPlayer];
        if (!seat.socket) {
            seat.socket = socket;
            return { room, role: 'player', player: desiredPlayer, token: seat.token };
        }
    }

    if (room.spectators.length >= MAX_SPECTATORS) {
        return null;
    }

    const spectator = { socket, token: crypto.randomUUID() };
    room.spectators.push(spectator);
    return { room, role: 'spectator', player: null, token: spectator.token };
}

function joinRandomRoom(socket, token, matchTier = 'rank') {
    const tier = matchTier === 'normal' ? 'normal' : 'rank';
    if (token) {
        const matched = findRoomByToken(token);
        if (matched) {
            if (matched.role === 'player') {
                replaceSocket(matched.room.seats[matched.player].socket, socket);
                matched.room.seats[matched.player].socket = socket;
                return { room: matched.room, role: 'player', player: matched.player, token: matched.room.seats[matched.player].token };
            }
            const spec = matched.room.spectators.find(entry => entry.token === token);
            replaceSocket(spec.socket, socket);
            spec.socket = socket;
            return { room: matched.room, role: 'spectator', player: null, token };
        }
    }

    let room = pendingRandomRoomIds[tier] ? rooms.get(pendingRandomRoomIds[tier]) : null;
    if (!room || room.started || room.seats[2].socket) {
        room = createRoom(`RANDOM-${String(randomRoomSerial++).padStart(4, '0')}`, true);
        room.randomTier = tier;
        pendingRandomRoomIds[tier] = room.id;
        room.seats[1].socket = socket;
        sendRandomQueueStatus(tier);
        return { room, role: 'player', player: 1, token: room.seats[1].token };
    }

    room.seats[2].socket = socket;
    pendingRandomRoomIds[tier] = null;
    sendRandomQueueStatus(tier);
    return { room, role: 'player', player: 2, token: room.seats[2].token };
}

function trackRoomState(room, message, senderInfo) {
    if (message.kind === 'start') {
        room.started = true;
        room.startConfig = message.config;
        room.history = [];
        return;
    }
    if (message.kind === 'reset') {
        room.started = false;
        room.startConfig = null;
        room.history = [];
        return;
    }
    if (message.kind === 'profile' && senderInfo.player) {
        room.profiles[senderInfo.player] = message.username;
        if (room.profileDetails[senderInfo.player]) {
            room.profileDetails[senderInfo.player] = {
                ...room.profileDetails[senderInfo.player],
                name: message.username
            };
        }
        sendRoomProfiles(room);
        return;
    }
    if (room.started && (message.kind === 'action' || message.kind === 'forfeit' || message.kind === 'win' || message.kind === 'draw' || message.kind === 'draw_request')) {
        room.history.push(message);
    }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const method = req.method || 'GET';

    try {
        if (url.pathname.startsWith('/api/')) {
            const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(req);
            const sessionToken = body.token || body.sessionToken || getBearerToken(req);
            const session = sessionToken ? await accountStore.getSession(sessionToken) : null;

            if (method === 'GET' && url.pathname === '/api/auth/me') {
                if (!session) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
                return sendJson(res, 200, { ok: true, profile: session.profile });
            }

            if (method === 'POST' && url.pathname === '/api/auth/register') {
                const result = await accountStore.registerPlayer({ name: body.name, pin: body.pin });
                if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
                return sendJson(res, 200, {
                    ok: true,
                    token: result.token,
                    profile: result.profile
                });
            }

            if (method === 'POST' && url.pathname === '/api/auth/login') {
                const result = await accountStore.loginPlayer({
                    playerId: body.playerId,
                    pin: body.pin,
                    deviceLabel: sanitizeDisplayName(body.deviceLabel || body.device || '')
                });
                if (!result.ok) {
                    return sendJson(res, 401, {
                        ok: false,
                        error: result.error
                    });
                }
                return sendJson(res, 200, { ok: true, token: result.token, profile: result.profile });
            }

            if (method === 'POST' && url.pathname === '/api/auth/restore') {
                const result = await accountStore.restoreSession(body.token || sessionToken);
                if (!result.ok) return sendJson(res, 401, { ok: false, error: result.error });
                return sendJson(res, 200, { ok: true, profile: result.profile });
            }

            if (method === 'POST' && url.pathname === '/api/auth/logout') {
                await accountStore.logoutSession(body.token || sessionToken);
                return sendJson(res, 200, { ok: true });
            }

            if (method === 'POST' && url.pathname === '/api/account/name') {
                if (!session) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
                const result = await accountStore.updatePlayerName(session.profile.id, body.name);
                if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
                return sendJson(res, 200, { ok: true, profile: result.profile });
            }

            if (url.pathname.startsWith('/api/dev/')) {
                if (req.headers['x-sector8-dev'] !== '1') {
                    return sendJson(res, 403, { ok: false, error: 'forbidden' });
                }

                if (method === 'GET' && url.pathname === '/api/dev/player') {
                    const query = body.query || url.searchParams.get('query') || '';
                    const player = await resolveDevPlayer(query);
                    if (!player) return sendJson(res, 404, { ok: false, error: 'not_found' });
                    return sendJson(res, 200, { ok: true, player });
                }

                if (method === 'POST' && url.pathname === '/api/dev/player-adjust') {
                    const target = await resolveDevPlayer(body.query || body.playerId || '');
                    if (!target) return sendJson(res, 404, { ok: false, error: 'not_found' });
                    const ratingDelta = Number(body.ratingDelta || 0);
                    const expDelta = Number(body.expDelta || 0);
                    const result = await accountStore.adjustPlayerProgress(target.id, ratingDelta, expDelta);
                    if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
                    return sendJson(res, 200, { ok: true, player: result.profile });
                }

                if (method === 'DELETE' && url.pathname === '/api/dev/player') {
                    const target = await resolveDevPlayer(body.query || body.playerId || '');
                    if (!target) return sendJson(res, 404, { ok: false, error: 'not_found' });
                    const result = await accountStore.deletePlayerById(target.id);
                    if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
                    return sendJson(res, 200, { ok: true, player: result.profile });
                }

                return sendJson(res, 404, { ok: false, error: 'not_found' });
            }

            if (method === 'GET' && url.pathname === '/api/players/lookup') {
                const friendCode = normalizeFriendCode(url.searchParams.get('friendCode') || '');
                if (!friendCode) return sendJson(res, 400, { ok: false, error: 'friend_code_missing' });
                const profile = await accountStore.getPlayerByFriendCode(friendCode);
                if (!profile) return sendJson(res, 404, { ok: false, error: 'not_found' });
                return sendJson(res, 200, { ok: true, player: profile });
            }

            if (method === 'GET' && url.pathname === '/api/friends') {
                if (!session) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
                return sendJson(res, 200, { ok: true, friends: await accountStore.listFriends(session.profile.id) });
            }

            if (method === 'GET' && url.pathname === '/api/friends/requests') {
                if (!session) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
                return sendJson(res, 200, { ok: true, requests: await accountStore.listFriendRequests(session.profile.id) });
            }

            if (method === 'POST' && url.pathname === '/api/friends/request') {
                if (!session) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
                const result = await accountStore.sendFriendRequest(session.profile.id, body.friendCode || '');
                if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
                return sendJson(res, 200, { ok: true, requestId: result.requestId });
            }

            if (method === 'POST' && url.pathname.startsWith('/api/friends/requests/')) {
                if (!session) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
                const match = url.pathname.match(/^\/api\/friends\/requests\/(\d+)\/respond$/);
                const requestId = Number(match?.[1] || 0);
                const result = await accountStore.respondFriendRequest(session.profile.id, requestId, body.action);
                if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
                return sendJson(res, 200, { ok: true, status: result.status });
            }

            if (method === 'GET' && url.pathname === '/api/matches') {
                if (!session) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
                const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)));
                return sendJson(res, 200, { ok: true, matches: await accountStore.listRecentMatches(session.profile.id, limit) });
            }

            if (method === 'POST' && url.pathname === '/api/matches') {
                if (!session) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
                const matchKey = String(body.matchKey || '').trim();
                if (!matchKey) return sendJson(res, 400, { ok: false, error: 'match_key_required' });

                if (pendingMatchHistoryKeys.has(matchKey)) {
                    for (let attempt = 0; attempt < 50 && pendingMatchHistoryKeys.has(matchKey); attempt++) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    if (pendingMatchHistoryKeys.has(matchKey)) {
                        return sendJson(res, 202, { ok: true, duplicate: true, pending: true });
                    }
                }

                const existing = await accountStore.hasMatchHistoryByKey(matchKey);
                if (existing) {
                    const player1 = existing.player1_id ? await accountStore.getPlayerById(existing.player1_id) : null;
                    const player2 = existing.player2_id ? await accountStore.getPlayerById(existing.player2_id) : null;
                    return sendJson(res, 200, { ok: true, id: existing.id, duplicate: true, player1, player2 });
                }
                pendingMatchHistoryKeys.add(matchKey);

                try {
                    const player1Id = body.player1Id ? Number(body.player1Id) : null;
                    const player2Id = body.player2Id ? Number(body.player2Id) : null;
                    const matchType = String(body.matchType || 'normal');
                    const result = String(body.result || '');
                    const isDraw = result === 'draw';
                    const player1Won = result === 'win';
                    const room = body.roomId ? rooms.get(String(body.roomId)) : null;
                    const resolveMatchProfile = async (id, name, roomProfile) => {
                        const hintedId = id || roomProfile?.id || null;
                        const resolvedById = hintedId ? await accountStore.getPlayerById(hintedId) : null;
                        if (resolvedById) return resolvedById;
                        const cleanedName = sanitizeDisplayName(name || roomProfile?.name || '');
                        if (!cleanedName) return null;
                        return accountStore.getPlayerByName(cleanedName);
                    };

                    let player1Profile = await resolveMatchProfile(player1Id, body.player1Name, room?.profileDetails?.[1]);
                    let player2Profile = await resolveMatchProfile(player2Id, body.player2Name, room?.profileDetails?.[2]);
                    if (body.roomId && matchType === 'rank' && (!player1Profile || !player2Profile)) {
                        return sendJson(res, 409, { ok: false, error: 'match_players_not_ready' });
                    }

                    const player1StartRating = Number(body.player1StartRating || player1Profile?.rating || 0);
                    const player2StartRating = Number(body.player2StartRating || player2Profile?.rating || 0);
                    const player1StartLevel = Number(body.player1Level || player1Profile?.level || 1);
                    const player2StartLevel = Number(body.player2Level || player2Profile?.level || 1);
                    let player1RatingDelta = 0;
                    let player2RatingDelta = 0;
                    const updateWarnings = [];
                    const ratingBonus = (playerRating, opponentRating) => {
                        const diff = Math.max(0, Number(opponentRating || 0) - Number(playerRating || 0));
                        return Math.floor(diff / 100);
                    };

                    if (matchType === 'rank' && !isDraw && player1Profile && player2Profile) {
                        const bonus1 = ratingBonus(player1StartRating, player2StartRating);
                        const bonus2 = ratingBonus(player2StartRating, player1StartRating);
                        player1RatingDelta = (player1Won ? 10 : -10) + bonus1;
                        player2RatingDelta = (player1Won ? -10 : 10) + bonus2;
                    } else if (matchType === 'rank' && player1Profile && !player2Profile && !isDraw) {
                        player1RatingDelta = player1Won ? 10 : -10;
                    }

                    const matchId = await accountStore.recordMatchHistory({
                        matchKey,
                        matchType,
                        player1Id: player1Profile?.id || null,
                        player2Id: player2Profile?.id || null,
                        player1Name: body.player1Name || player1Profile?.name || 'PLAYER 1',
                        player2Name: body.player2Name || player2Profile?.name || 'PLAYER 2',
                        winner: body.winner || (isDraw ? 'DRAW' : (winnerPlayerId === (player1Profile?.id || player1Id) ? (player1Profile?.name || 'PLAYER 1') : (player2Profile?.name || 'PLAYER 2'))),
                        loser: body.loser || (isDraw ? 'DRAW' : (loserPlayerId === (player1Profile?.id || player1Id) ? (player1Profile?.name || 'PLAYER 1') : (player2Profile?.name || 'PLAYER 2'))),
                        result: body.result || 'win',
                        player1RatingDelta,
                        player2RatingDelta,
                        player1Level: player1Profile?.level || player1StartLevel,
                        player2Level: player2Profile?.level || player2StartLevel,
                        player1StartRating,
                        player2StartRating,
                        startedTime: body.startedTime,
                        endedTime: body.endedTime,
                        timeTaken: body.timeTaken,
                        surrenderByPlayerId: body.surrenderByPlayerId || null,
                        winnerPlayerId: isDraw ? null : (player1Won ? (player1Profile?.id || null) : (player2Profile?.id || null)),
                        loserPlayerId: isDraw ? null : (!player1Won ? (player1Profile?.id || null) : (player2Profile?.id || null)),
                        summaryJson: body.summaryJson || null,
                        replayJson: null
                    });

                    if (player1Profile) {
                        try {
                            player1Profile = await accountStore.updatePlayerProgress(player1Profile.id, player1RatingDelta, 50);
                        } catch (error) {
                            updateWarnings.push(`player1:${error?.message || error}`);
                            console.error('match update failed for player1', error);
                        }
                    }
                    if (player2Profile) {
                        try {
                            player2Profile = await accountStore.updatePlayerProgress(player2Profile.id, player2RatingDelta, 50);
                        } catch (error) {
                            updateWarnings.push(`player2:${error?.message || error}`);
                            console.error('match update failed for player2', error);
                        }
                    }

                    return sendJson(res, 200, {
                        ok: true,
                        id: matchId,
                        player1: player1Profile,
                        player2: player2Profile,
                        warnings: updateWarnings.length ? updateWarnings : undefined
                    });
                } finally {
                    if (matchKey) pendingMatchHistoryKeys.delete(matchKey);
                }
            }

            return sendJson(res, 404, { ok: false, error: 'not_found' });
        }

    if (url.pathname === '/p1') {
        res.writeHead(302, { Location: '/index.html?online=1&player=1' });
        res.end(); return;
    }
    if (url.pathname === '/p2') {
        res.writeHead(302, { Location: '/index.html?online=1&player=2' });
        res.end(); return;
    }
    if (url.pathname === '/keepalive') {
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-cache'
        });
        res.end(JSON.stringify({ ok: true, now: Date.now() }));
        return;
    }

    const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.normalize(path.join(root, requestPath));

    if (!filePath.startsWith(root)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.readFile(filePath, (error, data) => {
        if (error) {
            res.writeHead(404); res.end('Not found'); return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, {
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
        });
        res.end(data);
    });
    } catch (error) {
        console.error('API request failed:', method, url.pathname, error?.message || error);
        sendJson(res, 500, { ok: false, error: error.message || 'server_error' });
    }
});

server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/ws') { socket.destroy(); return; }

    const key = req.headers['sec-websocket-key'];
    const accept = crypto
        .createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');

    socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '', ''
    ].join('\r\n'));

    const desiredPlayer = Number(url.searchParams.get('player') || 0);
    const requestedRoomId = url.searchParams.get('room');
    const random = url.searchParams.get('random') === '1';
    const matchTier = url.searchParams.get('matchTier') === 'normal' ? 'normal' : 'rank';
    const token = url.searchParams.get('token') || '';
    const authToken = url.searchParams.get('authToken') || '';

    const joined = random
        ? joinRandomRoom(socket, token, matchTier)
        : joinSpecificRoom(socket, requestedRoomId || 'default', desiredPlayer, token);

    if (!joined) {
        sendClose(socket, 1008, 'room is full');
        return;
    }

    const { room, role, player, token: reconnectToken } = joined;
    clients.set(socket, { roomId: room.id, role, player, token: reconnectToken, authToken });
    sendFrame(socket, {
        kind: 'hello',
        player,
        role,
        roomId: room.id,
        randomRoom: room.random,
        randomTier: room.randomTier || 'rank',
        randomWaitingCount: countRandomWaitingPlayers(room.randomTier || 'rank'),
        reconnectToken,
        snapshot: getRoomSnapshot(room),
        profiles: room.profiles,
        profileDetails: room.profileDetails
    });

    if (authToken && role === 'player' && player) {
        void (async () => {
            try {
                const result = await accountStore.restoreSession(authToken);
                if (!result.ok || socket.destroyed) return;
                const profile = result.profile;
                room.profileDetails[player] = {
                    id: profile.id,
                    playerId: profile.playerId,
                    name: profile.name,
                    level: profile.level,
                    rating: profile.rating,
                    exp: profile.exp
                };
                room.profiles[player] = profile.name;
                sendRoomProfiles(room);
            } catch {}
        })();
    }

    if (role === 'player' && player === 2 && room.seats[1].socket) {
        sendFrame(room.seats[1].socket, { kind: 'player_joined', player: 2 });
        sendFrame(socket, { kind: 'player_joined', player: 1 });
    }

    if (role === 'spectator') {
        broadcast(socket, { kind: 'spectator_joined', count: room.spectators.length }, room.id);
    }

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        let parsed = readFrame(buf);
        while (parsed) {
            const message = parsed.frame;
            buf = parsed.rest;
            if (message && message.close) { socket.destroy(); return; }
            if (message && message.ping) sendPong(socket, message.payload);
            else if (message && !message.ignored) {
                const senderInfo = clients.get(socket);
                if (senderInfo) trackRoomState(room, message, senderInfo);
                broadcast(socket, message, room.id);
            }
            parsed = readFrame(buf);
        }
    });

    socket.on('close', () => removeClient(socket));
    socket.on('error', () => removeClient(socket));
});

server.on('error', (error) => {
    console.error('Sector8 server error:', error.message);
    if (error.code === 'EADDRINUSE') {
        console.error(`Port ${port} is in use. Try: set PORT=8788 && node server.js`);
    }
});

if (require.main === module) {
    server.listen(port, '0.0.0.0', () => {
        console.log('');
        console.log('SECTOR-8 SERVER ONLINE');
        console.log(`Local:  http://localhost:${port}/`);
        console.log(`LAN:    http://<your-ip>:${port}/`);
        console.log('Render: deploy this repo as a Node web service');
        console.log('');
    });
}

module.exports = server;
