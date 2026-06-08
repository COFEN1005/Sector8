const MAP_ORDER = ['area1', 'area2', 'area3'];
const MAP_LABELS = {
    area1: 'AREA 1',
    area2: 'AREA 2',
    area3: 'AREA 3'
};
const MAP_HINTS = {
    area1: 'AREA 2 の下側ポータルへ接続',
    area2: '上下どちらにも接続する中継エリア',
    area3: 'AREA 2 の上側ポータルへ接続'
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
const STORAGE_KEY = 'sector8-map-editor-v5';
const PRESET_STORAGE_KEY = 'sector8-fixed-map-preset-v1';
const MAX_HEIGHT = 1;
const EXPORT_VERSION = 4;

const dom = {
    mapStack: document.getElementById('map-stack'),
    teleportLayer: document.getElementById('teleport-link-layer'),
    exportJson: document.getElementById('export-json'),
    exportJs: document.getElementById('export-js'),
    importText: document.getElementById('import-text'),
    statusLine: document.getElementById('status-line'),
    teleportPairLabel: document.getElementById('teleport-pair-label'),
    teleportNextLabel: document.getElementById('teleport-next-label'),
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
    btnImportFile: document.getElementById('btn-import-file'),
    btnCopyJson: document.getElementById('btn-copy-json'),
    btnCopyJs: document.getElementById('btn-copy-js'),
    btnDownload: document.getElementById('btn-download'),
    importFileInput: document.getElementById('import-file-input'),
    boardArea1: document.getElementById('board-area1'),
    boardArea2: document.getElementById('board-area2'),
    boardArea3: document.getElementById('board-area3'),
    cardArea1: document.querySelector('[data-map-card="area1"]'),
    cardArea2: document.querySelector('[data-map-card="area2"]'),
    cardArea3: document.querySelector('[data-map-card="area3"]')
};

const boardByMap = {
    area1: dom.boardArea1,
    area2: dom.boardArea2,
    area3: dom.boardArea3
};

let state = loadState();
let history = [];
let future = [];
let strokeActive = false;
let strokeSnapshotTaken = false;
let statusTimer = null;
let rafHandle = 0;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function makeGrid() {
    const { rows, cols } = MAP_SIZES.area1;
    return Array.from({ length: rows }, () => (
        Array.from({ length: cols }, () => ({ terrain: null, height: 0, teleportGroup: null }))
    ));
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
        version: EXPORT_VERSION,
        activeMap: 'area1',
        activeTool: 'wall',
        activeHeight: 0,
        applyMode: 'both',
        maps
    };
}

function seedAnchors(mapName, grid) {
    if (mapName === 'area1' || mapName === 'area2') {
        const topRow = 0;
        PORTAL_COLS.forEach((col, index) => {
            grid[topRow][col].terrain = 'teleport';
            grid[topRow][col].teleportGroup = index + 1;
        });
    }

    if (mapName === 'area2' || mapName === 'area3') {
        const bottomRow = 10;
        PORTAL_COLS.forEach((col, index) => {
            grid[bottomRow][col].terrain = 'teleport';
            grid[bottomRow][col].teleportGroup = index + 5;
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

function normalizeTerrain(value) {
    return VALID_TERRAINS.has(value) ? value : null;
}

function normalizeHeight(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return clamp(Math.trunc(n), 0, MAX_HEIGHT);
}

function normalizeTeleportGroup(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(1, Math.trunc(n));
}

function normalizeCell(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return {
            terrain: normalizeTerrain(raw.terrain),
            height: normalizeHeight(raw.height ?? raw.h ?? 0),
            teleportGroup: normalizeTeleportGroup(raw.teleportGroup ?? raw.link ?? raw.teleportId ?? null)
        };
    }

    if (typeof raw === 'string') {
        if (VALID_TERRAINS.has(raw)) {
            return { terrain: raw, height: 0, teleportGroup: raw === 'teleport' ? 1 : null };
        }

        const maybeHeight = Number(raw);
        if (Number.isFinite(maybeHeight)) {
            return { terrain: null, height: clamp(Math.trunc(maybeHeight), 0, MAX_HEIGHT), teleportGroup: null };
        }
    }

    return { terrain: null, height: 0, teleportGroup: null };
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
    } else if (source && typeof source === 'object' && Array.isArray(source.cells)) {
        return normalizeGrid(source.cells);
    }

    if (hasInvalidTeleportGrouping(grid)) {
        rebalanceTeleportGroups(grid);
    }

    return grid;
}

function hasInvalidTeleportGrouping(grid) {
    if (!Array.isArray(grid)) {
        return MAP_ORDER.some(mapName => hasInvalidTeleportGrouping(grid?.[mapName] || []));
    }

    const counts = new Map();
    let hasTeleport = false;
    let hasMissingGroup = false;

    for (const row of grid) {
        for (const cell of row) {
            if (cell.terrain !== 'teleport') continue;
            hasTeleport = true;
            if (!cell.teleportGroup) hasMissingGroup = true;
            const group = cell.teleportGroup || 0;
            counts.set(group, (counts.get(group) || 0) + 1);
        }
    }

    if (!hasTeleport) return false;
    if (hasMissingGroup) return true;

    for (const [group, count] of counts.entries()) {
        if (!group || count > 2) {
            return true;
        }
    }

    return false;
}

function rebalanceTeleportGroups(gridOrMaps) {
    const cells = [];

    if (Array.isArray(gridOrMaps)) {
        for (let row = 0; row < gridOrMaps.length; row += 1) {
            for (let col = 0; col < gridOrMaps[row].length; col += 1) {
                const cell = gridOrMaps[row][col];
                if (cell.terrain === 'teleport') {
                    cells.push(cell);
                }
            }
        }
    } else {
        MAP_ORDER.forEach(mapName => {
            const map = gridOrMaps[mapName];
            for (let row = 0; row < map.length; row += 1) {
                for (let col = 0; col < map[row].length; col += 1) {
                    const cell = map[row][col];
                    if (cell.terrain === 'teleport') {
                        cells.push(cell);
                    }
                }
            }
        });
    }

    let group = 1;
    let slot = 0;
    for (const cell of cells) {
        cell.teleportGroup = group;
        slot += 1;
        if (slot >= 2) {
            slot = 0;
            group += 1;
        }
    }
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

    if (hasInvalidTeleportGrouping(next.maps)) {
        rebalanceTeleportGroups(next.maps);
    }

    return next;
}

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return createState(true);
        return normalizeState(JSON.parse(raw));
    } catch {
        return createState(true);
    }
}

function saveState() {
    try {
        const preset = serializeExportPayload();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(preset));
        window.SECTOR8_FIXED_MAP_PRESET = preset;
    } catch {
        // ignore storage errors
    }
}

function getCell(mapName, row, col) {
    return state.maps[mapName]?.[row]?.[col] || null;
}

function getGlobalTeleportCounts() {
    const counts = new Map();
    MAP_ORDER.forEach(mapName => {
        state.maps[mapName].forEach(row => {
            row.forEach(cell => {
                if (cell.terrain !== 'teleport') return;
                const group = Number(cell.teleportGroup) || 0;
                counts.set(group, (counts.get(group) || 0) + 1);
            });
        });
    });
    return counts;
}

function getNextTeleportGroup() {
    const counts = getGlobalTeleportCounts();
    let group = 1;
    while ((counts.get(group) || 0) >= 2) {
        group += 1;
    }
    return group;
}

function allocateTeleportGroup() {
    return getNextTeleportGroup();
}

function removeTeleportGroup(group) {
    if (!group) return;
    MAP_ORDER.forEach(mapName => {
        const map = state.maps[mapName];
        map.forEach(row => {
            row.forEach(cell => {
                if (cell.terrain === 'teleport' && Number(cell.teleportGroup) === Number(group)) {
                    cell.terrain = null;
                    cell.teleportGroup = null;
                }
            });
        });
    });
}

function getTeleportMirrorCell(mapName, row, col) {
    if (!PORTAL_COLS.includes(col)) return null;
    if (mapName === 'area1' && row === 0) return { mapName: 'area2', row: 0, col };
    if (mapName === 'area2' && row === 0) return { mapName: 'area1', row: 0, col };
    if (mapName === 'area2' && row === 10) return { mapName: 'area3', row: 10, col };
    if (mapName === 'area3' && row === 10) return { mapName: 'area2', row: 10, col };
    return null;
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
    const teleportGroups = new Map();

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
            if (cell.terrain === 'teleport') {
                const group = cell.teleportGroup || 0;
                teleportGroups.set(group, (teleportGroups.get(group) || 0) + 1);
            }
        }
    }

    teleportGroups.forEach((count, group) => {
        if (!group || count !== 2) {
            stats.warnings += 1;
        }
    });

    return stats;
}

function getGlobalStats() {
    return MAP_ORDER.reduce((acc, mapName) => {
        const stats = getMapStats(mapName);
        acc.wall += stats.wall;
        acc.teleport += stats.teleport;
        acc.core += stats.core;
        acc.high += stats.high;
        acc.peak += stats.peak;
        acc.changed += stats.changed;
        acc.warnings += stats.warnings;
        return acc;
    }, {
        wall: 0,
        teleport: 0,
        core: 0,
        high: 0,
        peak: 0,
        changed: 0,
        warnings: 0
    });
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
    saveState();
    renderAll();
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

function setFocusMap(mapName, scroll = false) {
    if (!MAP_ORDER.includes(mapName)) return;
    state.activeMap = mapName;
    saveState();
    renderToolbar();
    if (scroll) {
        document.querySelector(`[data-map-card="${mapName}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
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

function paintCell(mapName, row, col) {
    const cell = getCell(mapName, row, col);
    if (!cell) return false;

    const targetTerrain = state.applyMode !== 'height'
        ? (state.activeTool === 'erase' ? null : state.activeTool)
        : cell.terrain;
    const targetHeight = state.applyMode !== 'terrain'
        ? clamp(state.activeHeight, 0, MAX_HEIGHT)
        : cell.height;

    let nextTerrain = cell.terrain;
    let nextHeight = cell.height;
    let nextTeleportGroup = cell.teleportGroup;

    if (state.applyMode !== 'height') {
        if (cell.terrain === 'teleport' && targetTerrain !== 'teleport') {
            removeTeleportGroup(cell.teleportGroup);
            nextTerrain = null;
            nextTeleportGroup = null;
        }

        if (targetTerrain === 'teleport') {
            const mirror = getTeleportMirrorCell(mapName, row, col);
            const linkedCells = [
                { mapName, row, col, cell },
                mirror ? { mapName: mirror.mapName, row: mirror.row, col: mirror.col, cell: getCell(mirror.mapName, mirror.row, mirror.col) } : null
            ].filter(Boolean);
            const existingGroups = linkedCells
                .map(entry => entry.cell?.terrain === 'teleport' ? Number(entry.cell.teleportGroup) || null : null)
                .filter(Boolean);
            const chosenGroup = existingGroups[0] || allocateTeleportGroup();

            linkedCells.forEach(entry => {
                const targetCell = entry.cell;
                if (!targetCell) return;
                if (targetCell.terrain === 'teleport' && Number(targetCell.teleportGroup) !== chosenGroup) {
                    removeTeleportGroup(targetCell.teleportGroup);
                }
            });

            linkedCells.forEach(entry => {
                const targetCell = entry.cell;
                if (!targetCell) return;
                targetCell.terrain = 'teleport';
                targetCell.teleportGroup = chosenGroup;
            });

            nextTerrain = 'teleport';
            nextTeleportGroup = chosenGroup;
        } else if (targetTerrain !== 'teleport') {
            nextTerrain = targetTerrain;
            nextTeleportGroup = null;
        }
    }

    if (state.applyMode !== 'terrain') {
        nextHeight = targetHeight;
    }

    const changed =
        cell.terrain !== nextTerrain ||
        cell.height !== nextHeight ||
        cell.teleportGroup !== nextTeleportGroup;

    if (!changed) return false;

    if (!strokeSnapshotTaken) {
        captureHistory();
        strokeSnapshotTaken = true;
    }

    cell.terrain = nextTerrain;
    cell.height = nextHeight;
    cell.teleportGroup = nextTeleportGroup;

    saveState();
    renderAll();

    if (nextTerrain === 'teleport' && nextTeleportGroup) {
        announce(`TELEPORT ${`T${nextTeleportGroup}`}`, 900);
    }

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

function handleMapPointerDown(event) {
    const cellEl = event.target.closest('.cell');
    if (!cellEl || event.button !== 0) return;
    event.preventDefault();
    beginStroke();
    setFocusMap(cellEl.dataset.map);
    paintCell(cellEl.dataset.map, Number(cellEl.dataset.row), Number(cellEl.dataset.col));
}

function handleMapPointerMove(event) {
    if (!strokeActive || event.buttons !== 1) return;
    const cellEl = event.target.closest('.cell');
    if (!cellEl) return;
    event.preventDefault();
    paintCell(cellEl.dataset.map, Number(cellEl.dataset.row), Number(cellEl.dataset.col));
}

function handleMapContextMenu(event) {
    event.preventDefault();
}

function renderToolbar() {
    document.querySelectorAll('[data-focus-map]').forEach(button => {
        button.classList.toggle('active', button.dataset.focusMap === state.activeMap);
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

    document.querySelectorAll('[data-map-card]').forEach(card => {
        card.classList.toggle('active', card.dataset.mapCard === state.activeMap);
    });

    dom.teleportPairLabel.textContent = `T${getNextTeleportGroup()}`;
    dom.teleportNextLabel.textContent = `T${getNextTeleportGroup() + 1}`;
}

function renderBoard(mapName) {
    const map = state.maps[mapName];
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
                (cell.terrain === 'teleport' && !isTeleportSlot(mapName, row, col)) ||
                (cell.terrain === 'core' && !isCoreSlot(mapName, row, col))
            ) {
                button.classList.add('illegal');
            }

            button.dataset.map = mapName;
            button.dataset.row = String(row);
            button.dataset.col = String(col);
            button.setAttribute(
                'aria-label',
                `${MAP_LABELS[mapName]} ${row + 1}-${col + 1} ${getTerrainLabel(cell.terrain)} H${cell.height}`
            );
            const teleportLabel = cell.terrain === 'teleport' ? ` / T${cell.teleportGroup || '?'}` : '';
            button.title = `${getTerrainLabel(cell.terrain)} / H${cell.height}${teleportLabel}`;
            button.innerHTML = `
                <span class="height-fill"></span>
                <span class="terrain-glyph">${getTerrainGlyph(cell.terrain)}</span>
                <span class="height-badge">H${cell.height}</span>
                ${cell.terrain === 'teleport' ? `<span class="teleport-link-badge">T${cell.teleportGroup || '?'}</span>` : ''}
            `;
            fragment.appendChild(button);
        }
    }

    boardByMap[mapName].replaceChildren(fragment);
}

function renderBoards() {
    MAP_ORDER.forEach(renderBoard);
}

function renderTeleportLinks() {
    if (rafHandle) {
        cancelAnimationFrame(rafHandle);
    }
    rafHandle = requestAnimationFrame(() => {
        rafHandle = 0;
        const mapStackRect = dom.mapStack.getBoundingClientRect();
        const width = Math.max(1, Math.round(mapStackRect.width));
        const height = Math.max(1, Math.round(mapStackRect.height));
        const svgNS = 'http://www.w3.org/2000/svg';

        dom.teleportLayer.replaceChildren();
        dom.teleportLayer.setAttribute('viewBox', `0 0 ${width} ${height}`);
        dom.teleportLayer.setAttribute('width', String(width));
        dom.teleportLayer.setAttribute('height', String(height));

        const groups = new Map();

        MAP_ORDER.forEach(mapName => {
            boardByMap[mapName].querySelectorAll('.cell').forEach(cellEl => {
                const data = getCell(mapName, Number(cellEl.dataset.row), Number(cellEl.dataset.col));
                if (data.terrain !== 'teleport' || !data.teleportGroup) return;
                const group = Number(data.teleportGroup);
                if (!groups.has(group)) groups.set(group, []);
                groups.get(group).push({ mapName, cellEl });
            });
        });

        const orderedGroups = Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);
        for (const [group, cells] of orderedGroups) {
            const points = cells
                .map(({ cellEl, mapName }) => {
                    const rect = cellEl.getBoundingClientRect();
                    return {
                        x: rect.left - mapStackRect.left + rect.width / 2,
                        y: rect.top - mapStackRect.top + rect.height / 2,
                        mapName
                    };
                })
                .sort((a, b) => MAP_ORDER.indexOf(a.mapName) - MAP_ORDER.indexOf(b.mapName) || a.y - b.y || a.x - b.x);

            points.forEach(point => {
                const circle = document.createElementNS(svgNS, 'circle');
                circle.setAttribute('class', 'teleport-link-node');
                circle.setAttribute('cx', String(point.x));
                circle.setAttribute('cy', String(point.y));
                circle.setAttribute('r', '6');
                dom.teleportLayer.appendChild(circle);
            });

            if (points.length >= 2) {
                const line = document.createElementNS(svgNS, 'line');
                line.setAttribute('class', 'teleport-link-line');
                line.setAttribute('x1', String(points[0].x));
                line.setAttribute('y1', String(points[0].y));
                line.setAttribute('x2', String(points[1].x));
                line.setAttribute('y2', String(points[1].y));
                dom.teleportLayer.appendChild(line);
            }

            if (points.length) {
                const label = document.createElementNS(svgNS, 'text');
                label.setAttribute('class', 'teleport-link-label');
                label.setAttribute('x', String(points[0].x));
                label.setAttribute('y', String(points[0].y - 12));
                label.textContent = `T${group}`;
                dom.teleportLayer.appendChild(label);
            }
        }
    });
}

function renderStats() {
    const stats = getGlobalStats();
    dom.statWall.textContent = String(stats.wall);
    dom.statTeleport.textContent = String(stats.teleport);
    dom.statCore.textContent = String(stats.core);
    dom.statHigh.textContent = String(stats.high);
    dom.statPeak.textContent = String(stats.peak);
    dom.statChanged.textContent = String(stats.changed);
    dom.statWarnings.textContent = String(stats.warnings);
}

function renderStatus() {
    const stats = getGlobalStats();
    const toolLabel = state.activeTool === 'erase' ? 'ERASE' : state.activeTool.toUpperCase();
    const applyLabel = state.applyMode.toUpperCase();
    const warningPart = stats.warnings > 0 ? ` / WARNINGS ${stats.warnings}` : '';
    dom.statusLine.textContent = `FOCUS ${MAP_LABELS[state.activeMap]} / TOOL ${toolLabel} / HEIGHT H${state.activeHeight} / APPLY ${applyLabel}${warningPart}`;
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
            },
            teleport: {
                syncMode: 'pair',
                visualize: ['number', 'line'],
                pairSize: 2
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

function renderAll() {
    saveState();
    renderToolbar();
    renderBoards();
    renderStats();
    renderStatus();
    refreshExports();
    renderTeleportLinks();
}

function announce(message, delay = 1400) {
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

async function importFromFile(file) {
    if (!file) return;
    const text = await file.text();
    dom.importText.value = text;
    await importFromTextarea();
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
    document.querySelectorAll('[data-focus-map]').forEach(button => {
        button.addEventListener('click', () => setFocusMap(button.dataset.focusMap, true));
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
    dom.btnImportFile.addEventListener('click', () => dom.importFileInput?.click());
    dom.importFileInput.addEventListener('change', () => {
        const file = dom.importFileInput.files?.[0] || null;
        if (file) importFromFile(file).catch(() => announce('ファイルの読み込みに失敗しました'));
        dom.importFileInput.value = '';
    });
    dom.btnCopyJson.addEventListener('click', () => copyText(dom.exportJson.value, 'JSON'));
    dom.btnCopyJs.addEventListener('click', () => copyText(dom.exportJs.value, 'JS'));
    dom.btnDownload.addEventListener('click', downloadJson);

    dom.mapStack.addEventListener('pointerdown', handleMapPointerDown);
    dom.mapStack.addEventListener('pointermove', handleMapPointerMove);
    dom.mapStack.addEventListener('contextmenu', handleMapContextMenu);
    window.addEventListener('pointerup', endStroke);
    window.addEventListener('pointercancel', endStroke);
    window.addEventListener('blur', endStroke);
    window.addEventListener('resize', renderTeleportLinks);

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
    });
}

bindEvents();
renderAll();
