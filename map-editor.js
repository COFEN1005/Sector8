const MAP_SIZES = { area1: { rows: 11, cols: 11 }, area2: { rows: 11, cols: 11 }, area3: { rows: 11, cols: 11 } };
const STORAGE_KEY = 'sector8_map_editor_state_v1';
const MAP_ORDER = ['area1', 'area2', 'area3'];
const TOOL_LABELS = {
    wall: 'WALL',
    teleport: 'TELEPORT',
    core: 'CORE',
    erase: 'ERASE'
};

const state = loadState() || createBlankState();
let activeMap = 'area1';
let activeTool = 'wall';
let history = [];
let future = [];
let painting = false;
let lastPaintKey = null;

function createBlankMap() {
    return Array.from({ length: 11 }, () => Array.from({ length: 11 }, () => null));
}

function createBlankState() {
    return {
        version: 1,
        maps: {
            area1: createBlankMap(),
            area2: createBlankMap(),
            area3: createBlankMap()
        }
    };
}

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.maps) return null;
        return normalizeState(parsed);
    } catch {
        return null;
    }
}

function normalizeState(input) {
    const next = createBlankState();
    MAP_ORDER.forEach(mapName => {
        const cells = input.maps?.[mapName];
        if (!Array.isArray(cells)) return;
        for (let r = 0; r < 11; r++) {
            for (let c = 0; c < 11; c++) {
                const value = cells[r]?.[c];
                next.maps[mapName][r][c] = value === 'wall' || value === 'teleport' || value === 'core' ? value : null;
            }
        }
    });
    return next;
}

function saveState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
}

function isLegalTeleportCell(mapName, row, col) {
    const legalCols = [0, 1, 9, 10];
    if (!legalCols.includes(col)) return false;
    if (mapName === 'area1') return row === 0;
    if (mapName === 'area2') return row === 0 || row === 10;
    if (mapName === 'area3') return row === 10;
    return false;
}

function isLegalCoreCell(mapName, row, col) {
    if (mapName === 'area1') return row === 10 && col >= 4 && col <= 6;
    if (mapName === 'area3') return row === 0 && col >= 4 && col <= 6;
    return false;
}

function getCellType(mapName, row, col) {
    return state.maps[mapName][row][col];
}

function setCellType(mapName, row, col, type) {
    const current = getCellType(mapName, row, col);
    if (current === type) return false;

    if (type === 'teleport' && !isLegalTeleportCell(mapName, row, col)) {
        setStatus('Teleport はこのマスに置けません。');
        return false;
    }
    if (type === 'core' && !isLegalCoreCell(mapName, row, col)) {
        setStatus('Core はこのマスに置けません。');
        return false;
    }

    pushHistory();
    state.maps[mapName][row][col] = type;
    future = [];
    saveState();
    renderAll();
    return true;
}

function clearCell(mapName, row, col) {
    if (!getCellType(mapName, row, col)) return false;
    pushHistory();
    state.maps[mapName][row][col] = null;
    future = [];
    saveState();
    renderAll();
    return true;
}

function pushHistory() {
    history.push(structuredClone(state));
    if (history.length > 40) history.shift();
}

function undo() {
    if (!history.length) return;
    future.push(structuredClone(state));
    const prev = history.pop();
    restoreState(prev);
}

function redo() {
    if (!future.length) return;
    history.push(structuredClone(state));
    const next = future.pop();
    restoreState(next);
}

function restoreState(next) {
    const normalized = normalizeState(next);
    state.version = normalized.version;
    state.maps = normalized.maps;
    saveState();
    renderAll();
}

function paintCell(mapName, row, col) {
    if (activeTool === 'erase') {
        clearCell(mapName, row, col);
        return;
    }
    if (activeTool === 'wall') {
        setCellType(mapName, row, col, 'wall');
        return;
    }
    if (activeTool === 'teleport') {
        setCellType(mapName, row, col, 'teleport');
        return;
    }
    if (activeTool === 'core') {
        setCellType(mapName, row, col, 'core');
    }
}

function renderBoard() {
    const board = document.getElementById('board');
    board.innerHTML = '';
    board.style.gridTemplateColumns = 'repeat(11, minmax(0, 1fr))';
    const map = state.maps[activeMap];

    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'cell';
            cell.dataset.row = String(r);
            cell.dataset.col = String(c);
            const cellType = map[r][c];
            if (cellType) cell.classList.add(cellType);
            if ((activeTool === 'teleport' && isLegalTeleportCell(activeMap, r, c)) || (activeTool === 'core' && isLegalCoreCell(activeMap, r, c))) {
                cell.classList.add('legal');
            }
            if ((activeTool === 'teleport' && !isLegalTeleportCell(activeMap, r, c)) || (activeTool === 'core' && !isLegalCoreCell(activeMap, r, c))) {
                cell.classList.add('locked');
            }
            cell.addEventListener('pointerdown', event => {
                event.preventDefault();
                painting = true;
                lastPaintKey = `${r},${c}`;
                paintCell(activeMap, r, c);
            });
            cell.addEventListener('pointerenter', () => {
                if (!painting) return;
                const key = `${r},${c}`;
                if (key === lastPaintKey) return;
                lastPaintKey = key;
                paintCell(activeMap, r, c);
            });
            board.appendChild(cell);
        }
    }
}

function renderStats() {
    const counts = { wall: 0, teleport: 0, core: 0, changed: 0 };
    MAP_ORDER.forEach(mapName => {
        state.maps[mapName].forEach(row => row.forEach(cell => {
            if (cell === 'wall') counts.wall++;
            if (cell === 'teleport') counts.teleport++;
            if (cell === 'core') counts.core++;
        }));
    });
    counts.changed = history.length;
    document.getElementById('stat-wall').textContent = String(counts.wall);
    document.getElementById('stat-teleport').textContent = String(counts.teleport);
    document.getElementById('stat-core').textContent = String(counts.core);
    document.getElementById('stat-changed').textContent = String(counts.changed);
}

function buildExportObject() {
    const maps = {};
    MAP_ORDER.forEach(mapName => {
        const walls = [];
        const teleports = [];
        const cores = [];
        const cells = state.maps[mapName].map((row, r) => row.map((cell, c) => {
            if (cell === 'wall') walls.push([r, c]);
            if (cell === 'teleport') teleports.push([r, c]);
            if (cell === 'core') cores.push([r, c]);
            return cell;
        }));
        maps[mapName] = { cells, walls, teleports, cores };
    });
    return { version: 1, maps };
}

function updateExportPanels() {
    const exportObj = buildExportObject();
    document.getElementById('export-json').value = JSON.stringify(exportObj, null, 2);
    document.getElementById('export-js').value = `const FIXED_MAP_CONFIG = ${JSON.stringify(exportObj, null, 2)};`;
}

function setStatus(text) {
    document.getElementById('status-line').textContent = text;
}

function renderAll() {
    document.getElementById('active-map-label').textContent = activeMap.toUpperCase();
    renderBoard();
    renderStats();
    updateExportPanels();
    document.querySelectorAll('.map-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.map === activeMap));
    document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tool === activeTool));
}

function loadImportedJson() {
    const text = document.getElementById('import-text').value.trim();
    if (!text) {
        setStatus('JSON が空です。');
        return;
    }
    try {
        const parsed = normalizeState(JSON.parse(text));
        pushHistory();
        state.maps = parsed.maps;
        saveState();
        future = [];
        renderAll();
        setStatus('JSON を読み込みました。');
    } catch {
        setStatus('JSON の読み込みに失敗しました。');
    }
}

function resetAll() {
    pushHistory();
    const blank = createBlankState();
    state.maps = blank.maps;
    future = [];
    saveState();
    renderAll();
    setStatus('新規マップを作成しました。');
}

async function copyText(value, label) {
    try {
        await navigator.clipboard.writeText(value);
        setStatus(`${label} をコピーしました。`);
    } catch {
        const temp = document.createElement('textarea');
        temp.value = value;
        temp.style.position = 'fixed';
        temp.style.opacity = '0';
        document.body.appendChild(temp);
        temp.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(temp);
        setStatus(ok ? `${label} をコピーしました。` : `${label} のコピーに失敗しました。`);
    }
}

function downloadJson() {
    const blob = new Blob([JSON.stringify(buildExportObject(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sector8-fixed-map.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('JSON を保存しました。');
}

document.addEventListener('pointerup', () => {
    painting = false;
    lastPaintKey = null;
});

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.map-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            activeMap = btn.dataset.map;
            setStatus(`${activeMap.toUpperCase()} を編集中です。`);
            renderAll();
        });
    });

    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTool = btn.dataset.tool;
            const hints = {
                wall: 'WALL を編集中です。',
                teleport: 'TELEPORT を編集中です。',
                core: 'CORE を編集中です。',
                erase: 'ERASE を編集中です。'
            };
            setStatus(hints[activeTool] || '編集中です。');
            renderAll();
        });
    });

    document.getElementById('btn-new-preset').addEventListener('click', resetAll);
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-redo').addEventListener('click', redo);
    document.getElementById('btn-import').addEventListener('click', loadImportedJson);
    document.getElementById('btn-copy-json').addEventListener('click', () => copyText(document.getElementById('export-json').value, 'JSON'));
    document.getElementById('btn-copy-js').addEventListener('click', () => copyText(document.getElementById('export-js').value, 'JS'));
    document.getElementById('btn-download').addEventListener('click', downloadJson);
    document.getElementById('board').addEventListener('contextmenu', event => event.preventDefault());

    window.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            if (event.shiftKey) redo();
            else undo();
            return;
        }
        if (event.key === '1') { activeTool = 'wall'; renderAll(); }
        if (event.key === '2') { activeTool = 'teleport'; renderAll(); }
        if (event.key === '3') { activeTool = 'core'; renderAll(); }
        if (event.key === '4') { activeTool = 'erase'; renderAll(); }
    });

    renderAll();
    setStatus('編集を開始できます。');
});
