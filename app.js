/**
 * SECTOR-8: INFORMATION COLLAPSE
 * Core Game Engine - Teleport / 3-Map Edition (v2.0)
 * 
 * Changes v2.0:
 * - Area1/Area2/Area3: 11x11 grids
 * - Core: 3 tiles wide (center-aligned)
 * - Walls: 3x3 blocks, point-symmetric
 * - Unit lineup: 乙丙丁丁丙丁丁丙乙
 * - 甲 new ability: 暗殺者 (直線移動5・視界5, 撃破後1マス後退)
 * - AI tab restored
 * - AI teleport weight reduced
 * - Online match tab implemented
 */

// --- CONSTANTS & CONFIGURATION ---
const MAP_SIZES = {
    area1: { rows: 11, cols: 11 },
    area2: { rows: 11, cols: 11 },
    area3: { rows: 11, cols: 11 }
};

const PORTAL_COLS = [0, 1, 9, 10];
const WALLS_PER_MAP = 12;
const SCOUT_REINFORCE_INTERVAL = 10;
const MEDIC_SCOUT_REINFORCE_INTERVAL = 5;
const SCOUT_LIMIT_PER_PLAYER = 3;
const ACTIONS_PER_TURN = 2;
const FLAG_SURVIVAL_TURNS = 7;
const KEEPALIVE_WARNING_MS = 10 * 60 * 1000;
const DEVELOP_MODE_SEQUENCE = '12312321213';
const ALL_ABILITY_OPTIONS = ['千里眼', '鼓舞', '足跡', '歴戦王', '戦姫', '爆破', '暗殺者', '盲目', '衛生兵', '監視', '迷彩'];
const USERNAME_STORAGE_KEY = 'sector8_username';
const ONLINE_SESSION_STORAGE_KEY = 'sector8_online_session';
const AUTH_SESSION_STORAGE_KEY = 'sector8_auth_session';
const LAST_PLAYER_ID_STORAGE_KEY = 'sector8_last_player_id';
const UI_SETTINGS_STORAGE_KEY = 'sector8_ui_settings';

function getPortalDestination(mapName, r, c) {
    if (!PORTAL_COLS.includes(c)) return null;

    if (mapName === 'area1' && r === 0) {
        return { map: 'area2', row: 10, col: c };
    }
    if (mapName === 'area2') {
        if (r === 10) return { map: 'area1', row: 0, col: c };
        if (r === 0) return { map: 'area3', row: 10, col: c };
    }
    if (mapName === 'area3' && r === 10) {
        return { map: 'area2', row: 0, col: c };
    }
    return null;
}

function getAreaLabel(mapName) {
    if (mapName === 'area1') return 'エリア1';
    if (mapName === 'area2') return 'エリア2';
    return 'エリア3';
}

function resolveMoveDestination(unit, destRow, destCol) {
    const localCell = boards[unit.map][destRow][destCol];
    const portalDest = unit.type === 'scout' ? null : getPortalDestination(unit.map, destRow, destCol);

    if (!portalDest) {
        return {
            portalDest: null,
            targetMap: unit.map,
            targetRow: destRow,
            targetCol: destCol,
            localOccupant: localCell.unit,
            destOccupant: localCell.unit
        };
    }

    return {
        portalDest,
        targetMap: portalDest.map,
        targetRow: portalDest.row,
        targetCol: portalDest.col,
        localOccupant: localCell.unit,
        destOccupant: boards[portalDest.map][portalDest.row][portalDest.col].unit
    };
}

function isFrontlineOwnBaseTeleport(unit, portalDest) {
    return Boolean(unit.isFrontline && portalDest && (
        (unit.player === 1 && portalDest.map === 'area1') ||
        (unit.player === 2 && portalDest.map === 'area3')
    ));
}

function isMoveDestinationBlockedByFriendly(unit, destRow, destCol) {
    const resolved = resolveMoveDestination(unit, destRow, destCol);
    return Boolean(
        isFrontlineOwnBaseTeleport(unit, resolved.portalDest) ||
        (resolved.localOccupant && resolved.localOccupant.player === unit.player) ||
        (resolved.portalDest && resolved.destOccupant && resolved.destOccupant.player === unit.player)
    );
}

function isDiagonalCornerBlocked(map, fromRow, fromCol, toRow, toCol) {
    const dr = toRow - fromRow;
    const dc = toCol - fromCol;
    if (Math.abs(dr) !== 1 || Math.abs(dc) !== 1) return false;

    const adj1 = boards[map]?.[fromRow]?.[toCol];
    const adj2 = boards[map]?.[toRow]?.[fromCol];
    return Boolean(adj1?.isWall || adj2?.isWall);
}

function isOccupantVisibleToPlayer(occupant, viewerPlayer, mapName) {
    if (!occupant) return false;
    if (occupant.player === viewerPlayer) return true;
    const vision = viewerPlayer === 1 ? p1Vision : p2Vision;
    return isUnitVisibleToViewer(occupant, viewerPlayer, vision[mapName]);
}

function shouldIgnoreOccupantForPreview(unit, occupant, mapName, options = {}) {
    if (!options.hideUnseenEnemies || !occupant || occupant.player === unit.player) return false;
    return !isOccupantVisibleToPlayer(occupant, unit.player, mapName);
}

// --- GAME STATE ---
let boards = { area1: [], area2: [], area3: [] };
let units = [];
let currentPlayer = 1;
let gameTurn = 1;
let p1Ability = '足跡';
let p2Ability = '歴戦王';
let vsAI = true;
let gameMode = 'debug';
let isGameOver = false;
let protectedWallCells = new Set();
let scoutReinforcementSerial = 0;
let militaryFlagSerial = 0;
let gameSeed = 1;
let actionsThisTurn = 0;
let actedUnitIds = new Set();
let militaryFlags = [];
let lastKeepAliveAt = Date.now();
let developModeEnabled = false;
let developModeSequence = '';
let audioInitialized = false;
let moveSfxEnabled = true;
let bgmEnabled = true;
let moveSfx = null;
let bgmTrack = null;
let lobbyBgmTrack = null;
let uiSfx = null;
let turnSfx = null;
let moveSfxVolume = 0.55;
let bgmVolume = 0.35;
let visionSaturation = 1;
let afkTurnTimer = null;
let afkTurnPopupShown = false;
let lastTurnOwner = null;
let currentMatchKey = null;
let currentMatchStartedAt = 0;
let currentMatchStartProfile = null;
let currentMatchOpponentStartProfile = null;
let currentMatchRecord = null;
let currentMatchReplay = null;
let activeMatchSummaryView = null;
let replayPlaybackActive = false;
let replayPlaybackTimer = null;
let replayPlaybackRunId = 0;
let replayPlaybackSource = null;
let replayViewerSnapshots = [];
let replayViewerIndex = 0;
let replayViewerEntry = null;
let replayViewerOpen = false;

let selectedUnit = null;
let previewUnit = null;
let selectedAction = 'move';
let activePhase = 'setup';
let activeMap = 'area1';

let p1Vision = { area1: new Set(), area2: new Set(), area3: new Set() };
let p2Vision = { area1: new Set(), area2: new Set(), area3: new Set() };
let p1LastVision = { area1: new Set(), area2: new Set(), area3: new Set() };
let p2LastVision = { area1: new Set(), area2: new Set(), area3: new Set() };
let p1VisionHistory = [];
let p2VisionHistory = [];

let p1KohDestroyed = false;
let p2KohDestroyed = false;
let p1ClairvoyanceDir = null;
let p2ClairvoyanceDir = null;
let p1ClairvoyanceAge = 0;
let p2ClairvoyanceAge = 0;

function createRng(seed) {
    let t = seed >>> 0;
    return function random() {
        t += 0x6D2B79F5;
        let x = Math.imul(t ^ (t >>> 15), 1 | t);
        x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffleWithRng(items, rng) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function cellKey(mapName, r, c) {
    return `${mapName}:${r},${c}`;
}

// --- ONLINE MULTIPLAYER STATE ---
const urlParams = new URLSearchParams(window.location.search);
let onlineMode = urlParams.get('online') === '1';
let localPlayer = onlineMode ? Number(urlParams.get('player') || 0) : null;
let onlineSocket = null;
let applyingRemoteAction = false;
let spectatorMode = false;
let spectatorViewPlayer = 1;
let reconnectTimer = null;
let manualDisconnect = false;
let onlineSession = null;
let authSession = null;
let authProfile = null;
let matchHistoryCache = [];
let matchHistoryLoadedForPlayerId = null;
let matchHistoryRequestToken = 0;
let devTargetPlayer = null;
let onlineProfileDetails = { 1: null, 2: null };
let matchIntroActive = false;
let matchIntroTimer = null;
let pendingMatchIntroCutIn = false;
let drawRequestTurnByPlayer = { 1: null, 2: null };
// Matchmaking state
let matchmakingMode = false;
let matchmakingRole = null; // 'host' or 'guest'
let matchRoomId = null;
let onlineAbilityChoices = { 1: null, 2: null };
let onlineReadyState = { 1: false, 2: false };
let localUsername = '';
let onlineUsernames = { 1: null, 2: null };
let onlineMatchTier = 'rank';
let onlineMatchPreviewActive = false;
let randomMatchAutoStarted = false;
let privateMatchAutoStarted = false;
let privateMatchAutoStartTimer = null;
let randomQueuePending = false;
let randomWaitingCount = 0;

function hashStringToSeed(value) {
    let hash = 0x811c9dc5;
    String(value || '').split('').forEach(char => {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193);
    });
    return hash >>> 0;
}

function getOnlineMatchTier() {
    return onlineMatchTier === 'normal' ? 'normal' : 'rank';
}

function isRankedMatch() {
    return onlineMode && getOnlineMatchTier() === 'rank';
}

function getCurrentMatchType() {
    if (!onlineMode) {
        return 'normal';
    }
    if (onlineMode && !isRandomMatchRoom() && (matchmakingRole === 'host' || matchmakingRole === 'guest')) {
        return 'private';
    }
    return getOnlineMatchTier();
}

function detectDeviceProfile() {
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const narrowScreen = window.matchMedia('(max-width: 768px)').matches;
    const mobileAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    return (coarsePointer && narrowScreen) || mobileAgent ? 'mobile' : 'pc';
}

function applyDeviceProfile() {
    const profile = detectDeviceProfile();
    document.body.classList.toggle('device-mobile', profile === 'mobile');
    document.body.classList.toggle('device-pc', profile === 'pc');
    document.body.dataset.device = profile;
}

function sanitizeUsername(name) {
    return (name || '').trim().replace(/\s+/g, ' ').slice(0, 20);
}

function sanitizePlayerIdInput(value) {
    return (value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
}

function sanitizeFriendCodeInput(value) {
    return (value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function formatFriendCodeDisplay(code) {
    const normalized = sanitizeFriendCodeInput(code);
    if (normalized.length !== 12) return normalized;
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}`;
}

function loadSavedOnlineSession() {
    try {
        const raw = window.localStorage.getItem(ONLINE_SESSION_STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!saved?.token || !saved?.roomId) return;
        onlineSession = saved;
        onlineMode = true;
        localPlayer = saved.player || null;
        matchRoomId = saved.roomId;
        spectatorMode = saved.role === 'spectator';
        matchmakingRole = saved.randomRoom ? 'random' : 'resume';
    } catch {}
}

function getDefaultUsername() {
    return 'Commander';
}

function loadSavedUsername() {
    try {
        localUsername = sanitizeUsername(window.localStorage.getItem(USERNAME_STORAGE_KEY)) || getDefaultUsername();
    } catch {
        localUsername = getDefaultUsername();
    }
}

function loadSavedAuthSession() {
    try {
        const raw = window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!saved?.token || !saved?.profile) return;
        authSession = { token: saved.token };
        authProfile = saved.profile;
        if (authProfile?.name) {
            localUsername = sanitizeUsername(authProfile.name) || getDefaultUsername();
        }
    } catch {}
}

function loadSavedUiSettings() {
    try {
        const raw = window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (typeof saved.moveSfxEnabled === 'boolean') moveSfxEnabled = saved.moveSfxEnabled;
        if (typeof saved.bgmEnabled === 'boolean') bgmEnabled = saved.bgmEnabled;
        if (Number.isFinite(Number(saved.moveSfxVolume))) moveSfxVolume = Math.min(1, Math.max(0, Number(saved.moveSfxVolume)));
        if (Number.isFinite(Number(saved.bgmVolume))) bgmVolume = Math.min(1, Math.max(0, Number(saved.bgmVolume)));
        if (Number.isFinite(Number(saved.visionSaturation))) visionSaturation = Math.min(1.6, Math.max(0.2, Number(saved.visionSaturation)));
    } catch {}
    document.documentElement.style.setProperty('--vision-brightness', String(visionSaturation));
}

function saveUiSettings() {
    try {
        window.localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify({
            moveSfxEnabled,
            bgmEnabled,
            moveSfxVolume,
            bgmVolume,
            visionSaturation
        }));
    } catch {}
}

function safeJsonParse(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function formatReplayUnitName(unit) {
    if (!unit) return 'UNKNOWN';
    const baseName = unit.victimName || unit.name || unit.type || 'UNKNOWN';
    const owner = unit.victimPlayer || unit.player;
    return `${baseName}${owner ? ` (P${owner})` : ''}`;
}

function createMatchRecordBase() {
    return {
        matchKey: currentMatchKey,
        startedTime: currentMatchStartedAt || Date.now(),
        endedTime: null,
        timeTaken: null,
        matchType: getCurrentMatchType(),
        config: {
            p1Ability,
            p2Ability,
            seed: gameSeed
        },
        firstPlayer: currentPlayer,
        startProfile: authProfile ? {
            id: authProfile.id,
            playerId: authProfile.playerId,
            name: authProfile.name,
            level: authProfile.level,
            exp: authProfile.exp,
            rating: authProfile.rating
        } : null,
        opponentStartProfile: currentMatchOpponentStartProfile ? { ...currentMatchOpponentStartProfile } : null,
        captures: [],
        result: null,
        winnerId: null,
        loserId: null,
        reason: null,
        summary: null
    };
}

function createMatchReplayBase() {
    return {
        matchKey: currentMatchKey,
        startedTime: currentMatchStartedAt || Date.now(),
        config: {
            p1Ability,
            p2Ability,
            seed: gameSeed
        },
        events: [],
        snapshots: []
    };
}

function resetMatchRecording() {
    currentMatchRecord = createMatchRecordBase();
    currentMatchReplay = createMatchReplayBase();
    activeMatchSummaryView = null;
    resetDrawRequests();
}

function resetDrawRequests() {
    drawRequestTurnByPlayer = { 1: null, 2: null };
    updateDrawButtonState();
}

function hasActiveDrawRequest(player) {
    return drawRequestTurnByPlayer[player] === gameTurn;
}

function isMutualDrawRequested() {
    return hasActiveDrawRequest(1) && hasActiveDrawRequest(2);
}

function updateDrawButtonState() {
    const drawBtn = document.getElementById('btn-draw');
    if (!drawBtn) return;
    const pending = hasActiveDrawRequest(1) || hasActiveDrawRequest(2);
    drawBtn.textContent = pending ? '引き分け申請中' : '引き分け申請';
    drawBtn.classList.toggle('active', pending);
    drawBtn.disabled = isGameOver || activePhase !== 'battle' || spectatorMode;
}

function receiveDrawRequest(player, requestTurn) {
    if (!player || isGameOver || activePhase !== 'battle') return;
    if (requestTurn !== gameTurn) return;
    drawRequestTurnByPlayer[player] = requestTurn;
    addConsoleLog(`SYSTEM: Player ${player} が引き分けを申請しました。`, player === 1 ? 'p1' : 'p2');
    updateDrawButtonState();
    if (isMutualDrawRequested()) {
        triggerDraw(true, 'mutual');
    }
}

function requestDraw() {
    if (isGameOver || activePhase !== 'battle') return;
    const requester = onlineMode ? localPlayer : currentPlayer;
    if (!requester) return;
    if (drawRequestTurnByPlayer[requester] === gameTurn) {
        addConsoleLog(`SYSTEM: Player ${requester} の引き分け申請は既に受理待ちです。`, requester === 1 ? 'p1' : 'p2');
        updateDrawButtonState();
        return;
    }
    drawRequestTurnByPlayer[requester] = gameTurn;
    addConsoleLog(`SYSTEM: Player ${requester} が引き分けを申請しました。`, requester === 1 ? 'p1' : 'p2');
    updateDrawButtonState();
    if (onlineMode) sendOnlineMessage({ kind: 'draw_request', turn: gameTurn });
    if (isMutualDrawRequested()) {
        triggerDraw(false, 'mutual');
    }
}

function setGameOverTitle(title, tone = 'gold') {
    const titleEl = document.getElementById('game-over-title');
    if (!titleEl) return;
    titleEl.textContent = title;
    titleEl.setAttribute('data-text', title);
    titleEl.className = 'glitch-text';
    if (tone === 'gold') titleEl.classList.add('text-gold');
    else if (tone === 'cyan') titleEl.classList.add('text-cyan');
    else if (tone === 'magenta') titleEl.classList.add('text-magenta');
}

function recordMatchReplayEvent(event) {
    if (replayPlaybackActive) return;
    if (!currentMatchReplay) currentMatchReplay = createMatchReplayBase();
    currentMatchReplay.events.push({
        ...event,
        at: Date.now(),
        turn: gameTurn,
        player: currentPlayer
    });
}

function recordMatchCapture(victim, attackerPlayer) {
    if (replayPlaybackActive) return;
    if (!currentMatchRecord) currentMatchRecord = createMatchRecordBase();
    currentMatchRecord.captures.push({
        victimName: victim?.name || 'UNKNOWN',
        victimType: victim?.type || 'unknown',
        victimPlayer: victim?.player || null,
        attackerPlayer: attackerPlayer || null,
        map: victim?.map || '',
        row: Number(victim?.row || 0),
        col: Number(victim?.col || 0),
        turn: gameTurn
    });
}

function buildMatchSummary(reason, winnerId) {
    const endedTime = Date.now();
    const matchType = getCurrentMatchType();
    const startProfile = currentMatchRecord?.startProfile || null;
    const endedProfile = authProfile || startProfile;
    const opponentName = onlineMode
        ? getOnlineDisplayName(localPlayer === 1 ? 2 : 1)
        : (vsAI ? 'AI BOT' : 'PLAYER 2');
    const viewerSide = onlineMode && localPlayer ? localPlayer : 1;
    const isDraw = winnerId == null || reason === 'draw';
    const viewerWon = isDraw ? null : winnerId === viewerSide;
    const summary = {
        matchKey: currentMatchKey,
        matchType,
        reason,
        winnerId: isDraw ? null : winnerId,
        loserId: isDraw ? null : (winnerId === 1 ? 2 : 1),
        player1Name: currentMatchRecord?.startProfile?.name || authProfile?.name || 'PLAYER 1',
        player2Name: opponentName,
        winnerName: isDraw ? 'DRAW' : (winnerId === 1 ? (currentMatchRecord?.player1Name || authProfile?.name || 'PLAYER 1') : opponentName),
        loserName: isDraw ? 'DRAW' : (winnerId === 1 ? opponentName : (currentMatchRecord?.player1Name || authProfile?.name || 'PLAYER 1')),
        startedTime: currentMatchStartedAt || endedTime,
        endedTime,
        timeTaken: Math.max(0, endedTime - (currentMatchStartedAt || endedTime)),
        firstPlayer: currentMatchRecord?.firstPlayer || currentPlayer,
        p1: {
            name: currentMatchRecord?.startProfile?.name || authProfile?.name || 'PLAYER 1',
            playerId: currentMatchRecord?.startProfile?.playerId || null,
            level: currentMatchRecord?.startProfile?.level ?? 1,
            rating: currentMatchRecord?.startProfile?.rating ?? 0
        },
        p2: {
            name: currentMatchRecord?.opponentStartProfile?.name || opponentName,
            playerId: currentMatchRecord?.opponentStartProfile?.playerId || null,
            level: currentMatchRecord?.opponentStartProfile?.level ?? 1,
            rating: currentMatchRecord?.opponentStartProfile?.rating ?? null
        },
        captures: [...(currentMatchRecord?.captures || [])],
        capturedByPlayer1: (currentMatchRecord?.captures || []).filter(entry => Number(entry.victimPlayer) === 1),
        capturedByPlayer2: (currentMatchRecord?.captures || []).filter(entry => Number(entry.victimPlayer) === 2),
        resultText: isDraw ? 'DRAW' : (viewerWon ? 'VICTORY' : 'DEFEAT'),
        viewerWon,
        winnerPlayerId: isDraw ? null : winnerId,
        loserPlayerId: isDraw ? null : (winnerId === 1 ? 2 : 1),
        startProfile,
        endProfile: endedProfile ? {
            id: endedProfile.id,
            playerId: endedProfile.playerId,
            name: endedProfile.name,
            level: endedProfile.level,
            exp: endedProfile.exp,
            rating: endedProfile.rating
        } : null,
        player1StartRating: currentMatchRecord?.startProfile?.rating ?? null,
        player2StartRating: currentMatchRecord?.opponentStartProfile?.rating ?? null,
        opponentStartRating: currentMatchRecord?.opponentStartProfile?.rating ?? null,
        ratingDelta: isDraw ? 0 : null,
        expDelta: isDraw ? 0 : null
    };
    if (isDraw) {
        summary.ratingDelta = 0;
        summary.expDelta = 0;
    } else if (startProfile && endedProfile && startProfile.id === endedProfile.id) {
        summary.ratingDelta = Number(endedProfile.rating || 0) - Number(startProfile.rating || 0);
        summary.expDelta = Number(endedProfile.exp || 0) - Number(startProfile.exp || 0);
    }
    if (currentMatchRecord) {
        currentMatchRecord.endedTime = endedTime;
        currentMatchRecord.timeTaken = summary.timeTaken;
        currentMatchRecord.matchType = matchType;
        currentMatchRecord.result = isDraw ? 'draw' : (viewerWon ? 'win' : 'lose');
        currentMatchRecord.winnerId = isDraw ? null : winnerId;
        currentMatchRecord.loserId = summary.loserId;
        currentMatchRecord.reason = reason;
        currentMatchRecord.summary = summary;
    }
    return summary;
}

function formatCaptureList(captures = []) {
    if (!captures.length) return '<div class="match-history-empty">なし</div>';
    return captures.map(entry => `
        <div class="match-summary-capture-row">
            <span class="match-summary-capture-name">${formatReplayUnitName(entry)}</span>
            <span class="match-summary-capture-meta">${entry.victimType || 'unit'} / ${entry.map || 'map'} / T${entry.turn}</span>
        </div>
    `).join('');
}

function renderGameOverSummary(summary = null) {
    const summaryEl = document.getElementById('game-summary-panel');
    const captureP1El = document.getElementById('summary-captured-p1');
    const captureP2El = document.getElementById('summary-captured-p2');
    const statsEl = document.getElementById('summary-stats');
    const replayBtn = document.getElementById('btn-replay-match');
    const restartBtn = document.getElementById('btn-restart');
    if (!summaryEl || !captureP1El || !captureP2El || !statsEl) return;

    if (!summary) {
        summaryEl.classList.add('hidden');
        if (replayBtn) replayBtn.disabled = true;
        if (restartBtn) restartBtn.textContent = 'RELOAD SYSTEM';
        return;
    }

    const capturedByP1 = summary.capturedByPlayer1 || [];
    const capturedByP2 = summary.capturedByPlayer2 || [];
    const timeTaken = Number(summary.timeTaken || 0);
    const isDraw = String(summary.resultText || '').toUpperCase() === 'DRAW';
    summaryEl.classList.remove('hidden');
    captureP1El.innerHTML = formatCaptureList(capturedByP1);
    captureP2El.innerHTML = formatCaptureList(capturedByP2);
    statsEl.innerHTML = `
        <div class="summary-row"><span>MODE</span><strong>${String(summary.matchType || 'unknown').toUpperCase()}</strong></div>
        <div class="summary-row"><span>TIME</span><strong>${Math.floor(timeTaken / 60000)}m ${String(Math.floor((timeTaken % 60000) / 1000)).padStart(2, '0')}s</strong></div>
        <div class="summary-row"><span>${isDraw ? 'RESULT' : 'WINNER'}</span><strong>${summary.winnerName || 'UNKNOWN'}</strong></div>
        <div class="summary-row"><span>OPP START RATING</span><strong>${(summary.player2StartRating ?? summary.opponentStartRating) == null ? '-' : (summary.player2StartRating ?? summary.opponentStartRating)}</strong></div>
        <div class="summary-row"><span>RATING Δ</span><strong>${summary.ratingDelta === null ? '-' : (summary.ratingDelta > 0 ? `+${summary.ratingDelta}` : String(summary.ratingDelta))}</strong></div>
        <div class="summary-row"><span>EXP Δ</span><strong>${summary.expDelta === null ? '-' : (summary.expDelta > 0 ? `+${summary.expDelta}` : String(summary.expDelta))}</strong></div>
    `;
    if (replayBtn) replayBtn.disabled = !(summary.replay && summary.replay.snapshots && summary.replay.snapshots.length);
    if (restartBtn) restartBtn.textContent = 'RELOAD SYSTEM';
}

function normalizeMatchHistoryEntry(entry) {
    const summary = safeJsonParse(entry?.summary_json || entry?.summaryJson, null);
    const replay = safeJsonParse(entry?.replay_json || entry?.replayJson, null);
    return {
        ...entry,
        summary_json: summary || null,
        replay_json: replay || null
    };
}

function startReplayPlayback(matchEntry) {
    const entry = normalizeMatchHistoryEntry(matchEntry);
    const replay = entry.replay_json;
    const snapshots = Array.isArray(replay?.snapshots) ? replay.snapshots : [];
    if (!snapshots.length) {
        showStatusAlert('リプレイデータがありません。', 'warning', 2500);
        return;
    }
    replayPlaybackSource = entry;
    replayViewerEntry = entry;
    replayViewerSnapshots = snapshots.map(hydrateReplaySnapshot);
    replayViewerIndex = 0;
    replayPlaybackActive = true;
    replayViewerOpen = true;
    const replaySummary = entry.summary_json || {};
    activeMatchSummaryView = { ...replaySummary, replay };
    document.getElementById('game-summary-panel')?.classList.add('hidden');
    document.getElementById('replay-viewer')?.classList.remove('hidden');
    document.getElementById('btn-replay-match')?.classList.add('hidden');
    document.getElementById('btn-replay-close')?.classList.remove('hidden');
    document.getElementById('replay-slider').max = String(Math.max(0, replayViewerSnapshots.length - 1));
    renderReplaySnapshot(0);
}

function renderReplaySnapshot(index = 0) {
    if (!replayViewerSnapshots.length) return;
    const safeIndex = Math.min(Math.max(0, Number(index) || 0), replayViewerSnapshots.length - 1);
    replayViewerIndex = safeIndex;
    const snapshot = replayViewerSnapshots[safeIndex];
    const slider = document.getElementById('replay-slider');
    const turnLabel = document.getElementById('replay-turn-label');
    const snapshotLabel = document.getElementById('replay-snapshot-label');
    const snapshotCount = document.getElementById('replay-snapshot-count');
    if (slider) slider.value = String(safeIndex);
    if (turnLabel) {
        turnLabel.textContent = `TURN ${snapshot.turn || safeIndex + 1} / PLAYER ${snapshot.currentPlayer || 1}`;
    }
    if (snapshotLabel) {
        snapshotLabel.textContent = snapshot.label || `TURN ${snapshot.turn || safeIndex + 1}`;
    }
    if (snapshotCount) {
        snapshotCount.textContent = `${safeIndex + 1} / ${replayViewerSnapshots.length}`;
    }

    withReplayRenderState(snapshot, () => {
        renderBoard({
            boardId: 'replay-board',
            mapName: snapshot.activeMap || activeMap,
            viewerPlayerOverride: snapshot.viewerPlayer || 1,
            updateLinkedPanels: false,
            interactive: false,
            revealAll: true
        });
    });
}

function closeReplayViewer() {
    replayPlaybackActive = false;
    replayViewerOpen = false;
    replayViewerEntry = null;
    replayViewerSnapshots = [];
    replayViewerIndex = 0;
    document.getElementById('replay-viewer')?.classList.add('hidden');
    document.getElementById('game-summary-panel')?.classList.remove('hidden');
    document.getElementById('btn-replay-match')?.classList.remove('hidden');
    document.getElementById('btn-replay-close')?.classList.add('hidden');
}

function openMatchHistorySummary(matchEntry) {
    const entry = normalizeMatchHistoryEntry(matchEntry);
    const outcome = getMatchHistoryOutcome(entry);
    const summary = entry.summary_json || {
        matchKey: entry.match_key || entry.matchKey || null,
        matchType: entry.match_type || 'unknown',
        reason: entry.reason || 'history',
        winnerId: entry.winner_id || null,
        loserId: entry.loser_id || null,
        player1Name: entry.player1_name || 'PLAYER 1',
        player2Name: entry.player2_name || 'PLAYER 2',
        winnerName: outcome === 'DRAW' ? 'DRAW' : (entry.winner || 'UNKNOWN'),
        loserName: outcome === 'DRAW' ? 'DRAW' : (entry.loser || 'UNKNOWN'),
        startedTime: entry.started_time || entry.startedTime || Date.now(),
        endedTime: entry.ended_time || entry.endedTime || Date.now(),
        timeTaken: entry.time_taken || entry.timeTaken || 0,
        firstPlayer: entry.first_player || 1,
        p1: { name: entry.player1_name || 'PLAYER 1', playerId: null, level: entry.player1_level || 1, rating: null },
        p2: { name: entry.player2_name || 'PLAYER 2', playerId: null, level: entry.player2_level || 1, rating: entry.player2_start_rating ?? entry.summary_json?.player2StartRating ?? null },
        captures: [],
        capturedByPlayer1: [],
        capturedByPlayer2: [],
        resultText: outcome === 'LOSE' ? 'DEFEAT' : (outcome === 'DRAW' ? 'DRAW' : 'VICTORY'),
        viewerWon: outcome === 'LOSE' ? false : (outcome === 'DRAW' ? null : true),
        ratingDelta: entry.player1_get_rating || 0,
        expDelta: null,
        player2StartRating: entry.player2_start_rating ?? entry.summary_json?.player2StartRating ?? null
    };
    activeMatchSummaryView = summary;
    activeMatchSummaryView.replay = entry.replay_json || null;
    replayPlaybackSource = entry;
    replayViewerEntry = entry;
    replayViewerSnapshots = Array.isArray(entry.replay_json?.snapshots) ? entry.replay_json.snapshots.map(hydrateReplaySnapshot) : [];
    replayViewerIndex = 0;
    replayPlaybackActive = false;
    document.getElementById('replay-viewer')?.classList.add('hidden');
    document.getElementById('game-summary-panel')?.classList.remove('hidden');
    document.getElementById('btn-replay-match')?.classList.remove('hidden');
    document.getElementById('btn-replay-close')?.classList.add('hidden');
    renderGameOverSummary(activeMatchSummaryView);
    setGameOverTitle(summary.resultText || 'MATCH SUMMARY', summary.resultText === 'VICTORY' ? 'cyan' : (summary.resultText === 'DEFEAT' ? 'magenta' : 'gold'));
    document.getElementById('game-over-subtitle').textContent = summary.resultText === 'DRAW'
        ? '双方が同意した引き分けです。'
        : `${entry.player1_name || 'PLAYER 1'} VS ${entry.player2_name || 'PLAYER 2'}`;
    document.getElementById('game-over-overlay')?.classList.remove('hidden');
    const replayBtn = document.getElementById('btn-replay-match');
    if (replayBtn) {
        replayBtn.disabled = !(entry.replay_json?.snapshots?.length);
    }
}

function saveAuthSession() {
    try {
        if (authSession?.token && authProfile) {
            window.localStorage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify({
                token: authSession.token,
                profile: authProfile
            }));
        } else {
            window.localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
        }
    } catch {}
}

async function apiRequest(path, { method = 'GET', body = null, auth = true, headers: extraHeaders = {} } = {}) {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (auth && authSession?.token) headers.Authorization = `Bearer ${authSession.token}`;
    const response = await fetch(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
        const error = new Error(data.error || `HTTP_${response.status}`);
        error.status = response.status;
        error.data = data;
        throw error;
    }
    return data;
}

function updateUsernameUI() {
    const input = document.getElementById('username-input');
    const saved = document.getElementById('username-saved');
    if (input) input.value = localUsername;
    if (saved) saved.textContent = `現在: ${localUsername}`;
}

function saveUsername(notify = true) {
    const input = document.getElementById('username-input');
    const nextName = sanitizeUsername(input?.value) || getDefaultUsername();
    localUsername = nextName;
    try {
        window.localStorage.setItem(USERNAME_STORAGE_KEY, localUsername);
    } catch {}
    if (authSession?.token && authProfile) updateAccountName(nextName).catch(() => {});
    updateUsernameUI();
    updateUI();
    updateMatchmakingPlayerSummary();
    if (onlineMode && localPlayer) {
        onlineUsernames[localPlayer] = localUsername;
        sendOnlineMessage({ kind: 'profile', username: localUsername });
    }
    if (notify) showStatusAlert(`ユーザー名を保存しました: ${localUsername}`, 'system', 2500);
}

function updateAccountUI() {
    const statusEl = document.getElementById('account-status');
    const playerIdEl = document.getElementById('account-player-id');
    const friendCodeEl = document.getElementById('account-friend-code');
    const levelEl = document.getElementById('account-level');
    const ratingEl = document.getElementById('account-rating');
    const expEl = document.getElementById('account-exp');
    const copyPlayerIdBtn = document.getElementById('btn-copy-player-id');
    const copyFriendCodeBtn = document.getElementById('btn-copy-friend-code');
    const loginBtn = document.getElementById('btn-account-login');
    const registerBtn = document.getElementById('btn-account-register');
    const logoutBtn = document.getElementById('btn-account-logout');
    const loggedIn = Boolean(authSession?.token && authProfile);

    if (statusEl) {
        statusEl.textContent = loggedIn
            ? `LOGIN OK / ${authProfile.name}`
            : 'REGISTER: USER NAME + 4桁PIN / LOGIN: PLAYER ID + 4桁PIN';
        statusEl.classList.toggle('logged-in', loggedIn);
        statusEl.classList.toggle('error', false);
    }
    if (playerIdEl) playerIdEl.textContent = loggedIn ? authProfile.playerId : '--------';
    if (friendCodeEl) friendCodeEl.textContent = loggedIn ? formatFriendCodeDisplay(authProfile.friendCode) : '--- --- ---';
    if (levelEl) levelEl.textContent = loggedIn ? `LV ${authProfile.level}` : 'LV -';
    if (ratingEl) ratingEl.textContent = loggedIn ? String(authProfile.rating) : '-';
    if (expEl) expEl.textContent = loggedIn ? `${authProfile.exp}/100` : '0/100';
    if (copyPlayerIdBtn) copyPlayerIdBtn.disabled = !loggedIn;
    if (copyFriendCodeBtn) copyFriendCodeBtn.disabled = !loggedIn;
    const playerIdInput = document.getElementById('account-player-id-input');
    if (loginBtn) loginBtn.disabled = !playerIdInput?.value || !document.getElementById('account-pin-input')?.value;
    if (registerBtn) registerBtn.disabled = !document.getElementById('account-pin-input')?.value;
    if (logoutBtn) logoutBtn.disabled = !loggedIn;
    updateLobbyPlayerCard();
}

function clearAccountInputs() {
    const playerIdInput = document.getElementById('account-player-id-input');
    const pinInput = document.getElementById('account-pin-input');
    if (playerIdInput) playerIdInput.value = '';
    if (pinInput) pinInput.value = '';
    updateAccountUI();
}

function updateLobbyPlayerCard() {
    const card = document.getElementById('lobby-player-card');
    const nameEl = document.getElementById('lobby-player-name');
    const levelEl = document.getElementById('lobby-player-level');
    const ratingEl = document.getElementById('lobby-player-rating');
    if (!card) return;

    const shouldShow = activePhase !== 'battle';
    card.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) return;

    const profileName = authProfile?.name || localUsername || getDefaultUsername();
    const levelValue = authProfile?.level ?? null;
    const ratingValue = authProfile?.rating ?? null;

    if (nameEl) nameEl.textContent = profileName;
    if (levelEl) levelEl.textContent = levelValue === null ? '-' : String(levelValue);
    if (ratingEl) ratingEl.textContent = ratingValue === null ? '-' : String(ratingValue);
}

function setAccountStatus(message, tone = 'system') {
    const statusEl = document.getElementById('account-status');
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle('logged-in', tone === 'success');
    statusEl.classList.toggle('error', tone === 'error' || tone === 'warning');
}

function getAccountErrorMessage(error, fallback) {
    const code = error?.data?.error || error?.message || '';
    switch (code) {
        case 'name_invalid':
            return 'USER NAME は1〜24文字で入力してください。';
        case 'pin_invalid':
            return 'PIN は4桁の数字で入力してください。';
        case 'credentials_invalid':
            return 'PLAYER ID または PIN が違います。';
        case 'invalid':
            return '保存されたログイン情報が見つかりません。';
        default:
            return code || fallback || '処理に失敗しました。';
    }
}

async function copyTextToClipboard(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
    }
    const temp = document.createElement('textarea');
    temp.value = value;
    temp.setAttribute('readonly', 'readonly');
    temp.style.position = 'fixed';
    temp.style.opacity = '0';
    document.body.appendChild(temp);
    temp.select();
    const ok = document.execCommand('copy');
    temp.remove();
    return ok;
}

async function copyAccountIdentifier(kind) {
    if (!authSession?.token || !authProfile) {
        showStatusAlert('先にログインしてください。', 'warning', 3000);
        return;
    }
    const value = kind === 'friendCode' ? formatFriendCodeDisplay(authProfile.friendCode) : authProfile.playerId;
    try {
        const ok = await copyTextToClipboard(value);
        if (!ok) throw new Error('copy_failed');
        showStatusAlert(kind === 'friendCode' ? 'FRIEND CODE をコピーしました。' : 'PLAYER ID をコピーしました。', 'success', 2500);
    } catch {
        showStatusAlert('コピーに失敗しました。', 'warning', 3000);
    }
}

function devApiHeaders() {
    return { 'X-Sector8-Dev': developModeEnabled ? '1' : '0' };
}

function getDevQueryInput() {
    return document.getElementById('dev-player-query-input')?.value || '';
}

function setDevTargetPlayer(player) {
    devTargetPlayer = player || null;
    const infoEl = document.getElementById('dev-target-info');
    const lookupBtn = document.getElementById('btn-dev-lookup');
    const applyPlusBtn = document.getElementById('btn-dev-apply-plus');
    const applyMinusBtn = document.getElementById('btn-dev-apply-minus');
    const deleteBtn = document.getElementById('btn-dev-delete');
    if (infoEl) {
        infoEl.textContent = player
            ? `${player.name} / ${player.playerId} / LV ${player.level} / EXP ${player.exp} / RATING ${player.rating}`
            : '対象未選択';
        infoEl.classList.toggle('logged-in', Boolean(player));
        infoEl.classList.toggle('error', false);
    }
    if (applyPlusBtn) applyPlusBtn.disabled = !player;
    if (applyMinusBtn) applyMinusBtn.disabled = !player;
    if (deleteBtn) deleteBtn.disabled = !player;
    if (lookupBtn) lookupBtn.disabled = !getDevQueryInput().trim();
}

function syncDevToolsVisibility() {
    document.getElementById('dev-tools-panel')?.classList.toggle('hidden', !developModeEnabled);
}

async function lookupDevTarget() {
    const query = getDevQueryInput().trim();
    if (!query) {
        setDevTargetPlayer(null);
        showStatusAlert('対象の PLAYER ID か名前を入力してください。', 'warning', 2500);
        return null;
    }
    const result = await apiRequest(`/api/dev/player?query=${encodeURIComponent(query)}`, {
        method: 'GET',
        auth: false,
        headers: devApiHeaders()
    });
    setDevTargetPlayer(result.player);
    showStatusAlert(`対象を選択しました: ${result.player.name}`, 'success', 2500);
    return result.player;
}

async function applyDevAdjustment(sign = 1) {
    const target = devTargetPlayer || await lookupDevTarget();
    if (!target) return null;
    const ratingDeltaRaw = Number(document.getElementById('dev-rating-delta-input')?.value || 0);
    const expDeltaRaw = Number(document.getElementById('dev-exp-delta-input')?.value || 0);
    const result = await apiRequest('/api/dev/player-adjust', {
        method: 'POST',
        body: {
            query: target.playerId,
            ratingDelta: sign * ratingDeltaRaw,
            expDelta: sign * expDeltaRaw
        },
        auth: false,
        headers: devApiHeaders()
    });
    setDevTargetPlayer(result.player);
    showStatusAlert(`補正しました: ${result.player.name}`, 'success', 2500);
    if (authProfile && result.player.id === authProfile.id) {
        authProfile = result.player;
        saveAuthSession();
        updateAccountUI();
    }
    return result.player;
}

async function deleteDevTargetPlayer() {
    const target = devTargetPlayer || await lookupDevTarget();
    if (!target) return null;
    if (!confirm(`本当に ${target.name} を削除しますか？`)) return null;
    const result = await apiRequest('/api/dev/player', {
        method: 'DELETE',
        body: { query: target.playerId },
        auth: false,
        headers: devApiHeaders()
    });
    showStatusAlert(`アカウントを削除しました: ${result.player.name}`, 'warning', 3000);
    setDevTargetPlayer(null);
    if (authProfile && result.player.id === authProfile.id) {
        authSession = null;
        authProfile = null;
        saveAuthSession();
        updateAccountUI();
    }
    return result.player;
}

function getMatchHistoryDelta(entry) {
    if (!authProfile) return 0;
    if (Number(entry?.player1_id) === Number(authProfile.id)) return Number(entry?.player1_get_rating || 0);
    if (Number(entry?.player2_id) === Number(authProfile.id)) return Number(entry?.player2_get_rating || 0);
    return Number(entry?.player1_get_rating || 0);
}

function getMatchHistoryOutcome(entry) {
    const playerId = Number(authProfile?.id || 0);
    if (String(entry?.result || '').toLowerCase() === 'draw') return 'DRAW';
    const winnerId = Number(entry?.winner_player_id || 0);
    const loserId = Number(entry?.loser_player_id || 0);
    if (playerId && winnerId && playerId === winnerId) return 'WIN';
    if (playerId && loserId && playerId === loserId) return 'LOSE';
    return String(entry?.result || '').toLowerCase() === 'lose' ? 'LOSE' : 'WIN';
}

function getMatchTypeLabel(matchType) {
    switch (String(matchType || '').toLowerCase()) {
        case 'rank':
            return 'ランクマッチ';
        case 'normal':
            return 'ノーマルマッチ';
        case 'private':
            return 'プライベートマッチ';
        case 'local':
            return 'ローカル対戦';
        default:
            return '未分類';
    }
}

function getMatchTypeOrder(matchType) {
    switch (String(matchType || '').toLowerCase()) {
        case 'rank': return 0;
        case 'normal': return 1;
        case 'private': return 2;
        case 'local': return 3;
        default: return 4;
    }
}

function formatMatchHistoryTimestamp(value) {
    const ts = Number(value || 0);
    if (!ts) return '日時不明';
    return new Intl.DateTimeFormat('ja-JP', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    }).format(new Date(ts));
}

function formatMatchHistoryDuration(value) {
    const ms = Math.max(0, Number(value || 0));
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function renderMatchHistory(matches = [], state = {}) {
    const listEl = document.getElementById('match-history-list');
    if (!listEl) return;

    if (!authSession?.token || !authProfile) {
        listEl.innerHTML = '<div class="match-history-empty">ログインすると対戦履歴が表示されます。</div>';
        return;
    }

    if (state.loading) {
        listEl.innerHTML = '<div class="match-history-empty">読み込み中...</div>';
        return;
    }

    if (state.error) {
        listEl.innerHTML = `<div class="match-history-empty error">${state.error}</div>`;
        return;
    }

    if (!Array.isArray(matches) || !matches.length) {
        listEl.innerHTML = '<div class="match-history-empty">まだ対戦履歴がありません。</div>';
        return;
    }

    const profileId = Number(authProfile.id);
    const entries = matches.map((entry, index) => ({ entry, index }));
    const grouped = entries.reduce((acc, item) => {
        const key = String(item.entry.match_type || 'unknown').toLowerCase();
        (acc[key] ||= []).push(item);
        return acc;
    }, {});
    const sortedGroups = Object.entries(grouped).sort((a, b) => getMatchTypeOrder(a[0]) - getMatchTypeOrder(b[0]));

    listEl.innerHTML = sortedGroups.map(([matchType, items]) => `
        <section class="match-history-group">
            <div class="match-history-group-header">
                <span>${getMatchTypeLabel(matchType)}</span>
                <strong>${items.length}</strong>
            </div>
            <div class="match-history-group-list">
                ${items.map(({ entry, index }) => {
                    const resultText = getMatchHistoryOutcome(entry);
                    const delta = getMatchHistoryDelta(entry);
                    const deltaText = delta > 0 ? `+${delta}` : String(delta);
                    const opponentStartRating = entry.player2_start_rating ?? entry.summary_json?.player2StartRating ?? null;
                    const opponentName = Number(entry.player1_id) === profileId
                        ? (entry.player2_name || 'UNKNOWN')
                        : (entry.player1_name || 'UNKNOWN');
                    const winnerName = entry.winner || 'UNKNOWN';
                    const loserName = entry.loser || 'UNKNOWN';
                    const outcomeLine = resultText === 'DRAW'
                        ? 'DRAW'
                        : `${winnerName} / ${loserName}`;
                    const timeText = formatMatchHistoryTimestamp(entry.started_time || entry.created_at);
                    const durationText = formatMatchHistoryDuration(entry.time_taken);
                    const surrenderText = entry.surrender_by_player_id ? ' / SURRENDER' : '';
                    return `
                        <article class="match-history-card" data-match-index="${index}" title="クリックでサマリーを表示">
                            <div class="match-history-topline">
                                <span class="match-history-result ${resultText === 'WIN' ? 'win' : resultText === 'DRAW' ? 'draw' : 'lose'}">${resultText}</span>
                                <strong class="match-history-opponent">VS ${opponentName}</strong>
                                <span class="match-history-rating ${delta >= 0 ? 'positive' : 'negative'}">RATING ${deltaText}</span>
                                <span class="match-history-start-rating">OPP START ${opponentStartRating == null ? '-' : opponentStartRating}</span>
                            </div>
                            <div class="match-history-meta">
                                <span>${timeText}</span>
                                <span>${durationText}</span>
                                <span>${outcomeLine}${surrenderText}</span>
                            </div>
                            <div class="match-history-footer">${entry.replay_json?.snapshots?.length ? 'REPLAY AVAILABLE' : 'SUMMARY ONLY'}</div>
                        </article>
                    `;
                }).join('')}
            </div>
        </section>
    `).join('');
}

async function loadMatchHistory({ force = false } = {}) {
    const listEl = document.getElementById('match-history-list');
    if (!listEl) return;
    if (!authSession?.token || !authProfile) {
        matchHistoryCache = [];
        matchHistoryLoadedForPlayerId = null;
        renderMatchHistory();
        return;
    }

    const profileId = Number(authProfile.id);
    if (!force && matchHistoryLoadedForPlayerId === profileId && matchHistoryCache.length) {
        renderMatchHistory(matchHistoryCache);
        return;
    }

    const requestToken = ++matchHistoryRequestToken;
    renderMatchHistory([], { loading: true });
    try {
        const result = await apiRequest('/api/matches?limit=10', { method: 'GET', auth: true });
        if (requestToken !== matchHistoryRequestToken) return;
        matchHistoryCache = Array.isArray(result.matches) ? result.matches.map(normalizeMatchHistoryEntry) : [];
        matchHistoryLoadedForPlayerId = profileId;
        renderMatchHistory(matchHistoryCache);
    } catch (error) {
        if (requestToken !== matchHistoryRequestToken) return;
        renderMatchHistory([], { error: '対戦履歴の読み込みに失敗しました。' });
        console.warn('match history load failed', error);
    }
}

function applyAuthProfile(profile, token) {
    authProfile = profile || null;
    authSession = token ? { token } : null;
    saveAuthSession();
    if (authProfile?.playerId) {
        try { window.localStorage.setItem(LAST_PLAYER_ID_STORAGE_KEY, authProfile.playerId); } catch {}
    }
    if (authProfile?.name) {
        localUsername = sanitizeUsername(authProfile.name) || getDefaultUsername();
        const usernameInput = document.getElementById('username-input');
        if (usernameInput) usernameInput.value = localUsername;
        try { window.localStorage.setItem(USERNAME_STORAGE_KEY, localUsername); } catch {}
    }
    updateUsernameUI();
    updateAccountUI();
}

async function restoreAuthSession() {
    if (!authSession?.token) return false;
    try {
        const result = await apiRequest('/api/auth/restore', { method: 'POST', body: { token: authSession.token }, auth: false });
        applyAuthProfile(result.profile, authSession.token);
        loadMatchHistory({ force: true }).catch(() => {});
        showStatusAlert(`LOGIN RESTORED: ${result.profile.name}`, 'system', 2500);
        return true;
    } catch {
        authSession = null;
        authProfile = null;
        saveAuthSession();
        updateAccountUI();
        return false;
    }
}

async function registerAccount() {
    const name = sanitizeUsername(document.getElementById('username-input')?.value) || getDefaultUsername();
    const pin = String(document.getElementById('account-pin-input')?.value || '').trim();
    const result = await apiRequest('/api/auth/register', { method: 'POST', body: { name, pin }, auth: false });
    applyAuthProfile(result.profile, result.token);
    loadMatchHistory({ force: true }).catch(() => {});
    try { window.localStorage.setItem(LAST_PLAYER_ID_STORAGE_KEY, result.profile.playerId); } catch {}
    showStatusAlert(`REGISTERED: ${result.profile.playerId}`, 'success', 3500);
    setAccountStatus(`REGISTERED / ${result.profile.playerId}`, 'success');
    return result.profile;
}

async function loginAccount() {
    const playerId = sanitizePlayerIdInput(document.getElementById('account-player-id-input')?.value);
    const pin = String(document.getElementById('account-pin-input')?.value || '').trim();
    const result = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: { playerId, pin, deviceLabel: sanitizeUsername(navigator.userAgent) || 'browser' },
        auth: false
    });
    applyAuthProfile(result.profile, result.token);
    loadMatchHistory({ force: true }).catch(() => {});
    try { window.localStorage.setItem(LAST_PLAYER_ID_STORAGE_KEY, result.profile.playerId); } catch {}
    showStatusAlert(`LOGIN OK: ${result.profile.name}`, 'success', 2500);
    setAccountStatus(`LOGIN OK / ${result.profile.name}`, 'success');
    return result.profile;
}

async function logoutAccount() {
    if (authSession?.token) {
        try {
            await apiRequest('/api/auth/logout', { method: 'POST', body: { token: authSession.token }, auth: false });
        } catch {}
    }
    authSession = null;
    authProfile = null;
    saveAuthSession();
    clearAccountInputs();
    matchHistoryCache = [];
    matchHistoryLoadedForPlayerId = null;
    renderMatchHistory();
    showStatusAlert('LOGGED OUT', 'system', 2500);
    setAccountStatus('LOGGED OUT', 'system');
}

async function updateAccountName(nextName) {
    if (!authSession?.token) return null;
    const result = await apiRequest('/api/account/name', {
        method: 'POST',
        body: { name: nextName },
        auth: true
    });
    applyAuthProfile(result.profile, authSession.token);
    updateMatchmakingPlayerSummary();
    return result.profile;
}

function startMatchTracking() {
    if (replayPlaybackActive) return;
    currentMatchStartedAt = Date.now();
    currentMatchKey = onlineMode
        ? `${matchRoomId || 'online'}:${gameSeed}`
        : `local:${gameSeed}:${Date.now()}`;
    currentMatchStartProfile = authProfile ? {
        id: authProfile.id,
        playerId: authProfile.playerId,
        name: authProfile.name,
        level: authProfile.level,
        exp: authProfile.exp,
        rating: authProfile.rating
    } : null;
    currentMatchOpponentStartProfile = onlineMode ? { ...getOnlineProfileData(getMatchIntroOpponentPlayer()) } : null;
    resetMatchRecording();
}

async function submitMatchHistory(reason, winnerId) {
    if (!authSession?.token || !authProfile || replayPlaybackActive) return;
    const viewerSide = onlineMode && localPlayer ? localPlayer : 1;
    const isDraw = winnerId == null || reason === 'draw';
    const viewerWon = isDraw ? null : winnerId === viewerSide;
    const opponentName = onlineMode
        ? getOnlineDisplayName(localPlayer === 1 ? 2 : 1)
        : (vsAI ? 'AI BOT' : 'PLAYER 2');
    const summary = buildMatchSummary(isDraw ? 'draw' : reason, isDraw ? null : winnerId);
    summary.winnerName = isDraw ? 'DRAW' : (viewerWon ? authProfile.name : opponentName);
    summary.loserName = isDraw ? 'DRAW' : (viewerWon ? opponentName : authProfile.name);
    summary.replay = currentMatchReplay;
    activeMatchSummaryView = summary;
    const payload = {
        matchKey: currentMatchKey || `local:${Date.now()}`,
        player1Id: authProfile.id,
        player1Name: authProfile.name,
        player2Name: opponentName,
        winner: isDraw ? 'DRAW' : (viewerWon ? authProfile.name : opponentName),
        loser: isDraw ? 'DRAW' : (viewerWon ? opponentName : authProfile.name),
        result: isDraw ? 'draw' : (viewerWon ? 'win' : 'lose'),
        matchType: getCurrentMatchType(),
        player1Level: authProfile.level,
        player2Level: 1,
        player1StartRating: currentMatchRecord?.startProfile?.rating ?? authProfile.rating ?? 0,
        player2StartRating: currentMatchRecord?.opponentStartProfile?.rating ?? null,
        startedTime: currentMatchStartedAt || Date.now(),
        endedTime: Date.now(),
        timeTaken: Math.max(0, Date.now() - (currentMatchStartedAt || Date.now())),
        surrenderByPlayerId: !isDraw && !viewerWon && reason === 'forfeit' ? authProfile.id : null,
        winnerPlayerId: isDraw ? null : winnerId,
        loserPlayerId: isDraw ? null : (viewerWon ? null : authProfile.id),
        summaryJson: summary,
        replayJson: currentMatchReplay
    };
    try {
        const result = await apiRequest('/api/matches', { method: 'POST', body: payload, auth: true });
        if (result.player1) {
            const endProfile = result.player1;
            summary.endProfile = {
                id: endProfile.id,
                playerId: endProfile.playerId,
                name: endProfile.name,
                level: endProfile.level,
                exp: endProfile.exp,
                rating: endProfile.rating
            };
            summary.ratingDelta = Number(endProfile.rating || 0) - Number(currentMatchStartProfile?.rating || authProfile?.rating || 0);
            summary.expDelta = Number(endProfile.exp || 0) - Number(currentMatchStartProfile?.exp || authProfile?.exp || 0);
            applyAuthProfile(result.player1, authSession.token);
        }
        if (!document.getElementById('menu-panel')?.classList.contains('hidden')) {
            loadMatchHistory({ force: true }).catch(() => {});
        }
        if (activeMatchSummaryView) {
            activeMatchSummaryView.ratingDelta = summary.ratingDelta;
            activeMatchSummaryView.expDelta = summary.expDelta;
            activeMatchSummaryView.replay = currentMatchReplay;
            renderGameOverSummary(activeMatchSummaryView);
        }
    } catch (error) {
        console.warn('match history save failed', error);
    }
}

function getOnlineDisplayName(player) {
    return onlineProfileDetails[player]?.name || onlineUsernames[player] || `P${player}`;
}

function normalizeOnlineProfileData(profile, fallbackName = null) {
    if (!profile) return null;
    if (typeof profile === 'string') {
        const name = sanitizeUsername(profile) || sanitizeUsername(fallbackName) || null;
        return name ? { name, level: null, rating: null, playerId: null } : null;
    }
    const name = sanitizeUsername(profile.name || fallbackName || '');
    if (!name) return null;
    return {
        name,
        level: profile.level ?? null,
        rating: profile.rating ?? null,
        playerId: profile.playerId || profile.player_id || null
    };
}

function applyOnlineProfileData(player, profile, fallbackName = null) {
    const normalized = normalizeOnlineProfileData(profile, fallbackName);
    onlineProfileDetails[player] = normalized;
    if (normalized?.name) onlineUsernames[player] = normalized.name;
    if (matchIntroActive) refreshMatchIntroCutIn();
    return normalized;
}

function getOnlineProfileData(player) {
    return onlineProfileDetails[player] || {
        name: onlineUsernames[player] || `P${player}`,
        level: null,
        rating: null,
        playerId: null
    };
}

function getMatchIntroOpponentPlayer() {
    if (!onlineMode || !localPlayer) return 2;
    return localPlayer === 1 ? 2 : 1;
}

function showMatchIntroCutIn() {
    const overlay = document.getElementById('match-intro-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    overlay.getBoundingClientRect();
    matchIntroActive = true;
    refreshMatchIntroCutIn();
    window.clearTimeout(matchIntroTimer);
    matchIntroTimer = window.setTimeout(() => {
        overlay.classList.add('hidden');
        matchIntroActive = false;
        matchIntroTimer = null;
        startAfkTurnReminder();
    }, 2000);
}

function refreshMatchIntroCutIn() {
    const nameEl = document.getElementById('match-intro-opponent-name');
    const levelEl = document.getElementById('match-intro-opponent-level');
    const ratingEl = document.getElementById('match-intro-opponent-rating');
    if (!matchIntroActive || !nameEl || !levelEl || !ratingEl) return;
    const opponent = getMatchIntroOpponentPlayer();
    const profile = onlineMode ? getOnlineProfileData(opponent) : {
        name: vsAI ? 'AI BOT' : 'PLAYER 2',
        level: 1,
        rating: null
    };
    levelEl.textContent = profile.level == null ? 'LV ?' : `LV ${profile.level}`;
    ratingEl.textContent = profile.rating == null ? 'RATING ?' : `RATING ${profile.rating}`;
    nameEl.textContent = profile.name || `P${opponent}`;
}

function queueMatchIntroCutIn() {
    pendingMatchIntroCutIn = true;
    window.clearTimeout(matchIntroTimer);
    window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
            if (!pendingMatchIntroCutIn) return;
            pendingMatchIntroCutIn = false;
            showMatchIntroCutIn();
        });
    });
}

function saveOnlineSession() {
    try {
        if (onlineSession) window.localStorage.setItem(ONLINE_SESSION_STORAGE_KEY, JSON.stringify(onlineSession));
        else window.localStorage.removeItem(ONLINE_SESSION_STORAGE_KEY);
    } catch {}
}

function clearOnlineSession() {
    onlineSession = null;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    try { window.localStorage.removeItem(ONLINE_SESSION_STORAGE_KEY); } catch {}
}

function deactivateOnlineMode(clearSession = true) {
    manualDisconnect = true;
    if (onlineSocket) {
        try { onlineSocket.close(); } catch {}
        onlineSocket = null;
    }
    onlineMode = false;
    localPlayer = null;
    spectatorMode = false;
    matchmakingRole = null;
    matchRoomId = null;
    randomQueuePending = false;
    randomMatchAutoStarted = false;
    onlineAbilityChoices = { 1: null, 2: null };
    onlineReadyState = { 1: false, 2: false };
    onlineUsernames = { 1: null, 2: null };
    onlineProfileDetails = { 1: null, 2: null };
    matchIntroActive = false;
    window.clearTimeout(matchIntroTimer);
    matchIntroTimer = null;
    pendingMatchIntroCutIn = false;
    document.getElementById('match-intro-overlay')?.classList.add('hidden');
    currentMatchOpponentStartProfile = null;
    if (clearSession) clearOnlineSession();
}

function getViewerPlayer() {
    if (spectatorMode) return spectatorViewPlayer;
    return onlineMode && localPlayer ? localPlayer : currentPlayer;
}

function canControlCurrentTurn() {
    if (spectatorMode) return false;
    return !onlineMode || localPlayer === currentPlayer;
}

// --- UNIT DEFINITION ---
class Unit {
    constructor(id, type, player, map, row, col, isFrontline = false) {
        this.id = id;
        this.type = type;
        this.player = player;
        this.map = map;
        this.row = row;
        this.col = col;
        this.isFrontline = isFrontline;
        this.inspirationTurns = 0;
        this.warPrincessKills = 0;
        this.warPrincessTeiPromoted = false;
        this.warPrincessHeiPromoted = false;
        this.camouflaged = false;
        this.veteranMomentumPenalty = false;
        this.carryingFlagPlayer = null;
        this.carryingFlagAbility = null;
        this.flagSurvivalTurns = 0;

        this.configureTypeStats(type);
    }

    configureTypeStats(type) {
        this.baseVision = 2;
        this.baseMove = 2;
        this.moveType = 'straight';

        switch (type) {
            case 'core':
                this.baseVision = 2;
                this.baseMove = 0;
                break;
            case 'koh':
                this.baseVision = 3;
                this.baseMove = 3;
                this.moveType = 'manhattan';
                break;
            case 'otsu':
                this.baseVision = 3;
                this.baseMove = 3;
                this.moveType = 'straight';
                break;
            case 'hei':
                this.baseVision = 2;
                this.baseMove = 2;
                this.moveType = 'manhattan';
                break;
            case 'tei':
                this.baseVision = 2;
                this.baseMove = 2;
                this.moveType = 'straight';
                break;
            case 'scout':
                this.baseVision = 2;
                this.baseMove = 1;
                this.moveType = 'straight';
                break;
        }
    }

    get name() {
        switch (this.type) {
            case 'core': return 'コア (Core)';
            case 'koh': return '甲 (Koh)';
            case 'otsu': return '乙 (Otsu)';
            case 'hei': return '丙 (Hei)';
            case 'tei': return '丁 (Tei)';
            case 'scout': return '偵察兵 (Scout)';
        }
    }

    get symbol() {
        switch (this.type) {
            case 'core': return '核';
            case 'koh': return getAbilityInitial(this.player);
            case 'otsu': return '乙';
            case 'hei': return '丙';
            case 'tei': return '丁';
            case 'scout': return '偵';
        }
    }

    get abilityDescription() {
        if (this.type === 'koh') {
            const ability = getPlayerAbility(this.player);
            const descriptions = {
                '千里眼': '【甲特有: 千里眼 / 発動型】選んだ1方向の直線全マスを表示。',
                '鼓舞': '【甲特有: 鼓舞 / 発動型】周囲1マスの味方に移動+1・視界+1を付与。',
                '足跡': '【甲特有: 足跡 / パッシブ型】直近2ターン分の視界情報を保持。',
                '歴戦王': '【甲特有: 歴戦王 / パッシブ型】敵撃破時に行動済みを解除。再行動は自陣側を除く直線移動2。',
                '戦姫': '【甲特有: 戦姫 / パッシブ型】4体撃破で丁→丙、10体撃破で丙→乙へ昇格。',
                '爆破': '【甲特有: 爆破 / 発動・パッシブ型】発動時または死亡時、周囲2マスを完全破壊。',
                '暗殺者': '【甲特有: 暗殺者 / パッシブ型】直線移動5・直線視界5。敵撃破時、進行方向から1マス戻る。',
                '盲目': '【甲特有: 盲目 / パッシブ型】マンハッタン移動5、視界1。',
                '衛生兵': '【甲特有: 衛生兵 / パッシブ型】生存中、偵察兵の補充周期が5ターンになり上限が3になる。',
                '監視': '【甲特有: 監視 / パッシブ型】周囲正方形視界2・周囲正方形移動1。視界内の敵移動-1。',
                '迷彩': '【甲特有: 迷彩 / 発動型】使用後はマンハッタン視界1になり、動かない限り敵視界に出ない。'
            };
            return descriptions[ability] || `【甲特有: ${ability}】`;
        }
        if (this.type === 'otsu') {
            return `【乙特有: 切り崩し】敵本拠地で敵撃破時、周囲1マスの全コマを追加破壊。`;
        }
        if (this.type === 'scout') {
            return `【偵察兵特有: ワープ】直線移動1・攻撃可。エリア2固定。視界内の空きマスへ瞬時ワープ。`;
        }
        return '固有アビリティなし';
    }

    getMovementRange() {
        let r = this.baseMove;
        if (this.type === 'koh') {
            const ability = getPlayerAbility(this.player);
            if (ability === '暗殺者') { return 5; }
            if (ability === '盲目') { return 5; }
            if (ability === '監視') { return 1; }
            if (ability === '歴戦王' && this.veteranMomentumPenalty) r = 2;
        }
        r -= getMonitorPenalty(this);
        if (this.inspirationTurns > 0) r += 1;
        return Math.max(0, r);
    }

    getVisionRange() {
        let v = this.baseVision;
        if (this.type === 'koh') {
            const ability = getPlayerAbility(this.player);
            if (ability === '暗殺者') v = 5; // 直線視界5 (special: handled separately)
            if (ability === '盲目') v = 1;
            if (ability === '監視') v = 2;
            if (ability === '歴戦王') v = 2;
            if (ability === '迷彩' && this.camouflaged) v = 1;
        }
        if (this.inspirationTurns > 0) v += 1;
        return v;
    }

    getEffectiveMoveType() {
        if (this.type === 'koh') {
            const ability = getPlayerAbility(this.player);
            if (ability === '暗殺者') return 'straight';
            if (ability === '監視') return 'square';
            if (ability === '歴戦王' && this.veteranMomentumPenalty) return 'straight';
        }
        return this.moveType;
    }

    getVisionShape() {
        if (this.type === 'koh') {
            const ability = getPlayerAbility(this.player);
            if (ability === '暗殺者') return 'beam';
            if (ability === '盲目' || ability === '監視' || (ability === '迷彩' && this.camouflaged)) return 'square';
        }
        return 'manhattan';
    }
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    applyDeviceProfile();
    loadSavedUsername();
    loadSavedAuthSession();
    loadSavedOnlineSession();
    loadSavedUiSettings();
    syncAbilitySelectOptions();
    setupUIEventListeners();
    setupMapTabs();
    setupGameModeTabs();
    setupOnlineMode();
    updateModeVisibility();
    updateUsernameUI();
    updateAccountUI();
    updateAudioButtons();
    restoreAuthSession().catch(() => {});
    addConsoleLog("SYSTEM READY. SELECT CONFIGURATION AND PRESS 'SYSTEM INITIATE'.", 'system');
});

window.addEventListener('resize', applyDeviceProfile);

function getAbilityInitial(player) {
    const ability = player === 1 ? p1Ability : p2Ability;
    return ability ? ability.charAt(0) : '甲';
}

function getAbilityClass(player) {
    const ability = player === 1 ? p1Ability : p2Ability;
    const classMap = {
        '千里眼': 'ability-clairvoyance',
        '鼓舞': 'ability-inspire',
        '足跡': 'ability-trail',
        '歴戦王': 'ability-veteran',
        '戦姫': 'ability-princess',
        '爆破': 'ability-blast',
        '暗殺者': 'ability-assassin',
        '盲目': 'ability-blind',
        '衛生兵': 'ability-medic',
        '監視': 'ability-watch',
        '迷彩': 'ability-camouflage'
    };
    return classMap[ability] || 'ability-unknown';
}

function getPlayerAbility(player) {
    return player === 1 ? p1Ability : p2Ability;
}

function getAllAbilityOptions() {
    return [...ALL_ABILITY_OPTIONS];
}

function syncAbilitySelectOptions() {
    const selects = ['p1-ability-choice', 'p2-ability-choice', 'online-ability-choice']
        .map(id => document.getElementById(id))
        .filter(Boolean);

    selects.forEach(select => {
        const currentValue = select.value;
        select.innerHTML = '';
        getAllAbilityOptions().forEach(ability => {
            const option = document.createElement('option');
            option.value = ability;
            option.textContent = ability;
            select.appendChild(option);
        });

        const fallbackValue =
            select.id === 'p2-ability-choice' ? '歴戦王' :
            select.id === 'online-ability-choice' ? '足跡' :
            '足跡';
        select.value = getAllAbilityOptions().includes(currentValue) ? currentValue : fallbackValue;
    });
}

function serializeReplayFlag(flag) {
    if (!flag) return null;
    return {
        id: flag.id,
        player: flag.player,
        map: flag.map,
        row: flag.row,
        col: flag.col,
        ability: flag.ability
    };
}

function serializeReplayCell(cell) {
    return {
        isWall: Boolean(cell?.isWall),
        isTeleport: Boolean(cell?.isTeleport),
        isCoreTile: Boolean(cell?.isCoreTile),
        unitId: cell?.unit?.id || null,
        flag: serializeReplayFlag(cell?.flag),
        flags: Array.isArray(cell?.flags) ? cell.flags.map(serializeReplayFlag).filter(Boolean) : []
    };
}

function serializeReplayUnit(unit) {
    if (!unit) return null;
    return {
        id: unit.id,
        type: unit.type,
        player: unit.player,
        map: unit.map,
        row: unit.row,
        col: unit.col,
        isFrontline: Boolean(unit.isFrontline),
        inspirationTurns: unit.inspirationTurns || 0,
        warPrincessKills: unit.warPrincessKills || 0,
        warPrincessTeiPromoted: Boolean(unit.warPrincessTeiPromoted),
        warPrincessHeiPromoted: Boolean(unit.warPrincessHeiPromoted),
        camouflaged: Boolean(unit.camouflaged),
        veteranMomentumPenalty: Boolean(unit.veteranMomentumPenalty),
        carryingFlagPlayer: unit.carryingFlagPlayer || null,
        carryingFlagAbility: unit.carryingFlagAbility || null,
        flagSurvivalTurns: unit.flagSurvivalTurns || 0
    };
}

function serializeReplayVision(vision = {}) {
    return {
        area1: Array.from(vision.area1 || []),
        area2: Array.from(vision.area2 || []),
        area3: Array.from(vision.area3 || [])
    };
}

function serializeReplaySnapshot(label = null) {
    return {
        label: label || `TURN ${gameTurn}`,
        turn: gameTurn,
        currentPlayer,
        actionsThisTurn,
        activeMap,
        viewerPlayer: getViewerPlayer(),
        gameMode,
        p1Ability,
        p2Ability,
        p1Vision: serializeReplayVision(p1Vision),
        p2Vision: serializeReplayVision(p2Vision),
        actedUnitIds: Array.from(actedUnitIds || []),
        boards: Object.fromEntries(Object.entries(boards).map(([mapName, rows]) => [
            mapName,
            rows.map(row => row.map(cell => serializeReplayCell(cell)))
        ])),
        units: units.map(serializeReplayUnit).filter(Boolean)
    };
}

function hydrateReplayFlag(flag) {
    if (!flag) return null;
    return {
        id: flag.id,
        player: flag.player,
        map: flag.map,
        row: flag.row,
        col: flag.col,
        ability: flag.ability
    };
}

function hydrateReplayVision(vision = {}) {
    return {
        area1: new Set(vision.area1 || []),
        area2: new Set(vision.area2 || []),
        area3: new Set(vision.area3 || [])
    };
}

function hydrateReplayUnit(raw) {
    if (!raw) return null;
    const unit = new Unit(raw.id, raw.type, raw.player, raw.map, raw.row, raw.col, raw.isFrontline);
    Object.assign(unit, raw);
    return unit;
}

function hydrateReplaySnapshot(snapshot = {}) {
    const unitsList = (snapshot.units || []).map(hydrateReplayUnit).filter(Boolean);
    const unitsById = new Map(unitsList.map(unit => [unit.id, unit]));
    const boardState = {};
    Object.keys(MAP_SIZES).forEach(mapName => {
        const sourceRows = snapshot.boards?.[mapName] || [];
        if (!sourceRows.length) {
            const size = MAP_SIZES[mapName];
            boardState[mapName] = Array.from({ length: size.rows }, (_, rowIndex) => (
                Array.from({ length: size.cols }, (_, colIndex) => ({
                    row: rowIndex,
                    col: colIndex,
                    isWall: false,
                    isTeleport: false,
                    isCoreTile: false,
                    unit: null,
                    flag: null,
                    flags: []
                }))
            ));
            return;
        }
        boardState[mapName] = sourceRows.map((row, rowIndex) => row.map((cell, colIndex) => {
            const flags = Array.isArray(cell.flags) ? cell.flags.map(hydrateReplayFlag).filter(Boolean) : [];
            const fallbackFlag = cell.flag ? hydrateReplayFlag(cell.flag) : null;
            const combinedFlags = flags.length ? flags : (fallbackFlag ? [fallbackFlag] : []);
            return {
                row: rowIndex,
                col: colIndex,
                isWall: Boolean(cell.isWall),
                isTeleport: Boolean(cell.isTeleport),
                isCoreTile: Boolean(cell.isCoreTile),
                unit: cell.unitId ? (unitsById.get(cell.unitId) || null) : null,
                flag: combinedFlags[combinedFlags.length - 1] || null,
                flags: combinedFlags
            };
        }));
    });

    return {
        ...snapshot,
        activeMap: snapshot.activeMap || 'area1',
        viewerPlayer: Number(snapshot.viewerPlayer) === 2 ? 2 : 1,
        gameMode: snapshot.gameMode || 'debug',
        boards: boardState,
        units: unitsList,
        p1Vision: hydrateReplayVision(snapshot.p1Vision),
        p2Vision: hydrateReplayVision(snapshot.p2Vision),
        actedUnitIds: new Set(snapshot.actedUnitIds || [])
    };
}

function withReplayRenderState(snapshotState, callback) {
    const saved = {
        boards,
        units,
        activeMap,
        currentPlayer,
        gameTurn,
        actionsThisTurn,
        actedUnitIds,
        p1Vision,
        p2Vision,
        p1Ability,
        p2Ability,
        gameMode
    };

    boards = snapshotState.boards;
    units = snapshotState.units;
    activeMap = snapshotState.activeMap;
    currentPlayer = snapshotState.currentPlayer;
    gameTurn = snapshotState.turn || snapshotState.gameTurn || gameTurn;
    actionsThisTurn = Number(snapshotState.actionsThisTurn || 0);
    actedUnitIds = snapshotState.actedUnitIds instanceof Set ? new Set(snapshotState.actedUnitIds) : new Set(snapshotState.actedUnitIds || []);
    p1Vision = snapshotState.p1Vision;
    p2Vision = snapshotState.p2Vision;
    p1Ability = snapshotState.p1Ability || p1Ability;
    p2Ability = snapshotState.p2Ability || p2Ability;
    gameMode = snapshotState.gameMode || gameMode;

    try {
        callback();
    } finally {
        boards = saved.boards;
        units = saved.units;
        activeMap = saved.activeMap;
        currentPlayer = saved.currentPlayer;
        gameTurn = saved.gameTurn;
        actionsThisTurn = saved.actionsThisTurn;
        actedUnitIds = saved.actedUnitIds;
        p1Vision = saved.p1Vision;
        p2Vision = saved.p2Vision;
        p1Ability = saved.p1Ability;
        p2Ability = saved.p2Ability;
        gameMode = saved.gameMode;
    }
}

function recordMatchReplaySnapshot(label = null) {
    if (replayPlaybackActive) return;
    if (!currentMatchReplay) currentMatchReplay = createMatchReplayBase();
    currentMatchReplay.snapshots = currentMatchReplay.snapshots || [];
    currentMatchReplay.snapshots.push(serializeReplaySnapshot(label));
}

function getReplayEntrySnapshots(entry) {
    const replay = entry?.replay_json || entry?.replayJson || null;
    return Array.isArray(replay?.snapshots) ? replay.snapshots : [];
}

function setDevelopModeEnabled(enabled) {
    developModeEnabled = enabled;
    syncAbilitySelectOptions();
    const badge = document.getElementById('develop-mode-badge');
    if (badge) badge.classList.toggle('hidden', !enabled);
    const debugTab = document.getElementById('tab-mode-debug');
    if (debugTab) debugTab.classList.toggle('hidden', !enabled);
    syncDevToolsVisibility();
    if (!enabled) setDevTargetPlayer(null);
}

function registerMapTabSequence(mapName) {
    if (activePhase !== 'setup' || developModeEnabled) return;
    const token = mapName === 'area1' ? '1' : mapName === 'area2' ? '2' : '3';
    developModeSequence = (developModeSequence + token).slice(-DEVELOP_MODE_SEQUENCE.length);
    if (developModeSequence === DEVELOP_MODE_SEQUENCE) {
        setDevelopModeEnabled(true);
        addConsoleLog('DEVELOP MODE: 開発モードを起動しました。', 'system');
        showStatusAlert('DEVELOP MODE 起動', 'system', 5000);
    }
}

function setupUIEventListeners() {
    document.addEventListener('pointerdown', initializeAudio, { once: true });
    document.getElementById('btn-start-game').addEventListener('click', () => startGame());
    const menuToggle = document.getElementById('btn-toggle-menu');
    const menuPanel = document.getElementById('menu-panel');
    const newsMenu = document.querySelector('.news-menu');
    const settingsMenu = document.querySelector('.settings-menu');

    const closeHeaderPanels = (except = null) => {
        if (except !== 'menu' && menuPanel) {
            menuPanel.classList.add('hidden');
            menuToggle?.classList.remove('active');
        }
        if (except !== 'news' && newsMenu?.open) {
            newsMenu.open = false;
        }
        if (except !== 'settings' && settingsMenu?.open) {
            settingsMenu.open = false;
        }
    };

    if (menuToggle && menuPanel) {
        menuToggle.addEventListener('click', () => {
            const willOpen = menuPanel.classList.contains('hidden');
            closeHeaderPanels('menu');
            menuPanel.classList.toggle('hidden');
            menuToggle.classList.toggle('active', willOpen);
            if (!menuPanel.classList.contains('hidden')) {
                loadMatchHistory({ force: true }).catch(() => {});
            }
        });
    }
    if (newsMenu) {
        newsMenu.addEventListener('toggle', () => {
            if (newsMenu.open) closeHeaderPanels('news');
        });
    }
    if (settingsMenu) {
        settingsMenu.addEventListener('toggle', () => {
            if (settingsMenu.open) closeHeaderPanels('settings');
        });
    }
    document.getElementById('btn-opt-ai').addEventListener('click', () => setOpponent(true));
    document.getElementById('btn-opt-human').addEventListener('click', () => setOpponent(false));
    document.getElementById('btn-move').addEventListener('click', () => selectActionType('move'));
    document.getElementById('btn-ability').addEventListener('click', () => selectActionType('ability'));
    document.getElementById('btn-cancel').addEventListener('click', cancelSelection);
    document.getElementById('btn-skip-turn')?.addEventListener('click', skipTurn);
    document.getElementById('btn-draw')?.addEventListener('click', requestDraw);
    document.getElementById('btn-forfeit').addEventListener('click', forfeitGame);
    document.getElementById('btn-restart').addEventListener('click', resetToSetup);
    const replayMatchBtn = document.getElementById('btn-replay-match');
    if (replayMatchBtn) replayMatchBtn.addEventListener('click', () => {
        const source = replayPlaybackSource || activeMatchSummaryView;
        const replay = source?.replay || source?.replay_json;
        if (!replay?.snapshots?.length) {
            showStatusAlert('リプレイデータがありません。', 'warning', 2500);
            return;
        }
        startReplayPlayback(source);
    });
    const replayCloseBtn = document.getElementById('btn-replay-close');
    if (replayCloseBtn) replayCloseBtn.addEventListener('click', closeReplayViewer);
    const replaySlider = document.getElementById('replay-slider');
    if (replaySlider) replaySlider.addEventListener('input', (event) => {
        renderReplaySnapshot(Number(event.target.value || 0));
    });
    document.getElementById('btn-cancel-dir').addEventListener('click', () => {
        document.getElementById('direction-overlay').classList.add('hidden');
    });

    document.querySelectorAll('.dir-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const dir = e.target.getAttribute('data-dir');
            executeClairvoyance(dir);
        });
    });

    const onlineAbilityChoice = document.getElementById('online-ability-choice');
    if (onlineAbilityChoice) {
        onlineAbilityChoice.addEventListener('change', () => {
            if (!onlineMode || !localPlayer) return;
            const wasReady = Boolean(onlineReadyState[localPlayer]);
            onlineAbilityChoices[localPlayer] = getOnlineAbilityChoice();
            onlineReadyState[localPlayer] = false;
            if (wasReady) sendOnlineMessage({ kind: 'ready_state', ready: false });
            updateReadyButton();
            updateOnlineStartAvailability();
        });
    }

    const onlineReadyBtn = document.getElementById('btn-online-ready');
    if (onlineReadyBtn) onlineReadyBtn.addEventListener('click', markOnlineReady);

    const copyRoomBtn = document.getElementById('btn-copy-room');
    if (copyRoomBtn) copyRoomBtn.addEventListener('click', copyRoomCode);

    const sendChatBtn = document.getElementById('btn-send-chat');
    if (sendChatBtn) sendChatBtn.addEventListener('click', sendChatMessage);
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') sendChatMessage();
        });
    }
    const keepAliveBtn = document.getElementById('btn-keepalive');
    if (keepAliveBtn) keepAliveBtn.addEventListener('click', extendRenderSession);
    const toggleMoveSfxBtn = document.getElementById('btn-toggle-sfx');
    if (toggleMoveSfxBtn) toggleMoveSfxBtn.addEventListener('click', toggleMoveSfx);
    const toggleBgmBtn = document.getElementById('btn-toggle-bgm');
    if (toggleBgmBtn) toggleBgmBtn.addEventListener('click', toggleBgm);
    const openMapEditorBtn = document.getElementById('btn-open-map-editor');
    if (openMapEditorBtn) openMapEditorBtn.addEventListener('click', () => {
        window.open('map-editor.html', '_blank', 'noopener');
    });
    const saveUsernameBtn = document.getElementById('btn-save-username');
    if (saveUsernameBtn) saveUsernameBtn.addEventListener('click', () => saveUsername());
    const usernameInput = document.getElementById('username-input');
    if (usernameInput) {
        usernameInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') saveUsername();
        });
        usernameInput.addEventListener('blur', () => saveUsername(false));
    }
    const accountRegisterBtn = document.getElementById('btn-account-register');
    if (accountRegisterBtn) accountRegisterBtn.addEventListener('click', async () => {
        try {
            await registerAccount();
        } catch (error) {
            const message = getAccountErrorMessage(error, 'REGISTER に失敗しました。');
            setAccountStatus(message, 'error');
            showStatusAlert(message, 'warning', 4000);
        }
    });
    const accountLoginBtn = document.getElementById('btn-account-login');
    if (accountLoginBtn) accountLoginBtn.addEventListener('click', async () => {
        try {
            await loginAccount();
        } catch (error) {
            const message = getAccountErrorMessage(error, 'LOGIN に失敗しました。');
            setAccountStatus(message, 'error');
            showStatusAlert(message, 'warning', 4000);
        }
    });
    const accountLogoutBtn = document.getElementById('btn-account-logout');
    if (accountLogoutBtn) accountLogoutBtn.addEventListener('click', async () => {
        try {
            await logoutAccount();
        } catch (error) {
            const message = getAccountErrorMessage(error, 'LOGOUT に失敗しました。');
            setAccountStatus(message, 'error');
            showStatusAlert(message, 'warning', 4000);
        }
    });
    const copyPlayerIdBtn = document.getElementById('btn-copy-player-id');
    if (copyPlayerIdBtn) copyPlayerIdBtn.addEventListener('click', () => copyAccountIdentifier('playerId'));
    const copyFriendCodeBtn = document.getElementById('btn-copy-friend-code');
    if (copyFriendCodeBtn) copyFriendCodeBtn.addEventListener('click', () => copyAccountIdentifier('friendCode'));
    const refreshMatchHistoryBtn = document.getElementById('btn-refresh-match-history');
    if (refreshMatchHistoryBtn) refreshMatchHistoryBtn.addEventListener('click', () => loadMatchHistory({ force: true }).catch(() => {}));
    const matchHistoryList = document.getElementById('match-history-list');
    if (matchHistoryList) {
        matchHistoryList.addEventListener('click', (event) => {
            const card = event.target.closest('.match-history-card');
            if (!card) return;
            const index = Number(card.dataset.matchIndex);
            const entry = matchHistoryCache[index];
            if (entry) openMatchHistorySummary(entry);
        });
    }
    const devLookupBtn = document.getElementById('btn-dev-lookup');
    if (devLookupBtn) devLookupBtn.addEventListener('click', () => lookupDevTarget().catch(() => {
        showStatusAlert('対象の取得に失敗しました。', 'warning', 3000);
    }));
    const devApplyPlusBtn = document.getElementById('btn-dev-apply-plus');
    if (devApplyPlusBtn) devApplyPlusBtn.addEventListener('click', () => applyDevAdjustment(1).catch(() => {
        showStatusAlert('補正に失敗しました。', 'warning', 3000);
    }));
    const devApplyMinusBtn = document.getElementById('btn-dev-apply-minus');
    if (devApplyMinusBtn) devApplyMinusBtn.addEventListener('click', () => applyDevAdjustment(-1).catch(() => {
        showStatusAlert('補正に失敗しました。', 'warning', 3000);
    }));
    const devDeleteBtn = document.getElementById('btn-dev-delete');
    if (devDeleteBtn) devDeleteBtn.addEventListener('click', () => deleteDevTargetPlayer().catch(() => {
        showStatusAlert('削除に失敗しました。', 'warning', 3000);
    }));
    const devOpenMapEditorBtn = document.getElementById('btn-dev-open-map-editor');
    if (devOpenMapEditorBtn) devOpenMapEditorBtn.addEventListener('click', () => {
        window.open('map-editor.html', '_blank', 'noopener');
    });
    const devQueryInput = document.getElementById('dev-player-query-input');
    if (devQueryInput) {
        devQueryInput.addEventListener('input', () => {
            if (document.getElementById('btn-dev-lookup')) {
                document.getElementById('btn-dev-lookup').disabled = !devQueryInput.value.trim();
            }
        });
        devQueryInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') lookupDevTarget().catch(() => {});
        });
    }
    const accountPlayerIdInput = document.getElementById('account-player-id-input');
    if (accountPlayerIdInput) {
        accountPlayerIdInput.addEventListener('input', () => {
            accountPlayerIdInput.value = sanitizePlayerIdInput(accountPlayerIdInput.value);
            updateAccountUI();
        });
        accountPlayerIdInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') loginAccount().catch(() => {});
        });
    }
    const accountPinInput = document.getElementById('account-pin-input');
    if (accountPinInput) {
        accountPinInput.addEventListener('input', () => {
            accountPinInput.value = accountPinInput.value.replace(/[^0-9]/g, '').slice(0, 4);
            updateAccountUI();
        });
        accountPinInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') loginAccount().catch(() => {});
        });
    }
    const sfxVolumeSlider = document.getElementById('sfx-volume');
    if (sfxVolumeSlider) sfxVolumeSlider.addEventListener('input', handleSfxVolumeChange);
    const bgmVolumeSlider = document.getElementById('bgm-volume');
    if (bgmVolumeSlider) bgmVolumeSlider.addEventListener('input', handleBgmVolumeChange);
    const visionSlider = document.getElementById('vision-saturation');
    if (visionSlider) visionSlider.addEventListener('input', handleVisionSaturationChange);
}

function setupMapTabs() {
    document.querySelectorAll('.map-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            const targetMap = e.currentTarget.getAttribute('data-map');
            switchActiveMap(targetMap);
        });
    });
}

// --- GAME MODE TABS (AI / LOCAL / ONLINE) ---
function setupGameModeTabs() {
    const tabOnline = document.getElementById('tab-mode-online');
    if (tabOnline) {
        tabOnline.addEventListener('click', () => showMatchmakingPanel());
    }

    const btnHostRoom = document.getElementById('btn-host-room');
    if (btnHostRoom) btnHostRoom.addEventListener('click', hostRoom);

    const btnJoinRoom = document.getElementById('btn-join-room');
    if (btnJoinRoom) btnJoinRoom.addEventListener('click', joinRoom);

    const btnCancelMatch = document.getElementById('btn-cancel-match');
    if (btnCancelMatch) btnCancelMatch.addEventListener('click', cancelMatchmaking);
    const btnRandomMatch = document.getElementById('btn-random-match');
    if (btnRandomMatch) btnRandomMatch.addEventListener('click', startRandomMatch);
    const tabPrivate = document.getElementById('tab-online-private');
    if (tabPrivate) tabPrivate.addEventListener('click', () => setOnlineMatchTab('private'));
    const tabRandom = document.getElementById('tab-online-random');
    if (tabRandom) tabRandom.addEventListener('click', () => setOnlineMatchTab('random'));
    const tabRank = document.getElementById('tab-online-rank');
    if (tabRank) tabRank.addEventListener('click', () => { if (!onlineSocket) setOnlineMatchTier('rank'); });
    const tabNormal = document.getElementById('tab-online-normal');
    if (tabNormal) tabNormal.addEventListener('click', () => { if (!onlineSocket) setOnlineMatchTier('normal'); });
}

function switchActiveMap(mapName) {
    if (activeMap !== mapName) playUiSfx();
    activeMap = mapName;
    registerMapTabSequence(mapName);
    document.querySelectorAll('.map-tab').forEach(tab => {
        tab.classList.toggle('active', tab.getAttribute('data-map') === mapName);
    });
    cancelSelection();
    renderBoard();
}

function setOpponent(isAi) {
    vsAI = isAi;
    document.getElementById('btn-opt-ai').classList.toggle('active', isAi);
    document.getElementById('btn-opt-human').classList.toggle('active', !isAi);

    const p2AbilityGroup = document.getElementById('p2-ability-group');
    if (p2AbilityGroup) {
        p2AbilityGroup.style.opacity = isAi ? '0.5' : '1';
    }
}

function setGameMode(mode) {
    gameMode = mode === 'ai' ? 'local' : mode;
    if (mode === 'online') {
        vsAI = false;
    } else if (mode === 'debug') {
        vsAI = true;
    } else {
        vsAI = false;
    }
    updateModeVisibility();
}

window.setGameMode = setGameMode;

function setSetupMode(mode) {
    if (mode === 'online') {
        showMatchmakingPanel();
        return;
    }
    deactivateOnlineMode();
    showLocalPanel();
    setGameMode(mode);
    setOpponent(mode === 'debug');
}

window.setSetupMode = setSetupMode;

function updateModeVisibility() {
    const feedPanel = document.getElementById('combat-feed-panel');
    if (feedPanel) feedPanel.classList.toggle('hidden', !(gameMode === 'debug' && developModeEnabled));
    const onlinePanel = document.getElementById('online-tools-panel');
    if (onlinePanel) onlinePanel.classList.toggle('hidden', gameMode !== 'online');
    const prebattlePanel = document.getElementById('online-prebattle-panel');
    if (prebattlePanel) prebattlePanel.classList.toggle('hidden', !(onlineMode && onlineMatchPreviewActive && activePhase === 'setup'));
}

function showMatchmakingPanel() {
    playUiSfx();
    setGameMode('online');
    document.getElementById('matchmaking-panel').classList.remove('hidden');
    document.getElementById('setup-local-panel').classList.add('hidden');
    document.getElementById('game-info-panel').classList.add('hidden');
    document.getElementById('online-prebattle-panel')?.classList.add('hidden');
    updateLobbyPlayerCard();
    onlineMatchPreviewActive = false;
    updateUsernameUI();
    updateMatchmakingPlayerSummary();
    setOnlineMatchTab(matchmakingRole === 'host' || matchmakingRole === 'guest' ? 'private' : 'random');
    updateReadyButton();
    // highlight online tab
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    const tabOnline = document.getElementById('tab-mode-online');
    if (tabOnline) tabOnline.classList.add('active');
}

function showLocalPanel() {
    playUiSfx();
    document.getElementById('matchmaking-panel').classList.add('hidden');
    document.getElementById('setup-local-panel').classList.remove('hidden');
    updateLobbyPlayerCard();
}

function resetOnlineMatchmakingState(keepPanel = true) {
    manualDisconnect = true;
    if (onlineSocket) {
        try { onlineSocket.close(); } catch {}
        onlineSocket = null;
    }
    onlineMode = false;
    localPlayer = null;
    spectatorMode = false;
    matchmakingRole = null;
    matchRoomId = null;
    onlineMatchTier = 'rank';
    onlineMatchPreviewActive = false;
    randomQueuePending = false;
    randomMatchAutoStarted = false;
    resetOnlineAutoStartState();
    onlineAbilityChoices = { 1: null, 2: null };
    onlineReadyState = { 1: false, 2: false };
    onlineUsernames = { 1: null, 2: null };
    onlineProfileDetails = { 1: null, 2: null };
    matchIntroActive = false;
    window.clearTimeout(matchIntroTimer);
    matchIntroTimer = null;
    pendingMatchIntroCutIn = false;
    document.getElementById('match-intro-overlay')?.classList.add('hidden');
    onlineMatchPreviewActive = false;
    clearOnlineSession();
    updateRandomQueueCount(0);
    if (keepPanel) {
        setMatchmakingStatus('');
        updateMatchmakingPlayerSummary();
        updateReadyButton();
    }
}

function setOnlineMatchTab(tab, options = {}) {
    const isRandom = tab === 'random';
    if (!isRandom && (matchmakingRole === 'random' || isRandomMatchRoom() || randomQueuePending)) {
        resetOnlineMatchmakingState(true);
    }
    document.getElementById('online-private-panel')?.classList.toggle('hidden', isRandom);
    document.getElementById('online-random-panel')?.classList.toggle('hidden', !isRandom);
    document.getElementById('tab-online-private')?.classList.toggle('active', !isRandom);
    document.getElementById('tab-online-random')?.classList.toggle('active', isRandom);
    document.getElementById('tab-online-rank')?.classList.toggle('active', isRandom && getOnlineMatchTier() === 'rank');
    document.getElementById('tab-online-normal')?.classList.toggle('active', isRandom && getOnlineMatchTier() === 'normal');
    if (isRandom && options.tier) setOnlineMatchTier(options.tier);
    if (isRandom && !onlineSocket) {
        setMatchmakingStatus(onlineMatchTier === 'rank' ? 'ランクマッチを検索します。' : 'ノーマルマッチを検索します。');
    }
}

function setOnlineMatchTier(tier) {
    onlineMatchTier = tier === 'normal' ? 'normal' : 'rank';
    document.getElementById('tab-online-rank')?.classList.toggle('active', onlineMatchTier === 'rank');
    document.getElementById('tab-online-normal')?.classList.toggle('active', onlineMatchTier === 'normal');
    if (!onlineSocket) {
        setMatchmakingStatus(onlineMatchTier === 'rank' ? 'ランクマッチを検索します。' : 'ノーマルマッチを検索します。');
    }
}

function revealOnlineMatchPreview() {
    onlineMatchPreviewActive = true;
    document.getElementById('setup-panel').classList.add('hidden');
    document.getElementById('game-info-panel').classList.remove('hidden');
    document.getElementById('online-prebattle-panel')?.classList.remove('hidden');
    updateModeVisibility();
}

function hideOnlineMatchPreview() {
    onlineMatchPreviewActive = false;
    document.getElementById('online-prebattle-panel')?.classList.add('hidden');
    updateModeVisibility();
}

// Simple room-based matchmaking via WebSocket
function hostRoom() {
    manualDisconnect = false;
    const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
    document.getElementById('room-id-display').textContent = roomId;
    setMatchmakingStatus('対戦相手の接続を待っています...');
    document.getElementById('room-share-area').classList.remove('hidden');
    matchRoomId = roomId;
    matchmakingRole = 'host';
    localPlayer = 1;
    onlineAbilityChoices = { 1: null, 2: null };
    onlineReadyState = { 1: false, 2: false };
    onlineUsernames = { 1: localUsername, 2: null };
    resetOnlineAutoStartState();
    onlineMatchPreviewActive = false;
    onlineMode = true;
    spectatorMode = false;
    setGameMode('online');
    updateReadyButton();
    updateMatchmakingPlayerSummary();
    connectOnlineSocket({ roomId, player: 1 });
}

function joinRoom() {
    manualDisconnect = false;
    const input = document.getElementById('room-id-input');
    const roomId = input ? input.value.trim().toUpperCase() : '';
    if (!roomId) {
        addConsoleLog('ONLINE: ルームIDを入力してください。', 'system');
        return;
    }
    matchRoomId = roomId;
    matchmakingRole = 'guest';
    localPlayer = 2;
    onlineAbilityChoices = { 1: null, 2: null };
    onlineReadyState = { 1: false, 2: false };
    onlineUsernames = { 1: null, 2: localUsername };
    resetOnlineAutoStartState();
    onlineMatchPreviewActive = false;
    onlineMode = true;
    spectatorMode = false;
    setGameMode('online');
    updateReadyButton();
    setMatchmakingStatus(`ルーム ${roomId} に接続中...`);
    updateMatchmakingPlayerSummary();
    connectOnlineSocket({ roomId, player: 2 });
}

function startRandomMatch() {
    if (onlineSocket && onlineSocket.readyState === WebSocket.OPEN) return;
    manualDisconnect = false;
    matchmakingRole = 'random';
    localPlayer = null;
    onlineMode = true;
    randomQueuePending = false;
    onlineAbilityChoices = { 1: null, 2: null };
    onlineReadyState = { 1: false, 2: false };
    onlineUsernames = { 1: null, 2: null };
    resetOnlineAutoStartState();
    spectatorMode = false;
    onlineMatchPreviewActive = false;
    setGameMode('online');
    document.getElementById('room-share-area').classList.add('hidden');
    setOnlineMatchTab('random');
    setMatchmakingStatus(`${getOnlineMatchTier() === 'rank' ? 'ランク' : 'ノーマル'}マッチングを開始しています。`, 'searching');
    updateMatchmakingPlayerSummary();
    connectOnlineSocket({ random: true });
}

function cancelMatchmaking() {
    manualDisconnect = true;
    if (onlineSocket) onlineSocket.close();
    onlineMode = false;
    localPlayer = null;
    spectatorMode = false;
    activePhase = 'setup';
    isGameOver = false;
    currentPlayer = 1;
    matchmakingMode = false;
    matchRoomId = null;
    onlineMatchPreviewActive = false;
    randomQueuePending = false;
    onlineAbilityChoices = { 1: null, 2: null };
    onlineReadyState = { 1: false, 2: false };
    onlineUsernames = { 1: null, 2: null };
    resetOnlineAutoStartState();
    syncAbilitySelectOptions();
    setDevelopModeEnabled(developModeEnabled);
    document.getElementById('online-prebattle-panel')?.classList.add('hidden');
    document.getElementById('game-info-panel').classList.add('hidden');
    boards = { area1: [], area2: [], area3: [] };
    units = [];
    document.getElementById('board').innerHTML = '';
    clearHighlights();
    showLocalPanel();
    setMatchmakingStatus('');
    updateMatchmakingPlayerSummary();
    document.getElementById('room-share-area').classList.add('hidden');
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-mode-local').classList.add('active');
    setGameMode('local');
    clearOnlineSession();
}

function setupOnlineMode() {
    if (!onlineMode) return;
    manualDisconnect = false;
    setGameMode('online');
    vsAI = false;
    setOpponent(false);
    document.getElementById('current-player-name').textContent = `${localUsername} CONNECTING`;
    updateMatchmakingPlayerSummary();
    if (onlineSession?.token) {
        showMatchmakingPanel();
        setMatchmakingStatus('前回の対局に再接続しています...');
        connectOnlineSocket({
            roomId: onlineSession.roomId,
            player: onlineSession.player,
            reconnectToken: onlineSession.token
        });
        return;
    }
    if (localPlayer === 2) {
        document.getElementById('btn-start-game').disabled = true;
        document.getElementById('btn-start-game').textContent = 'WAITING FOR PLAYER 1';
    } else {
        document.getElementById('btn-start-game').textContent = 'START ONLINE MATCH';
    }
    connectOnlineSocket({ roomId: matchRoomId, player: localPlayer });
}

function getOnlineAbilityChoice() {
    return document.getElementById('online-ability-choice')?.value || '足跡';
}

async function copyRoomCode() {
    const roomText = document.getElementById('room-id-display')?.textContent?.trim();
    if (!roomText || roomText === '------') return;
    try {
        await navigator.clipboard.writeText(roomText);
        setMatchmakingStatus('ルームIDをコピーしました。');
    } catch {
        setMatchmakingStatus(`ルームID: ${roomText}`);
    }
}

function scheduleReconnect() {
    if (reconnectTimer || !onlineSession?.token) return;
    showStatusAlert('接続が切れました。再接続を試みています...', 'warning', 0);
    reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectOnlineSocket({
            roomId: onlineSession.roomId,
            player: onlineSession.player,
            reconnectToken: onlineSession.token
        });
    }, 1800);
}

function isRandomMatchRoom() {
    return Boolean(onlineSession?.randomRoom || (matchRoomId && matchRoomId.startsWith('RANDOM-')));
}

function setMatchmakingStatus(text, tone = '') {
    const statusEl = document.getElementById('matchmaking-status');
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = `match-status${tone ? ` ${tone}` : ''}`;
}

function updateMatchmakingPlayerSummary() {
    const summaryEl = document.getElementById('matchmaking-players');
    if (!summaryEl) return;
    if (!onlineMode && !randomQueuePending) {
        summaryEl.textContent = '';
        return;
    }
    if (onlineUsernames[1] && onlineUsernames[2]) {
        summaryEl.textContent = `${getOnlineDisplayName(1)} VS ${getOnlineDisplayName(2)}`;
        return;
    }
    if (isRandomMatchRoom()) {
        summaryEl.textContent = `${localUsername || 'Commander'} / ${getOnlineMatchTier() === 'rank' ? 'RANK' : 'NORMAL'} MATCHING...`;
        return;
    }
    if (matchmakingRole === 'random' && randomQueuePending) {
        summaryEl.textContent = `${localUsername || 'Commander'} / READY CHECK`;
        return;
    }
    if (matchRoomId) {
        summaryEl.textContent = `${localUsername || 'Commander'} / ROOM ${matchRoomId}`;
        return;
    }
    summaryEl.textContent = localUsername || 'Commander';
}

function updateRandomQueueCount(waiting = randomWaitingCount) {
    randomWaitingCount = Number.isFinite(waiting) ? waiting : 0;
    const queueEl = document.getElementById('matchmaking-queue');
    if (!queueEl) return;
    queueEl.textContent = `待機人数: ${randomWaitingCount}`;
}

function resetOnlineAutoStartState() {
    randomMatchAutoStarted = false;
    privateMatchAutoStarted = false;
    window.clearTimeout(privateMatchAutoStartTimer);
    privateMatchAutoStartTimer = null;
}

function maybeAutoStartRandomMatch() {
    const ready = Boolean(onlineAbilityChoices[1] && onlineAbilityChoices[2] && onlineReadyState[1] && onlineReadyState[2]);
    if (!onlineMode || activePhase !== 'setup') {
        resetOnlineAutoStartState();
        return;
    }
    if (!ready) {
        resetOnlineAutoStartState();
        return;
    }
    updateMatchmakingPlayerSummary();
    if (!isRandomMatchRoom()) {
        if ((matchmakingRole === 'host' || localPlayer === 1) && onlineMatchPreviewActive && !privateMatchAutoStarted) {
            privateMatchAutoStarted = true;
            window.clearTimeout(privateMatchAutoStartTimer);
            privateMatchAutoStartTimer = window.setTimeout(() => {
                privateMatchAutoStartTimer = null;
                if (onlineMode && !isRandomMatchRoom() && activePhase === 'setup' && onlineMatchPreviewActive && localPlayer === 1) {
                    setMatchmakingStatus('両者準備完了。試合を開始します。', 'success');
                    startOnlineBattle();
                }
            }, 900);
        }
        return;
    }
    setMatchmakingStatus(`${getOnlineDisplayName(1)} と ${getOnlineDisplayName(2)} のマッチが成立しました。`, 'success');
    if (localPlayer === 1 && !randomMatchAutoStarted) {
        randomMatchAutoStarted = true;
        window.setTimeout(() => {
            if (onlineMode && isRandomMatchRoom() && activePhase === 'setup') {
                startOnlineBattle();
            }
        }, 900);
    }
}

function connectOnlineSocket({ roomId = null, player = null, random = false, reconnectToken = null } = {}) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const roomParam = roomId ? `&room=${encodeURIComponent(roomId)}` : '';
    const playerParam = player ? `player=${player}` : '';
    const randomParam = random ? `${playerParam ? '&' : ''}random=1` : '';
    const tierParam = random ? `${playerParam || roomParam ? '&' : ''}matchTier=${encodeURIComponent(getOnlineMatchTier())}` : '';
    const tokenParam = reconnectToken ? `${playerParam || randomParam || roomParam ? '&' : ''}token=${encodeURIComponent(reconnectToken)}` : '';
    const authParam = authSession?.token ? `${playerParam || randomParam || roomParam || tokenParam ? '&' : ''}authToken=${encodeURIComponent(authSession.token)}` : '';
    const query = [playerParam, roomParam.replace(/^&/, ''), randomParam.replace(/^&/, ''), tierParam.replace(/^&/, ''), tokenParam.replace(/^&/, ''), authParam.replace(/^&/, '')].filter(Boolean).join('&');
    onlineSocket = new WebSocket(`${protocol}//${window.location.host}/ws?${query}`);

    onlineSocket.addEventListener('open', () => {
        addConsoleLog(`ONLINE: ${localUsername} として接続しました。`, 'system');
        addConnectionLog(`${localUsername} として接続しました。`);
        if (matchmakingRole === 'random') setMatchmakingStatus('マッチング中...', 'searching');
        if (player) {
            onlineUsernames[player] = localUsername;
        }
        updateReadyButton();
        updateMatchmakingPlayerSummary();
        sendOnlineMessage({ kind: 'profile', username: localUsername });
    });

    onlineSocket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        handleOnlineMessage(message);
    });

    onlineSocket.addEventListener('close', () => {
        addConsoleLog('ONLINE: サーバー接続が切断されました。', 'system');
        addConnectionLog('サーバー接続が切断されました。');
        if (!manualDisconnect && onlineSession?.token) {
            setMatchmakingStatus('接続が切れました。同じブラウザで開き直しても復帰できます。', 'searching');
        }
        if (!manualDisconnect && onlineMode && onlineSession?.token) scheduleReconnect();
    });

    onlineSocket.addEventListener('error', () => {
        addConsoleLog('ONLINE: 接続エラー。サーバーが起動しているか確認してください。', 'system');
        addConnectionLog('接続エラーが発生しました。');
    });
}

function revealAllPreviewVision() {
    const allCells = new Set();
    Object.keys(MAP_SIZES).forEach(mapName => {
        for (let r = 0; r < MAP_SIZES[mapName].rows; r++) {
            for (let c = 0; c < MAP_SIZES[mapName].cols; c++) {
                allCells.add(`${r},${c}`);
            }
        }
    });
    p1Vision = { area1: new Set(allCells), area2: new Set(allCells), area3: new Set(allCells) };
    p2Vision = { area1: new Set(allCells), area2: new Set(allCells), area3: new Set(allCells) };
}

function prepareOnlineMatchPreview(seed = null) {
    const previewSeed = Number.isFinite(seed) ? seed : hashStringToSeed(matchRoomId || onlineSession?.roomId || 'online');
    gameSeed = previewSeed;
    onlineMatchPreviewActive = true;
    resetOnlineAutoStartState();
    onlineAbilityChoices = { 1: null, 2: null };
    onlineReadyState = { 1: false, 2: false };
    activePhase = 'setup';
    isGameOver = false;
    currentPlayer = 1;
    gameTurn = 1;
    selectedUnit = null;
    previewUnit = null;
    scoutReinforcementSerial = 0;
    militaryFlagSerial = 0;
    actionsThisTurn = 0;
    actedUnitIds = new Set();
    militaryFlags = [];
    lastKeepAliveAt = Date.now();
    developModeSequence = '';
    p1KohDestroyed = false;
    p2KohDestroyed = false;
    p1ClairvoyanceDir = null;
    p2ClairvoyanceDir = null;
    p1ClairvoyanceAge = 0;
    p2ClairvoyanceAge = 0;
    p1LastVision = { area1: new Set(), area2: new Set(), area3: new Set() };
    p2LastVision = { area1: new Set(), area2: new Set(), area3: new Set() };
    p1VisionHistory = [];
    p2VisionHistory = [];
    currentMatchStartedAt = 0;
    currentMatchKey = onlineMode
        ? `${matchRoomId || onlineSession?.roomId || 'online'}:${gameSeed}`
        : `preview:${gameSeed}`;

    p1Ability = onlineAbilityChoices[1] || '足跡';
    p2Ability = onlineAbilityChoices[2] || '歴戦王';
    vsAI = false;

    initializeAudio();
    initializeBoards();
    initializeUnits();
    generateRandomWalls(gameSeed);
    revealAllPreviewVision();
    calculateVisibility();

    document.getElementById('setup-panel').classList.add('hidden');
    document.getElementById('game-info-panel').classList.remove('hidden');
    document.getElementById('online-prebattle-panel')?.classList.remove('hidden');
    switchActiveMap(getViewerPlayer() === 2 ? 'area3' : 'area1');
    renderBoard();
    updateUI();
    updateReadyButton();
    updateOnlineStartAvailability();
    clearStatusAlert();
    syncBgmPlayback();
    updateAudioButtons();
    setMatchmakingStatus('盤面を確認して、甲アビリティを選択してください。', 'success');
}

function startOnlineBattle() {
    const config = {
        p1Ability: onlineAbilityChoices[1] || '足跡',
        p2Ability: onlineAbilityChoices[2] || '歴戦王',
        seed: gameSeed || hashStringToSeed(matchRoomId || onlineSession?.roomId || 'online'),
        matchType: getCurrentMatchType()
    };

    if (onlineMode && (!onlineAbilityChoices[1] || !onlineAbilityChoices[2])) {
        setMatchmakingStatus('双方の甲アビリティを選択してから開始してください。');
        return;
    }

    if (!onlineMatchPreviewActive || activePhase !== 'setup' || !boards.area1.length) {
        prepareOnlineMatchPreview(config.seed);
    }

    p1Ability = config.p1Ability;
    p2Ability = config.p2Ability;
    pendingMatchIntroCutIn = true;
    startGame(config, true);
    if (onlineMode && localPlayer === 1) {
        sendOnlineMessage({ kind: 'start', config });
    }
}

function handleOnlineMessage(message) {
    if (message.kind === 'hello') {
        localPlayer = message.player || null;
        spectatorMode = message.role === 'spectator';
        spectatorViewPlayer = spectatorMode ? 1 : (localPlayer || 1);
        matchRoomId = message.roomId || matchRoomId;
        onlineSession = {
            roomId: message.roomId || matchRoomId,
            token: message.reconnectToken || onlineSession?.token,
            player: message.player || null,
            role: message.role || 'player',
            randomRoom: Boolean(message.randomRoom)
        };
        if (message.randomTier) {
            onlineMatchTier = message.randomTier === 'normal' ? 'normal' : 'rank';
            setOnlineMatchTier(onlineMatchTier);
        }
        saveOnlineSession();
        updateRandomQueueCount(message.randomWaitingCount ?? randomWaitingCount);
        if (message.profiles) {
            applyOnlineProfileData(1, message.profileDetails?.[1] || message.profiles[1], message.profiles[1]);
            applyOnlineProfileData(2, message.profileDetails?.[2] || message.profiles[2], message.profiles[2]);
        }
        if (localPlayer) onlineUsernames[localPlayer] = localUsername;
        if (localPlayer && onlineSocket?.readyState === WebSocket.OPEN) {
            sendOnlineMessage({ kind: 'profile', username: localUsername });
        }
        updateMatchmakingPlayerSummary();
        if (isRandomMatchRoom()) setMatchmakingStatus('マッチング中...', 'searching');
        if (!message.snapshot?.started && !onlineMatchPreviewActive && onlineMode && message.role !== 'spectator' && message.profiles?.[1] && message.profiles?.[2]) {
            if (localPlayer === 1) {
                const previewSeed = hashStringToSeed(`${message.roomId || matchRoomId || onlineSession?.roomId || 'online'}:${Date.now()}`);
                prepareOnlineMatchPreview(previewSeed);
                sendOnlineMessage({ kind: 'preview_seed', seed: previewSeed, matchTier: getOnlineMatchTier() });
            }
        }
        if (message.snapshot?.started && activePhase !== 'battle') {
            pendingMatchIntroCutIn = true;
            startGame(message.snapshot.config, true);
            applyingRemoteAction = true;
            try {
                (message.snapshot.history || []).forEach(entry => {
                    if (entry.kind === 'action') applyRemoteAction(entry.action);
                    else if (entry.kind === 'forfeit' || entry.kind === 'win') {
                        triggerWin(entry.winner, true, entry.kind === 'forfeit' ? 'forfeit' : 'core');
                    } else if (entry.kind === 'draw_request') {
                        receiveDrawRequest(entry.player, Number(entry.turn || gameTurn));
                    } else if (entry.kind === 'draw') {
                        triggerDraw(true, entry.reason || 'mutual');
                    }
                });
            } finally {
                applyingRemoteAction = false;
            }
        }
        addConsoleLog(`ONLINE: あなたは ${spectatorMode ? `観戦者 ${localUsername}` : `${localUsername} / Player ${localPlayer}` } です。`, 'system');
        updateUI();
        maybeAutoStartRandomMatch();
        return;
    }

    if (message.kind === 'room_profiles') {
        if (message.profiles) {
            applyOnlineProfileData(1, message.profileDetails?.[1] || message.profiles[1], message.profiles[1]);
            applyOnlineProfileData(2, message.profileDetails?.[2] || message.profiles[2], message.profiles[2]);
        }
        updateMatchmakingPlayerSummary();
        updateLobbyPlayerCard();
        return;
    }

    if (message.kind === 'draw_request') {
        receiveDrawRequest(message.player, Number(message.turn || gameTurn));
        return;
    }

    if (message.kind === 'draw') {
        triggerDraw(true, message.reason || 'mutual');
        return;
    }

    if (message.kind === 'player_joined') {
        addConsoleLog(`ONLINE: 対戦相手が接続しました！`, 'system');
        addConnectionLog('対戦相手が接続しました。');
        setMatchmakingStatus(
            isRandomMatchRoom()
                ? '対戦相手を確保しました。盤面を展開します...'
                : '対戦相手が接続しました。盤面を展開します。'
        );
        if (onlineMode && !onlineMatchPreviewActive && localPlayer === 1) {
            const previewSeed = hashStringToSeed(`${matchRoomId || onlineSession?.roomId || 'online'}:${Date.now()}`);
            prepareOnlineMatchPreview(previewSeed);
            sendOnlineMessage({ kind: 'preview_seed', seed: previewSeed, matchTier: getOnlineMatchTier() });
        }
        updateMatchmakingPlayerSummary();
        updateOnlineStartAvailability();
        maybeAutoStartRandomMatch();
        return;
    }

    if (message.kind === 'queue_status') {
        if (message.matchTier) {
            onlineMatchTier = message.matchTier === 'normal' ? 'normal' : 'rank';
            setOnlineMatchTier(onlineMatchTier);
        }
        updateRandomQueueCount(message.waiting);
        return;
    }

    if (message.kind === 'preview_seed') {
        if (!onlineMatchPreviewActive && activePhase !== 'battle') {
            if (message.matchTier) {
                onlineMatchTier = message.matchTier === 'normal' ? 'normal' : 'rank';
                setOnlineMatchTier(onlineMatchTier);
            }
            prepareOnlineMatchPreview(Number(message.seed) || hashStringToSeed(matchRoomId || onlineSession?.roomId || 'online'));
        }
        return;
    }

    if (message.player === localPlayer) return;

    if (message.kind === 'profile') {
        applyOnlineProfileData(message.player, {
            ...(onlineProfileDetails[message.player] || {}),
            name: sanitizeUsername(message.username) || `P${message.player}`
        }, message.username);
        addConnectionLog(`${getOnlineDisplayName(message.player)} (P${message.player}) が参加しました。`);
        updateMatchmakingPlayerSummary();
        maybeAutoStartRandomMatch();
        updateUI();
        return;
    }

    if (message.kind === 'ability_choice') {
        onlineAbilityChoices[message.player] = message.ability;
        setMatchmakingStatus(
            isRandomMatchRoom()
                ? '相手の準備情報を受信しました。マッチ確定を待っています...'
                : '相手の甲アビリティ選択を受信しました。'
        );
        updateOnlineStartAvailability();
        maybeAutoStartRandomMatch();
        return;
    }

    if (message.kind === 'ready_state') {
        onlineReadyState[message.player] = Boolean(message.ready);
        setMatchmakingStatus(
            isRandomMatchRoom()
                ? (message.ready ? 'マッチング中...' : '相手がキューを離れました。')
                : (message.ready ? '相手が準備完了しました。' : '相手が準備を解除しました。'),
            isRandomMatchRoom() && message.ready ? 'searching' : ''
        );
        updateOnlineStartAvailability();
        updateMatchmakingPlayerSummary();
        maybeAutoStartRandomMatch();
        return;
    }

    if (message.kind === 'chat') {
        addChatMessage(getOnlineDisplayName(message.player), message.text);
        return;
    }

    if (message.kind === 'keepalive') {
        addConnectionLog(`P${message.player} が接続延長しました。`);
        return;
    }

    applyingRemoteAction = true;
    try {
        if (message.kind === 'start') {
            startGame(message.config, true);
        } else if (message.kind === 'action') {
            applyRemoteAction(message.action);
        } else if (message.kind === 'reset') {
            resetToSetup(true);
        } else if (message.kind === 'forfeit' || message.kind === 'win') {
            triggerWin(message.winner, true, message.kind === 'forfeit' ? 'forfeit' : 'core');
        }
    } finally {
        applyingRemoteAction = false;
    }
}

function sendOnlineMessage(message) {
    if (!onlineMode || replayPlaybackActive || applyingRemoteAction || !onlineSocket || onlineSocket.readyState !== WebSocket.OPEN) return;
    onlineSocket.send(JSON.stringify({ ...message, player: localPlayer }));
}

function updateOnlineStartAvailability() {
    const btnStart = document.getElementById('btn-start-online-match');
    if (btnStart) {
        const ready = Boolean(onlineAbilityChoices[1] && onlineAbilityChoices[2] && onlineReadyState[1] && onlineReadyState[2]);
        btnStart.disabled = !(localPlayer === 1 && ready);
        if (localPlayer === 1) {
            btnStart.textContent = ready ? 'ONLINE MATCH START' : 'WAITING FOR READY';
        }
    }
}

function updateReadyButton() {
    const readyBtn = document.getElementById('btn-online-ready');
    if (!readyBtn) return;
    readyBtn.classList.toggle('hidden', !(onlineMode && onlineMatchPreviewActive && activePhase === 'setup'));
    readyBtn.disabled = !onlineMode || !localPlayer || !onlineSocket || onlineSocket.readyState !== WebSocket.OPEN || !onlineMatchPreviewActive;
    readyBtn.classList.toggle('ready', Boolean(localPlayer && onlineReadyState[localPlayer]));
    readyBtn.textContent = localPlayer && onlineReadyState[localPlayer] ? '準備完了済み' : '準備完了';
}

function markOnlineReady() {
    if (!onlineMode || !localPlayer || !onlineMatchPreviewActive) return;
    onlineAbilityChoices[localPlayer] = getOnlineAbilityChoice();
    onlineReadyState[localPlayer] = true;
    sendOnlineMessage({ kind: 'ability_choice', ability: onlineAbilityChoices[localPlayer] });
    sendOnlineMessage({ kind: 'ready_state', ready: true });
    setMatchmakingStatus(isRandomMatchRoom() ? 'マッチング中...' : '準備完了しました。相手を待っています。', isRandomMatchRoom() ? 'searching' : '');
    updateMatchmakingPlayerSummary();
    updateReadyButton();
    updateOnlineStartAvailability();
    maybeAutoStartRandomMatch();
}

function addConnectionLog(text) {
    const feed = document.getElementById('connection-log');
    if (!feed) return;
    const entry = document.createElement('div');
    entry.className = 'connection-entry';
    const timeStamp = new Date().toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit' });
    entry.textContent = `[${timeStamp}] ${text}`;
    feed.appendChild(entry);
    feed.scrollTop = feed.scrollHeight;
}

function addChatMessage(author, text) {
    const feed = document.getElementById('chat-feed');
    if (!feed || !text) return;
    const entry = document.createElement('div');
    entry.className = 'chat-entry';
    entry.textContent = `${author}: ${text}`;
    feed.appendChild(entry);
    feed.scrollTop = feed.scrollHeight;
}

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input?.value.trim();
    if (!text) return;
    addChatMessage(localUsername, text);
    sendOnlineMessage({ kind: 'chat', text });
    input.value = '';
}

async function extendRenderSession() {
    lastKeepAliveAt = Date.now();
    try {
        await fetch('/keepalive', { cache: 'no-store' });
        addConnectionLog('Render接続を延長しました。');
        sendOnlineMessage({ kind: 'keepalive' });
        clearStatusAlert();
    } catch {
        addConnectionLog('接続延長リクエストに失敗しました。');
        showStatusAlert('接続延長に失敗しました。少し待って再試行してください。', 'warning', 5000);
    }
}

function startKeepAliveWarningTimer() {
    window.clearInterval(startKeepAliveWarningTimer.timer);
    startKeepAliveWarningTimer.timer = window.setInterval(() => {
        if (!onlineMode || activePhase !== 'battle') return;
        if (Date.now() - lastKeepAliveAt >= KEEPALIVE_WARNING_MS) {
            addConnectionLog('10分以上延長していません。Render対策として延長ボタンを押してください。');
            showKeepAliveWarning();
            lastKeepAliveAt = Date.now();
        }
    }, 30 * 1000);
}

function showKeepAliveWarning() {
    showStatusAlert('10分以上延長していません。ONLINE欄の EXTEND を押してください。', 'warning', 0);
}

function clearStatusAlert() {
    const alert = document.getElementById('status-alert');
    if (!alert) return;
    alert.className = 'status-alert hidden';
    alert.textContent = '';
    window.clearTimeout(clearStatusAlert.timer);
}

function showStatusAlert(message, tone = 'warning', durationMs = 4000) {
    const alert = document.getElementById('status-alert');
    if (!alert) return;
    alert.textContent = message;
    alert.className = `status-alert ${tone}`;
    window.clearTimeout(clearStatusAlert.timer);
    if (durationMs > 0) {
        clearStatusAlert.timer = window.setTimeout(() => {
            alert.classList.add('hidden');
        }, durationMs);
    }
}

function initializeAudio() {
    if (audioInitialized) return;
    audioInitialized = true;

    moveSfx = new Audio('audio/sfx_move.wav');
    moveSfx.preload = 'auto';
    moveSfx.volume = moveSfxVolume;

    bgmTrack = new Audio('audio/bgm_main.mp3');
    bgmTrack.preload = 'auto';
    bgmTrack.loop = true;
    bgmTrack.volume = bgmVolume;

    lobbyBgmTrack = new Audio('audio/bgm_lobby.mp3');
    lobbyBgmTrack.preload = 'auto';
    lobbyBgmTrack.loop = true;
    lobbyBgmTrack.volume = bgmVolume;

    uiSfx = new Audio('audio/sfx_ui.wav');
    uiSfx.preload = 'auto';
    uiSfx.volume = moveSfxVolume;

    turnSfx = new Audio('audio/sfx_turn.wav');
    turnSfx.preload = 'auto';
    turnSfx.volume = moveSfxVolume;

    updateAudioButtons();
    syncBgmPlayback();
}

function updateAudioButtons() {
    const sfxBtn = document.getElementById('btn-toggle-sfx');
    const bgmBtn = document.getElementById('btn-toggle-bgm');
    const sfxVolumeSlider = document.getElementById('sfx-volume');
    const bgmVolumeSlider = document.getElementById('bgm-volume');
    if (sfxBtn) sfxBtn.textContent = moveSfxEnabled ? 'SE ON' : 'SE OFF';
    if (bgmBtn) bgmBtn.textContent = bgmEnabled ? 'BGM ON' : 'BGM OFF';
    if (sfxVolumeSlider) sfxVolumeSlider.value = String(Math.round(moveSfxVolume * 100));
    if (bgmVolumeSlider) bgmVolumeSlider.value = String(Math.round(bgmVolume * 100));
}

function playMoveSfx() {
    if (!moveSfxEnabled || !moveSfx) return;
    try {
        moveSfx.currentTime = 0;
        void moveSfx.play().catch(() => {});
    } catch {}
}

function playUiSfx() {
    if (!moveSfxEnabled || !uiSfx) return;
    try {
        uiSfx.currentTime = 0;
        void uiSfx.play().catch(() => {});
    } catch {}
}

window.playUiSfx = playUiSfx;

function toggleMoveSfx() {
    initializeAudio();
    if (bgmTrack) { bgmTrack.currentTime = 0; }
    if (lobbyBgmTrack) { lobbyBgmTrack.currentTime = 0; }
    moveSfxEnabled = !moveSfxEnabled;
    updateAudioButtons();
    saveUiSettings();
}

function toggleBgm() {
    initializeAudio();
    bgmEnabled = !bgmEnabled;
    syncBgmPlayback();
    updateAudioButtons();
    saveUiSettings();
}

function handleSfxVolumeChange(event) {
    moveSfxVolume = Number(event.target.value) / 100;
    if (moveSfx) moveSfx.volume = moveSfxVolume;
    if (uiSfx) uiSfx.volume = moveSfxVolume;
    if (turnSfx) turnSfx.volume = moveSfxVolume;
    saveUiSettings();
}

function handleBgmVolumeChange(event) {
    bgmVolume = Number(event.target.value) / 100;
    if (bgmTrack) bgmTrack.volume = bgmVolume;
    if (lobbyBgmTrack) lobbyBgmTrack.volume = bgmVolume;
    saveUiSettings();
}

function handleVisionSaturationChange(event) {
    visionSaturation = Number(event.target.value) / 100;
    document.documentElement.style.setProperty('--vision-brightness', String(visionSaturation));
    saveUiSettings();
}

function playTurnSfx() {
    if (!moveSfxEnabled) return;
    if (!turnSfx) return;
    try { turnSfx.currentTime = 0; void turnSfx.play().catch(() => {}); } catch {}
}

function startAfkTurnReminder() {
    window.clearTimeout(afkTurnTimer);
    afkTurnPopupShown = false;
    if (replayPlaybackActive || matchIntroActive || !canControlCurrentTurn() || isGameOver || activePhase !== 'battle') return;
    afkTurnTimer = window.setTimeout(() => {
        if (canControlCurrentTurn() && !isGameOver && activePhase === 'battle' && !matchIntroActive) {
            afkTurnPopupShown = true;
            showStatusAlert('あなたの番です', 'warning', 0);
        }
    }, 20000);
}

function clearAfkTurnReminderOnAction() {
    if (!afkTurnPopupShown) return;
    afkTurnPopupShown = false;
    clearStatusAlert();
}

function syncBgmPlayback() {
    if (!bgmEnabled) {
        if (bgmTrack) bgmTrack.pause();
        if (lobbyBgmTrack) lobbyBgmTrack.pause();
        return;
    }
    if (activePhase === 'battle') {
        if (lobbyBgmTrack) lobbyBgmTrack.pause();
        if (bgmTrack) void bgmTrack.play().catch(() => {});
    } else {
        if (bgmTrack) bgmTrack.pause();
        if (lobbyBgmTrack) void lobbyBgmTrack.play().catch(() => {});
    }
}

function applyRemoteAction(action) {
    if (action.type === 'skip') {
        endTurn();
        return;
    }
    const unit = units.find(u => u.id === action.unitId);
    if (!unit) {
        console.error(`[ONLINE] Unit not found: ${action.unitId}`);
        addConsoleLog(`ERROR: ユニット${action.unitId}が見つかりません。`, 'system');
        return;
    }

    if (action.type === 'move') {
        executeMove(unit, action.row, action.col);
    } else if (action.type === 'ability') {
        executeAbility(unit, action.row ?? null, action.col ?? null);
    } else if (action.type === 'clairvoyance') {
        executeClairvoyance(action.dir, unit);
    }
}

function startGame(config = null, fromOnline = false) {
    if (onlineMode && localPlayer !== 1 && !fromOnline) return;
    const reusePreview = onlineMode && onlineMatchPreviewActive && activePhase === 'setup' && boards.area1.length > 0;

    if (onlineMode) {
        if (!reusePreview && localPlayer) {
            onlineAbilityChoices[localPlayer] = getOnlineAbilityChoice();
        }
        p1Ability = config ? config.p1Ability : (onlineAbilityChoices[1] || '足跡');
        p2Ability = config ? config.p2Ability : (onlineAbilityChoices[2] || '歴戦王');
    } else {
        p1Ability = config ? config.p1Ability : document.getElementById('p1-ability-choice').value;
        p2Ability = config ? config.p2Ability : document.getElementById('p2-ability-choice').value;
    }
    gameSeed = config?.seed || Math.floor(Math.random() * 0xFFFFFFFF);
    vsAI = onlineMode ? false : vsAI;
    startMatchTracking();

    activePhase = 'battle';
    resetOnlineAutoStartState();
    isGameOver = false;
    currentPlayer = 1;
    gameTurn = 1;
    selectedUnit = null;
    activeMap = 'area1';
    scoutReinforcementSerial = 0;
    militaryFlagSerial = 0;
    actionsThisTurn = 0;
    actedUnitIds = new Set();
    militaryFlags = [];
    lastKeepAliveAt = Date.now();
    previewUnit = null;
    developModeSequence = '';
    initializeAudio();

    p1KohDestroyed = false;
    p2KohDestroyed = false;
    p1ClairvoyanceDir = null;
    p2ClairvoyanceDir = null;
    p1ClairvoyanceAge = 0;
    p2ClairvoyanceAge = 0;
    resetDrawRequests();

    p1LastVision = { area1: new Set(), area2: new Set(), area3: new Set() };
    p2LastVision = { area1: new Set(), area2: new Set(), area3: new Set() };
    p1VisionHistory = [];
    p2VisionHistory = [];

    if (!reusePreview) {
        initializeBoards();
        initializeUnits();
        generateRandomWalls(gameSeed);
    } else {
        hideOnlineMatchPreview();
    }

    const firstPlayer = createRng(gameSeed ^ 0x9E3779B9)() < 0.5 ? 1 : 2;
    currentPlayer = firstPlayer;
    if (currentMatchRecord) currentMatchRecord.firstPlayer = firstPlayer;
    if (currentMatchReplay) currentMatchReplay.firstPlayer = firstPlayer;

    // Hide setup panels, show game
    document.getElementById('setup-panel').classList.add('hidden');
    document.getElementById('game-info-panel').classList.remove('hidden');
    document.getElementById('online-prebattle-panel')?.classList.add('hidden');
    onlineMatchPreviewActive = false;
    calculateVisibility();
    switchActiveMap(getViewerPlayer() === 2 ? 'area3' : 'area1');
    renderBoard();
    updateUI();
    recordMatchReplaySnapshot('TURN START');
    window.clearTimeout(matchIntroTimer);
    matchIntroTimer = null;
    if (onlineMode && fromOnline && !replayPlaybackActive && !reusePreview) {
        queueMatchIntroCutIn();
    } else if (!onlineMode && vsAI && !replayPlaybackActive) {
        queueMatchIntroCutIn();
    } else {
        matchIntroActive = false;
        document.getElementById('match-intro-overlay')?.classList.add('hidden');
    }

    addConsoleLog(`GAME INITIATED. PLAYER ${firstPlayer} TURN.`, 'system');
    showTurnBanner();
    if (lastTurnOwner !== currentPlayer) playTurnSfx();
    lastTurnOwner = currentPlayer;
    if (!matchIntroActive) startAfkTurnReminder();
    startKeepAliveWarningTimer();
    clearStatusAlert();
    syncBgmPlayback();
    updateAudioButtons();

    if (onlineMode && !fromOnline) {
        sendOnlineMessage({ kind: 'start', config: { p1Ability, p2Ability, seed: gameSeed } });
    }
}

// --- BOARD INITIALIZATION ---
function initializeBoards() {
    boards = { area1: [], area2: [], area3: [] };
    protectedWallCells = new Set();

    Object.keys(MAP_SIZES).forEach(mapName => {
        const size = MAP_SIZES[mapName];
        let mapBoard = [];

        for (let r = 0; r < size.rows; r++) {
            let rowCells = [];
            for (let c = 0; c < size.cols; c++) {
                const isTeleport = PORTAL_COLS.includes(c) && (
                    (mapName === 'area1' && r === 0) ||
                    (mapName === 'area2' && (r === 0 || r === 10)) ||
                    (mapName === 'area3' && r === 10)
                );

                let isCoreTile = false;
                if (mapName === 'area1' && r === 10 && (c >= 4 && c <= 6)) isCoreTile = true;
                if (mapName === 'area3' && r === 0 && (c >= 4 && c <= 6)) isCoreTile = true;

                rowCells.push({ row: r, col: c, isWall: false, isTeleport, isCoreTile, unit: null, flag: null, flags: [] });
            }
            mapBoard.push(rowCells);
        }
        boards[mapName] = mapBoard;
    });
}

function isNearTeleporter(mapName, row, col) {
    return PORTAL_COLS.some(portalCol => {
        const portalRows =
            mapName === 'area1' ? [0] :
            mapName === 'area2' ? [0, 10] :
            [10];
        return portalRows.some(portalRow => Math.max(Math.abs(portalRow - row), Math.abs(portalCol - col)) <= 1);
    });
}

// --- UNIT INITIALIZATION ---
function initializeUnits() {
    units = [];
    const rng = createRng(gameSeed);

    // --- PLAYER 1 (Blue) ---
    const p1Core = new Unit('p1_core', 'core', 1, 'area1', 10, 5);
    addUnitToBoard(p1Core, 'area1', 10, 4);
    addUnitToBoard(p1Core, 'area1', 10, 5);
    addUnitToBoard(p1Core, 'area1', 10, 6);

    const p1Lineup = ['otsu','hei','tei','tei','hei','tei','tei','hei','otsu'];
    p1Lineup.forEach((type, i) => {
        addUnitToBoard(new Unit(`p1_home_${i}`, type, 1, 'area1', 9, i + 1), 'area1', 9, i + 1);
    });

    placeArea2Frontline(1, [
        ['p1_scout_1', 'scout'],
        ['p1_koh', 'koh'],
        ['p1_hei_front', 'hei'],
        ['p1_tei_front', 'tei'],
        ['p1_hei_front_extra', 'hei'],
        ['p1_tei_front_extra', 'tei'],
        ['p1_scout_2', 'scout']
    ], rng);

    // --- PLAYER 2 (Magenta) ---
    const p2Core = new Unit('p2_core', 'core', 2, 'area3', 0, 5);
    addUnitToBoard(p2Core, 'area3', 0, 4);
    addUnitToBoard(p2Core, 'area3', 0, 5);
    addUnitToBoard(p2Core, 'area3', 0, 6);

    const p2Lineup = ['otsu','hei','tei','tei','hei','tei','tei','hei','otsu'];
    p2Lineup.forEach((type, i) => {
        const col = 9 - i;
        addUnitToBoard(new Unit(`p2_home_${i}`, type, 2, 'area3', 1, col), 'area3', 1, col);
    });

    placeArea2Frontline(2, [
        ['p2_scout_1', 'scout'],
        ['p2_koh', 'koh'],
        ['p2_hei_front', 'hei'],
        ['p2_tei_front', 'tei'],
        ['p2_hei_front_extra', 'hei'],
        ['p2_tei_front_extra', 'tei'],
        ['p2_scout_2', 'scout']
    ], rng);
}

function addUnitToBoard(unit, mapName, r, c) {
    if (!units.includes(unit)) units.push(unit);
    unit.map = mapName;
    unit.row = r;
    unit.col = c;
    boards[mapName][r][c].unit = unit;
    protectedWallCells.add(cellKey(mapName, r, c));
}

function placeArea2Frontline(player, lineup, rng) {
    const rows = player === 1 ? [9, 10] : [0, 1];
    const candidates = [];
    rows.forEach(row => {
        for (let col = 0; col < MAP_SIZES.area2.cols; col++) {
            candidates.push({ row, col });
        }
    });

    shuffleWithRng(candidates, rng).slice(0, lineup.length).forEach((pos, index) => {
        const [id, type] = lineup[index];
        addUnitToBoard(new Unit(id, type, player, 'area2', pos.row, pos.col, true), 'area2', pos.row, pos.col);
    });
}

function isCentralReserveCell(mapName, r, c) {
    const size = MAP_SIZES[mapName];
    const midR = Math.floor(size.rows / 2);
    const midC = Math.floor(size.cols / 2);
    return Math.abs(r - midR) <= 1 && Math.abs(c - midC) <= 1;
}

function getWallCandidates(mapName) {
    const size = MAP_SIZES[mapName];
    const candidates = [];
    for (let r = 0; r < size.rows; r++) {
        for (let c = 0; c < size.cols; c++) {
            const cell = boards[mapName][r][c];
            if (cell.isWall || cell.isTeleport || cell.isCoreTile || cell.unit) continue;
            if (protectedWallCells.has(cellKey(mapName, r, c))) continue;
            if (isCentralReserveCell(mapName, r, c)) continue;
            if (isNearTeleporter(mapName, r, c)) continue;
            candidates.push({ row: r, col: c });
        }
    }
    return candidates;
}

function getWallPlacementWeight(mapName, row, col) {
    const size = MAP_SIZES[mapName];
    const centerRow = (size.rows - 1) / 2;
    const centerCol = (size.cols - 1) / 2;
    const distance = Math.abs(row - centerRow) + Math.abs(col - centerCol);
    const maxDistance = centerRow + centerCol;
    return Math.max(1, 2 + (maxDistance - distance) * 2);
}

function pickWeightedCandidate(candidates, weightFn, rng) {
    const weighted = candidates
        .map(candidate => ({ candidate, weight: Math.max(0, weightFn(candidate)) }))
        .filter(entry => entry.weight > 0);
    const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    if (!weighted.length || total <= 0) return null;
    let roll = rng() * total;
    for (const entry of weighted) {
        roll -= entry.weight;
        if (roll <= 0) return entry.candidate;
    }
    return weighted[weighted.length - 1].candidate;
}

function isMapConnected(mapName) {
    const size = MAP_SIZES[mapName];
    let start = null;
    let passableCount = 0;
    for (let r = 0; r < size.rows; r++) {
        for (let c = 0; c < size.cols; c++) {
            if (!boards[mapName][r][c].isWall) {
                passableCount++;
                if (!start) start = { row: r, col: c };
            }
        }
    }
    if (!start) return false;

    const visited = new Set([`${start.row},${start.col}`]);
    const queue = [start];
    const dirs = [{ r: -1, c: 0 }, { r: 1, c: 0 }, { r: 0, c: -1 }, { r: 0, c: 1 }];
    while (queue.length) {
        const current = queue.shift();
        dirs.forEach(dir => {
            const nr = current.row + dir.r;
            const nc = current.col + dir.c;
            const key = `${nr},${nc}`;
            if (nr < 0 || nr >= size.rows || nc < 0 || nc >= size.cols) return;
            if (visited.has(key) || boards[mapName][nr][nc].isWall) return;
            visited.add(key);
            queue.push({ row: nr, col: nc });
        });
    }
    return visited.size === passableCount;
}

function generateRandomWalls(seed) {
    placeSymmetricWalls('area1', seed + 9973, ['area3']);
    placeSymmetricWalls('area2', seed + 19946);
}

function placeSymmetricWalls(mapName, seed, mirrorMaps = []) {
    const rng = createRng(seed);
    const targetMaps = [mapName, ...mirrorMaps];
    let placed = 0;
    let attempts = 0;

    while (placed < WALLS_PER_MAP && attempts < 1200) {
        attempts++;
        const candidates = getWallCandidates(mapName).filter(pos => {
            const pair = getPointSymmetricCell(mapName, pos.row, pos.col);
            return canPlaceWallSet(targetMaps, [pos, pair]);
        });
        const candidate = pickWeightedCandidate(
            candidates,
            pos => getWallPlacementWeight(mapName, pos.row, pos.col),
            rng
        );
        if (!candidate) break;

        const pair = getPointSymmetricCell(mapName, candidate.row, candidate.col);
        const cells = sameCell(candidate, pair) ? [candidate] : [candidate, pair];
        targetMaps.forEach(targetMap => setWalls(targetMap, cells, true));
        if (targetMaps.every(targetMap => isMapConnected(targetMap))) {
            placed += cells.length;
        } else {
            targetMaps.forEach(targetMap => setWalls(targetMap, cells, false));
        }
    }
}

function getPointSymmetricCell(mapName, row, col) {
    const size = MAP_SIZES[mapName];
    return { row: size.rows - 1 - row, col: size.cols - 1 - col };
}

function sameCell(a, b) {
    return a.row === b.row && a.col === b.col;
}

function canPlaceWallSet(mapNames, cells) {
    return mapNames.every(mapName => cells.every(pos => {
        const cell = boards[mapName][pos.row][pos.col];
        return !cell.isWall &&
            !cell.isTeleport &&
            !cell.isCoreTile &&
            !cell.unit &&
            !protectedWallCells.has(cellKey(mapName, pos.row, pos.col)) &&
            !isCentralReserveCell(mapName, pos.row, pos.col) &&
            !isNearTeleporter(mapName, pos.row, pos.col);
    }));
}

function setWalls(mapName, cells, value) {
    cells.forEach(pos => {
        boards[mapName][pos.row][pos.col].isWall = value;
    });
}

function removeUnitEverywhere(unit) {
    for (const mapName of Object.keys(boards)) {
        for (let r = 0; r < MAP_SIZES[mapName].rows; r++) {
            for (let c = 0; c < MAP_SIZES[mapName].cols; c++) {
                if (boards[mapName][r][c].unit && boards[mapName][r][c].unit.id === unit.id) {
                    boards[mapName][r][c].unit = null;
                }
            }
        }
    }
    units = units.filter(u => u.id !== unit.id);
}

function addMilitaryFlagToBoard(flag) {
    const cell = boards[flag.map][flag.row][flag.col];
    if (!cell.flags) cell.flags = [];
    cell.flags.push(flag);
    cell.flag = cell.flags[cell.flags.length - 1] || null;
    militaryFlags.push(flag);
}

function removeMilitaryFlag(flag) {
    if (!flag) return;
    const cell = boards[flag.map]?.[flag.row]?.[flag.col];
    if (cell?.flags?.length) {
        cell.flags = cell.flags.filter(entry => entry.id !== flag.id);
        cell.flag = cell.flags[cell.flags.length - 1] || null;
    } else if (cell?.flag?.id === flag.id) {
        cell.flag = null;
    }
    militaryFlags = militaryFlags.filter(entry => entry.id !== flag.id);
}

function clearFlagCarrier(unit, preserveSurvivalTurns = false) {
    if (!unit) return;
    unit.carryingFlagPlayer = null;
    unit.carryingFlagAbility = null;
    if (!preserveSurvivalTurns) unit.flagSurvivalTurns = 0;
}

function createMilitaryFlag(player, map, row, col, ability) {
    militaryFlagSerial++;
    return {
        id: `flag_${player}_${militaryFlagSerial}`,
        player,
        map,
        row,
        col,
        ability
    };
}

function dropMilitaryFlag(player, map, row, col, ability, silent = false) {
    const flag = createMilitaryFlag(player, map, row, col, ability);
    addMilitaryFlagToBoard(flag);
    if (!silent) {
        addConsoleLog(`SYSTEM: Player ${player} の軍旗が ${getAreaLabel(map)} [${col},${row}] に落ちた。`, 'destroy');
    }
    return flag;
}

function dropFlagForUnit(unit, map, row, col, silent = false) {
    let flag = null;
    if (unit.type === 'koh') {
        flag = dropMilitaryFlag(unit.player, map, row, col, getPlayerAbility(unit.player), silent);
    } else if (unit.carryingFlagPlayer) {
        flag = dropMilitaryFlag(unit.carryingFlagPlayer, map, row, col, unit.carryingFlagAbility, silent);
    }
    clearFlagCarrier(unit);
    return flag;
}

function destroyMilitaryFlagAt(map, row, col, reason = '爆破') {
    const cell = boards[map]?.[row]?.[col];
    const flags = cell?.flags || (cell?.flag ? [cell.flag] : []);
    if (!flags.length) return false;
    flags.slice().forEach(flag => removeMilitaryFlag(flag));
    addConsoleLog(`SYSTEM: ${reason}により Player ${flags[0].player} の軍旗を含む ${flags.length} 体が消滅。`, 'destroy');
    return true;
}

function tryPickupMilitaryFlag(unit) {
    if (!unit || unit.type === 'core' || unit.type === 'koh' || unit.type === 'scout' || unit.carryingFlagPlayer) return false;
    const cell = boards[unit.map]?.[unit.row]?.[unit.col];
    const flag = cell?.flags?.slice().reverse().find(entry => entry.player === unit.player) || cell?.flag;
    if (!flag || flag.player !== unit.player) return false;
    unit.carryingFlagPlayer = flag.player;
    unit.carryingFlagAbility = flag.ability;
    unit.flagSurvivalTurns = 0;
    removeMilitaryFlag(flag);
    addConsoleLog(`SYSTEM: ${unit.name} が Player ${unit.player} の軍旗を回収した。`, unit.player === 1 ? 'p1' : 'p2');
    return true;
}

function promoteFlagBearer(unit) {
    const inheritedAbility = unit.carryingFlagAbility || getPlayerAbility(unit.player);
    clearFlagCarrier(unit, true);
    promoteUnitType(unit, 'koh');
    unit.camouflaged = false;
    unit.veteranMomentumPenalty = false;
    unit.warPrincessKills = 0;
    unit.warPrincessTeiPromoted = false;
    unit.warPrincessHeiPromoted = false;
    if (unit.player === 1) p1KohDestroyed = false;
    else p2KohDestroyed = false;
    addConsoleLog(`SYSTEM: ${unit.name} が軍旗を守り抜き、甲へ昇格。アビリティ「${inheritedAbility}」を継承。`, 'ability');
}

function updateFlagCarrierSurvival(player) {
    units.forEach(unit => {
        if (unit.player !== player || !unit.carryingFlagPlayer) return;
        unit.flagSurvivalTurns++;
        addConsoleLog(`SYSTEM: ${unit.name} の軍旗生存カウント ${unit.flagSurvivalTurns}/${FLAG_SURVIVAL_TURNS}。`, player === 1 ? 'p1' : 'p2');
        if (unit.flagSurvivalTurns >= FLAG_SURVIVAL_TURNS) {
            promoteFlagBearer(unit);
        }
    });
}

function isFlagVisibleToViewer(flag, viewerPlayer, activeVision) {
    if (!flag) return false;
    if (flag.player === viewerPlayer) return true;
    return activeVision?.has(`${flag.row},${flag.col}`) || false;
}

function getVisibleFlagsOnCell(cell, viewerPlayer, activeVision) {
    const flags = cell?.flags?.length ? cell.flags : (cell?.flag ? [cell.flag] : []);
    return flags.filter(flag => isFlagVisibleToViewer(flag, viewerPlayer, activeVision));
}

function captureUnit(victim, attackerPlayer) {
    recordMatchCapture(victim, attackerPlayer);
    const victimMap = victim.map;
    const victimRow = victim.row;
    const victimCol = victim.col;
    removeUnitEverywhere(victim);
    dropFlagForUnit(victim, victimMap, victimRow, victimCol);

    if (victim.type === 'koh') {
        if (victim.player === 1) p1KohDestroyed = true;
        else p2KohDestroyed = true;
        addConsoleLog(`SYSTEM: Player ${victim.player} の甲(Koh)が撃破されました！`, 'destroy');
    }

    if (victim.type === 'core') {
        triggerWin(attackerPlayer);
        return true;
    }

    return false;
}

function promoteUnitType(unit, type) {
    unit.type = type;
    unit.configureTypeStats(type);
}

function applyWarPrincessKills(unit, killCount) {
    if (!killCount || unit.type !== 'koh') return;
    const ability = unit.player === 1 ? p1Ability : p2Ability;
    if (ability !== '戦姫') return;

    unit.warPrincessKills = (unit.warPrincessKills || 0) + killCount;
    addConsoleLog(`ABILITY: 戦姫 - 撃破数 ${unit.warPrincessKills}。`, 'ability');

    if (!unit.warPrincessTeiPromoted && unit.warPrincessKills >= 4) {
        unit.warPrincessTeiPromoted = true;
        let promoted = 0;
        units.forEach(ally => {
            if (ally.player === unit.player && ally.type === 'tei') {
                promoteUnitType(ally, 'hei');
                promoted++;
            }
        });
        if (promoted > 0) addConsoleLog(`ABILITY: 戦姫 - 自軍の丁 ${promoted}体を丙へ昇格。`, 'ability');
    }

    if (!unit.warPrincessHeiPromoted && unit.warPrincessKills >= 10) {
        unit.warPrincessHeiPromoted = true;
        let promoted = 0;
        units.forEach(ally => {
            if (ally.player === unit.player && ally.type === 'hei') {
                promoteUnitType(ally, 'otsu');
                promoted++;
            }
        });
        if (promoted > 0) addConsoleLog(`ABILITY: 戦姫 - 自軍の丙 ${promoted}体を乙へ昇格。`, 'ability');
    }
}

function isCellWithinUnitVision(unit, mapName, row, col) {
    if (!unit || unit.map !== mapName) return false;
    return getUnitVisionCells(unit).has(`${row},${col}`);
}

function isCellInsideVisionShape(unit, row, col, shape, range) {
    const dr = row - unit.row;
    const dc = col - unit.col;
    if (shape === 'beam') {
        return (row === unit.row && Math.abs(dc) <= range) || (col === unit.col && Math.abs(dr) <= range);
    }
    if (shape === 'square') {
        return Math.max(Math.abs(dr), Math.abs(dc)) <= range;
    }
    return Math.abs(dr) + Math.abs(dc) <= range;
}

function hasOpaqueLineOfSight(mapName, fromRow, fromCol, toRow, toCol) {
    const steps = Math.max(Math.abs(toRow - fromRow), Math.abs(toCol - fromCol));
    if (steps <= 1) return true;
    for (let step = 1; step < steps; step++) {
        const t = step / steps;
        const row = Math.round(fromRow + (toRow - fromRow) * t);
        const col = Math.round(fromCol + (toCol - fromCol) * t);
        if (row === fromRow && col === fromCol) continue;
        if (row === toRow && col === toCol) continue;
        if (boards[mapName][row]?.[col]?.isWall) return false;
    }
    return true;
}

function getUnitVisionCells(unit) {
    const visible = new Set();
    if (!unit || !unit.map) return visible;

    const mapName = unit.map;
    const size = MAP_SIZES[mapName];
    const shape = unit.getVisionShape();
    const range = unit.getVisionRange();
    const originKey = `${unit.row},${unit.col}`;
    visible.add(originKey);

    const startRow = Math.max(0, unit.row - range);
    const endRow = Math.min(size.rows - 1, unit.row + range);
    const startCol = Math.max(0, unit.col - range);
    const endCol = Math.min(size.cols - 1, unit.col + range);

    for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
            if (row === unit.row && col === unit.col) continue;
            if (!isCellInsideVisionShape(unit, row, col, shape, range)) continue;
            if (hasOpaqueLineOfSight(mapName, unit.row, unit.col, row, col)) {
                visible.add(`${row},${col}`);
            }
        }
    }
    return visible;
}

function getKohUnit(player) {
    return units.find(unit => unit.player === player && unit.type === 'koh') || null;
}

function getMonitorPenalty(unit) {
    if (!unit || unit.type === 'core') return 0;
    const enemyPlayer = unit.player === 1 ? 2 : 1;
    if (getPlayerAbility(enemyPlayer) !== '監視') return 0;
    const watcher = getKohUnit(enemyPlayer);
    if (!watcher) return 0;
    return isCellWithinUnitVision(watcher, unit.map, unit.row, unit.col) ? 1 : 0;
}

function canScoutRevealCamouflage(viewerPlayer, mapName, row, col) {
    // 迷彩は通常の視界では偵察兵にも見せない。
    // ワープ候補の特別表示は getScoutWarpTargets 側で行う。
    return false;
}

function isUnitVisibleToViewer(unit, viewerPlayer, activeVisionSet) {
    if (!unit) return false;
    if (gameMode === 'debug') return true;
    if (unit.player === viewerPlayer) return true;
    if (!activeVisionSet.has(`${unit.row},${unit.col}`)) return false;
    if (!unit.camouflaged) return true;
    return false;
}

function maybeClearCamouflageAfterMove(unit) {
    if (unit.type !== 'koh' || !unit.camouflaged) return;
    const ability = getPlayerAbility(unit.player);
    if (ability !== '迷彩') return;
    unit.camouflaged = false;
    addConsoleLog(`ABILITY: 迷彩解除 - ${unit.name} が移動したため姿を現しました。`, 'ability');
}

// --- FOG OF WAR / VISIBILITY ---
function calculateVisibility() {
    Object.keys(p1Vision).forEach(map => p1Vision[map].clear());
    Object.keys(p2Vision).forEach(map => p2Vision[map].clear());

    const p1InArea2 = units.some(u => u.player === 1 && u.map === 'area2');
    const p2InArea2 = units.some(u => u.player === 2 && u.map === 'area2');

    if (p1InArea2) {
        const size = MAP_SIZES.area1;
        for (let r = 0; r < size.rows; r++)
            for (let c = 0; c < size.cols; c++) p1Vision.area1.add(`${r},${c}`);
    }
    if (p2InArea2) {
        const size = MAP_SIZES.area3;
        for (let r = 0; r < size.rows; r++)
            for (let c = 0; c < size.cols; c++) p2Vision.area3.add(`${r},${c}`);
    }

    const p1StatusEl = document.getElementById('p1-area2-status');
    const p2StatusEl = document.getElementById('p2-area2-status');
    if (p1StatusEl) {
        p1StatusEl.textContent = p1InArea2 ? 'ONLINE (正常)' : 'COLLAPSE (情報崩壊)';
        p1StatusEl.className = p1InArea2 ? 'status-val text-cyan' : 'status-val text-gold';
    }
    if (p2StatusEl) {
        p2StatusEl.textContent = p2InArea2 ? 'ONLINE (正常)' : 'COLLAPSE (情報崩壊)';
        p2StatusEl.className = p2InArea2 ? 'status-val text-magenta' : 'status-val text-gold';
    }

    units.forEach(unit => {
        const visionSet = unit.player === 1 ? p1Vision[unit.map] : p2Vision[unit.map];
        getUnitVisionCells(unit).forEach(coord => visionSet.add(coord));
    });

    if (p1ClairvoyanceDir) applyClairvoyanceSight(p1ClairvoyanceDir, p1Vision[p1ClairvoyanceDir.map]);
    if (p2ClairvoyanceDir) applyClairvoyanceSight(p2ClairvoyanceDir, p2Vision[p2ClairvoyanceDir.map]);

    if (p1Ability === '足跡' && !p1KohDestroyed) {
        p1VisionHistory.forEach(snapshot => {
            Object.keys(p1Vision).forEach(map => {
                snapshot[map].forEach(coord => p1Vision[map].add(coord));
            });
        });
    }
    if (p2Ability === '足跡' && !p2KohDestroyed) {
        p2VisionHistory.forEach(snapshot => {
            Object.keys(p2Vision).forEach(map => {
                snapshot[map].forEach(coord => p2Vision[map].add(coord));
            });
        });
    }
}

function applyClairvoyanceSight(clairObj, targetVisionSet) {
    const { map, row, col, dir } = clairObj;
    const size = MAP_SIZES[map];
    let dr = 0, dc = 0;
    if (dir === 'up') dr = -1;
    else if (dir === 'down') dr = 1;
    else if (dir === 'left') dc = -1;
    else if (dir === 'right') dc = 1;

    let currR = row + dr, currC = col + dc;
    while (currR >= 0 && currR < size.rows && currC >= 0 && currC < size.cols) {
        targetVisionSet.add(`${currR},${currC}`);
        if (boards[map][currR][currC].isWall) break;
        currR += dr; currC += dc;
    }
}

function saveTurnVision() {
    const p1Snapshot = {
        area1: new Set(p1Vision.area1),
        area2: new Set(p1Vision.area2),
        area3: new Set(p1Vision.area3)
    };
    const p2Snapshot = {
        area1: new Set(p2Vision.area1),
        area2: new Set(p2Vision.area2),
        area3: new Set(p2Vision.area3)
    };
    p1LastVision = p1Snapshot;
    p2LastVision = p2Snapshot;
    p1VisionHistory.unshift(p1Snapshot);
    p2VisionHistory.unshift(p2Snapshot);
    p1VisionHistory = p1VisionHistory.slice(0, 2);
    p2VisionHistory = p2VisionHistory.slice(0, 2);
}

// --- BOARD RENDERER ---
function renderBoard(options = {}) {
    const {
        boardId = 'board',
        mapName = activeMap,
        viewerPlayerOverride = null,
        updateLinkedPanels = true,
        interactive = true,
        revealAll = false
    } = options;
    const boardEl = document.getElementById(boardId);
    if (!boardEl) return;
    boardEl.innerHTML = '';
    const viewerPlayer = viewerPlayerOverride || getViewerPlayer();
    boardEl.className = `board-map-${mapName} viewer-player-${viewerPlayer}`;

    const size = MAP_SIZES[mapName];
    boardEl.style.gridTemplateColumns = `repeat(${size.cols}, 1fr)`;
    boardEl.style.gridTemplateRows = `repeat(${size.rows}, 1fr)`;
    const wrapper = boardId === 'board'
        ? document.getElementById('game-board-wrapper')
        : document.getElementById('replay-board-wrapper');
    if (wrapper) wrapper.style.aspectRatio = `${size.cols} / ${size.rows}`;

    const activeVision = viewerPlayer === 1 ? p1Vision[mapName] : p2Vision[mapName];

    for (let r = 0; r < size.rows; r++) {
        for (let c = 0; c < size.cols; c++) {
            const cellData = boards[mapName][r][c];
            const coordStr = `${r},${c}`;

            const cellEl = document.createElement('div');
            cellEl.className = 'cell';
            cellEl.setAttribute('data-row', r);
            cellEl.setAttribute('data-col', c);
            cellEl.setAttribute('data-coord', `[${c},${r}]`);

            if (cellData.isTeleport) cellEl.classList.add('teleport');
            if (cellData.isWall) cellEl.classList.add('wall');
            if (cellData.isCoreTile) cellEl.classList.add('core-tile');
            const visibleFlags = revealAll
                ? (cellData.flags?.length ? cellData.flags : (cellData.flag ? [cellData.flag] : []))
                : getVisibleFlagsOnCell(cellData, viewerPlayer, activeVision);
            if (visibleFlags.length) cellEl.classList.add('has-flag');

            if (!revealAll && !activeVision.has(coordStr)) cellEl.classList.add('fog-grey');

            visibleFlags.forEach((flag, index) => {
                const flagEl = document.createElement('div');
                flagEl.className = `military-flag player-${flag.player}`;
                if (index > 0) flagEl.classList.add(`stacked-${index}`);
                flagEl.title = `Player ${flag.player} の軍旗`;
                flagEl.style.transform = index > 0 ? `translate(${index * 0.12}rem, ${index * -0.12}rem)` : '';
                cellEl.appendChild(flagEl);
            });

            if (cellData.unit) {
                const u = cellData.unit;
                const isHiddenByFog = !revealAll && !isUnitVisibleToViewer(u, viewerPlayer, activeVision);

                if (!isHiddenByFog) {
                    const unitEl = document.createElement('div');
                    unitEl.className = `unit player-${u.player} ${u.type}`;
                    if (actedUnitIds.has(u.id)) unitEl.classList.add('acted');
                    if (u.type === 'koh') {
                        unitEl.classList.add('koh-ability', getAbilityClass(u.player));
                        unitEl.setAttribute('data-ability', u.player === 1 ? p1Ability : p2Ability);
                        if ((u.player === 1 ? p1Ability : p2Ability) === '戦姫') {
                            const killCounter = document.createElement('span');
                            killCounter.className = 'kill-counter';
                            killCounter.textContent = u.warPrincessKills || 0;
                            unitEl.appendChild(killCounter);
                        }
                    }
                    if (u.carryingFlagPlayer) {
                        unitEl.classList.add('flag-carrier');
                        const flagCounter = document.createElement('span');
                        flagCounter.className = 'flag-counter';
                        flagCounter.textContent = `${u.flagSurvivalTurns}/${FLAG_SURVIVAL_TURNS}`;
                        unitEl.appendChild(flagCounter);
                    }
                    unitEl.setAttribute('data-rank', u.symbol);
                    unitEl.title = `${u.name} (P${u.player})\n移動: ${getMoveTypeLabel(u.getEffectiveMoveType())}${u.getMovementRange()}\n視界: ${getVisionShapeLabel(u.getVisionShape())}${u.getVisionRange()}${u.carryingFlagPlayer ? '\n軍旗生存: ' + u.flagSurvivalTurns + '/' + FLAG_SURVIVAL_TURNS : ''}\n${u.abilityDescription}`;
                    if (u.type === 'core') unitEl.classList.add('core');
                    cellEl.appendChild(unitEl);
                }
            }

            if (interactive) {
                cellEl.addEventListener('click', () => handleCellClick(r, c));
            }
            boardEl.appendChild(cellEl);
        }
    }

    if (updateLinkedPanels && boardId === 'board') {
        updateTabIndicators();
        renderMinimaps();
    }
}

function updateTabIndicators() {
    const viewerPlayer = getViewerPlayer();
    const activeVision = viewerPlayer === 1 ? p1Vision : p2Vision;

    Object.keys(boards).forEach(map => {
        let alliesCount = 0, visibleEnemies = 0;
        for (let r = 0; r < MAP_SIZES[map].rows; r++) {
            for (let c = 0; c < MAP_SIZES[map].cols; c++) {
                const u = boards[map][r][c].unit;
                if (u) {
                    if (u.type === 'core' && u.col !== c) continue;
                    if (u.player === viewerPlayer) alliesCount++;
                    else if (isUnitVisibleToViewer(u, viewerPlayer, activeVision[map])) visibleEnemies++;
                }
            }
        }
        const countEl = document.getElementById(`tab-count-${map}`);
        if (countEl) countEl.textContent = `${alliesCount} / ${visibleEnemies}`;
    });
}

function renderMinimaps() {
    const panel = document.getElementById('minimap-panel');
    if (!panel || !boards.area1.length) return;
    const viewerPlayer = getViewerPlayer();
    const vision = viewerPlayer === 1 ? p1Vision : p2Vision;
    panel.innerHTML = '';

    Object.keys(MAP_SIZES).forEach(mapName => {
        const mini = document.createElement('button');
        mini.className = `minimap ${activeMap === mapName ? 'active' : ''}`;
        mini.type = 'button';
        mini.addEventListener('click', () => switchActiveMap(mapName));

        const title = document.createElement('span');
        title.className = 'minimap-title';
        title.textContent = getViewerAreaLabel(mapName, viewerPlayer);
        mini.appendChild(title);

        const grid = document.createElement('span');
        grid.className = 'minimap-grid';
        grid.style.gridTemplateColumns = `repeat(${MAP_SIZES[mapName].cols}, 1fr)`;
        for (let r = 0; r < MAP_SIZES[mapName].rows; r++) {
            for (let c = 0; c < MAP_SIZES[mapName].cols; c++) {
                const cell = document.createElement('span');
                const boardCell = boards[mapName][r][c];
                cell.className = 'minimap-cell';
                if (boardCell.isWall) cell.classList.add('wall');
                if (boardCell.isTeleport) cell.classList.add('teleport');
                if (boardCell.isCoreTile) cell.classList.add('core-tile');
                const visibleFlags = getVisibleFlagsOnCell(boardCell, viewerPlayer, vision[mapName]);
                if (visibleFlags.length) {
                    cell.classList.add(`flag-p${visibleFlags[visibleFlags.length - 1].player}`);
                }
                const unit = boardCell.unit;
                const visible = gameMode === 'debug' || !unit || isUnitVisibleToViewer(unit, viewerPlayer, vision[mapName]);
                if (unit && visible) cell.classList.add(unit.player === 1 ? 'p1' : 'p2');
                else if (!vision[mapName].has(`${r},${c}`) && gameMode !== 'debug') cell.classList.add('fog');
                grid.appendChild(cell);
            }
        }
        mini.appendChild(grid);
        panel.appendChild(mini);
    });
}

function getViewerAreaLabel(mapName, viewerPlayer = getViewerPlayer()) {
    if (viewerPlayer === 2) {
        if (mapName === 'area3') return 'AREA 1: 自陣';
        if (mapName === 'area1') return 'AREA 3: 敵陣';
    }
    return getAreaLabel(mapName);
}

function getMoveTypeLabel(moveType) {
    if (moveType === 'straight') return '直線';
    if (moveType === 'square') return '周囲';
    return 'マンハッタン';
}

function getVisionShapeLabel(shape) {
    if (shape === 'beam') return '直線';
    if (shape === 'square') return '周囲';
    return 'マンハッタン';
}

// --- MOVEMENT & PATHFINDING ---
function getValidMoves(unit, options = {}) {
    const valid = [];
    const moveRange = unit.getMovementRange();
    const effectiveMoveType = unit.getEffectiveMoveType();
    const map = unit.map;
    const size = MAP_SIZES[map];

    if (moveRange === 0) return valid;

    if (effectiveMoveType === 'straight') {
        const dirs = [{ r: -1, c: 0 }, { r: 1, c: 0 }, { r: 0, c: -1 }, { r: 0, c: 1 }];

        dirs.forEach(dir => {
            for (let step = 1; step <= moveRange; step++) {
                const targetR = unit.row + dir.r * step;
                const targetC = unit.col + dir.c * step;

                if (targetR < 0 || targetR >= size.rows || targetC < 0 || targetC >= size.cols) break;

                const pathCells = [];
                for (let s = 1; s <= step; s++) {
                    pathCells.push({ r: unit.row + dir.r * s, c: unit.col + dir.c * s });
                }

                if (isValidPath(unit, pathCells, options)) {
                    if (isMoveDestinationBlockedByFriendly(unit, targetR, targetC)) break;

                    const resolved = resolveMoveDestination(unit, targetR, targetC);
                    const hasEnemyTarget =
                        (resolved.localOccupant &&
                            resolved.localOccupant.player !== unit.player &&
                            !shouldIgnoreOccupantForPreview(unit, resolved.localOccupant, unit.map, options)) ||
                        (resolved.portalDest &&
                            resolved.destOccupant &&
                            resolved.destOccupant.player !== unit.player &&
                            !shouldIgnoreOccupantForPreview(unit, resolved.destOccupant, resolved.targetMap, options));
                    const visibleEnemyTarget = isVisibleEnemyMoveTarget(unit, resolved, targetR, targetC);

                    valid.push({ row: targetR, col: targetC, type: hasEnemyTarget && visibleEnemyTarget ? 'attack' : 'move' });

                    const localBlocked = resolved.localOccupant && !shouldIgnoreOccupantForPreview(unit, resolved.localOccupant, unit.map, options);
                    const portalBlocked = resolved.portalDest && resolved.destOccupant && !shouldIgnoreOccupantForPreview(unit, resolved.destOccupant, resolved.targetMap, options);
                    if (localBlocked || portalBlocked) break;
                } else {
                    break;
                }
            }
        });
    } else {
        // BFS manhattan / square movement
        const queue = [{ row: unit.row, col: unit.col, steps: 0 }];
        const visited = new Set();
        visited.add(`${unit.row},${unit.col}`);
        const dirs = effectiveMoveType === 'square'
            ? [
                { r: -1, c: 0 }, { r: 1, c: 0 }, { r: 0, c: -1 }, { r: 0, c: 1 },
                { r: -1, c: -1 }, { r: -1, c: 1 }, { r: 1, c: -1 }, { r: 1, c: 1 }
            ]
            : [{ r: -1, c: 0 }, { r: 1, c: 0 }, { r: 0, c: -1 }, { r: 0, c: 1 }];

        while (queue.length > 0) {
            const curr = queue.shift();
            if (curr.steps >= moveRange) continue;

            dirs.forEach(dir => {
                    const nextR = curr.row + dir.r, nextC = curr.col + dir.c;
                    const key = `${nextR},${nextC}`;

                    if (nextR < 0 || nextR >= size.rows || nextC < 0 || nextC >= size.cols) return;
                    if (boards[map][nextR][nextC].isWall) return;
                    if (effectiveMoveType === 'square' && isDiagonalCornerBlocked(map, curr.row, curr.col, nextR, nextC)) return;
                    if (unit.type === 'scout' && map !== 'area2') return;
                    if (isMoveDestinationBlockedByFriendly(unit, nextR, nextC)) return;

                    const resolved = resolveMoveDestination(unit, nextR, nextC);
                    const hasEnemyTarget =
                        (resolved.localOccupant &&
                            resolved.localOccupant.player !== unit.player &&
                            !shouldIgnoreOccupantForPreview(unit, resolved.localOccupant, unit.map, options)) ||
                        (resolved.portalDest &&
                            resolved.destOccupant &&
                            resolved.destOccupant.player !== unit.player &&
                            !shouldIgnoreOccupantForPreview(unit, resolved.destOccupant, resolved.targetMap, options));
                    const visibleEnemyTarget = isVisibleEnemyMoveTarget(unit, resolved, nextR, nextC);

                    if (!visited.has(key)) {
                        visited.add(key);
                        valid.push({ row: nextR, col: nextC, type: hasEnemyTarget && visibleEnemyTarget ? 'attack' : 'move' });
                        const localBlocked = resolved.localOccupant && !shouldIgnoreOccupantForPreview(unit, resolved.localOccupant, unit.map, options);
                        const portalBlocked = resolved.portalDest && resolved.destOccupant && !shouldIgnoreOccupantForPreview(unit, resolved.destOccupant, resolved.targetMap, options);
                        if (!localBlocked && !portalBlocked) {
                            queue.push({ row: nextR, col: nextC, steps: curr.steps + 1 });
                        }
                    }
            });
        }
    }

    return valid;
}

function isValidPath(unit, pathCells, options = {}) {
    const map = unit.map;
    for (let i = 0; i < pathCells.length; i++) {
        const { r, c } = pathCells[i];
        if (boards[map][r][c].isWall) return false;
        if (unit.type === 'scout' && map !== 'area2') return false;
        const occupant = boards[map][r][c].unit;
        if (occupant) {
            if (shouldIgnoreOccupantForPreview(unit, occupant, map, options)) continue;
            if (i < pathCells.length - 1) return false;
            if (occupant.player === unit.player) return false;
        }
    }
    return true;
}

function isVisibleEnemyMoveTarget(unit, resolved, localRow, localCol) {
    const vision = unit.player === 1 ? p1Vision : p2Vision;
    if (
        resolved.localOccupant &&
        resolved.localOccupant.player !== unit.player &&
        isUnitVisibleToViewer(resolved.localOccupant, unit.player, vision[unit.map])
    ) {
        return true;
    }
    if (
        resolved.portalDest &&
        resolved.destOccupant &&
        resolved.destOccupant.player !== unit.player &&
        isUnitVisibleToViewer(resolved.destOccupant, unit.player, vision[resolved.targetMap])
    ) {
        return true;
    }
    return false;
}

function getScoutWarpTargets(scout) {
    const valid = [];
    const map = scout.map;
    if (map !== 'area2') return valid;

    const size = MAP_SIZES[map];
    const activeVision = scout.player === 1 ? p1Vision[map] : p2Vision[map];

    for (let r = 0; r < size.rows; r++) {
        for (let c = 0; c < size.cols; c++) {
            const cell = boards[map][r][c];
            const occupant = cell.unit;
            if (cell.isWall) continue;

            if (occupant) {
                if (occupant.player !== scout.player && occupant.camouflaged && activeVision.has(`${r},${c}`)) {
                    valid.push({ row: r, col: c, type: 'ability', camouflagedTarget: true });
                }
                continue;
            }

            if (activeVision.has(`${r},${c}`)) {
                valid.push({ row: r, col: c, type: 'ability' });
            }
        }
    }
    return valid;
}

// --- CELL CLICK HANDLER ---
function handleCellClick(row, col) {
    if (isGameOver) return;
    clearAfkTurnReminderOnAction();
    const cell = boards[activeMap][row][col];
    const viewerPlayer = getViewerPlayer();
    const activeVision = viewerPlayer === 1 ? p1Vision[activeMap] : p2Vision[activeMap];
    const clickedVisibleEnemy = cell.unit && cell.unit.player !== viewerPlayer && isUnitVisibleToViewer(cell.unit, viewerPlayer, activeVision);
    const clickedOwnUnit = cell.unit && cell.unit.player === viewerPlayer;

    if (onlineMode && onlineMatchPreviewActive && activePhase === 'setup') {
        if (clickedOwnUnit) {
            showUnitPreview(cell.unit, 'ALLY PREVIEW');
        } else if (clickedVisibleEnemy) {
            showUnitPreview(cell.unit, 'ENEMY PREVIEW');
        } else {
            cancelSelection();
        }
        return;
    }

    if (!canControlCurrentTurn() || (currentPlayer === 2 && vsAI)) {
        if (clickedOwnUnit) showUnitPreview(cell.unit, 'ALLY PREVIEW');
        else if (clickedVisibleEnemy) showUnitPreview(cell.unit, 'ENEMY PREVIEW');
        else cancelSelection();
        return;
    }

    if (selectedUnit) {
        const moveTarget = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"].highlight-move`);
        const attackTarget = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"].highlight-attack`);
        const abilityTarget = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"].highlight-ability`);

        if (moveTarget || attackTarget) { executeMove(selectedUnit, row, col); return; }
        if (abilityTarget) { executeAbility(selectedUnit, row, col); return; }
        if (cell.unit && cell.unit.player === currentPlayer) selectUnit(cell.unit);
        else if (clickedVisibleEnemy) showUnitPreview(cell.unit, 'ENEMY PREVIEW');
        else cancelSelection();
    } else {
        if (cell.unit && cell.unit.player === currentPlayer) selectUnit(cell.unit);
        else if (clickedVisibleEnemy) showUnitPreview(cell.unit, 'ENEMY PREVIEW');
        else cancelSelection();
    }
}

function showUnitPreview(unit, previewLabel = 'ENEMY PREVIEW') {
    if (!unit) return;
    previewUnit = unit;
    selectedUnit = null;
    selectedAction = 'move';
    clearHighlights();

    const actionCtrl = document.getElementById('action-controls');
    actionCtrl.classList.remove('hidden');
    actionCtrl.classList.add('preview-mode');
    actionCtrl.querySelector('.unit-badge').textContent = unit.symbol;
    const abilityName = unit.type === 'koh' ? getPlayerAbility(unit.player) : null;
    actionCtrl.querySelector('.unit-name').textContent = abilityName
        ? `${previewLabel} / ${unit.name} / ${abilityName}`
        : `${previewLabel} / ${unit.name}`;
    actionCtrl.querySelector('.unit-coords').textContent = `[${unit.col}, ${unit.row}]`;

    const selectedCell = document.querySelector(`.cell[data-row="${unit.row}"][data-col="${unit.col}"]`);
    if (selectedCell) selectedCell.classList.add('selected');

    getValidMoves(unit).forEach(move => {
        const el = document.querySelector(`.cell[data-row="${move.row}"][data-col="${move.col}"]`);
        if (!el) return;
        el.classList.add(move.type === 'attack' ? 'highlight-preview-attack' : 'highlight-preview-move');
    });
}

function selectUnit(unit) {
    if (unit.type === 'core') return;
    if (actedUnitIds.has(unit.id)) {
        addConsoleLog('INFO: このターンに行動済みのコマは再行動できません。', 'system');
        return;
    }

    if (activeMap !== unit.map) {
        activeMap = unit.map;
        document.querySelectorAll('.map-tab').forEach(tab => {
            tab.classList.toggle('active', tab.getAttribute('data-map') === unit.map);
        });
        renderBoard();
    }

    selectedUnit = unit;
    previewUnit = null;
    selectedAction = 'move';

    const actionCtrl = document.getElementById('action-controls');
    actionCtrl.classList.remove('hidden');
    actionCtrl.classList.remove('preview-mode');
    actionCtrl.querySelector('.unit-badge').textContent = unit.symbol;
    const selectedAbilityName = unit.type === 'koh' ? (unit.player === 1 ? p1Ability : p2Ability) : null;
    actionCtrl.querySelector('.unit-name').textContent = selectedAbilityName ? `${unit.name} / ${selectedAbilityName}` : unit.name;
    actionCtrl.querySelector('.unit-coords').textContent = `[${unit.col}, ${unit.row}]`;

    const abilityBtn = document.getElementById('btn-ability');
    const teleportBtn = document.getElementById('btn-teleport');
    const abilityName = currentPlayer === 1 ? p1Ability : p2Ability;

    if (unit.type === 'koh') {
        abilityBtn.classList.remove('hidden');
        if (abilityName === '千里眼') abilityBtn.textContent = `方向選択: ${abilityName}`;
        else if (abilityName === '鼓舞' || abilityName === '爆破' || abilityName === '迷彩') abilityBtn.textContent = `即時発動: ${abilityName}`;
        else abilityBtn.textContent = `特性確認: ${abilityName}`;
    } else if (unit.type === 'scout') {
        abilityBtn.classList.remove('hidden');
        abilityBtn.textContent = 'ワープ先を選択';
    } else {
        abilityBtn.classList.add('hidden');
    }

    teleportBtn.classList.add('hidden');
    selectActionType('move');
}

function selectActionType(type) {
    selectedAction = type;
    document.getElementById('btn-move').classList.toggle('active', type === 'move');
    document.getElementById('btn-ability').classList.toggle('active', type === 'ability');

    clearHighlights();

    const cellEl = document.querySelector(`.cell[data-row="${selectedUnit.row}"][data-col="${selectedUnit.col}"]`);
    if (cellEl) cellEl.classList.add('selected');

    if (type === 'move') {
        const moves = getValidMoves(selectedUnit, { hideUnseenEnemies: true });
        moves.forEach(m => {
            const el = document.querySelector(`.cell[data-row="${m.row}"][data-col="${m.col}"]`);
            if (el) {
                if (m.type === 'attack') el.classList.add('highlight-attack');
                else el.classList.add('highlight-move');
            }
        });
    } else if (type === 'ability') {
        if (selectedUnit.type === 'scout') {
            const warps = getScoutWarpTargets(selectedUnit);
            warps.forEach(w => {
                const el = document.querySelector(`.cell[data-row="${w.row}"][data-col="${w.col}"]`);
                if (el) el.classList.add('highlight-ability');
            });
        } else if (selectedUnit.type === 'koh') {
            const abilityName = currentPlayer === 1 ? p1Ability : p2Ability;
            if (abilityName === '千里眼') {
                document.getElementById('direction-overlay').classList.remove('hidden');
            } else if (abilityName === '鼓舞' || abilityName === '爆破' || abilityName === '迷彩') {
                executeAbility(selectedUnit, null, null);
            }
            // パッシブ系はアビリティボタンで何もしない
        }
    }
}

function clearHighlights() {
    document.querySelectorAll('.cell').forEach(c => {
        c.classList.remove('highlight-move', 'highlight-attack', 'highlight-ability', 'highlight-preview-move', 'highlight-preview-attack', 'selected');
    });
}

function cancelSelection() {
    selectedUnit = null;
    previewUnit = null;
    clearHighlights();
    const actionCtrl = document.getElementById('action-controls');
    actionCtrl.classList.add('hidden');
    actionCtrl.classList.remove('preview-mode');
}

// --- MOVEMENT EXECUTION ---
function executeMove(unit, destRow, destCol) {
    const startMap = unit.map;
    const startRow = unit.row;
    const startCol = unit.col;
    const resolved = resolveMoveDestination(unit, destRow, destCol);

    if (isMoveDestinationBlockedByFriendly(unit, destRow, destCol)) {
        addConsoleLog(`ERROR: 転送先または移動先に味方がいるため移動できません。`, 'system');
        cancelSelection();
        return;
    }

    boards[startMap][startRow][startCol].unit = null;

    const targetMap = resolved.targetMap;
    const targetRow = resolved.targetRow;
    const targetCol = resolved.targetCol;
    const captured = [];
    let logType = unit.player === 1 ? 'p1' : 'p2';
    const shouldFocusMove = onlineMode
        ? unit.player === localPlayer
        : !shouldHideAiActionFeedback(unit.player);

    if (resolved.localOccupant && resolved.localOccupant.player !== unit.player) {
        captured.push({ unit: resolved.localOccupant, map: startMap, row: destRow, col: destCol });
    }

    if (
        resolved.portalDest &&
        resolved.destOccupant &&
        resolved.destOccupant.player !== unit.player &&
        (!resolved.localOccupant || resolved.destOccupant.id !== resolved.localOccupant.id)
    ) {
        captured.push({ unit: resolved.destOccupant, map: targetMap, row: targetRow, col: targetCol });
    }

    captured.forEach(v => {
        logType = 'destroy';
        if (captureUnit(v.unit, unit.player)) return;

        const isEnemyHome = unit.player === 1 ? v.map === 'area3' : v.map === 'area1';
        if (!isGameOver && unit.type === 'otsu' && isEnemyHome) {
            addConsoleLog(`ABILITY: 乙の「切り崩し」発動！`, 'ability');
            executeOtsuBreakthrough(v.map, v.row, v.col);
        }
    });

    if (isGameOver) return;
    applyWarPrincessKills(unit, captured.length);

    // 暗殺者: 撃破時、進行方向から1マス戻る
    let finalRow = targetRow, finalCol = targetCol, finalMap = targetMap;
    if (unit.type === 'koh' && captured.length > 0) {
        const ability = unit.player === 1 ? p1Ability : p2Ability;
        if (ability === '歴戦王') {
            unit.refreshActedAfterAction = true;
            unit.veteranMomentumPenalty = true;
            addConsoleLog(`ABILITY: 歴戦王 - 撃破により行動済み状態を解除。次の移動範囲は-1。`, 'ability');
        }
        if (ability === '暗殺者') {
            // Calculate move direction (from start to dest on same map; ignore portal for direction)
            const dr = destRow - startRow;
            const dc = destCol - startCol;
            let normDr = 0, normDc = 0;
            if (dr !== 0) normDr = dr > 0 ? 1 : -1;
            else if (dc !== 0) normDc = dc > 0 ? 1 : -1;

            const backR = targetRow - normDr;
            const backC = targetCol - normDc;
            const mapSize = MAP_SIZES[targetMap];

            if (backR >= 0 && backR < mapSize.rows && backC >= 0 && backC < mapSize.cols &&
                !boards[targetMap][backR][backC].isWall &&
                !boards[targetMap][backR][backC].unit) {
                finalRow = backR;
                finalCol = backC;
            }

            // Place unit at final position and end turn
            unit.map = finalMap;
            unit.row = finalRow;
            unit.col = finalCol;
            boards[finalMap][finalRow][finalCol].unit = unit;
            tryPickupMilitaryFlag(unit);

            const captureNames = captured.map(v => v.unit.name).join(', ');
            addConsoleLog(`ABILITY: 暗殺者 - ${unit.name}が${captureNames}を撃破し、1マス後退。`, 'ability');
            if (resolved.portalDest && unit.player === currentPlayer && shouldFocusMove) activeMap = finalMap;
            if (resolved.portalDest) unit.refreshActedAfterAction = true;
            maybeClearCamouflageAfterMove(unit);
            recordMatchReplayEvent({ kind: 'action', action: { type: 'move', unitId: unit.id, row: destRow, col: destCol } });
            sendOnlineMessage({ kind: 'action', action: { type: 'move', unitId: unit.id, row: destRow, col: destCol } });
            completeUnitAction(unit);
            return;
        }
    }

    // Normal placement
    unit.map = finalMap;
    unit.row = finalRow;
    unit.col = finalCol;
    boards[finalMap][finalRow][finalCol].unit = unit;
    tryPickupMilitaryFlag(unit);

    let logMsg;
    if (resolved.portalDest) {
        const destLabel = getAreaLabel(targetMap);
        if (captured.length > 0) {
            const names = captured.map(v => `${v.unit.name}[${v.col},${v.row}]`).join(' / ');
            logMsg = `Player ${unit.player}: ${unit.name} がポータルに進入し、${destLabel} [${targetCol},${targetRow}] へ転送。${names} を撃破！`;
        } else {
            logMsg = `Player ${unit.player}: ${unit.name} がポータルに進入し、${destLabel} [${targetCol},${targetRow}] へ自動転送。`;
        }
    } else if (captured.length > 0) {
        logMsg = `Player ${unit.player}: ${unit.name} が [${startCol},${startRow}] から [${destCol},${destRow}] の敵 ${captured[0].unit.name} を撃破！`;
    } else {
        logMsg = `Player ${unit.player}: ${unit.name} が [${startCol},${startRow}] から [${destCol},${destRow}] へ移動。`;
    }

    addConsoleLog(logMsg, logType);
    if (resolved.portalDest && unit.player === currentPlayer && shouldFocusMove) activeMap = targetMap;
    if (resolved.portalDest) {
        unit.refreshActedAfterAction = true;
        addConsoleLog(`SYSTEM: テレポート使用により行動済み状態を解除。`, 'system');
    }
    if (!shouldHideAiActionFeedback(unit.player)) playMoveSfx();
    maybeClearCamouflageAfterMove(unit);
    recordMatchReplayEvent({ kind: 'action', action: { type: 'move', unitId: unit.id, row: destRow, col: destCol } });
    sendOnlineMessage({ kind: 'action', action: { type: 'move', unitId: unit.id, row: destRow, col: destCol } });
    completeUnitAction(unit);
}

function executeAbility(unit, destRow, destCol) {
    const map = unit.map;

    if (unit.type === 'scout') {
        const startRow = unit.row, startCol = unit.col;
        const targetCell = boards[map][destRow][destCol];
        const targetOccupant = targetCell.unit;

        if (targetOccupant) {
            if (targetOccupant.player === unit.player) {
                addConsoleLog(`ERROR: ワープ先に味方ユニットがいるため移動できません。`, 'error');
                return;
            }

            if (!targetOccupant.camouflaged) {
                addConsoleLog(`ERROR: ワープ先にユニットがいるため移動できません。`, 'error');
                return;
            }

            addConsoleLog(`ABILITY: 偵察兵のワープ先に潜んでいた ${targetOccupant.name} を撃破！`, 'destroy');
            captureUnit(targetOccupant, unit.player);
            if (isGameOver) return;
        }

        boards[map][startRow][startCol].unit = null;
        boards[map][destRow][destCol].unit = unit;
        unit.row = destRow; unit.col = destCol;
        tryPickupMilitaryFlag(unit);
        addConsoleLog(`Player ${unit.player}: 偵察兵が [${startCol},${startRow}] から [${destCol},${destRow}] へワープ転送。`, 'ability');
        if (!shouldHideAiActionFeedback(unit.player)) playMoveSfx();
        recordMatchReplayEvent({ kind: 'action', action: { type: 'ability', unitId: unit.id, row: destRow, col: destCol } });
        sendOnlineMessage({ kind: 'action', action: { type: 'ability', unitId: unit.id, row: destRow, col: destCol } });
        completeUnitAction(unit);
        return;
    }

    if (unit.type === 'koh') {
        const abilityName = currentPlayer === 1 ? p1Ability : p2Ability;

        if (abilityName === '鼓舞') {
            let affectedCount = 0;
            const size = MAP_SIZES[map];
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    const r = unit.row + dr, c = unit.col + dc;
                    if (r >= 0 && r < size.rows && c >= 0 && c < size.cols) {
                        const targetU = boards[map][r][c].unit;
                        if (targetU && targetU.player === unit.player && targetU.id !== unit.id) {
                            targetU.inspirationTurns = 2;
                            affectedCount++;
                        }
                    }
                }
            }
            addConsoleLog(`ABILITY: 甲の「鼓舞」発動！同マップ周囲 ${affectedCount} 体の味方の移動・視界+1。`, 'ability');
            recordMatchReplayEvent({ kind: 'action', action: { type: 'ability', unitId: unit.id } });
            sendOnlineMessage({ kind: 'action', action: { type: 'ability', unitId: unit.id } });
            completeUnitAction(unit);

        } else if (abilityName === '迷彩') {
            unit.camouflaged = true;
            addConsoleLog(`ABILITY: 甲の「迷彩」発動。次の移動まで偵察兵以外から視認されません。`, 'ability');
            recordMatchReplayEvent({ kind: 'action', action: { type: 'ability', unitId: unit.id } });
            sendOnlineMessage({ kind: 'action', action: { type: 'ability', unitId: unit.id } });
            completeUnitAction(unit);

        } else if (abilityName === '爆破') {
            addConsoleLog(`ABILITY: 甲の「爆破」自滅シークエンス開始！`, 'destroy');
            const selfRow = unit.row;
            const selfCol = unit.col;
            captureUnit(unit, unit.player === 1 ? 2 : 1);
            if (unit.player === 1) p1KohDestroyed = true;
            else p2KohDestroyed = true;
            destroyMilitaryFlagAt(map, selfRow, selfCol);

            const destroyedCoords = [];
            const size = MAP_SIZES[map];

            for (let dr = -2; dr <= 2; dr++) {
                for (let dc = -2; dc <= 2; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const r = unit.row + dr, c = unit.col + dc;
                    if (r >= 0 && r < size.rows && c >= 0 && c < size.cols) {
                        const targetCell = boards[map][r][c];
                        if (targetCell.isWall) {
                            targetCell.isWall = false;
                            destroyedCoords.push(`壁[${c},${r}]`);
                        }
                        if (targetCell.unit) {
                            const victim = targetCell.unit;
                            destroyedCoords.push(`${victim.name}[${c},${r}]`);
                            if (victim.type === 'core') {
                                for (let cr = 0; cr < size.rows; cr++)
                                    for (let cc = 0; cc < size.cols; cc++)
                                        if (boards[map][cr][cc].unit?.id === victim.id)
                                            boards[map][cr][cc].unit = null;
                                triggerWin(unit.player === 1 ? (victim.player === 2 ? 1 : 2) : (victim.player === 1 ? 2 : 1));
                                return;
                            } else {
                                captureUnit(victim, unit.player);
                                destroyMilitaryFlagAt(map, r, c);
                            }
                        } else if ((targetCell.flags?.length || targetCell.flag)) {
                            destroyMilitaryFlagAt(map, r, c);
                            destroyedCoords.push(`軍旗[${c},${r}]`);
                        }
                    }
                }
            }

            if (destroyedCoords.length > 0)
                addConsoleLog(`SYSTEM: 爆破により消滅: ${destroyedCoords.join(', ')}`, 'destroy');
            recordMatchReplayEvent({ kind: 'action', action: { type: 'ability', unitId: unit.id } });
            sendOnlineMessage({ kind: 'action', action: { type: 'ability', unitId: unit.id } });
            completeUnitAction(unit);

        } else {
            // パッシブ系アビリティはターン消費なし（移動が本アクション）
            addConsoleLog(`INFO: ${abilityName} はパッシブアビリティです。移動を選択してください。`, 'system');
            cancelSelection();
        }
    }
}

function executeClairvoyance(direction, unitOverride = selectedUnit) {
    document.getElementById('direction-overlay').classList.add('hidden');
    const unit = unitOverride;
    if (!unit) return;

    let actualDirection = direction;
    if (unit.player === 2) {
        const reverse = { up: 'down', down: 'up', left: 'right', right: 'left' };
        actualDirection = reverse[direction] || direction;
    }
    const scanObj = { map: unit.map, row: unit.row, col: unit.col, dir: actualDirection };
    if (currentPlayer === 1) { p1ClairvoyanceDir = scanObj; p1ClairvoyanceAge = 0; }
    else { p2ClairvoyanceDir = scanObj; p2ClairvoyanceAge = 0; }

    const dirKanji = { up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT' }[actualDirection];
    addConsoleLog(`ABILITY: 甲の「千里眼」起動。${unit.map} 内の ${dirKanji} 方向を可視化。`, 'ability');
    recordMatchReplayEvent({ kind: 'action', action: { type: 'clairvoyance', unitId: unit.id, dir: actualDirection } });
    sendOnlineMessage({ kind: 'action', action: { type: 'clairvoyance', unitId: unit.id, dir: actualDirection } });
    completeUnitAction(unit);
}

function executeOtsuBreakthrough(mapName, centerR, centerC) {
    const victims = [];
    const size = MAP_SIZES[mapName];
    const startR = Math.max(0, centerR - 1), endR = Math.min(size.rows - 1, centerR + 1);
    const startC = Math.max(0, centerC - 1), endC = Math.min(size.cols - 1, centerC + 1);

    for (let r = startR; r <= endR; r++) {
        for (let c = startC; c <= endC; c++) {
            if (r === centerR && c === centerC) continue;
            const targetCell = boards[mapName][r][c];
            if (targetCell.unit) {
                const victim = targetCell.unit;
                victims.push(`${victim.name}[${c},${r}]`);
                if (captureUnit(victim, currentPlayer)) return;
            }
        }
    }
    if (victims.length > 0)
        addConsoleLog(`SYSTEM: 切り崩し爆風: ${victims.join(', ')}`, 'destroy');
}

// --- TURN TRANSITION ---
function completeUnitAction(unit) {
    if (isGameOver) return;
    const refreshActed = unit.refreshActedAfterAction;
    const hideAiFeedback = shouldHideAiActionFeedback();
    unit.refreshActedAfterAction = false;
    if (!refreshActed) actedUnitIds.add(unit.id);
    else actedUnitIds.delete(unit.id);
    if (!refreshActed) unit.veteranMomentumPenalty = false;
    actionsThisTurn++;
    cancelSelection();
    calculateVisibility();

    if (actionsThisTurn >= ACTIONS_PER_TURN || !hasAvailableActionUnit(currentPlayer)) {
        endTurn();
        return;
    }

    if (!hideAiFeedback) {
        renderBoard();
        updateUI();
    }

    addConsoleLog(`ACTION ${actionsThisTurn}/${ACTIONS_PER_TURN}: Player ${currentPlayer} は別のコマをもう1体行動できます。`, currentPlayer === 1 ? 'p1' : 'p2');
    if (!hideAiFeedback) showTurnBanner();
    if (currentPlayer === 2 && vsAI && !replayPlaybackActive) setTimeout(executeAITurn, 700);
}

function hasAvailableActionUnit(player) {
    return units.some(unit => unit.player === player && unit.type !== 'core' && !actedUnitIds.has(unit.id));
}

function shouldHideAiActionFeedback(player = currentPlayer) {
    return vsAI && !onlineMode && player === 2;
}

function endTurn() {
    cancelSelection();
    if (isGameOver) return;

    units.forEach(u => {
        if (u.player === currentPlayer && u.inspirationTurns > 0) u.inspirationTurns--;
    });
    updateFlagCarrierSurvival(currentPlayer);

    saveTurnVision();

    if (currentPlayer === 1 && p1ClairvoyanceDir) {
        p1ClairvoyanceAge++;
        if (p1ClairvoyanceAge >= 2) { p1ClairvoyanceDir = null; p1ClairvoyanceAge = 0; }
    } else if (currentPlayer === 2 && p2ClairvoyanceDir) {
        p2ClairvoyanceAge++;
        if (p2ClairvoyanceAge >= 2) { p2ClairvoyanceDir = null; p2ClairvoyanceAge = 0; }
    }

    currentPlayer = currentPlayer === 1 ? 2 : 1;
    actionsThisTurn = 0;
    actedUnitIds = new Set();
    units.forEach(u => { u.veteranMomentumPenalty = false; });
    if (currentPlayer === 1) {
        gameTurn++;
        reinforceScouts();
        resetDrawRequests();
    }

    calculateVisibility();
    renderBoard();
    updateUI();
    recordMatchReplaySnapshot(`TURN ${gameTurn}`);

    const playerName = currentPlayer === 1 ? "PLAYER 1" : "PLAYER 2";
    const logColor = currentPlayer === 1 ? 'p1' : 'p2';
    addConsoleLog(`TURN ${gameTurn} - ${playerName} の戦術行動フェーズ。`, logColor);
    showTurnBanner();

    if (!hasAvailableActionUnit(currentPlayer)) {
        const otherPlayer = currentPlayer === 1 ? 2 : 1;
        if (!hasAvailableActionUnit(otherPlayer)) {
            addConsoleLog('TURN HOLD: 両プレイヤーとも行動可能なコマがありません。', 'system');
            return;
        }
        addConsoleLog(`TURN SKIP: Player ${currentPlayer} は行動可能なコマがありません。`, 'system');
        setTimeout(endTurn, 500);
        return;
    }

    if (currentPlayer === 2 && vsAI && !replayPlaybackActive) {
        setTimeout(executeAITurn, 1000);
    }
}

function showTurnBanner() {
    let banner = document.getElementById('turn-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'turn-banner';
        document.body.appendChild(banner);
    }
    const isMine = !onlineMode || localPlayer === currentPlayer;
    const bannerName = onlineMode ? getOnlineDisplayName(currentPlayer) : `PLAYER ${currentPlayer}`;
    banner.className = `turn-banner player-${currentPlayer} show`;
    banner.textContent = `TURN ${gameTurn} / ${bannerName} / ${actionsThisTurn}/${ACTIONS_PER_TURN}${onlineMode ? (isMine ? ' - YOUR TURN' : ' - OPPONENT') : ''}`;
    window.clearTimeout(showTurnBanner.timer);
    showTurnBanner.timer = window.setTimeout(() => banner.classList.remove('show'), 1500);
}

function reinforceScouts() {
    [1, 2].forEach(player => {
        const interval = getScoutReinforceInterval(player);
        if (gameTurn % interval !== 0) return;
        const scoutCount = units.filter(unit => unit.player === player && unit.type === 'scout').length;
        if (scoutCount >= SCOUT_LIMIT_PER_PLAYER) {
            addConsoleLog(`SUPPLY: Player ${player} の偵察兵は上限${SCOUT_LIMIT_PER_PLAYER}体です。`, 'system');
            return;
        }
        const rows = player === 1 ? [10, 9] : [0, 1];
        const spawn = rows.flatMap(row =>
            Array.from({ length: MAP_SIZES.area2.cols }, (_, col) => ({ row, col }))
        ).find(pos => {
            const cell = boards.area2[pos.row][pos.col];
            return !cell.isWall && !cell.unit;
        });
        if (!spawn) {
            addConsoleLog(`SUPPLY: Player ${player} の偵察兵補充地点がありません。`, 'system');
            return;
        }
        scoutReinforcementSerial++;
        addUnitToBoard(
            new Unit(`p${player}_scout_reinforce_${scoutReinforcementSerial}`, 'scout', player, 'area2', spawn.row, spawn.col, true),
            'area2',
            spawn.row,
            spawn.col
        );
        addConsoleLog(`SUPPLY: Player ${player} に偵察兵を1体補充しました。`, player === 1 ? 'p1' : 'p2');
    });
}

function getScoutReinforceInterval(player) {
    const koh = getKohUnit(player);
    if (koh && getPlayerAbility(player) === '衛生兵') return MEDIC_SCOUT_REINFORCE_INTERVAL;
    return SCOUT_REINFORCE_INTERVAL;
}

// --- WIN / LOSE ---
function triggerWin(winnerId, fromOnline = false, reason = 'core') {
    isGameOver = true;
    resetDrawRequests();
    const subtitleEl = document.getElementById('game-over-subtitle');
    const viewerPlayer = onlineMode && localPlayer ? localPlayer : 1;
    const viewerWon = winnerId === viewerPlayer;
    const summary = replayPlaybackActive && activeMatchSummaryView
        ? activeMatchSummaryView
        : buildMatchSummary(reason, winnerId);
    summary.replay = summary.replay || currentMatchReplay;
    activeMatchSummaryView = summary;
    recordMatchReplaySnapshot('MATCH END');

    if (viewerWon) {
        setGameOverTitle('VICTORY', winnerId === 1 ? 'cyan' : 'magenta');
        subtitleEl.textContent = reason === 'forfeit'
            ? '対戦相手のコアが自壊しました。'
            : `PLAYER ${winnerId} が敵のコア領域を完全破壊し、勝利を収めました。`;
        addConsoleLog(`SYSTEM OVERRIDE: PLAYER ${winnerId} VICTORY. ENEMY CORE PURGED.`, 'system');
    } else {
        setGameOverTitle('DEFEAT', winnerId === 1 ? 'cyan' : 'magenta');
        subtitleEl.textContent = reason === 'forfeit'
            ? '自身のコアを自壊しました。'
            : (vsAI
                ? '対戦AI (RED) によって自軍コアが崩壊しました。'
                : `PLAYER ${winnerId} が敵のコア領域を完全破壊し、勝利を収めました。`);
        addConsoleLog(`SYSTEM OVERRIDE: PLAYER ${winnerId} VICTORY. HOME CORE PURGED.`, 'system');
    }

    renderGameOverSummary(summary);
    document.getElementById('game-over-overlay').classList.remove('hidden');
    recordMatchReplayEvent({ kind: 'result', winner: winnerId, reason });
    submitMatchHistory(reason, winnerId);
    if (onlineMode && !fromOnline) sendOnlineMessage({ kind: 'win', winner: winnerId });
    if (onlineMode && activePhase !== 'battle' && !isRandomMatchRoom()) {
        resetOnlineMatchmakingState(true);
        window.setTimeout(() => {
            document.getElementById('game-over-overlay')?.classList.add('hidden');
            showMatchmakingPanel();
            setOnlineMatchTab('private');
            setMatchmakingStatus('プライベートマッチを終了しました。', 'system');
            updateLobbyPlayerCard();
        }, 900);
    }
}

function triggerDraw(fromOnline = false, reason = 'mutual') {
    if (isGameOver) return;
    isGameOver = true;
    resetDrawRequests();

    const subtitleEl = document.getElementById('game-over-subtitle');
    const summary = replayPlaybackActive && activeMatchSummaryView
        ? activeMatchSummaryView
        : buildMatchSummary('draw', null);
    summary.replay = summary.replay || currentMatchReplay;
    activeMatchSummaryView = summary;
    recordMatchReplaySnapshot('MATCH DRAW');

    setGameOverTitle('DRAW', 'gold');
    subtitleEl.textContent = reason === 'mutual'
        ? '双方が同ターンで引き分けを了承しました。'
        : '引き分けが成立しました。';
    addConsoleLog('SYSTEM OVERRIDE: MATCH ENDED IN DRAW.', 'system');

    renderGameOverSummary(summary);
    document.getElementById('game-over-overlay').classList.remove('hidden');
    recordMatchReplayEvent({ kind: 'result', result: 'draw', reason });
    submitMatchHistory('draw', null);
    if (onlineMode && !fromOnline) sendOnlineMessage({ kind: 'draw', reason });
    if (onlineMode && activePhase !== 'battle' && !isRandomMatchRoom()) {
        resetOnlineMatchmakingState(true);
        window.setTimeout(() => {
            document.getElementById('game-over-overlay')?.classList.add('hidden');
            showMatchmakingPanel();
            setOnlineMatchTab('private');
            setMatchmakingStatus('プライベートマッチを終了しました。', 'system');
            updateLobbyPlayerCard();
        }, 900);
    }
}

function forfeitGame() {
    if (confirm("本当に降伏（Reboot）しますか？現在の作戦データは破棄されます。")) {
        const winner = localPlayer ? (localPlayer === 1 ? 2 : 1) : (currentPlayer === 1 ? 2 : 1);
        if (onlineMode) sendOnlineMessage({ kind: 'forfeit', winner });
        triggerWin(winner, true, 'forfeit');
    }
}

function skipTurn() {
    if (isGameOver || !canControlCurrentTurn() || activePhase !== 'battle') return;
    addConsoleLog(`TURN SKIP: Player ${currentPlayer} が手動でターンを終了。`, 'system');
    recordMatchReplayEvent({ kind: 'action', action: { type: 'skip' } });
    if (onlineMode) sendOnlineMessage({ kind: 'action', action: { type: 'skip' } });
    endTurn();
}

function resetToSetup(fromOnline = false) {
    activePhase = 'setup';
    document.getElementById('game-over-overlay').classList.add('hidden');
    document.getElementById('game-info-panel').classList.add('hidden');
    document.getElementById('online-prebattle-panel')?.classList.add('hidden');
    document.getElementById('setup-panel').classList.remove('hidden');
    onlineMatchPreviewActive = false;
    replayPlaybackActive = false;
    matchIntroActive = false;
    window.clearTimeout(replayPlaybackTimer);
    replayPlaybackTimer = null;
    replayPlaybackSource = null;
    replayPlaybackRunId++;
    replayViewerSnapshots = [];
    replayViewerIndex = 0;
    replayViewerEntry = null;
    replayViewerOpen = false;
    window.clearTimeout(matchIntroTimer);
    matchIntroTimer = null;
    document.getElementById('match-intro-overlay')?.classList.add('hidden');
    currentMatchRecord = null;
    currentMatchReplay = null;
    activeMatchSummaryView = null;
    currentMatchOpponentStartProfile = null;
    resetDrawRequests();

    boards = { area1: [], area2: [], area3: [] };
    units = [];
    previewUnit = null;
    developModeSequence = '';
    syncBgmPlayback();
    clearHighlights();
    document.getElementById('board').innerHTML = '';
    clearStatusAlert();
    addConsoleLog("SYSTEM REBOOTED. STANDBY FOR CONFIGURATION...", 'system');

    if (onlineMode && !fromOnline) sendOnlineMessage({ kind: 'reset' });
}

// --- UI UPDATE ---
function updateUI() {
    document.getElementById('turn-count').textContent = gameTurn;

    const playerNameEl = document.getElementById('current-player-name');
    const playerDotEl = document.querySelector('.indicator-dot');
    const currentTurnName = onlineMode ? getOnlineDisplayName(currentPlayer) : `PLAYER ${currentPlayer}`;

    if (spectatorMode) {
        playerNameEl.textContent = `SPECTATING / ${currentTurnName}`;
        playerNameEl.className = currentPlayer === 1 ? 'text-cyan' : 'text-magenta';
        playerDotEl.style.backgroundColor = currentPlayer === 1 ? 'var(--neon-cyan)' : 'var(--neon-magenta)';
        playerDotEl.style.boxShadow = currentPlayer === 1 ? '0 0 10px var(--neon-cyan)' : '0 0 10px var(--neon-magenta)';
    } else if (currentPlayer === 1) {
        playerNameEl.textContent = onlineMode
            ? `${currentTurnName} (P1)${localPlayer === 1 ? ` - YOUR TURN ${actionsThisTurn}/${ACTIONS_PER_TURN}` : ' - OPPONENT TURN'}`
            : 'PLAYER 1 (BLUE)';
        playerNameEl.className = 'text-cyan';
        playerDotEl.style.backgroundColor = 'var(--neon-cyan)';
        playerDotEl.style.boxShadow = '0 0 10px var(--neon-cyan)';
    } else {
        playerNameEl.textContent = onlineMode
            ? `${currentTurnName} (P2)${localPlayer === 2 ? ` - YOUR TURN ${actionsThisTurn}/${ACTIONS_PER_TURN}` : ' - OPPONENT TURN'}`
            : (vsAI ? `AI BOT (RED) ${actionsThisTurn}/${ACTIONS_PER_TURN}` : 'PLAYER 2 (RED)');
        playerNameEl.className = 'text-magenta';
        playerDotEl.style.backgroundColor = 'var(--neon-magenta)';
        playerDotEl.style.boxShadow = '0 0 10px var(--neon-magenta)';
    }

    const totalUnits = 9 + 7; // home lineup 9 + area2 frontline 7
    const p1Count = units.filter(u => u.player === 1 && u.type !== 'core').length;
    const p2Count = units.filter(u => u.player === 2 && u.type !== 'core').length;
    document.getElementById('p1-units-count').textContent = `${p1Count} / ${totalUnits}`;
    document.getElementById('p2-units-count').textContent = `${p2Count} / ${totalUnits}`;
    updateMapLabels();
    updateModeVisibility();
    updateLobbyPlayerCard();
    updateDrawButtonState();
    document.body.classList.toggle('my-turn', !onlineMode || localPlayer === currentPlayer);
    document.body.classList.toggle('opponent-turn', onlineMode && localPlayer !== currentPlayer);
}

function updateMapLabels() {
    const viewerPlayer = getViewerPlayer();
    document.querySelectorAll('.map-tab').forEach(tab => {
        const mapName = tab.getAttribute('data-map');
        const textEl = tab.querySelector('.tab-text');
        if (textEl) textEl.textContent = getViewerAreaLabel(mapName, viewerPlayer);
    });
}

function addConsoleLog(text, type = 'system') {
    const feed = document.getElementById('log-feed');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const timeStamp = new Date().toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.textContent = `[${timeStamp}] ${text}`;
    feed.appendChild(entry);
    feed.scrollTop = feed.scrollHeight;
}

// --- AI SYSTEM ---
function executeAITurn() {
    if (isGameOver) return;

    const aiUnits = units.filter(u => u.player === 2 && u.type !== 'core' && !actedUnitIds.has(u.id));
    if (aiUnits.length === 0) { endTurn(); return; }

    let bestAction = null;
    let bestScore = -999999;

    aiUnits.forEach(u => {
        const moves = getValidMoves(u);
        const map = u.map;

        moves.forEach(m => {
            let score = 0;
            const resolved = resolveMoveDestination(u, m.row, m.col);
            const victim = resolved.destOccupant || resolved.localOccupant;

            if (victim) {
                if (victim.type === 'core') score += 1000000;
                else if (victim.type === 'koh') score += 600;
                else if (victim.type === 'otsu') score += 400;
                else if (victim.type === 'hei') score += 200;
                else if (victim.type === 'tei') score += 150;
                else if (victim.type === 'scout') score += 100;
            }

            // Map position heuristics
            if (resolved.targetMap === 'area3') {
                score += 10;
            } else if (resolved.targetMap === 'area2') {
                score += 200;
                if (m.row === 10) score += 80;
            } else if (resolved.targetMap === 'area1') {
                score += 800;
                const dist = Math.abs(resolved.targetRow - 8) + Math.abs(resolved.targetCol - 4);
                score += (9 - dist) * 35;
            }

            // Teleport bonus significantly reduced (was 220/90 → now 40/20)
            if (resolved.portalDest) {
                score += resolved.targetMap === 'area1' ? 40 : 20;
            }

            // Keep presence in Area2
            const p2InArea2 = units.some(unit => unit.player === 2 && unit.map === 'area2');
            if (!p2InArea2 && resolved.targetMap === 'area2') score += 1200;

            if (score > bestScore) {
                bestScore = score;
                bestAction = { type: 'move', unit: u, row: m.row, col: m.col };
            }
        });

        // Scout warps
        if (u.type === 'scout' && map === 'area2') {
            const warps = getScoutWarpTargets(u);
            warps.forEach(w => {
                const score = 50 + w.row * 15;
                if (score > bestScore) {
                    bestScore = score;
                    bestAction = { type: 'warp', unit: u, row: w.row, col: w.col };
                }
            });
        } else if (u.type === 'koh') {
            const aiAbility = p2Ability;
            if (aiAbility === '爆破') {
                let adjacentEnemiesValue = 0;
                const size = MAP_SIZES[map];
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        if (dr === 0 && dc === 0) continue;
                        const r = u.row + dr, c = u.col + dc;
                        if (r >= 0 && r < size.rows && c >= 0 && c < size.cols) {
                            const enemy = boards[map][r][c].unit;
                            if (enemy && enemy.player === 1) {
                                if (enemy.type === 'core') adjacentEnemiesValue += 10000;
                                else adjacentEnemiesValue += 300;
                            }
                            if (boards[map][r][c].isWall) adjacentEnemiesValue += 120;
                        }
                    }
                }
                if (adjacentEnemiesValue >= 400 && adjacentEnemiesValue > bestScore) {
                    bestScore = adjacentEnemiesValue;
                    bestAction = { type: 'ability', unit: u, action: '爆破' };
                }
            } else if (aiAbility === '鼓舞') {
                let adjacentAllies = 0;
                const size = MAP_SIZES[map];
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        if (dr === 0 && dc === 0) continue;
                        const r = u.row + dr, c = u.col + dc;
                        if (r >= 0 && r < size.rows && c >= 0 && c < size.cols) {
                            const ally = boards[map][r][c].unit;
                            if (ally && ally.player === 2) adjacentAllies++;
                        }
                    }
                }
                if (adjacentAllies >= 2) {
                    const score = adjacentAllies * 80;
                    if (score > bestScore) {
                        bestScore = score;
                        bestAction = { type: 'ability', unit: u, action: '鼓舞' };
                    }
                }
            } else if (aiAbility === '迷彩') {
                const enemyNearby = units.some(enemy =>
                    enemy.player === 1 &&
                    enemy.map === map &&
                    Math.abs(enemy.row - u.row) + Math.abs(enemy.col - u.col) <= 4
                );
                if (!u.camouflaged && enemyNearby && 140 > bestScore) {
                    bestScore = 140;
                    bestAction = { type: 'ability', unit: u, action: '迷彩' };
                }
            } else if (aiAbility === '千里眼') {
                const score = 90;
                if (score > bestScore) {
                    bestScore = score;
                    bestAction = { type: 'ability', unit: u, action: '千里眼', dir: map === 'area2' ? 'down' : 'up' };
                }
            }
        }
    });

    if (bestAction) {
        setTimeout(() => {
            if (bestAction.type === 'move') {
                executeMove(bestAction.unit, bestAction.row, bestAction.col);
            } else if (bestAction.type === 'warp') {
                executeAbility(bestAction.unit, bestAction.row, bestAction.col);
            } else if (bestAction.type === 'ability') {
                if (bestAction.action === '爆破' || bestAction.action === '鼓舞' || bestAction.action === '迷彩') {
                    executeAbility(bestAction.unit, null, null);
                } else if (bestAction.action === '千里眼') {
                    selectedUnit = bestAction.unit;
                    executeClairvoyance(bestAction.dir);
                }
            }
        }, 300);
    } else {
        addConsoleLog("AI BOT: 実行可能アクションなし。フェーズスキップ。", 'p2');
        endTurn();
    }
}

// --- DEBUG ---
window.Sector8Engine = {
    getBoards: () => boards,
    getUnits: () => units,
    getState: () => ({ currentPlayer, gameTurn, p1Ability, p2Ability, activeMap, isGameOver }),
    getPortalDestination,
    getValidMoves,
    runSetupCheck: () => {
        const summary = Object.fromEntries(Object.keys(MAP_SIZES).map(map => [map, {
            rows: boards[map]?.length || 0,
            cols: boards[map]?.[0]?.length || 0,
            units: units.filter(u => u.map === map).length,
            teleports: boards[map]?.flat().filter(cell => cell.isTeleport).length || 0,
            walls: boards[map]?.flat().filter(cell => cell.isWall).length || 0
        }]));
        console.table(summary);
        return summary;
    }
};
