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
let gameSeed = 1;

let selectedUnit = null;
let selectedAction = 'move';
let activePhase = 'setup';
let activeMap = 'area1';

let p1Vision = { area1: new Set(), area2: new Set(), area3: new Set() };
let p2Vision = { area1: new Set(), area2: new Set(), area3: new Set() };
let p1LastVision = { area1: new Set(), area2: new Set(), area3: new Set() };
let p2LastVision = { area1: new Set(), area2: new Set(), area3: new Set() };

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
// Matchmaking state
let matchmakingMode = false;
let matchmakingRole = null; // 'host' or 'guest'
let matchRoomId = null;
let onlineAbilityChoices = { 1: null, 2: null };

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

function getViewerPlayer() {
    return onlineMode && localPlayer ? localPlayer : currentPlayer;
}

function canControlCurrentTurn() {
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
                this.baseMove = 0;
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
            const ability = this.player === 1 ? p1Ability : p2Ability;
            return `【甲特有: ${ability}】`;
        }
        if (this.type === 'otsu') {
            return `【乙特有: 切り崩し】敵本拠地で敵撃破時、周囲1マスの全コマを追加破壊。`;
        }
        if (this.type === 'scout') {
            return `【偵察兵特有: ワープ】攻撃不可。エリア2固定。視界内の空きマスへ瞬時ワープ。`;
        }
        return '固有アビリティなし';
    }

    getMovementRange() {
        let r = this.baseMove;
        if (this.type === 'koh') {
            const ability = this.player === 1 ? p1Ability : p2Ability;
            if (ability === '歴戦王') r += 1;
            if (ability === '暗殺者') { return 5; }
        }
        if (this.inspirationTurns > 0) r += 1;
        return r;
    }

    getVisionRange() {
        let v = this.baseVision;
        if (this.type === 'koh') {
            const ability = this.player === 1 ? p1Ability : p2Ability;
            if (ability === '歴戦王') v += 1;
            if (ability === '暗殺者') v = 5; // 直線視界5 (special: handled separately)
        }
        if (this.type === 'hei' || this.type === 'tei') {
            const hasWarPrincess = this.player === 1 ?
                (p1Ability === '戦姫' && p2KohDestroyed) :
                (p2Ability === '戦姫' && p1KohDestroyed);
            if (hasWarPrincess) v += 1;
        }
        if (this.inspirationTurns > 0) v += 1;
        return v;
    }

    getEffectiveMoveType() {
        return this.moveType;
    }
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    applyDeviceProfile();
    setupUIEventListeners();
    setupMapTabs();
    setupGameModeTabs();
    setupOnlineMode();
    updateModeVisibility();
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
        '暗殺者': 'ability-assassin'
    };
    return classMap[ability] || 'ability-unknown';
}

function setupUIEventListeners() {
    document.getElementById('btn-start-game').addEventListener('click', () => startGame());
    document.getElementById('btn-opt-ai').addEventListener('click', () => setOpponent(true));
    document.getElementById('btn-opt-human').addEventListener('click', () => setOpponent(false));
    document.getElementById('btn-move').addEventListener('click', () => selectActionType('move'));
    document.getElementById('btn-ability').addEventListener('click', () => selectActionType('ability'));
    document.getElementById('btn-cancel').addEventListener('click', cancelSelection);
    document.getElementById('btn-forfeit').addEventListener('click', forfeitGame);
    document.getElementById('btn-restart').addEventListener('click', resetToSetup);
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
            onlineAbilityChoices[localPlayer] = getOnlineAbilityChoice();
            sendOnlineMessage({ kind: 'ability_choice', ability: onlineAbilityChoices[localPlayer] });
            updateOnlineStartAvailability();
        });
    }

    const copyRoomBtn = document.getElementById('btn-copy-room');
    if (copyRoomBtn) copyRoomBtn.addEventListener('click', copyRoomCode);
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
}

function switchActiveMap(mapName) {
    activeMap = mapName;
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
    gameMode = mode;
    if (mode === 'online') {
        vsAI = false;
    } else if (mode === 'ai' || mode === 'debug') {
        vsAI = true;
    } else {
        vsAI = false;
    }
    updateModeVisibility();
}

window.setGameMode = setGameMode;

function updateModeVisibility() {
    const feedPanel = document.getElementById('combat-feed-panel');
    if (feedPanel) feedPanel.classList.toggle('hidden', gameMode !== 'debug');
}

function showMatchmakingPanel() {
    setGameMode('online');
    document.getElementById('matchmaking-panel').classList.remove('hidden');
    document.getElementById('setup-local-panel').classList.add('hidden');
    // highlight online tab
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    const tabOnline = document.getElementById('tab-mode-online');
    if (tabOnline) tabOnline.classList.add('active');
}

function showLocalPanel() {
    document.getElementById('matchmaking-panel').classList.add('hidden');
    document.getElementById('setup-local-panel').classList.remove('hidden');
}

// Simple room-based matchmaking via WebSocket
function hostRoom() {
    const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
    document.getElementById('room-id-display').textContent = roomId;
    document.getElementById('matchmaking-status').textContent = '対戦相手の接続を待っています...';
    document.getElementById('room-share-area').classList.remove('hidden');
    matchRoomId = roomId;
    matchmakingRole = 'host';
    localPlayer = 1;
    onlineAbilityChoices = { 1: getOnlineAbilityChoice(), 2: null };
    onlineMode = true;
    setGameMode('online');
    connectOnlineSocket(roomId, 1);
}

function joinRoom() {
    const input = document.getElementById('room-id-input');
    const roomId = input ? input.value.trim().toUpperCase() : '';
    if (!roomId) {
        addConsoleLog('ONLINE: ルームIDを入力してください。', 'system');
        return;
    }
    matchRoomId = roomId;
    matchmakingRole = 'guest';
    localPlayer = 2;
    onlineAbilityChoices = { 1: null, 2: getOnlineAbilityChoice() };
    onlineMode = true;
    setGameMode('online');
    document.getElementById('matchmaking-status').textContent = `ルーム ${roomId} に接続中...`;
    connectOnlineSocket(roomId, 2);
}

function cancelMatchmaking() {
    if (onlineSocket) onlineSocket.close();
    onlineMode = false;
    localPlayer = null;
    matchmakingMode = false;
    matchRoomId = null;
    onlineAbilityChoices = { 1: null, 2: null };
    showLocalPanel();
    document.getElementById('matchmaking-status').textContent = '';
    document.getElementById('room-share-area').classList.add('hidden');
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-mode-debug').classList.add('active');
    setGameMode('debug');
}

function setupOnlineMode() {
    if (!onlineMode) return;
    setGameMode('online');
    vsAI = false;
    setOpponent(false);
    document.getElementById('current-player-name').textContent = `PLAYER ${localPlayer || '?'} CONNECTING`;
    if (localPlayer === 2) {
        document.getElementById('btn-start-game').disabled = true;
        document.getElementById('btn-start-game').textContent = 'WAITING FOR PLAYER 1';
    } else {
        document.getElementById('btn-start-game').textContent = 'START ONLINE MATCH';
    }
    connectOnlineSocket(null, localPlayer);
}

function getOnlineAbilityChoice() {
    return document.getElementById('online-ability-choice')?.value || '足跡';
}

async function copyRoomCode() {
    const roomText = document.getElementById('room-id-display')?.textContent?.trim();
    if (!roomText || roomText === '------') return;
    try {
        await navigator.clipboard.writeText(roomText);
        document.getElementById('matchmaking-status').textContent = 'ルームIDをコピーしました。';
    } catch {
        document.getElementById('matchmaking-status').textContent = `ルームID: ${roomText}`;
    }
}

function connectOnlineSocket(roomId, player) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const roomParam = roomId ? `&room=${encodeURIComponent(roomId)}` : '';
    onlineSocket = new WebSocket(`${protocol}//${window.location.host}/ws?player=${player}${roomParam}`);

    onlineSocket.addEventListener('open', () => {
        addConsoleLog(`ONLINE: Player ${player} として接続しました。`, 'system');
        onlineAbilityChoices[player] = getOnlineAbilityChoice();
        sendOnlineMessage({ kind: 'ability_choice', ability: onlineAbilityChoices[player] });
    });

    onlineSocket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        handleOnlineMessage(message);
    });

    onlineSocket.addEventListener('close', () => {
        addConsoleLog('ONLINE: サーバー接続が切断されました。', 'system');
    });

    onlineSocket.addEventListener('error', () => {
        addConsoleLog('ONLINE: 接続エラー。サーバーが起動しているか確認してください。', 'system');
    });
}

function handleOnlineMessage(message) {
    if (message.kind === 'hello') {
        localPlayer = message.player;
        addConsoleLog(`ONLINE: あなたは Player ${localPlayer} です。`, 'system');
        updateUI();
        return;
    }

    if (message.kind === 'player_joined') {
        addConsoleLog(`ONLINE: 対戦相手が接続しました！`, 'system');
        document.getElementById('matchmaking-status').textContent = '対戦相手が接続しました。相手の甲アビリティ選択を確認中...';
        onlineAbilityChoices[localPlayer] = getOnlineAbilityChoice();
        sendOnlineMessage({ kind: 'ability_choice', ability: onlineAbilityChoices[localPlayer] });
        updateOnlineStartAvailability();
        return;
    }

    if (message.player === localPlayer) return;

    if (message.kind === 'ability_choice') {
        onlineAbilityChoices[message.player] = message.ability;
        document.getElementById('matchmaking-status').textContent =
            `相手の甲アビリティ: ${message.ability}`;
        sendOnlineMessage({ kind: 'ability_ack', ability: getOnlineAbilityChoice() });
        updateOnlineStartAvailability();
        return;
    }

    if (message.kind === 'ability_ack') {
        onlineAbilityChoices[message.player] = message.ability;
        updateOnlineStartAvailability();
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
        }
    } finally {
        applyingRemoteAction = false;
    }
}

function sendOnlineMessage(message) {
    if (!onlineMode || applyingRemoteAction || !onlineSocket || onlineSocket.readyState !== WebSocket.OPEN) return;
    onlineSocket.send(JSON.stringify({ ...message, player: localPlayer }));
}

function updateOnlineStartAvailability() {
    const btnStart = document.getElementById('btn-start-online-match');
    if (!btnStart) return;
    const ready = Boolean(onlineAbilityChoices[1] && onlineAbilityChoices[2]);
    btnStart.disabled = !(localPlayer === 1 && ready);
    if (localPlayer === 1) {
        btnStart.textContent = ready ? 'ONLINE MATCH START' : 'WAITING FOR ABILITY';
    }
}

function applyRemoteAction(action) {
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

    if (onlineMode) {
        onlineAbilityChoices[localPlayer || 1] = getOnlineAbilityChoice();
        p1Ability = config ? config.p1Ability : (onlineAbilityChoices[1] || '足跡');
        p2Ability = config ? config.p2Ability : (onlineAbilityChoices[2] || '歴戦王');
    } else {
        p1Ability = config ? config.p1Ability : document.getElementById('p1-ability-choice').value;
        p2Ability = config ? config.p2Ability : document.getElementById('p2-ability-choice').value;
    }
    gameSeed = config?.seed || Math.floor(Math.random() * 0xFFFFFFFF);
    vsAI = onlineMode ? false : vsAI;

    activePhase = 'battle';
    isGameOver = false;
    currentPlayer = 1;
    gameTurn = 1;
    selectedUnit = null;
    activeMap = 'area1';
    scoutReinforcementSerial = 0;

    p1KohDestroyed = false;
    p2KohDestroyed = false;
    p1ClairvoyanceDir = null;
    p2ClairvoyanceDir = null;
    p1ClairvoyanceAge = 0;
    p2ClairvoyanceAge = 0;

    p1LastVision = { area1: new Set(), area2: new Set(), area3: new Set() };
    p2LastVision = { area1: new Set(), area2: new Set(), area3: new Set() };

    // Hide setup panels, show game
    document.getElementById('setup-panel').classList.add('hidden');
    document.getElementById('game-info-panel').classList.remove('hidden');

    initializeBoards();
    initializeUnits();
    generateRandomWalls(gameSeed);
    calculateVisibility();
    switchActiveMap(getViewerPlayer() === 2 ? 'area3' : 'area1');
    renderBoard();
    updateUI();

    addConsoleLog("GAME INITIATED. PLAYER 1 (BLUE) TURN.", 'system');
    showTurnBanner();

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

                rowCells.push({ row: r, col: c, isWall: false, isTeleport, isCoreTile, unit: null });
            }
            mapBoard.push(rowCells);
        }
        boards[mapName] = mapBoard;
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
            candidates.push({ row: r, col: c });
        }
    }
    return candidates;
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
    Object.keys(MAP_SIZES).forEach((mapName, mapIndex) => {
        const rng = createRng(seed + (mapIndex + 1) * 9973);
        let placed = 0;
        let attempts = 0;
        while (placed < WALLS_PER_MAP && attempts < 800) {
            attempts++;
            const candidates = shuffleWithRng(getWallCandidates(mapName), rng);
            const candidate = candidates[0];
            if (!candidate) break;
            const cell = boards[mapName][candidate.row][candidate.col];
            cell.isWall = true;
            if (isMapConnected(mapName)) {
                placed++;
            } else {
                cell.isWall = false;
            }
        }
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

function captureUnit(victim, attackerPlayer) {
    removeUnitEverywhere(victim);

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
        const ability = unit.type === 'koh' ? (unit.player === 1 ? p1Ability : p2Ability) : null;

        // 暗殺者: 直線視界5 (4方向ビーム)
        if (unit.type === 'koh' && ability === '暗殺者') {
            const map = unit.map;
            const size = MAP_SIZES[map];
            const targetSet = unit.player === 1 ? p1Vision[map] : p2Vision[map];
            targetSet.add(`${unit.row},${unit.col}`);
            [[-1,0],[1,0],[0,-1],[0,1]].forEach(([dr,dc]) => {
                for (let s = 1; s <= 5; s++) {
                    const nr = unit.row + dr * s;
                    const nc = unit.col + dc * s;
                    if (nr < 0 || nr >= size.rows || nc < 0 || nc >= size.cols) break;
                    targetSet.add(`${nr},${nc}`);
                }
            });
            return;
        }

        const vRange = unit.getVisionRange();
        const mapSize = MAP_SIZES[unit.map];
        const startR = Math.max(0, unit.row - vRange);
        const endR = Math.min(mapSize.rows - 1, unit.row + vRange);
        const startC = Math.max(0, unit.col - vRange);
        const endC = Math.min(mapSize.cols - 1, unit.col + vRange);

        for (let r = startR; r <= endR; r++) {
            for (let c = startC; c <= endC; c++) {
                const manhattanDist = Math.abs(r - unit.row) + Math.abs(c - unit.col);
                if (manhattanDist <= vRange) {
                    if (unit.player === 1) p1Vision[unit.map].add(`${r},${c}`);
                    else p2Vision[unit.map].add(`${r},${c}`);
                }
            }
        }
    });

    if (p1ClairvoyanceDir) applyClairvoyanceSight(p1ClairvoyanceDir, p1Vision[p1ClairvoyanceDir.map]);
    if (p2ClairvoyanceDir) applyClairvoyanceSight(p2ClairvoyanceDir, p2Vision[p2ClairvoyanceDir.map]);

    if (p1Ability === '足跡' && !p1KohDestroyed) {
        Object.keys(p1Vision).forEach(map => {
            p1LastVision[map].forEach(coord => p1Vision[map].add(coord));
        });
    }
    if (p2Ability === '足跡' && !p2KohDestroyed) {
        Object.keys(p2Vision).forEach(map => {
            p2LastVision[map].forEach(coord => p2Vision[map].add(coord));
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
        currR += dr; currC += dc;
    }
}

function saveTurnVision() {
    Object.keys(boards).forEach(map => {
        p1LastVision[map] = new Set(p1Vision[map]);
        p2LastVision[map] = new Set(p2Vision[map]);
    });
}

// --- BOARD RENDERER ---
function renderBoard() {
    const boardEl = document.getElementById('board');
    boardEl.innerHTML = '';
    boardEl.className = `board-map-${activeMap}`;

    const size = MAP_SIZES[activeMap];
    boardEl.style.gridTemplateColumns = `repeat(${size.cols}, 1fr)`;
    boardEl.style.gridTemplateRows = `repeat(${size.rows}, 1fr)`;
    document.getElementById('game-board-wrapper').style.aspectRatio = `${size.cols} / ${size.rows}`;

    const viewerPlayer = getViewerPlayer();
    const activeVision = viewerPlayer === 1 ? p1Vision[activeMap] : p2Vision[activeMap];

    for (let r = 0; r < size.rows; r++) {
        for (let c = 0; c < size.cols; c++) {
            const cellData = boards[activeMap][r][c];
            const coordStr = `${r},${c}`;

            const cellEl = document.createElement('div');
            cellEl.className = 'cell';
            cellEl.setAttribute('data-row', r);
            cellEl.setAttribute('data-col', c);
            cellEl.setAttribute('data-coord', `[${c},${r}]`);

            if (cellData.isTeleport) cellEl.classList.add('teleport');
            if (cellData.isWall) cellEl.classList.add('wall');
            if (cellData.isCoreTile) cellEl.classList.add('core-tile');

            if (!activeVision.has(coordStr)) cellEl.classList.add('fog-grey');

            if (cellData.unit) {
                const u = cellData.unit;
                const isEnemy = u.player !== viewerPlayer;
                const isHiddenByFog = isEnemy && !activeVision.has(coordStr);

                if (!isHiddenByFog) {
                    const unitEl = document.createElement('div');
                    unitEl.className = `unit player-${u.player} ${u.type}`;
                    if (u.type === 'koh') {
                        unitEl.classList.add('koh-ability', getAbilityClass(u.player));
                        unitEl.setAttribute('data-ability', u.player === 1 ? p1Ability : p2Ability);
                    }
                    unitEl.setAttribute('data-rank', u.symbol);
                    unitEl.title = `${u.name} (P${u.player})\n移動: ${u.getEffectiveMoveType() === 'straight' ? '直線' : 'マンハッタン'}${u.getMovementRange()}\n視界: ${u.getVisionRange()}\n${u.abilityDescription}`;
                    if (u.type === 'core') unitEl.classList.add('core');
                    cellEl.appendChild(unitEl);
                }
            }

            cellEl.addEventListener('click', () => handleCellClick(r, c));
            boardEl.appendChild(cellEl);
        }
    }

    updateTabIndicators();
    renderMinimaps();
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
                    else if (activeVision[map].has(`${r},${c}`)) visibleEnemies++;
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
                const unit = boardCell.unit;
                const visible = gameMode === 'debug' || !unit || unit.player === viewerPlayer || vision[mapName].has(`${r},${c}`);
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

// --- MOVEMENT & PATHFINDING ---
function getValidMoves(unit) {
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

                if (isValidPath(unit, pathCells)) {
                    if (isMoveDestinationBlockedByFriendly(unit, targetR, targetC)) break;

                    const resolved = resolveMoveDestination(unit, targetR, targetC);
                    const hasEnemyTarget =
                        (resolved.localOccupant && resolved.localOccupant.player !== unit.player) ||
                        (resolved.portalDest && resolved.destOccupant && resolved.destOccupant.player !== unit.player);

                    valid.push({ row: targetR, col: targetC, type: hasEnemyTarget ? 'attack' : 'move' });

                    if (resolved.localOccupant || resolved.portalDest) break;
                } else {
                    break;
                }
            }
        });
    } else {
        // BFS manhattan movement
        const queue = [{ row: unit.row, col: unit.col, steps: 0 }];
        const visited = new Set();
        visited.add(`${unit.row},${unit.col}`);
        const dirs = [{ r: -1, c: 0 }, { r: 1, c: 0 }, { r: 0, c: -1 }, { r: 0, c: 1 }];

        while (queue.length > 0) {
            const curr = queue.shift();
            if (curr.steps >= moveRange) continue;

            dirs.forEach(dir => {
                    const nextR = curr.row + dir.r, nextC = curr.col + dir.c;
                    const key = `${nextR},${nextC}`;

                    if (nextR < 0 || nextR >= size.rows || nextC < 0 || nextC >= size.cols) return;
                    if (boards[map][nextR][nextC].isWall) return;
                    if (unit.type === 'scout' && map !== 'area2') return;
                    if (isMoveDestinationBlockedByFriendly(unit, nextR, nextC)) return;

                    const resolved = resolveMoveDestination(unit, nextR, nextC);
                    const hasEnemyTarget =
                        (resolved.localOccupant && resolved.localOccupant.player !== unit.player) ||
                        (resolved.portalDest && resolved.destOccupant && resolved.destOccupant.player !== unit.player);

                    if (!visited.has(key)) {
                        visited.add(key);
                        valid.push({ row: nextR, col: nextC, type: hasEnemyTarget ? 'attack' : 'move' });
                        if (!resolved.localOccupant && !resolved.portalDest) {
                            queue.push({ row: nextR, col: nextC, steps: curr.steps + 1 });
                        }
                    }
            });
        }
    }

    return valid;
}

function isValidPath(unit, pathCells) {
    const map = unit.map;
    for (let i = 0; i < pathCells.length; i++) {
        const { r, c } = pathCells[i];
        if (boards[map][r][c].isWall) return false;
        if (i < pathCells.length - 1 && getPortalDestination(map, r, c)) return false;
        if (unit.type === 'scout' && map !== 'area2') return false;
        const occupant = boards[map][r][c].unit;
        if (occupant) {
            if (i < pathCells.length - 1) return false;
            if (occupant.player === unit.player) return false;
        }
    }
    return true;
}

function getScoutWarpTargets(scout) {
    const valid = [];
    const map = scout.map;
    if (map !== 'area2') return valid;

    const size = MAP_SIZES[map];
    const activeVision = scout.player === 1 ? p1Vision[map] : p2Vision[map];

    for (let r = 0; r < size.rows; r++) {
        for (let c = 0; c < size.cols; c++) {
            if (boards[map][r][c].isWall) continue;
            if (boards[map][r][c].unit) continue;
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
    if (!canControlCurrentTurn()) return;
    if (currentPlayer === 2 && vsAI) return;

    const cell = boards[activeMap][row][col];

    if (selectedUnit) {
        const moveTarget = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"].highlight-move`);
        const attackTarget = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"].highlight-attack`);
        const abilityTarget = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"].highlight-ability`);

        if (moveTarget || attackTarget) { executeMove(selectedUnit, row, col); return; }
        if (abilityTarget) { executeAbility(selectedUnit, row, col); return; }
        if (cell.unit && cell.unit.player === currentPlayer) selectUnit(cell.unit);
        else cancelSelection();
    } else {
        if (cell.unit && cell.unit.player === currentPlayer) selectUnit(cell.unit);
    }
}

function selectUnit(unit) {
    if (unit.type === 'core') return;

    if (activeMap !== unit.map) {
        activeMap = unit.map;
        document.querySelectorAll('.map-tab').forEach(tab => {
            tab.classList.toggle('active', tab.getAttribute('data-map') === unit.map);
        });
        renderBoard();
    }

    selectedUnit = unit;
    selectedAction = 'move';

    const actionCtrl = document.getElementById('action-controls');
    actionCtrl.classList.remove('hidden');
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
        else abilityBtn.textContent = `即時発動: ${abilityName}`;
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
        const moves = getValidMoves(selectedUnit);
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
            } else if (abilityName === '鼓舞' || abilityName === '爆破') {
                executeAbility(selectedUnit, null, null);
            }
            // パッシブ系（足跡、歴戦王、戦姫、暗殺者）はアビリティボタンで何もしない
        }
    }
}

function clearHighlights() {
    document.querySelectorAll('.cell').forEach(c => {
        c.classList.remove('highlight-move', 'highlight-attack', 'highlight-ability', 'selected');
    });
}

function cancelSelection() {
    selectedUnit = null;
    clearHighlights();
    document.getElementById('action-controls').classList.add('hidden');
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

    // 暗殺者: 撃破時、進行方向から1マス戻る
    let finalRow = targetRow, finalCol = targetCol, finalMap = targetMap;
    if (unit.type === 'koh' && captured.length > 0) {
        const ability = unit.player === 1 ? p1Ability : p2Ability;
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

            const captureNames = captured.map(v => v.unit.name).join(', ');
            addConsoleLog(`ABILITY: 暗殺者 - ${unit.name}が${captureNames}を撃破し、1マス後退。`, 'ability');
            if (resolved.portalDest && unit.player === currentPlayer) activeMap = finalMap;
            sendOnlineMessage({ kind: 'action', action: { type: 'move', unitId: unit.id, row: destRow, col: destCol } });
            endTurn();
            return;
        }
    }

    // Normal placement
    unit.map = finalMap;
    unit.row = finalRow;
    unit.col = finalCol;
    boards[finalMap][finalRow][finalCol].unit = unit;

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
    if (resolved.portalDest && unit.player === currentPlayer) activeMap = targetMap;
    sendOnlineMessage({ kind: 'action', action: { type: 'move', unitId: unit.id, row: destRow, col: destCol } });
    endTurn();
}

function executeAbility(unit, destRow, destCol) {
    const map = unit.map;

    if (unit.type === 'scout') {
        const startRow = unit.row, startCol = unit.col;
        boards[map][startRow][startCol].unit = null;
        boards[map][destRow][destCol].unit = unit;
        unit.row = destRow; unit.col = destCol;
        addConsoleLog(`Player ${unit.player}: 偵察兵が [${startCol},${startRow}] から [${destCol},${destRow}] へワープ転送。`, 'ability');
        sendOnlineMessage({ kind: 'action', action: { type: 'ability', unitId: unit.id, row: destRow, col: destCol } });
        endTurn();
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
            sendOnlineMessage({ kind: 'action', action: { type: 'ability', unitId: unit.id } });
            endTurn();

        } else if (abilityName === '爆破') {
            addConsoleLog(`ABILITY: 甲の「爆破」自滅シークエンス開始！`, 'destroy');
            boards[map][unit.row][unit.col].unit = null;
            units = units.filter(u => u.id !== unit.id);
            if (unit.player === 1) p1KohDestroyed = true;
            else p2KohDestroyed = true;

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
                                boards[map][r][c].unit = null;
                            }
                            units = units.filter(u => u.id !== victim.id);
                            if (victim.type === 'koh') {
                                if (victim.player === 1) p1KohDestroyed = true;
                                else p2KohDestroyed = true;
                            }
                        }
                    }
                }
            }

            if (destroyedCoords.length > 0)
                addConsoleLog(`SYSTEM: 爆破により消滅: ${destroyedCoords.join(', ')}`, 'destroy');
            sendOnlineMessage({ kind: 'action', action: { type: 'ability', unitId: unit.id } });
            endTurn();

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

    const scanObj = { map: unit.map, row: unit.row, col: unit.col, dir: direction };
    if (currentPlayer === 1) { p1ClairvoyanceDir = scanObj; p1ClairvoyanceAge = 0; }
    else { p2ClairvoyanceDir = scanObj; p2ClairvoyanceAge = 0; }

    const dirKanji = { up: '▲上', down: '▼下', left: '◀左', right: '右▶' }[direction];
    addConsoleLog(`ABILITY: 甲の「千里眼」起動。${unit.map} 内の ${dirKanji} 方向を可視化。`, 'ability');
    sendOnlineMessage({ kind: 'action', action: { type: 'clairvoyance', unitId: unit.id, dir: direction } });
    endTurn();
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
                if (victim.type === 'core') {
                    for (let cr = 0; cr < size.rows; cr++)
                        for (let cc = 0; cc < size.cols; cc++)
                            if (boards[mapName][cr][cc].unit?.id === victim.id)
                                boards[mapName][cr][cc].unit = null;
                    triggerWin(currentPlayer);
                    return;
                } else {
                    boards[mapName][r][c].unit = null;
                }
                units = units.filter(u => u.id !== victim.id);
                if (victim.type === 'koh') {
                    if (victim.player === 1) p1KohDestroyed = true;
                    else p2KohDestroyed = true;
                }
            }
        }
    }
    if (victims.length > 0)
        addConsoleLog(`SYSTEM: 切り崩し爆風: ${victims.join(', ')}`, 'destroy');
}

// --- TURN TRANSITION ---
function endTurn() {
    cancelSelection();
    if (isGameOver) return;

    units.forEach(u => {
        if (u.player === currentPlayer && u.inspirationTurns > 0) u.inspirationTurns--;
    });

    saveTurnVision();

    if (currentPlayer === 1 && p1ClairvoyanceDir) {
        p1ClairvoyanceAge++;
        if (p1ClairvoyanceAge >= 2) { p1ClairvoyanceDir = null; p1ClairvoyanceAge = 0; }
    } else if (currentPlayer === 2 && p2ClairvoyanceDir) {
        p2ClairvoyanceAge++;
        if (p2ClairvoyanceAge >= 2) { p2ClairvoyanceDir = null; p2ClairvoyanceAge = 0; }
    }

    currentPlayer = currentPlayer === 1 ? 2 : 1;
    if (currentPlayer === 1) {
        gameTurn++;
        if (gameTurn % SCOUT_REINFORCE_INTERVAL === 0) reinforceScouts();
    }

    calculateVisibility();
    renderBoard();
    updateUI();

    const playerName = currentPlayer === 1 ? "PLAYER 1" : "PLAYER 2";
    const logColor = currentPlayer === 1 ? 'p1' : 'p2';
    addConsoleLog(`TURN ${gameTurn} - ${playerName} の戦術行動フェーズ。`, logColor);
    showTurnBanner();

    if (currentPlayer === 2 && vsAI) {
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
    banner.className = `turn-banner player-${currentPlayer} show`;
    banner.textContent = `TURN ${gameTurn} / PLAYER ${currentPlayer}${onlineMode ? (isMine ? ' - YOUR TURN' : ' - OPPONENT') : ''}`;
    window.clearTimeout(showTurnBanner.timer);
    showTurnBanner.timer = window.setTimeout(() => banner.classList.remove('show'), 1500);
}

function reinforceScouts() {
    [1, 2].forEach(player => {
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

// --- WIN / LOSE ---
function triggerWin(winnerId) {
    isGameOver = true;
    const titleEl = document.getElementById('game-over-title');
    const subtitleEl = document.getElementById('game-over-subtitle');

    if (winnerId === 1) {
        titleEl.textContent = 'VICTORY';
        titleEl.className = 'glitch-text text-cyan';
        subtitleEl.textContent = 'PLAYER 1 (BLUE) が敵のコア領域を完全破壊し、勝利を収めました。';
        addConsoleLog("SYSTEM OVERRIDE: PLAYER 1 VICTORY. ENEMY CORE PURGED.", 'system');
    } else {
        titleEl.textContent = 'DEFEAT';
        titleEl.className = 'glitch-text text-magenta';
        subtitleEl.textContent = vsAI ?
            '対戦AI (RED) によって自軍コアが消滅しました。再接続を推奨します。' :
            'PLAYER 2 (MAGENTA) が敵のコア領域を完全破壊し、勝利を収めました。';
        addConsoleLog("SYSTEM OVERRIDE: PLAYER 2 VICTORY. HOME CORE PURGED.", 'system');
    }

    document.getElementById('game-over-overlay').classList.remove('hidden');
}

function forfeitGame() {
    if (confirm("本当に降伏（Reboot）しますか？現在の作戦データは破棄されます。")) {
        triggerWin(currentPlayer === 1 ? 2 : 1);
    }
}

function resetToSetup(fromOnline = false) {
    document.getElementById('game-over-overlay').classList.add('hidden');
    document.getElementById('game-info-panel').classList.add('hidden');
    document.getElementById('setup-panel').classList.remove('hidden');

    boards = { area1: [], area2: [], area3: [] };
    units = [];
    clearHighlights();
    document.getElementById('board').innerHTML = '';
    addConsoleLog("SYSTEM REBOOTED. STANDBY FOR CONFIGURATION...", 'system');

    if (onlineMode && !fromOnline) sendOnlineMessage({ kind: 'reset' });
}

// --- UI UPDATE ---
function updateUI() {
    document.getElementById('turn-count').textContent = gameTurn;

    const playerNameEl = document.getElementById('current-player-name');
    const playerDotEl = document.querySelector('.indicator-dot');

    if (currentPlayer === 1) {
        playerNameEl.textContent = onlineMode
            ? `PLAYER 1 (BLUE)${localPlayer === 1 ? ' - YOUR TURN' : ' - OPPONENT TURN'}`
            : 'PLAYER 1 (BLUE)';
        playerNameEl.className = 'text-cyan';
        playerDotEl.style.backgroundColor = 'var(--neon-cyan)';
        playerDotEl.style.boxShadow = '0 0 10px var(--neon-cyan)';
    } else {
        playerNameEl.textContent = onlineMode
            ? `PLAYER 2 (RED)${localPlayer === 2 ? ' - YOUR TURN' : ' - OPPONENT TURN'}`
            : (vsAI ? 'AI BOT (RED)' : 'PLAYER 2 (RED)');
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

    const aiUnits = units.filter(u => u.player === 2 && u.type !== 'core');
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
        if (bestAction.unit.map !== activeMap) switchActiveMap(bestAction.unit.map);
        setTimeout(() => {
            if (bestAction.type === 'move') {
                executeMove(bestAction.unit, bestAction.row, bestAction.col);
            } else if (bestAction.type === 'warp') {
                executeAbility(bestAction.unit, bestAction.row, bestAction.col);
            } else if (bestAction.type === 'ability') {
                if (bestAction.action === '爆破' || bestAction.action === '鼓舞') {
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
