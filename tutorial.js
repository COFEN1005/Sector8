(function (root) {
    const LESSONS = [
        { title: 'コマを選ぶ', copy: '青い「丁」を押してください。自軍のコマを選ぶと、動かせるマスが表示されます。', hint: '青い丁をクリック' },
        { title: '直線に移動する', copy: '丁は直線に2マスまで移動できます。光っているマスへ動かしてみましょう。', hint: '丁の2マス前をクリック' },
        { title: '敵を撃破する', copy: '1ターンは2アクション。次は青い「乙」を選び、直線上の赤い「丁」を押して撃破します。同じコマは通常、同じターンにもう一度行動できません。', hint: '乙を選んで敵の丁をクリック' },
        { title: '情報崩壊を防ぐ', copy: 'ここは中央のエリア2です。偵察兵以外の自軍コマが中央にいなくなると情報崩壊が始まります。', hint: '正しい状態を選択' },
        { title: '勝利条件を知る', copy: '相手の核を守る領域を完全に破壊すると勝利です。情報崩壊の累積15ターンでも決着します。', hint: '主な攻撃目標を選択' },
        { title: '訓練完了', copy: '基本操作は以上です。実戦では壁やコマが視界を遮り、転送マスと甲の能力が戦局を変えます。詳しくは対戦画面のルールとMENUから確認できます。', hint: 'AI対戦で試してみよう' }
    ];

    function createState(step = 0) {
        return {
            step,
            selected: step === 1 ? 'tei' : null,
            actions: step < 2 ? 0 : step < 3 ? 1 : 2,
            teiMoved: step >= 2,
            enemyAlive: step < 3,
            skipped: false
        };
    }

    function advance(state, action) {
        const next = { ...state };
        const cell = `${action.row},${action.col}`;
        if (next.step === 0 && action.type === 'cell' && cell === '5,3') {
            next.step = 1;
            next.selected = 'tei';
            return { state: next, message: '丁を選択しました。移動先を押してください。' };
        }
        if (next.step === 1 && action.type === 'cell' && cell === '3,3') {
            next.step = 2;
            next.selected = null;
            next.teiMoved = true;
            next.actions = 1;
            return { state: next, message: '1アクション使用。残り1アクションです。' };
        }
        if (next.step === 2 && action.type === 'cell' && cell === '5,1') {
            next.selected = 'otsu';
            return { state: next, message: '乙を選択しました。赤い丁を押して撃破してください。' };
        }
        if (next.step === 2 && next.selected === 'otsu' && action.type === 'cell' && cell === '3,1') {
            next.step = 3;
            next.selected = null;
            next.enemyAlive = false;
            next.actions = 2;
            return { state: next, message: '敵を撃破しました。2アクションを使い切りました。' };
        }
        if (next.step === 3 && action.type === 'answer' && action.value === 'collapse') {
            next.step = 4;
            return { state: next, message: '正解。偵察兵だけでは情報崩壊を止められません。' };
        }
        if (next.step === 4 && action.type === 'answer' && action.value === 'core') {
            next.step = 5;
            return { state: next, message: '訓練完了。AI対戦へ進めます。' };
        }
        if (action.type === 'answer') return { state: next, message: 'もう一度考えてみましょう。' };
        return { state: next, message: LESSONS[next.step].hint };
    }

    let state = createState();
    let feedback = '';
    let initialized = false;

    function byId(id) { return document.getElementById(id); }

    function renderBoard() {
        const board = byId('tutorial-board');
        if (!board) return;
        board.replaceChildren();
        for (let row = 0; row < 7; row++) {
            for (let col = 0; col < 7; col++) {
                const cell = document.createElement('button');
                cell.type = 'button';
                cell.className = 'tutorial-cell';
                cell.dataset.row = row;
                cell.dataset.col = col;
                let label = '空きマス';
                if (row === 2 && col === 5) {
                    cell.classList.add('wall');
                    label = '壁';
                    cell.textContent = '▦';
                } else if (row === (state.teiMoved ? 3 : 5) && col === 3) {
                    cell.classList.add('ally');
                    if (state.selected === 'tei') cell.classList.add('selected');
                    cell.textContent = '丁';
                    label = '自軍の丁';
                } else if (row === (state.enemyAlive ? 5 : 3) && col === 1) {
                    cell.classList.add('ally');
                    if (state.selected === 'otsu') cell.classList.add('selected');
                    cell.textContent = '乙';
                    label = '自軍の乙';
                } else if (state.enemyAlive && row === 3 && col === 1) {
                    cell.classList.add('enemy');
                    cell.textContent = '丁';
                    label = '敵軍の丁';
                }
                if (state.step === 0 && row === 5 && col === 3) cell.classList.add('target');
                if (state.step === 1 && row === 3 && col === 3) cell.classList.add('target');
                if (state.step === 2 && row === 5 && col === 1 && state.selected !== 'otsu') cell.classList.add('target');
                if (state.step === 2 && row === 3 && col === 1 && state.selected === 'otsu') cell.classList.add('target');
                cell.setAttribute('aria-label', `${row + 1}行${col + 1}列: ${label}`);
                board.append(cell);
            }
        }
    }

    function addAnswer(container, label, value) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tutorial-answer';
        button.dataset.answer = value;
        button.textContent = label;
        container.append(button);
    }

    function render() {
        if (!byId('tutorial-screen')) return;
        const lesson = LESSONS[state.step];
        byId('tutorial-step-count').textContent = `${String(Math.min(state.step + 1, 5)).padStart(2, '0')} / 05`;
        byId('tutorial-progress-fill').style.width = `${Math.min(state.step, 5) * 20}%`;
        byId('tutorial-step-title').textContent = lesson.title;
        byId('tutorial-step-copy').textContent = lesson.copy;
        byId('tutorial-actions').textContent = `${state.actions} / 2 ACTIONS`;
        byId('tutorial-feedback').textContent = feedback || lesson.hint;
        byId('tutorial-back').disabled = state.step === 0;
        byId('tutorial-skip').classList.toggle('hidden', state.step === 5);
        byId('tutorial-ai').classList.toggle('hidden', state.step !== 5);
        const action = byId('tutorial-step-action');
        action.replaceChildren();
        if (state.step === 3) {
            addAnswer(action, '偵察兵だけでも防げる', 'safe');
            addAnswer(action, '情報崩壊が進む', 'collapse');
        } else if (state.step === 4) {
            addAnswer(action, '敵の偵察兵', 'scout');
            addAnswer(action, '敵の核の領域', 'core');
        } else if (state.step === 5) {
            const note = document.createElement('strong');
            note.textContent = state.skipped ? '説明をスキップしました。いつでも再挑戦できます。' : '訓練完了';
            action.append(note);
        }
        renderBoard();
    }

    function dispatch(action) {
        const result = advance(state, action);
        state = result.state;
        feedback = result.message;
        render();
    }

    function open() {
        if (!initialized) {
            byId('tutorial-board')?.addEventListener('click', event => {
                const cell = event.target.closest('.tutorial-cell');
                if (cell) dispatch({ type: 'cell', row: Number(cell.dataset.row), col: Number(cell.dataset.col) });
            });
            byId('tutorial-step-action')?.addEventListener('click', event => {
                const button = event.target.closest('[data-answer]');
                if (button) dispatch({ type: 'answer', value: button.dataset.answer });
            });
            byId('tutorial-reset')?.addEventListener('click', () => { state = createState(); feedback = ''; render(); });
            byId('tutorial-back')?.addEventListener('click', () => {
                state = createState(Math.max(0, state.step - 1));
                feedback = '';
                render();
            });
            byId('tutorial-skip')?.addEventListener('click', () => {
                state = { ...createState(5), skipped: true };
                feedback = '';
                render();
            });
            initialized = true;
        }
        render();
    }

    root.Sector8Tutorial = { open };
    if (typeof module !== 'undefined' && module.exports) module.exports = { createState, advance };
})(typeof window !== 'undefined' ? window : globalThis);
