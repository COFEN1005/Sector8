/**
 * SECTOR-8: Information Collapse
 * WebSocket Server - Room-based matchmaking edition
 * Compatible with: Render.com (set PORT env var automatically)
 * Local: node server.js
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = __dirname;
const port = Number(process.env.PORT || 8787);

// Map of roomId -> { p1: socket, p2: socket }
const rooms = new Map();
// Map of socket -> { player, roomId }
const clients = new Map();

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
};

function sendFrame(socket, payload) {
    if (socket.destroyed) return;
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

    try { socket.write(Buffer.concat([header, data])); } catch (e) {}
}

function sendClose(socket, code, reason) {
    if (socket.destroyed) return;
    const reasonBuffer = Buffer.from(reason || '');
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    try { socket.end(Buffer.concat([Buffer.from([0x88, payload.length]), payload])); } catch (e) {}
}

function sendPong(socket, pingPayload) {
    if (socket.destroyed) return;
    const payload = pingPayload || Buffer.alloc(0);
    try { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); } catch (e) {}
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
    [room.p1, room.p2].forEach(sock => {
        if (sock && sock !== senderSocket && !sock.destroyed) sendFrame(sock, payload);
    });
}

function removeClient(socket) {
    const info = clients.get(socket);
    clients.delete(socket);
    if (!info) return;

    const { roomId } = info;
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.p1 === socket) room.p1 = null;
    if (room.p2 === socket) room.p2 = null;

    if (!room.p1 && !room.p2) rooms.delete(roomId);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Legacy redirect endpoints for local LAN play
    if (url.pathname === '/p1') {
        res.writeHead(302, { Location: '/index.html?online=1&player=1' });
        res.end(); return;
    }
    if (url.pathname === '/p2') {
        res.writeHead(302, { Location: '/index.html?online=1&player=2' });
        res.end(); return;
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

    const player = Number(url.searchParams.get('player') || 0);
    const roomId = url.searchParams.get('room') || 'default';

    if (player !== 1 && player !== 2) {
        sendClose(socket, 1008, 'player must be 1 or 2');
        return;
    }

    // Register in room
    if (!rooms.has(roomId)) rooms.set(roomId, { p1: null, p2: null });
    const room = rooms.get(roomId);

    if ((player === 1 && room.p1 && !room.p1.destroyed) || (player === 2 && room.p2 && !room.p2.destroyed)) {
        sendClose(socket, 1008, 'seat already taken');
        return;
    }

    if (player === 1) room.p1 = socket;
    else if (player === 2) room.p2 = socket;

    clients.set(socket, { player, roomId });
    sendFrame(socket, { kind: 'hello', player });

    // Notify both players when P2 joins
    if (player === 2 && room.p1) {
        sendFrame(room.p1, { kind: 'player_joined', player: 2 });
        sendFrame(socket, { kind: 'player_joined', player: 1 });
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
            else if (message && !message.ignored) broadcast(socket, message, roomId);
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
