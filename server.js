/**
 * SECTOR-8: Information Collapse
 * WebSocket Server - Room / random / spectator / reconnect edition
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = __dirname;
const port = Number(process.env.PORT || 8787);
const MAX_SPECTATORS = 2;

const rooms = new Map();
const clients = new Map();
let pendingRandomRoomId = null;
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
        started: false,
        startConfig: null,
        history: [],
        profiles: { 1: null, 2: null },
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
        history: room.history
    };
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
        rooms.delete(room.id);
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

function joinRandomRoom(socket, token) {
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

    let room = pendingRandomRoomId ? rooms.get(pendingRandomRoomId) : null;
    if (!room || room.started || room.seats[2].socket) {
        room = createRoom(`RANDOM-${String(randomRoomSerial++).padStart(4, '0')}`, true);
        pendingRandomRoomId = room.id;
        room.seats[1].socket = socket;
        return { room, role: 'player', player: 1, token: room.seats[1].token };
    }

    room.seats[2].socket = socket;
    pendingRandomRoomId = null;
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
        return;
    }
    if (room.started && (message.kind === 'action' || message.kind === 'forfeit' || message.kind === 'win')) {
        room.history.push(message);
    }
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

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
    const token = url.searchParams.get('token') || '';

    const joined = random
        ? joinRandomRoom(socket, token)
        : joinSpecificRoom(socket, requestedRoomId || 'default', desiredPlayer, token);

    if (!joined) {
        sendClose(socket, 1008, 'room is full');
        return;
    }

    const { room, role, player, token: reconnectToken } = joined;
    clients.set(socket, { roomId: room.id, role, player, token: reconnectToken });
    sendFrame(socket, {
        kind: 'hello',
        player,
        role,
        roomId: room.id,
        reconnectToken,
        snapshot: getRoomSnapshot(room),
        profiles: room.profiles
    });

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

server.listen(port, '0.0.0.0', () => {
    console.log('');
    console.log('SECTOR-8 SERVER ONLINE');
    console.log(`Local:  http://localhost:${port}/`);
    console.log(`LAN:    http://<your-ip>:${port}/`);
    console.log('Render: deploy this repo as a Node web service');
    console.log('');
});
