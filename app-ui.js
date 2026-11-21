/**
 * app-ui.js (v7)
 * ・ノンストップ連続スキャン連動（モーダルを閉じれば即座にカメラ読取再開）
 * ・UIの「⚙️接続」ボタンからGASのURLを後から安全に登録・保存・共有リンク生成する機能
 * ・スマホ上部テンキー操作・後から発見した在庫の追加履歴管理・PC管理者ダッシュボード・完全バックアップ機能
 */

window.addEventListener('DOMContentLoaded', () => {
    loadFromLocalStorage();
    renderWorkerSelect();
    renderLocationFilters();
    renderAllViews();
    if (getActiveGasUrl()) {
        fetchAllFromGasApi(false);
    } else {
        updateSyncStatusDot('offline');
    }
});

function openGasConfigModal() {
    SFX.key();
    const currentUrl = getActiveGasUrl();
    const isConnected = Boolean(currentUrl);

    document.getElementById('modal-title').textContent = `⚙️ スプレッドシート(GAS) 接続設定 (${APP_VERSION})`;
    document.getElementById('modal-body').innerHTML = `
        <div class="space-y-3">
            <div class="p-3 rounded-xl border ${isConnected ? 'bg-emerald-50 border-emerald-300' : 'bg-amber-50 border-amber-300'} text-xs space-y-1">
                <div class="font-bold ${isConnected ? 'text-emerald-900' : 'text-amber-900'}">
                    ${isConnected ? '✅ 現在GAS URLが設定されています（この端末のみに安全に保存）' : '⚠️ GASのURLがまだ設定されていません'}
                </div>
                <p class="text-[11px] text-slate-600">
                    ※GASの「デプロイを管理」で「アクセスできるユーザー：<b>全員</b>」、URL末尾が <b>/exec</b> になっていることをご確認ください。
                </p>
            </div>

            <div>
                <label class="font-bold text-slate-700 block mb-1 text-xs">🔗 GAS ウェブアプリのURL（.../exec）：</label>
                <input id="gas-modal-url-input" type="url" value="${currentUrl}"
                       placeholder="https://script.google.com/macros/s/XXXX/exec"
                       class="w-full border-2 border-blue-400 rounded-xl px-3 py-2 text-xs font-mono bg-white">
            </div>

            <div class="flex flex-wrap gap-2">
                <button onclick="saveGasUrlFromModal()" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-4 rounded-xl text-xs shadow">
                    💾 URLを保存して今すぐ同期
                </button>
                <button onclick="clearGasUrlFromModal()" class="bg-rose-100 text-rose-700 font-bold py-2.5 px-3 rounded-xl text-xs">
                    クリア
                </button>
            </div>

            <div class="border-t pt-3 space-y-1.5">
                <label class="font-bold text-slate-700 block text-xs">👥 他の作業スタッフ（最大15名）のスマホへ設定を配る：</label>
                <p class="text-[11px] text-slate-500">
                    下のボタンを押すと、GASのURLが自動セットされる配布用リンクをコピーできます。LINEやメールでスタッフに送って開いてもらうだけで設定が完了します。
                </p>
                <button onclick="copyStaffShareLink()" class="w-full bg-slate-800 hover:bg-slate-700 text-amber-300 font-bold py-2.5 px-3 rounded-xl text-xs">
                    📋 スタッフ配布用リンク（GAS自動設定付き）をコピー
                </button>
            </div>
        </div>
    `;
    openModal();
}

function saveGasUrlFromModal() {
    const val = document.getElementById('gas-modal-url-input').value.trim();
    if (!val) {
        SFX.err();
        showToast('GASのURLを入力してください');
        return;
    }
    setActiveGasUrl(val);
    closeModal();
    SFX.next();
    fetchAllFromGasApi(true);
}

function clearGasUrlFromModal() {
    setActiveGasUrl('');
    document.getElementById('gas-modal-url-input').value = '';
    updateSyncStatusDot('offline');
    showToast('この端末のGAS接続URLを消去しました');
}

function copyStaffShareLink() {
    const val = (document.getElementById('gas-modal-url-input')?.value || getActiveGasUrl()).trim();
    if (!val) {
        SFX.err();
        showToast('先にGASのURLを入力してください');
        return;
    }
    setActiveGasUrl(val);
    const baseUrl = window.location.origin + window.location.pathname;
    const shareUrl = `${baseUrl}?gas=${encodeURIComponent(val)}`;
    navigator.clipboard.writeText(shareUrl).then(() => {
        SFX.next();
        showToast('📋 スタッフ配布用リンクをコピーしました！');
    });
}

function renderWorkerSelect() {
    const sel = document.getElementById('worker-select');
    sel.innerHTML = masterData.workers.slice(0, 15).map(w =>
        `<option value="${w}" ${w === appState.currentWorker ? 'selected' : ''}>👤 ${w}</option>`
    ).join('');
}

function onWorkerChange(workerName) {
    appState.currentWorker = workerName;
    saveToLocalStorage();
    showToast(`担当者を「${workerName}」に切り替えました`);
}

function renderLocationFilters() {
    const fill = (id, arr, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        const opts = ['すべて', ...arr];
        el.innerHTML = opts.map(o => `<option value="${o}" ${o === val ? 'selected' : ''}>${o}</option>`).join('');
    };
    fill('m-sel-area', masterData.areas, appState.filterArea);
    fill('m-sel-shelf', masterData.shelves, appState.filterShelf);
    fill('m-sel-level', masterData.levels, appState.filterLevel);

    const pcArea = document.getElementById('pc-filter-area');
    if (pcArea) {
        pcArea.innerHTML = ['すべて', ...masterData.areas].map(a => `<option value="${a}">${a}</option>`).join('');
    }
}

function onMobileLocationFilter() {
    appState.filterArea = document.getElementById('m-sel-area').value;
    appState.filterShelf = document.getElementById('m-sel-shelf').value;
    appState.filterLevel = document.getElementById('m-sel-level').value;
    const list = getFilteredMobileRecords();
    if (list.length > 0 && !list.some(r => r.id === appState.selectedRecordId)) {
        appState.selectedRecordId = list[0].id;
        appState.inputBuffer = '';
    }
    renderAllViews();
}

function renderAllViews() {
    renderMobileTopCard();
    renderMobileDetailsAndList();
    if (appState.isAdminUnlocked) {
        renderAdminKpis();
        renderAdminTables();
        renderMasterSettingsTab();
    }
    saveToLocalStorage();
}

function renderMobileTopCard() {
    const rec = getCurrentRecord();
    if (!rec) return;

    document.getElementById('m-cur-location').textContent = `📍 ${rec.area} / ${rec.shelf} / ${rec.level}`;
    const badge = document.getElementById('m-cur-status-badge');
    if (rec.counted) {
        badge.textContent = `済 (${rec.worker})`;
        badge.className = 'bg-emerald-600 text-white px-1.5 py-0.5 rounded text-[10px] font-bold';
    } else {
        badge.textContent = '未入力';
        badge.className = 'bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded text-[10px]';
    }

    document.getElementById('m-cur-name').textContent = rec.name;
    document.getElementById('m-cur-unit').textContent = rec.unit;
    document.getElementById('m-cur-unit-sub1').textContent = rec.unit;
    document.getElementById('m-cur-unit-sub2').textContent = rec.unit;

    document.getElementById('m-cur-prev').textContent = rec.prevQty;
    const totalHere = getRecordTotalQty(rec);
    document.getElementById('m-cur-actual').textContent = totalHere;
    document.getElementById('m-input-mode-label').textContent =
        rec.addedQty > 0 ? `今回計 (初回${rec.baseQty}+追${rec.addedQty})` : '今回実棚数';

    const sameProducts = inventoryRecords.filter(r => r.jan === rec.jan && r.unit === rec.unit);
    const allActual = sameProducts.reduce((s, r) => s + getRecordTotalQty(r), 0);
    const allPrev = sameProducts.reduce((s, r) => s + (Number(r.prevQty) || 0), 0);
    const diff = allActual - allPrev;

    document.getElementById('m-cur-total-all').textContent = `${allActual}${rec.unit}`;
    const diffEl = document.getElementById('m-cur-diff');
    diffEl.textContent = diff > 0 ? `+${diff}` : `${diff}`;
    diffEl.className = diff === 0 ? 'text-emerald-400' : diff > 0 ? 'text-sky-400' : 'text-rose-400';
}

function renderMobileDetailsAndList() {
    const rec = getCurrentRecord();
    if (!rec) return;

    document.getElementById('m-detail-jan').textContent = rec.jan;
    document.getElementById('m-detail-maker').textContent = rec.maker;
    document.getElementById('m-detail-price').textContent = `¥${Number(rec.price).toLocaleString()}`;

    const unitSel = document.getElementById('m-detail-unit-select');
    unitSel.innerHTML = masterData.units.map(u =>
        `<option value="${u}" ${u === rec.unit ? 'selected' : ''}>${u}</option>`
    ).join('');

    const sameJanList = inventoryRecords.filter(r => r.jan === rec.jan);
    document.getElementById('m-same-product-locations').innerHTML = sameJanList.map(r => {
        const isCur = r.id === rec.id;
        const tot = getRecordTotalQty(r);
        return `
            <div onclick="selectRecordById('${r.id}', true)" class="p-1.5 rounded-lg border flex justify-between items-center cursor-pointer ${isCur ? 'bg-blue-50 border-blue-400 font-bold' : 'bg-slate-50 border-slate-200'}">
                <span>📍 ${r.area} / ${r.shelf} / ${r.level}</span>
                <span class="font-mono">初回:${r.baseQty} ${r.addedQty > 0 ? `<b class="text-amber-600">+追:${r.addedQty}</b>` : ''} = <b>${tot}${r.unit}</b></span>
            </div>
        `;
    }).join('');

    const logs = addStockLogs.filter(l => l.jan === rec.jan);
    const logContainer = document.getElementById('m-add-logs-list');
    if (logs.length === 0) {
        logContainer.innerHTML = `<div class="text-slate-400">追加発見された履歴はありません</div>`;
    } else {
        logContainer.innerHTML = logs.map(l => `
            <div class="bg-amber-50 border border-amber-200 rounded p-1.5 flex justify-between items-center">
                <div>
                    <span class="font-bold text-amber-900">＋${l.addedQty}${l.unit}</span>
                    <span class="text-slate-700">(${l.area}/${l.shelf}/${l.level})</span>
                    <div class="text-[10px] text-slate-500">${l.timestamp} 担当:${l.worker} ${l.memo ? `「${l.memo}」` : ''}</div>
                </div>
            </div>
        `).join('');
    }

    const filtered = getFilteredMobileRecords();
    const doneCount = filtered.filter(r => r.counted).length;
    document.getElementById('m-progress-text').textContent = `完了 ${doneCount} / ${filtered.length} 件`;

    document.getElementById('m-inventory-list').innerHTML = filtered.map(r => {
        const isSel = r.id === rec.id;
        const tot = getRecordTotalQty(r);
        return `
            <div onclick="selectRecordById('${r.id}', true)" class="px-2.5 py-2 flex items-center justify-between cursor-pointer ${isSel ? 'bg-amber-100 border-l-4 border-amber-500 font-bold' : 'hover:bg-slate-50'}">
                <div class="min-w-0 pr-2">
                    <div class="text-slate-900 truncate">${r.name} <span class="bg-slate-200 text-slate-700 px-1 rounded text-[10px]">${r.unit}</span></div>
                    <div class="text-[10px] text-slate-500">${r.area}・${r.shelf}・${r.level}</div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                    <div class="text-right font-mono">
                        <div class="text-xs font-bold ${r.counted ? 'text-blue-700' : 'text-slate-400'}">${tot} ${r.unit}</div>
                        <div class="text-[10px] text-slate-400">前:${r.prevQty}</div>
                    </div>
                    ${r.counted
                        ? '<span class="bg-emerald-100 text-emerald-800 text-[10px] px-1.5 py-0.5 rounded font-bold">済</span>'
                        : '<span class="bg-slate-200 text-slate-600 text-[10px] px-1.5 py-0.5 rounded">未</span>'}
                </div>
            </div>
        `;
    }).join('');
}

function selectRecordById(id, autoSpeak = false) {
    appState.selectedRecordId = id;
    appState.inputBuffer = '';
    SFX.key();
    renderAllViews();
    if (autoSpeak) speakCurrentRecord(false);
}

function changeCurrentProductUnit(newUnit) {
    const rec = getCurrentRecord();
    if (!rec) return;
    rec.unit = newUnit;
    SFX.key();
    syncRecordToGasSheet(rec, null);
    renderAllViews();
    showToast(`単位を「${newUnit}」に変更しました`);
}

function applyBufferToCurrentRecord() {
    const rec = getCurrentRecord();
    if (!rec) return;
    const val = parseInt(appState.inputBuffer || '0', 10);
    rec.baseQty = isNaN(val) ? 0 : val;
    renderAllViews();
}

function pressNumKey(digit) {
    SFX.key();
    if (appState.inputBuffer.length >= 5) return;
    if (appState.inputBuffer === '0') appState.inputBuffer = '';
    appState.inputBuffer += digit;
    applyBufferToCurrentRecord();
}

function clearQtyInput() {
    SFX.key();
    appState.inputBuffer = '0';
    applyBufferToCurrentRecord();
    appState.inputBuffer = '';
}

function backspaceQty() {
    SFX.key();
    const rec = getCurrentRecord();
    const s = String(rec.baseQty);
    const next = s.length > 1 ? s.slice(0, -1) : '0';
    appState.inputBuffer = next === '0' ? '' : next;
    rec.baseQty = parseInt(next, 10);
    renderAllViews();
}

function adjustQty(delta) {
    SFX.key();
    const rec = getCurrentRecord();
    rec.baseQty = Math.max(0, (Number(rec.baseQty) || 0) + delta);
    appState.inputBuffer = String(rec.baseQty);
    renderAllViews();
}

function copyPrevQty() {
    SFX.key();
    const rec = getCurrentRecord();
    rec.baseQty = rec.prevQty;
    appState.inputBuffer = String(rec.baseQty);
    renderAllViews();
}

function confirmAndNextRecord() {
    const rec = getCurrentRecord();
    if (!rec) return;
    rec.counted = true;
    rec.worker = appState.currentWorker;
    rec.updatedAt = formatNow();
    appState.inputBuffer = '';
    SFX.next();

    syncRecordToGasSheet(rec, null);

    const list = getFilteredMobileRecords();
    const pool = list.length > 0 ? list : inventoryRecords;
    const idx = pool.findIndex(r => r.id === rec.id);
    const nextRec = pool[(idx + 1) % pool.length];
    appState.selectedRecordId = nextRec.id;
    renderAllViews();

    const allDone = inventoryRecords.every(r => r.counted);
    if (allDone) {
        speakText(`${getRecordTotalQty(rec)}${rec.unit}、確定！全完了しました！`);
        showToast('🎉 全商品の棚卸し入力が完了しました！');
    } else {
        speakCurrentRecord(false, `${getRecordTotalQty(rec)}${rec.unit}確定。次、`);
    }
}

function movePrevRecord() {
    SFX.key();
    appState.inputBuffer = '';
    const list = getFilteredMobileRecords();
    const pool = list.length > 0 ? list : inventoryRecords;
    const idx = pool.findIndex(r => r.id === appState.selectedRecordId);
    const prevRec = pool[(idx - 1 + pool.length) % pool.length];
    appState.selectedRecordId = prevRec.id;
    renderAllViews();
    speakCurrentRecord(false, '前へ。');
}

function handleBarcodeScan(janCode) {
    const code = (janCode || '').trim();
    if (!code) return;
    document.getElementById('barcode-input').value = '';

    const matches = inventoryRecords.filter(r => r.jan === code);
    if (matches.length === 0) {
        SFX.err();
        showToast(`未登録JAN (${code}) です。新規商品登録を開きます`);
        speakText('未登録のJANコードです');
        openNewMasterModal(code);
        return;
    }

    SFX.scan();
    const curAreaMatch = matches.find(r =>
        (appState.filterArea === 'すべて' || r.area === appState.filterArea) &&
        (appState.filterShelf === 'すべて' || r.shelf === appState.filterShelf)
    ) || matches[0];

    appState.selectedRecordId = curAreaMatch.id;
    appState.inputBuffer = '';
    renderAllViews();
    speakCurrentRecord(false);

    if (curAreaMatch.counted || matches.length > 1) {
        openScanActionChoiceModal(code, matches);
    } else {
        showToast(`スキャン読込: ${curAreaMatch.name}`);
    }
}

function openScanActionChoiceModal(jan, matches) {
    const first = matches[0];
    document.getElementById('modal-title').textContent = `📦 スキャン商品: ${first.name}`;
    document.getElementById('modal-body').innerHTML = `
        <div class="bg-slate-100 p-3 rounded-xl text-xs space-y-1">
            <div>JAN: <b class="font-mono">${jan}</b> / 単位: <b class="bg-amber-300 px-1.5 py-0.5 rounded">${first.unit}</b></div>
            <div class="text-slate-600">この商品は <b>${matches.length}箇所</b> に登録されています。操作を選んでください。</div>
        </div>

        <div class="space-y-2">
            <button onclick="closeModal(); openAddFoundStockModal('${first.id}');" class="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-3 px-4 rounded-xl text-left flex justify-between items-center shadow">
                <span>➕ 後から見つかった在庫として「追加登録」する（場所・追加数を記録）</span>
                <span>▶</span>
            </button>

            <div class="font-bold text-slate-700 pt-2">📍 既存の棚を選択してカウント修正する：</div>
            ${matches.map(m => `
                <button onclick="closeModal(); selectRecordById('${m.id}', true);" class="w-full bg-slate-50 hover:bg-blue-50 border border-slate-300 p-2.5 rounded-xl text-left flex justify-between items-center">
                    <span>${m.area} / ${m.shelf} / ${m.level}</span>
                    <span class="font-mono font-bold">現在: ${getRecordTotalQty(m)}${m.unit} (${m.counted ? '確定済' : '未'})</span>
                </button>
            `).join('')}
        </div>
    `;
    openModal();
}

function openAddFoundStockModal(targetRecordId = null) {
    SFX.key();
    const rec = targetRecordId
        ? inventoryRecords.find(r => r.id === targetRecordId)
        : getCurrentRecord();
    if (!rec) return;

    document.getElementById('modal-title').textContent = '➕ 後から見つかった在庫の追加登録';
    document.getElementById('modal-body').innerHTML = `
        <div class="bg-amber-50 border border-amber-300 p-3 rounded-xl text-xs space-y-1">
            <div class="font-bold text-sm text-slate-900">${rec.name} <span class="bg-amber-400 px-2 py-0.5 rounded text-xs">単位: ${rec.unit}</span></div>
            <div class="text-slate-600">JAN: ${rec.jan} / 現在までの全場所合計: <b>${inventoryRecords.filter(r=>r.jan===rec.jan).reduce((s,r)=>s+getRecordTotalQty(r),0)} ${rec.unit}</b></div>
            <p class="text-[11px] text-amber-900">※既存のカウント数を消さずに、「どこで・いくつ追加発見したか」を履歴付きで加算します。</p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div>
                <label class="font-bold text-slate-700 block mb-1">📍 発見したエリア</label>
                <select id="add-stock-area" class="w-full border border-slate-300 rounded-lg px-2 py-1.5 font-bold">
                    ${masterData.areas.map(a => `<option value="${a}" ${a === rec.area ? 'selected' : ''}>${a}</option>`).join('')}
                </select>
            </div>
            <div>
                <label class="font-bold text-slate-700 block mb-1">🗄️ 発見した棚番号</label>
                <select id="add-stock-shelf" class="w-full border border-slate-300 rounded-lg px-2 py-1.5 font-bold">
                    ${masterData.shelves.map(s => `<option value="${s}" ${s === rec.shelf ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
            </div>
            <div>
                <label class="font-bold text-slate-700 block mb-1">📶 発見した段</label>
                <select id="add-stock-level" class="w-full border border-slate-300 rounded-lg px-2 py-1.5 font-bold">
                    ${masterData.levels.map(l => `<option value="${l}" ${l === rec.level ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
            </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
                <label class="font-bold text-slate-700 block mb-1">➕ 追加する数量（単位: ${rec.unit}）</label>
                <input id="add-stock-qty" type="number" inputmode="numeric" value="1" min="1" class="w-full border-2 border-amber-500 rounded-lg px-3 py-2 text-lg font-mono font-bold">
            </div>
            <div>
                <label class="font-bold text-slate-700 block mb-1">📝 発見状況メモ（任意）</label>
                <input id="add-stock-memo" type="text" placeholder="例: バックヤード奥の段ボールから発見" class="w-full border border-slate-300 rounded-lg px-2.5 py-2">
            </div>
        </div>

        <div class="flex justify-end gap-2 pt-3 border-t">
            <button onclick="closeModal()" class="bg-slate-200 px-4 py-2 rounded-xl font-bold">キャンセル</button>
            <button onclick="commitAddFoundStock('${rec.jan}')" class="bg-amber-500 hover:bg-amber-400 text-slate-950 px-5 py-2 rounded-xl font-bold shadow">
                ＋ 追加分を登録して記録
            </button>
        </div>
    `;
    openModal();
}

function commitAddFoundStock(jan) {
    const baseProduct = inventoryRecords.find(r => r.jan === jan);
    if (!baseProduct) return;

    const area = document.getElementById('add-stock-area').value;
    const shelf = document.getElementById('add-stock-shelf').value;
    const level = document.getElementById('add-stock-level').value;
    const addedQty = parseInt(document.getElementById('add-stock-qty').value || '0', 10);
    const memo = document.getElementById('add-stock-memo').value.trim();

    if (!addedQty || addedQty <= 0) {
        SFX.err();
        showToast('追加する数量を1以上で入力してください');
        return;
    }

    let targetRec = inventoryRecords.find(r =>
        r.jan === jan && r.area === area && r.shelf === shelf && r.level === level
    );

    if (targetRec) {
        targetRec.addedQty = (Number(targetRec.addedQty) || 0) + addedQty;
        targetRec.counted = true;
        targetRec.worker = appState.currentWorker;
        targetRec.updatedAt = formatNow();
    } else {
        targetRec = {
            id: 'REC-' + Date.now(),
            jan: baseProduct.jan,
            name: baseProduct.name,
            maker: baseProduct.maker,
            unit: baseProduct.unit,
            price: baseProduct.price,
            area,
            shelf,
            level,
            prevQty: 0,
            baseQty: 0,
            addedQty: addedQty,
            counted: true,
            worker: appState.currentWorker,
            updatedAt: formatNow()
        };
        inventoryRecords.push(targetRec);
    }

    const newLog = {
        logId: 'LOG-' + Date.now(),
        timestamp: formatNow(),
        worker: appState.currentWorker,
        recordId: targetRec.id,
        jan: baseProduct.jan,
        name: baseProduct.name,
        unit: baseProduct.unit,
        area,
        shelf,
        level,
        addedQty,
        memo: memo || '後から追加発見'
    };
    addStockLogs.unshift(newLog);

    appState.selectedRecordId = targetRec.id;
    closeModal();
    SFX.next();
    syncRecordToGasSheet(targetRec, newLog);
    renderAllViews();
    speakText(`${addedQty}${baseProduct.unit}追加しました！`);
    showToast(`「${area}/${shelf}/${level}」に ＋${addedQty}${baseProduct.unit} を追加記録しました`);
}

function openNewMasterModal(prefillJan = '') {
    SFX.key();
    document.getElementById('modal-title').textContent = '＋ 新規商品 / 複数保管場所の登録';
    document.getElementById('modal-body').innerHTML = `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
                <label class="font-bold text-slate-600 block mb-1">JANコード</label>
                <input id="new-jan" type="text" value="${prefillJan || '490123400' + (inventoryRecords.length + 201)}" class="w-full border rounded-lg px-2.5 py-1.5 font-mono">
            </div>
            <div>
                <label class="font-bold text-slate-600 block mb-1">商品名</label>
                <input id="new-name" type="text" placeholder="例: 特濃カフェオレ 500ml" class="w-full border rounded-lg px-2.5 py-1.5">
            </div>
            <div>
                <label class="font-bold text-slate-600 block mb-1">単位</label>
                <select id="new-unit" class="w-full border rounded-lg px-2.5 py-1.5 font-bold">
                    ${masterData.units.map(u => `<option value="${u}">${u}</option>`).join('')}
                </select>
            </div>
            <div>
                <label class="font-bold text-slate-600 block mb-1">メーカー</label>
                <input id="new-maker" list="dl-makers" placeholder="例: 関東飲料" class="w-full border rounded-lg px-2.5 py-1.5">
                <datalist id="dl-makers">${masterData.makers.map(m => `<option value="${m}">`).join('')}</datalist>
            </div>
            <div>
                <label class="font-bold text-slate-600 block mb-1">エリア</label>
                <input id="new-area" list="dl-areas" value="${appState.filterArea !== 'すべて' ? appState.filterArea : masterData.areas[0]}" class="w-full border rounded-lg px-2.5 py-1.5">
                <datalist id="dl-areas">${masterData.areas.map(a => `<option value="${a}">`).join('')}</datalist>
            </div>
            <div>
                <label class="font-bold text-slate-600 block mb-1">棚番号</label>
                <input id="new-shelf" list="dl-shelves" value="${appState.filterShelf !== 'すべて' ? appState.filterShelf : masterData.shelves[0]}" class="w-full border rounded-lg px-2.5 py-1.5">
                <datalist id="dl-shelves">${masterData.shelves.map(s => `<option value="${s}">`).join('')}</datalist>
            </div>
            <div>
                <label class="font-bold text-slate-600 block mb-1">段（何段目）</label>
                <input id="new-level" list="dl-levels" value="${appState.filterLevel !== 'すべて' ? appState.filterLevel : masterData.levels[0]}" class="w-full border rounded-lg px-2.5 py-1.5">
                <datalist id="dl-levels">${masterData.levels.map(l => `<option value="${l}">`).join('')}</datalist>
            </div>
            <div class="grid grid-cols-2 gap-1.5">
                <div>
                    <label class="font-bold text-slate-600 block mb-1">単価(円)</label>
                    <input id="new-price" type="number" value="150" class="w-full border rounded-lg px-2 py-1.5 font-mono">
                </div>
                <div>
                    <label class="font-bold text-slate-600 block mb-1">前回棚卸数</label>
                    <input id="new-prev" type="number" value="0" class="w-full border rounded-lg px-2 py-1.5 font-mono">
                </div>
            </div>
        </div>
        <div class="flex justify-end gap-2 pt-3 border-t">
            <button onclick="closeModal()" class="bg-slate-200 px-4 py-2 rounded-xl font-bold">キャンセル</button>
            <button onclick="saveNewRecordFromModal()" class="bg-blue-600 text-white px-5 py-2 rounded-xl font-bold">登録する</button>
        </div>
    `;
    openModal();
}

function saveNewRecordFromModal() {
    const jan = document.getElementById('new-jan').value.trim();
    const name = document.getElementById('new-name').value.trim();
    const unit = document.getElementById('new-unit').value;
    const maker = document.getElementById('new-maker').value.trim() || '未設定';
    const area = document.getElementById('new-area').value.trim() || '1F売場';
    const shelf = document.getElementById('new-shelf').value.trim() || '棚A-01';
    const level = document.getElementById('new-level').value.trim() || '1段目';
    const price = parseInt(document.getElementById('new-price').value || '0', 10);
    const prevQty = parseInt(document.getElementById('new-prev').value || '0', 10);

    if (!jan || !name) {
        SFX.err();
        showToast('JANコードと商品名は必須です');
        return;
    }

    let masterChanged = false;
    if (!masterData.makers.includes(maker)) { masterData.makers.push(maker); masterChanged = true; }
    if (!masterData.areas.includes(area)) { masterData.areas.push(area); masterChanged = true; }
    if (!masterData.shelves.includes(shelf)) { masterData.shelves.push(shelf); masterChanged = true; }
    if (!masterData.levels.includes(level)) { masterData.levels.push(level); masterChanged = true; }

    const newRec = {
        id: 'REC-' + Date.now(),
        jan, name, maker, unit, price, area, shelf, level,
        prevQty, baseQty: 0, addedQty: 0, counted: false,
        worker: appState.currentWorker, updatedAt: formatNow()
    };
    inventoryRecords.push(newRec);
    appState.selectedRecordId = newRec.id;

    if (masterChanged) syncMasterToGasSheet();
    syncRecordToGasSheet(newRec, null);

    renderLocationFilters();
    closeModal();
    SFX.next();
    renderAllViews();
    speakCurrentRecord(false, '新規登録！');
    showToast(`「${name} (${area}/${shelf})」を登録しました`);
}

function requestAdminView() {
    if (appState.isAdminUnlocked) {
        const isHidden = document.getElementById('admin-view').classList.contains('hidden');
        if (isHidden) {
            showAdminView();
        } else {
            switchToMobileView();
        }
        return;
    }

    document.getElementById('modal-title').textContent = '🔒 管理者専用メニュー（暗証番号認証）';
    document.getElementById('modal-body').innerHTML = `
        <p class="text-slate-600 text-xs">PC管理画面（全体進捗・二軸集計・マスタ編集）は管理者のみ閲覧可能です。暗証番号を入力してください。（初期値: <b>1234</b>）</p>
        <input id="admin-pin-input" type="password" inputmode="numeric" placeholder="暗証番号を入力"
               onkeydown="if(event.key==='Enter') verifyAdminPin()"
               class="w-full border-2 border-slate-400 rounded-xl px-3 py-2 text-center text-lg font-mono tracking-widest">
        <div class="flex justify-end gap-2 pt-2">
            <button onclick="closeModal()" class="bg-slate-200 px-4 py-2 rounded-xl font-bold">キャンセル</button>
            <button onclick="verifyAdminPin()" class="bg-slate-900 text-white px-5 py-2 rounded-xl font-bold">ロック解除</button>
        </div>
    `;
    openModal();
    setTimeout(() => document.getElementById('admin-pin-input')?.focus(), 60);
}

function verifyAdminPin() {
    const val = document.getElementById('admin-pin-input').value.trim();
    if (val === masterData.adminPin) {
        appState.isAdminUnlocked = true;
        closeModal();
        SFX.next();
        showAdminView();
        showToast('管理者ロックを解除しました');
    } else {
        SFX.err();
        showToast('暗証番号が違います');
    }
}

function showAdminView() {
    document.getElementById('mobile-view').classList.add('hidden');
    document.getElementById('admin-view').classList.remove('hidden');
    document.getElementById('btn-mode-switch').textContent = '📱スマホ';
    renderAllViews();
}

function switchToMobileView() {
    document.getElementById('admin-view').classList.add('hidden');
    document.getElementById('mobile-view').classList.remove('hidden');
    document.getElementById('btn-mode-switch').textContent = '🔒管理';
    renderAllViews();
}

function switchAdminTab(tabId) {
    ['tab-locations', 'tab-products', 'tab-addlogs', 'tab-masters'].forEach(id => {
        document.getElementById(id).classList.toggle('hidden', id !== tabId);
        const btn = document.getElementById('btn-' + id);
        if (btn) {
            btn.className = (id === tabId)
                ? 'bg-blue-600 text-white font-bold text-xs px-4 py-2 rounded-xl'
                : 'bg-white text-slate-700 border border-slate-300 font-bold text-xs px-4 py-2 rounded-xl';
        }
    });
}

function renderAdminKpis() {
    const totalLocs = inventoryRecords.length;
    const doneLocs = inventoryRecords.filter(r => r.counted).length;
    const pct = totalLocs > 0 ? Math.round((doneLocs / totalLocs) * 100) : 0;

    document.getElementById('pc-kpi-progress').textContent = `${doneLocs} / ${totalLocs} 箇所 (${pct}%)`;
    document.getElementById('pc-kpi-progress-bar').style.width = `${pct}%`;

    const totalAmount = inventoryRecords.reduce((s, r) => s + getRecordTotalQty(r) * (Number(r.price) || 0), 0);
    const prevAmount = inventoryRecords.reduce((s, r) => s + (Number(r.prevQty) || 0) * (Number(r.price) || 0), 0);
    document.getElementById('pc-kpi-total-amount').textContent = `¥${totalAmount.toLocaleString()}`;
    document.getElementById('pc-kpi-prev-amount').textContent = `前回総額: ¥${prevAmount.toLocaleString()}`;

    const addedTotalQty = addStockLogs.reduce((s, l) => s + (Number(l.addedQty) || 0), 0);
    document.getElementById('pc-kpi-added-count').textContent = `${addStockLogs.length} 件（計 +${addedTotalQty}）`;

    const products = getProductAggregatedList();
    const diffProducts = products.filter(p => p.actualTotal !== p.prevTotal).length;
    document.getElementById('pc-kpi-workers').textContent = `${masterData.workers.length} 名登録`;
    document.getElementById('pc-kpi-diff-alert').textContent = `前回比差異あり: ${diffProducts} 品目`;
}

function renderAdminTables() {
    const areaFilter = document.getElementById('pc-filter-area')?.value || 'すべて';
    const statusFilter = document.getElementById('pc-filter-status')?.value || 'all';

    const locRows = inventoryRecords.filter(r => {
        if (areaFilter !== 'すべて' && r.area !== areaFilter) return false;
        const tot = getRecordTotalQty(r);
        if (statusFilter === 'uncounted' && r.counted) return false;
        if (statusFilter === 'counted' && !r.counted) return false;
        if (statusFilter === 'diff' && tot === r.prevQty) return false;
        if (statusFilter === 'added' && (!r.addedQty || r.addedQty <= 0)) return false;
        return true;
    });

    document.getElementById('pc-location-tbody').innerHTML = locRows.map(r => {
        const tot = getRecordTotalQty(r);
        const diff = tot - r.prevQty;
        const amount = tot * (Number(r.price) || 0);
        return `
            <tr class="hover:bg-slate-50">
                <td class="p-2 font-bold text-slate-800">${r.area} / ${r.shelf} / ${r.level}</td>
                <td class="p-2">
                    <div class="font-bold">${r.name}</div>
                    <div class="text-[10px] font-mono text-slate-500">${r.jan}</div>
                </td>
                <td class="p-2 text-slate-600">${r.maker}</td>
                <td class="p-2 text-center"><span class="bg-amber-100 text-amber-900 font-bold px-2 py-0.5 rounded">${r.unit}</span></td>
                <td class="p-2 text-right font-mono">${r.prevQty}</td>
                <td class="p-2 text-right font-mono">${r.baseQty}</td>
                <td class="p-2 text-right font-mono ${r.addedQty > 0 ? 'text-amber-600 font-bold' : 'text-slate-400'}">
                    ${r.addedQty > 0 ? `+${r.addedQty}` : '0'}
                </td>
                <td class="p-2 text-right font-mono font-bold text-blue-700">${tot} ${r.unit}</td>
                <td class="p-2 text-right font-mono ${diff === 0 ? 'text-emerald-600' : diff > 0 ? 'text-sky-600' : 'text-rose-600'}">
                    ${diff > 0 ? `+${diff}` : diff}
                </td>
                <td class="p-2 text-right font-mono">¥${amount.toLocaleString()}</td>
                <td class="p-2 text-[11px]">
                    <div>${r.worker}</div>
                    <div class="text-slate-400">${r.counted ? '✅確定済' : '未入力'}</div>
                </td>
                <td class="p-2 text-center">
                    <button onclick="openAddFoundStockModal('${r.id}')" class="bg-amber-400 text-slate-950 font-bold px-2 py-1 rounded text-[11px]">
                        ＋追加
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    const prodList = getProductAggregatedList();
    document.getElementById('pc-product-tbody').innerHTML = prodList.map(p => {
        const diff = p.actualTotal - p.prevTotal;
        const amt = p.actualTotal * (Number(p.price) || 0);
        const breakdownHtml = p.locations.map(loc =>
            `<span class="inline-block bg-slate-100 border border-slate-300 rounded px-2 py-0.5 mr-1 mb-1 text-[11px]">
                📍${loc.area}/${loc.shelf}/${loc.level}: <b>${loc.totalQty}${p.unit}</b>
                ${loc.addedQty > 0 ? `<span class="text-amber-700">(内追加+${loc.addedQty})</span>` : ''}
            </span>`
        ).join('');

        return `
            <tr class="hover:bg-slate-50">
                <td class="p-2 font-mono">${p.jan}</td>
                <td class="p-2">
                    <div class="font-bold text-slate-900">${p.name}</div>
                    <div class="text-[11px] text-slate-500">${p.maker}</div>
                </td>
                <td class="p-2 text-center"><span class="bg-amber-100 text-amber-900 font-bold px-2 py-0.5 rounded">${p.unit}</span></td>
                <td class="p-2 text-right font-mono">¥${Number(p.price).toLocaleString()}</td>
                <td class="p-2">${breakdownHtml}</td>
                <td class="p-2 text-right font-mono">${p.prevTotal} ${p.unit}</td>
                <td class="p-2 text-right font-mono font-bold text-blue-700">${p.actualTotal} ${p.unit}</td>
                <td class="p-2 text-right font-mono font-bold ${diff === 0 ? 'text-emerald-600' : diff > 0 ? 'text-sky-600' : 'text-rose-600'}">
                    ${diff > 0 ? `+${diff}` : diff} ${p.unit}
                </td>
                <td class="p-2 text-right font-mono font-bold">¥${amt.toLocaleString()}</td>
            </tr>
        `;
    }).join('');

    document.getElementById('pc-addlogs-tbody').innerHTML = addStockLogs.map(l => `
        <tr class="hover:bg-amber-50/40">
            <td class="p-2 font-mono">${l.timestamp}</td>
            <td class="p-2 font-bold">${l.worker}</td>
            <td class="p-2 font-bold text-slate-800">📍 ${l.area} / ${l.shelf} / ${l.level}</td>
            <td class="p-2">${l.name} <span class="text-slate-400 font-mono">(${l.jan})</span></td>
            <td class="p-2 text-right font-mono font-bold text-amber-700">+${l.addedQty} ${l.unit}</td>
            <td class="p-2 text-slate-600">${l.memo}</td>
        </tr>
    `).join('');
}

function renderMasterSettingsTab() {
    const renderTags = (key, containerId) => {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = masterData[key].map(item => `
            <span class="bg-slate-100 border border-slate-300 px-2 py-0.5 rounded-lg flex items-center gap-1 text-[11px]">
                <b>${item}</b>
                <button onclick="removeMasterOption('${key}', '${item}')" class="text-rose-500 font-bold">×</button>
            </span>
        `).join('');
    };
    renderTags('areas', 'mst-list-areas');
    renderTags('shelves', 'mst-list-shelves');
    renderTags('levels', 'mst-list-levels');
    renderTags('units', 'mst-list-units');
    renderTags('makers', 'mst-list-makers');

    const wInput = document.getElementById('mst-workers-input');
    if (wInput) wInput.value = masterData.workers.join(', ');
    const pinInput = document.getElementById('mst-admin-pin');
    if (pinInput) pinInput.value = masterData.adminPin;
}

function addMasterOption(key, inputId) {
    const input = document.getElementById(inputId);
    const val = input.value.trim();
    if (!val) return;
    if (!masterData[key].includes(val)) {
        masterData[key].push(val);
        input.value = '';
        syncMasterToGasSheet();
        renderLocationFilters();
        renderAllViews();
        showToast(`「${val}」をマスタに追加しました`);
    }
}

function removeMasterOption(key, val) {
    if (masterData[key].length <= 1) return;
    masterData[key] = masterData[key].filter(x => x !== val);
    syncMasterToGasSheet();
    renderLocationFilters();
    renderAllViews();
}

function saveWorkersList() {
    const raw = document.getElementById('mst-workers-input').value;
    const list = raw.split(/,|、|\n/).map(s => s.trim()).filter(Boolean).slice(0, 15);
    if (list.length === 0) return;
    masterData.workers = list;
    appState.currentWorker = list[0];
    syncMasterToGasSheet();
    renderWorkerSelect();
    saveToLocalStorage();
    showToast(`作業スタッフ（${list.length}名）を更新しました`);
}

function updateAdminPin() {
    const pin = document.getElementById('mst-admin-pin').value.trim();
    if (!pin) return;
    masterData.adminPin = pin;
    syncMasterToGasSheet();
    saveToLocalStorage();
    showToast(`管理者暗証番号を「${pin}」に変更しました`);
}

function buildSpreadsheetText(mode = 'locations', delimiter = ',') {
    if (mode === 'products') {
        const header = ['JANコード', '商品名', 'メーカー', '単位', '単価', '前回総数', '今回総数', '総差異', '合計金額', '場所別内訳'];
        const rows = getProductAggregatedList().map(p => [
            p.jan, p.name, p.maker, p.unit, p.price, p.prevTotal, p.actualTotal,
            p.actualTotal - p.prevTotal, p.actualTotal * p.price,
            p.locations.map(l => `${l.area}/${l.shelf}/${l.level}:${l.totalQty}${p.unit}`).join(' | ')
        ]);
        return [header, ...rows].map(r => r.join(delimiter)).join('\n');
    }

    if (mode === 'addlogs') {
        const header = ['追加日時', '担当者', '発見エリア', '発見棚番号', '発見段', 'JANコード', '商品名', '追加数量', '単位', 'メモ'];
        const rows = addStockLogs.map(l => [
            l.timestamp, l.worker, l.area, l.shelf, l.level, l.jan, l.name, l.addedQty, l.unit, l.memo
        ]);
        return [header, ...rows].map(r => r.join(delimiter)).join('\n');
    }

    const header = ['レコードID', 'エリア', '棚番号', '段', 'JANコード', '商品名', 'メーカー', '単位', '単価', '前回数', '初回実棚', '後から追加数', '今回合計', '差異', '担当者', '状態', '更新日時'];
    const rows = inventoryRecords.map(r => {
        const tot = getRecordTotalQty(r);
        return [
            r.id, r.area, r.shelf, r.level, r.jan, r.name, r.maker, r.unit, r.price,
            r.prevQty, r.baseQty, r.addedQty, tot, tot - r.prevQty, r.worker,
            r.counted ? '確定済' : '未入力', r.updatedAt
        ];
    });
    return [header, ...rows].map(r => r.join(delimiter)).join('\n');
}

function openSpreadsheetModal() {
    SFX.key();
    const preview = buildSpreadsheetText('locations', ',');
    document.getElementById('modal-title').textContent = '📊 CSVダウンロード ＆ スプレッドシート貼付コピー';
    document.getElementById('modal-body').innerHTML = `
        <div class="space-y-2.5">
            <label class="font-bold text-slate-700 block text-xs">出力・コピーする集計軸を選択：</label>
            <div class="grid grid-cols-3 gap-1.5 text-xs">
                <button onclick="updateSheetPreview('locations')" class="bg-blue-600 text-white font-bold py-2 rounded-lg">📍 場所別明細</button>
                <button onclick="updateSheetPreview('products')" class="bg-indigo-600 text-white font-bold py-2 rounded-lg">📦 商品別合算</button>
                <button onclick="updateSheetPreview('addlogs')" class="bg-amber-500 text-slate-950 font-bold py-2 rounded-lg">➕ 後から追加履歴</button>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button onclick="downloadCurrentSheetCsv()" class="bg-emerald-600 text-white font-bold py-2.5 rounded-xl text-xs">
                    📥 CSVファイルをダウンロード
                </button>
                <button onclick="copyCurrentSheetTsv()" class="bg-slate-800 text-white font-bold py-2.5 rounded-xl text-xs">
                    📋 スプレッドシート貼付用コピー (Ctrl+V)
                </button>
            </div>

            <textarea id="sheet-preview-box" rows="6" class="w-full border rounded-lg p-2 font-mono text-[11px] bg-slate-50">${preview}</textarea>
        </div>
    `;
    openModal();
}

let currentSheetMode = 'locations';
function updateSheetPreview(mode) {
    currentSheetMode = mode;
    document.getElementById('sheet-preview-box').value = buildSpreadsheetText(mode, ',');
}

function downloadCurrentSheetCsv() {
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const csv = buildSpreadsheetText(currentSheetMode, ',');
    const blob = new Blob([bom, csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tanaoroshi_${currentSheetMode}_${Date.now()}.csv`;
    a.click();
    showToast('CSVをダウンロードしました');
}

function copyCurrentSheetTsv() {
    const tsv = buildSpreadsheetText(currentSheetMode, '\t');
    navigator.clipboard.writeText(tsv).then(() => {
        showToast('スプレッドシート貼り付け用(TSV)をコピーしました！');
    });
}

// ==========================================================
// バックアップ機能（全データJSON ＆ フルソースコード結合コピー/ダウンロード）
// ==========================================================
async function buildFullSourceBundleText() {
    const htmlContent = document.documentElement.outerHTML;
    let coreJs = '';
    let uiJs = '';
    try {
        const r1 = await fetch('app-core.js?v=7');
        if (r1.ok) coreJs = await r1.text();
    } catch (e) {}
    try {
        const r2 = await fetch('app-ui.js?v=7');
        if (r2.ok) uiJs = await r2.text();
    } catch (e) {}

    if (coreJs && uiJs) {
        return `<!-- ===== index.html (${APP_VERSION}) ===== -->\n<!DOCTYPE html>\n${htmlContent}\n\n/* ===== app-core.js (${APP_VERSION}) ===== */\n${coreJs}\n\n/* ===== app-ui.js (${APP_VERSION}) ===== */\n${uiJs}`;
    }
    return `<!DOCTYPE html>\n${htmlContent}`;
}

function openBackupModal() {
    SFX.key();
    const safeMaster = Object.assign({}, masterData, { gasWebhookUrl: '' });
    const fullStateJson = JSON.stringify({
        version: APP_VERSION,
        exportedAt: formatNow(),
        masterData: safeMaster,
        inventoryRecords,
        addStockLogs
    }, null, 2);

    document.getElementById('modal-title').textContent = `💾 バックアップ ＆ ソースコード全文保存 (${APP_VERSION})`;
    document.getElementById('modal-body').innerHTML = `
        <p class="text-xs text-slate-600">
            現在の棚卸しデータ全体（マスタ・場所別実績・後から追加履歴）や、アプリケーションのソースコード全文をコピー・ファイル保存できます。
        </p>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button onclick="copyBackupDataJson()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-3 rounded-xl text-xs">
                📋 ① 全データをクリップボードにコピー
            </button>
            <button onclick="downloadBackupDataJson()" class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 px-3 rounded-xl text-xs">
                📥 ② 全データ(JSON)をダウンロード保存
            </button>
            <button onclick="copyAppSourceCode()" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 px-3 rounded-xl text-xs">
                📄 ③ アプリのコード全文をコピー
            </button>
            <button onclick="downloadAppSourceCode()" class="bg-slate-800 hover:bg-slate-900 text-white font-bold py-2.5 px-3 rounded-xl text-xs">
                💾 ④ アプリのHTMLコード自体をダウンロード
            </button>
        </div>

        <div>
            <label class="font-bold text-slate-700 block mb-1 text-xs">バックアップデータ / コード出力エリア（貼付で復元も可能）：</label>
            <textarea id="backup-textarea" rows="8" class="w-full border-2 border-slate-300 rounded-lg p-2 font-mono text-[11px] bg-slate-50">${fullStateJson}</textarea>
        </div>

        <div class="flex justify-between items-center pt-2 border-t">
            <button onclick="restoreFromBackupJson()" class="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-4 py-2 rounded-xl text-xs">
                🔄 上記JSONテキストからデータを復元（GASへも反映）
            </button>
            <button onclick="closeModal()" class="bg-slate-200 px-4 py-2 rounded-xl font-bold text-xs">閉じる</button>
        </div>
    `;
    openModal();
}

function copyBackupDataJson() {
    const text = document.getElementById('backup-textarea').value;
    navigator.clipboard.writeText(text).then(() => {
        showToast('バックアップデータをクリップボードにコピーしました');
    });
}

function downloadBackupDataJson() {
    const text = document.getElementById('backup-textarea').value;
    const blob = new Blob([text], { type: 'application/json;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `inventory_backup_${APP_VERSION}_${Date.now()}.json`;
    a.click();
    showToast('バックアップJSONファイルをダウンロードしました');
}

async function copyAppSourceCode() {
    const code = await buildFullSourceBundleText();
    document.getElementById('backup-textarea').value = code;
    navigator.clipboard.writeText(code).then(() => {
        showToast('アプリのソースコード全文をコピーしました');
    });
}

async function downloadAppSourceCode() {
    const code = await buildFullSourceBundleText();
    document.getElementById('backup-textarea').value = code;
    const blob = new Blob([code], { type: 'text/html;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `smart_inventory_app_${APP_VERSION}_${Date.now()}.html`;
    a.click();
    showToast('アプリのソースコードファイルをダウンロードしました');
}

function restoreFromBackupJson() {
    try {
        const raw = document.getElementById('backup-textarea').value.trim();
        const parsed = JSON.parse(raw);
        if (parsed.masterData && parsed.inventoryRecords) {
            const currentUrl = getActiveGasUrl();
            masterData = parsed.masterData;
            if (currentUrl) masterData.gasWebhookUrl = currentUrl;
            inventoryRecords = parsed.inventoryRecords;
            addStockLogs = parsed.addStockLogs || [];
            appState.selectedRecordId = inventoryRecords[0]?.id || '';
            postToGasApi({ action: 'restoreAll', payload: { masterData, inventoryRecords } });
            renderWorkerSelect();
            renderLocationFilters();
            renderAllViews();
            closeModal();
            SFX.next();
            showToast('バックアップデータから復元し、GASへ送信しました');
        } else {
            throw new Error('Invalid format');
        }
    } catch (e) {
        SFX.err();
        showToast('有効なバックアップJSONではありません');
    }
}

function openModal() {
    const el = document.getElementById('modal-overlay');
    el.classList.remove('hidden');
    el.classList.add('flex');
}

function closeModal() {
    const el = document.getElementById('modal-overlay');
    el.classList.add('hidden');
    el.classList.remove('flex');
    // モーダルを閉じたら直前の読取候補バッファをクリアして即座に次のスキャンを受け入れ可能にする
    if (typeof recentScanHits !== 'undefined') {
        recentScanHits = [];
    }
}

let toastTimer = null;
function showToast(msg) {
    const box = document.getElementById('toast-box');
    box.textContent = msg;
    box.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.add('hidden'), 4000);
}
