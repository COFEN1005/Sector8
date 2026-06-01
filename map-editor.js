const MAP_ORDER = ['area1', 'area2', 'area3'];
const MAP_LABELS = {
    area1: 'AREA 1',
    area2: 'AREA 2',
    area3: 'AREA 3'
};
const MAP_SIZES = {
    area1: { rows: 11, cols: 11 },
    area2: { rows: 11, cols: 11 },
    area3: { rows: 11, cols: 11 }
};
const PORTAL_COLS = [0, 1, 9, 10];
const CORE_COLS = [4, 5, 6];
const VALID_TERRAINS = new Set(['wall', 'teleport', 'core']);
const VALID_APPLY_MODES = new Set(['terrain', 'height', 'both']);
const STORAGE_KEY = 'sector8-map-editor-v3';
const MAX_HEIGHT = 3;
const EXPORT_VERSION = 2;

const dom = {
    board: document.getElementById('board'),
    activeMapLabel: document.getElementById('active-map-label'),
    statusLine: document.getElementById('status-line'),
    exportJson: document.getElementById('export-json'),
    exportJs: document.getElementById('export-js'),
    importText: document.getElementById('import-text'),
    statWall: document.getElementById('stat-wall'),
    statTeleport: document.getElementById('stat-teleport'),
    statCore: document.getElementById('stat-core'),
    statHigh: document.getElementById('stat-high'),
    statPeak: document.getElementById('stat-peak'),
    statChanged: document.getElementById('stat-changed'),
    statWarnings: document.getElementById('stat-warnings'),
    btnNewPreset: document.getElementById('btn-new-preset'),
    btnUndo: document.getElementById('btn-undo'),
    btnRedo: document.getElementById('btn-redo'),
    btnExportJson: document.getElementById('btn-export-json'),
    btnExportJs: document.getElementById('btn-export-js'),
    btnImport: document.getElementById('btn-import'),
    btnCopyJson: document.getElementById('btn-copy-json'),
    btnCopyJs: document.getElementById('btn-copy-js'),
    btnDownload: document.getElementById('btn-download')
};

let state = loadState();
let history = [];
let future = [];
let strokeActive = false;
let strokeSnapshotTaken = false;
let statusTimer = null;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function makeGrid() {
    const { rows, cols } = MAP_SIZES.area1;
    return Array.from({ length: rows }, () => (
        Array.from({ length: cols }, () => ({ terrain: null, height: 0 }))
    ));
}

function seedAnchors(mapName, grid) {
    if (mapName === 'area1' || mapName === 'area2') {
        const topRow = 0;
        PORTAL_COLS.forEach(col => {
            grid[topRow][col].terrain = 'teleport';
        });
    }

    if (mapName === 'area2' || mapName === 'area3') {
        const bottomRow = 10;
        PORTAL_COLS.forEach(col => {
            grid[bottomRow][col].terrain = 'teleport';
        });
    }

    if (mapName === 'area1') {
        const row = 10;
        CORE_COLS.forEach(col => {
            grid[row][col].terrain = 'core';
        });
    }

    if (mapName === 'area3') {
        const row = 0;
        CORE_COLS.forEach(col => {
            grid[row][col].terrain = 'core';
        });
    }
}

function createState(seedAnchorsEnabled = true) {
    const maps = {};
    MAP_ORDER.forEach(mapName => {
        const grid = makeGrid();
        if (seedAnchorsEnabled) {
            seedAnchors(mapName, grid);
        }
        maps[mapName] = grid;
    });

    return {
        version: 3,
        activeMap: 'area1',
        activeTool: 'wall',
        activeHeight: 0,
        applyMode: 'both',
        maps
    };
}

function normalizeTerrain(value) {
    return VALID_TERRAINS.has(value) ? value : null;
}

function normalizeHeight(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return clamp(Math.trunc(n), 0, MAX_HEIGHT);
}

function normalizeCell(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return {
            terrain: normalizeTerrain(raw.terrain),
            height: normalizeHeight(raw.height ?? raw.h ?? 0)
        };
    }

    if (typeof raw === 'string') {
        if (VALID_TERRAINS.has(raw)) {
            return { terrain: raw, height: 0 };
        }

        const maybeHeight = Number(raw);
        if (Number.isFinite(maybeHeight)) {
            return { terrain: null, height: clamp(Math.trunc(maybeHeight), 0, MAX_HEIGHT) };
        }
    }

    return { terrain: null, height: 0 };
}

function normalizeGrid(source) {
    const grid = makeGrid();

    if (Array.isArray(source)) {
        for (let row = 0; row < grid.length; row += 1) {
            const sourceRow = source[row] || [];
            for (let col = 0; col < grid[row].length; col += 1) {
                grid[row][col] = normalizeCell(sourceRow[col]);
            }
        }
        return grid;
    }

    if (source && typeof source === 'object' && Array.isArray(source.cells)) {
        return normalizeGrid(source.cells);
    }

    return grid;
}

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return createState(true);
        const parsed = JSON.parse(raw);
        return normalizeState(parsed);
    } catch {
        return createState(true);
    }
}

function normalizeState(raw) {
    const next = createState(false);
    if (!raw || typeof raw !== 'object') {
        return next;
    }

    if (MAP_ORDER.includes(raw.activeMap)) {
        next.activeMap = raw.activeMap;
    }

    if (typeof raw.activeTool === 'string' && (VALID_TERRAINS.has(raw.activeTool) || raw.activeTool === 'erase')) {
        next.activeTool = raw.activeTool;
    }

    if (Number.isFinite(Number(raw.activeHeight))) {
        next.activeHeight = clamp(Math.trunc(Number(raw.activeHeight)), 0, MAX_HEIGHT);
    }

    if (VALID_APPLY_MODES.has(raw.applyMode)) {
        next.applyMode = raw.applyMode;
    }

    MAP_ORDER.forEach(mapName => {
        const mapSource = getMapSource(raw, mapName);
        if (mapSource) {
            next.maps[mapName] = normalizeGrid(mapSource);
        }
    });

    return next;
}

function getMapSource(raw, mapName) {
    if (!raw || typeof raw !== 'object') return null;

    const direct = raw[mapName];
    if (Array.isArray(direct) || (direct && typeof direct === 'object' && Array.isArray(direct.cells))) {
        return direct;
    }

    if (raw.maps && typeof raw.maps === 'object') {
        const nested = raw.maps[mapName];
        if (Array.isArray(nested) || (nested && typeof nested === 'object' && Array.isArray(nested.cells))) {
            return nested;
        }
    }

    return null;
}

function saveState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // ignore storage quota issues
    }
}

function getCell(mapName, row, col) {
    return state.maps[mapName]?.[row]?.[col] || null;
}

function isTeleportSlot(mapName, row, col) {
    if (!PORTAL_COLS.includes(col)) return false;
    if (mapName === 'area1') return row === 0;
    if (mapName === 'area2') return row === 0 || row === 10;
    return row === 10;
}

function isCoreSlot(mapName, row, col) {
    if (!CORE_COLS.includes(col)) return false;
    if (mapName === 'area1') return row === 10;
    if (mapName === 'area3') return row === 0;
    return false;
}

function getTerrainGlyph(terrain) {
    if (terrain === 'wall') return 'W';
    if (terrain === 'teleport') return 'T';
    if (terrain === 'core') return 'C';
    return '';
}

function getTerrainLabel(terrain) {
    if (terrain === 'wall') return 'WALL';
    if (terrain === 'teleport') return 'TELEPORT';
    if (terrain === 'core') return 'CORE';
    return 'EMPTY';
}

function getMapStats(mapName) {
    const map = state.maps[mapName];
    const stats = {
        wall: 0,
        teleport: 0,
        core: 0,
        high: 0,
        peak: 0,
        changed: 0,
        warnings: 0
    };

    for (let row = 0; row < map.length; row += 1) {
        for (let col = 0; col < map[row].length; col += 1) {
            const cell = map[row][col];
            if (cell.terrain === 'wall') stats.wall += 1;
            if (cell.terrain === 'teleport') stats.teleport += 1;
            if (cell.terrain === 'core') stats.core += 1;
            if (cell.height > 0) stats.high += 1;
            if (cell.height === MAX_HEIGHT) stats.peak += 1;
            if (cell.height > 0 || cell.terrain) stats.changed += 1;
            if (
                (cell.terrain === 'teleport' && !isTeleportSlot(mapName, row, col)) ||
                (cell.terrain === 'core' && !isCoreSlot(mapName, row, col))
            ) {
                stats.warnings += 1;
            }
        }
    }

    return stats;
}

function captureHistory() {
    history.push(deepClone(state.maps));
    if (history.length > 64) {
        history.shift();
    }
    future = [];
}

function restoreMaps(snapshot) {
    state.maps = deepClone(snapshot);
    persistAndRender();
}

function undo() {
    if (!history.length) {
        announce('これ以上戻せません');
        return;
    }
    future.push(deepClone(state.maps));
    restoreMaps(history.pop());
}

function redo() {
    if (!future.length) {
        announce('やり直せる操作がありません');
        return;
    }
    history.push(deepClone(state.maps));
    restoreMaps(future.pop());
}

function setActiveMap(mapName) {
    if (!MAP_ORDER.includes(mapName)) return;
    state.activeMap = mapName;
    saveState();
    renderAll();
}

function setActiveTool(tool) {
    if (!VALID_TERRAINS.has(tool) && tool !== 'erase') return;
    state.activeTool = tool;
    saveState();
    renderToolbar();
    renderStatus();
}

function setActiveHeight(height) {
    state.activeHeight = clamp(Number(height) || 0, 0, MAX_HEIGHT);
    saveState();
    renderToolbar();
    renderStatus();
}

function setApplyMode(mode) {
    if (!VALID_APPLY_MODES.has(mode)) return;
    state.applyMode = mode;
    saveState();
    renderToolbar();
    renderStatus();
}

function createBlankPreset() {
    history.push(deepClone(state.maps));
    if (history.length > 64) {
        history.shift();
    }
    future = [];
    state = createState(true);
    saveState();
    renderAll();
    announce('新しい固定マップを作成しました');
}

function paintCell(row, col) {
    const cell = getCell(state.activeMap, row, col);
    if (!cell) return false;

    const nextTerrain = state.applyMode !== 'height'
        ? (state.activeTool === 'erase' ? null : state.activeTool)
        : cell.terrain;
    const nextHeight = state.applyMode !== 'terrain'
        ? clamp(state.activeHeight, 0, MAX_HEIGHT)
        : cell.height;

    const changed = cell.terrain !== nextTerrain || cell.height !== nextHeight;
    if (!changed) return false;

    if (!strokeSnapshotTaken) {
        captureHistory();
        strokeSnapshotTaken = true;
    }

    if (state.applyMode !== 'height') {
        cell.terrain = nextTerrain;
    }
    if (state.applyMode !== 'terrain') {
        cell.height = nextHeight;
    }

    saveState();
    renderAll(false);
    return true;
}

function beginStroke() {
    strokeActive = true;
    strokeSnapshotTaken = false;
}

function endStroke() {
    strokeActive = false;
    strokeSnapshotTaken = false;
}

function handleBoardPointerDown(event) {
    const cellEl = event.target.closest('.cell');
    if (!cellEl || event.button !== 0) return;
    event.preventDefault();
    beginStroke();
    paintCell(Number(cellEl.dataset.row), Number(cellEl.dataset.col));
}

function handleBoardPointerMove(event) {
    if (!strokeActive || event.buttons !== 1) return;
    const cellEl = event.target.closest('.cell');
    if (!cellEl) return;
    event.preventDefault();
    paintCell(Number(cellEl.dataset.row), Number(cellEl.dataset.col));
}

function handleBoardContextMenu(event) {
    event.preventDefault();
}

function renderToolbar() {
    document.querySelectorAll('[data-map]').forEach(button => {
        button.classList.toggle('active', button.dataset.map === state.activeMap);
    });

    document.querySelectorAll('[data-tool]').forEach(button => {
        button.classList.toggle('active', button.dataset.tool === state.activeTool);
    });

    document.querySelectorAll('[data-height]').forEach(button => {
        button.classList.toggle('active', Number(button.dataset.height) === state.activeHeight);
    });

    document.querySelectorAll('[data-apply-mode]').forEach(button => {
        button.classList.toggle('active', button.dataset.applyMode === state.applyMode);
    });

    dom.activeMapLabel.textContent = MAP_LABELS[state.activeMap];
}

function renderBoard() {
    const map = state.maps[state.activeMap];
    const fragment = document.createDocumentFragment();

    for (let row = 0; row < map.length; row += 1) {
        for (let col = 0; col < map[row].length; col += 1) {
            const cell = map[row][col];
            const button = document.createElement('button');
            button.type = 'button';
            button.className = [
                'cell',
                `height-${cell.height}`,
                cell.terrain ? `terrain-${cell.terrain}` : 'terrain-empty'
            ].join(' ');
            if (
                (cell.terrain === 'teleport' && !isTeleportSlot(state.activeMap, row, col)) ||
                (cell.terrain === 'core' && !isCoreSlot(state.activeMap, row, col))
            ) {
                button.classList.add('illegal');
            }
            button.dataset.row = String(row);
            button.dataset.col = String(col);
            button.setAttribute(
                'aria-label',
                `${MAP_LABELS[state.activeMap]} ${row + 1}-${col + 1} ${getTerrainLabel(cell.terrain)} H${cell.height}`
            );
            button.title = `${getTerrainLabel(cell.terrain)} / H${cell.height}`;
            button.innerHTML = `
                <span class="height-fill"></span>
                <span class="terrain-glyph">${getTerrainGlyph(cell.terrain)}</span>
                <span class="height-badge">H${cell.height}</span>
            `;
            fragment.appendChild(button);
        }
    }

    dom.board.replaceChildren(fragment);
}

function renderStats() {
    const stats = getMapStats(state.activeMap);
    dom.statWall.textContent = String(stats.wall);
    dom.statTeleport.textContent = String(stats.teleport);
    dom.statCore.textContent = String(stats.core);
    dom.statHigh.textContent = String(stats.high);
    dom.statPeak.textContent = String(stats.peak);
    dom.statChanged.textContent = String(stats.changed);
    dom.statWarnings.textContent = String(stats.warnings);
}

function renderStatus() {
    const stats = getMapStats(state.activeMap);
    const toolLabel = state.activeTool === 'erase' ? 'ERASE' : state.activeTool.toUpperCase();
    const applyLabel = state.applyMode.toUpperCase();
    const warningPart = stats.warnings > 0 ? ` / WARNINGS ${stats.warnings}` : '';
    dom.statusLine.textContent = `TOOL ${toolLabel} / HEIGHT H${state.activeHeight} / APPLY ${applyLabel}${warningPart}`;
}

function serializeExportPayload() {
    const maps = {};
    MAP_ORDER.forEach(mapName => {
        maps[mapName] = {
            rows: MAP_SIZES[mapName].rows,
            cols: MAP_SIZES[mapName].cols,
            cells: deepClone(state.maps[mapName]),
            stats: getMapStats(mapName)
        };
    });

    return {
        version: EXPORT_VERSION,
        type: 'sector8-fixed-map-preset',
        createdAt: new Date().toISOString(),
        rules: {
            height: {
                enabled: true,
                maxLevel: MAX_HEIGHT,
                visionBonusPerLevel: 1,
                moveExtraCostPerLevel: 1
            }
        },
        maps
    };
}

function refreshExports() {
    const payload = serializeExportPayload();
    const json = JSON.stringify(payload, null, 2);
    dom.exportJson.value = json;
    dom.exportJs.value = [
        'const SECTOR8_FIXED_MAP_PRESET = ' + json + ';',
        'if (typeof window !== "undefined") window.SECTOR8_FIXED_MAP_PRESET = SECTOR8_FIXED_MAP_PRESET;'
    ].join('\n');
}

function persistAndRender(refreshBoardOnly = true) {
    saveState();
    renderToolbar();
    renderBoard();
    renderStats();
    renderStatus();
    refreshExports();
    if (!refreshBoardOnly) {
        // reserved for future view updates
    }
}

function renderAll() {
    persistAndRender();
}

function announce(message, delay = 1600) {
    dom.statusLine.textContent = message;
    if (statusTimer) {
        clearTimeout(statusTimer);
    }
    statusTimer = setTimeout(() => {
        statusTimer = null;
        renderStatus();
    }, delay);
}

async function copyText(text, label) {
    try {
        await navigator.clipboard.writeText(text);
        announce(`${label} をコピーしました`);
    } catch {
        announce(`${label} のコピーに失敗しました`);
    }
}

async function importFromTextarea() {
    const text = dom.importText.value.trim();
    if (!text) {
        announce('読み込む JSON が空です');
        return;
    }

    try {
        const parsed = JSON.parse(text);
        history.push(deepClone(state.maps));
        if (history.length > 64) {
            history.shift();
        }
        future = [];
        state = normalizeState(parsed);
        saveState();
        renderAll();
        announce('JSON を読み込みました');
    } catch {
        announce('JSON の読み込みに失敗しました');
    }
}

function downloadJson() {
    const payload = serializeExportPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'sector8-fixed-map-preset.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    announce('JSON をダウンロードしました');
}

function bindEvents() {
    document.querySelectorAll('[data-map]').forEach(button => {
        button.addEventListener('click', () => setActiveMap(button.dataset.map));
    });

    document.querySelectorAll('[data-tool]').forEach(button => {
        button.addEventListener('click', () => setActiveTool(button.dataset.tool));
    });

    document.querySelectorAll('[data-height]').forEach(button => {
        button.addEventListener('click', () => setActiveHeight(button.dataset.height));
    });

    document.querySelectorAll('[data-apply-mode]').forEach(button => {
        button.addEventListener('click', () => setApplyMode(button.dataset.applyMode));
    });

    dom.btnNewPreset.addEventListener('click', createBlankPreset);
    dom.btnUndo.addEventListener('click', undo);
    dom.btnRedo.addEventListener('click', redo);
    dom.btnExportJson.addEventListener('click', () => {
        dom.exportJson.focus();
        dom.exportJson.select();
        announce('JSON を更新しました');
    });
    dom.btnExportJs.addEventListener('click', () => {
        dom.exportJs.focus();
        dom.exportJs.select();
        announce('JS を更新しました');
    });
    dom.btnImport.addEventListener('click', importFromTextarea);
    dom.btnCopyJson.addEventListener('click', () => copyText(dom.exportJson.value, 'JSON'));
    dom.btnCopyJs.addEventListener('click', () => copyText(dom.exportJs.value, 'JS'));
    dom.btnDownload.addEventListener('click', downloadJson);

    dom.board.addEventListener('pointerdown', handleBoardPointerDown);
    dom.board.addEventListener('pointermove', handleBoardPointerMove);
    dom.board.addEventListener('contextmenu', handleBoardContextMenu);
    window.addEventListener('pointerup', endStroke);
    window.addEventListener('pointercancel', endStroke);
    window.addEventListener('blur', endStroke);

    document.addEventListener('keydown', event => {
        if (event.ctrlKey && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            undo();
            return;
        }

        if (event.ctrlKey && event.key.toLowerCase() === 'y') {
            event.preventDefault();
            redo();
            return;
        }

        const key = event.key;
        if (key === '1') setActiveTool('wall');
        if (key === '2') setActiveTool('teleport');
        if (key === '3') setActiveTool('core');
        if (key === '4') setActiveTool('erase');
        if (key === '5') setActiveHeight(0);
        if (key === '6') setActiveHeight(1);
        if (key === '7') setActiveHeight(2);
        if (key === '8') setActiveHeight(3);
    });
}

bindEvents();
renderAll();
