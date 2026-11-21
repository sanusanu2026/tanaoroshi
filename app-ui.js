/**
 * app-ui.js (v11)
 * ・当日カウント画面 / 事前ピックアップ専用画面（音声なし） / PC管理画面の3画面完全分離
 * ・進捗マップへの「今月金額 vs 先月金額・差額」比較表示
 * ・担当者15名 ＆ 読み上げ辞書のセル入力テーブルUI
 * ・元Excel数式保護流し込み生成 / 2次元バーコード配布 / コード全文バックアップ
 */

window.addEventListener('DOMContentLoaded', async () => {
    const importedFromQr = captureGasUrlFromQuery();
    loadFromLocalStorage();
    await loadProductsFromIDB();
    initSheetNoSelects();
    renderWorkerSelect();
    document.getElementById('m-field-lock').value = appState.fieldLock;
    applyFieldLockState();
    setupExcelDropZones();
    renderAllViews();
    updateSyncStatusDot(offlineQueue.length > 0 ? 'offline' : (getActiveGasUrl() ? 'ok' : 'offline'));
    if (importedFromQr) showToast('📱 QRコードからGAS接続先を自動設定しました！');
    if (getActiveGasUrl()) fetchAllFromGasApi(false);
});

// ==========================================================
// 1. 3画面完全分離（当日カウント / 事前ピックアップ / PC管理）
// ==========================================================
function switchView(viewName) {
    appState.currentView = viewName;

    // ピックアップ画面またはPC管理画面へ移るときは音声を完全停止
    if (viewName !== 'mobile') {
        stopVoiceAll();
    }

    document.getElementById('mobile-view').classList.toggle('hidden', viewName !== 'mobile');
    document.getElementById('pickup-view').classList.toggle('hidden', viewName !== 'pickup');
    document.getElementById('admin-view').classList.toggle('hidden', viewName !== 'admin');
    document.getElementById('mobile-nav-bar').classList.toggle('hidden', viewName === 'admin');

    const btnM = document.getElementById('nav-btn-mobile');
    const btnP = document.getElementById('nav-btn-pickup');
    if (btnM && btnP) {
        btnM.className = viewName === 'mobile'
            ? 'flex-1 py-1.5 rounded-lg text-xs font-extrabold bg-blue-600 text-white shadow'
            : 'flex-1 py-1.5 rounded-lg text-xs font-extrabold bg-slate-700 text-slate-300';
        btnP.className = viewName === 'pickup'
            ? 'flex-1 py-1.5 rounded-lg text-xs font-extrabold bg-amber-500 text-slate-950 shadow'
            : 'flex-1 py-1.5 rounded-lg text-xs font-extrabold bg-slate-700 text-slate-300';
    }

    updateCameraContainersVisibility();
    if (viewName === 'admin') {
        loadSettingsToCellTables();
        renderAdminDashboard();
    } else {
        renderMobileView();
        renderPickupView();
    }
}

function initSheetNoSelects() {
    const names = masterData.sheetNames || {};
    let html = '';
    for (let i = 1; i <= 200; i++) {
        const label = names[String(i)] ? `No.${i} (${names[String(i)]})` : `用紙 No.${i}`;
        html += `<option value="${i}">${label}</option>`;
    }
    ['m-sheet-no', 'p-sheet-no', 'pc-export-sheet-no'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.innerHTML = html; el.value = appState.currentSheetNo; }
    });
}

function renderWorkerSelect() {
    const sel = document.getElementById('worker-select');
    const valid = masterData.workers.filter(Boolean);
    sel.innerHTML = valid.map(w => `<option value="${w}">${w}</option>`).join('');
    if (!valid.includes(appState.currentWorker) && valid.length > 0) {
        appState.currentWorker = valid[0];
    }
    sel.value = appState.currentWorker;
}

function onWorkerChange(val) {
    appState.currentWorker = val;
    saveToLocalStorage();
}

function onSheetNoChange(val) {
    appState.currentSheetNo = Number(val) || 1;
    ['m-sheet-no', 'p-sheet-no', 'pc-export-sheet-no'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = appState.currentSheetNo;
    });
    const list = getCurrentSheetRecords();
    appState.selectedRecordId = list.length > 0 ? list[0].id : null;
    appState.inputBuffer = '';
    saveToLocalStorage();
    renderMobileView();
    renderPickupView();
}

function onFieldLockChange(val) {
    appState.fieldLock = val;
    applyFieldLockState();
    saveToLocalStorage();
    renderMobileCard();
}

function applyFieldLockState() {
    if (appState.fieldLock === 'upper') appState.activeField = 'upper';
    if (appState.fieldLock === 'lower') appState.activeField = 'lower';
    const rec = getCurrentRecord();
    if (rec) {
        const curVal = appState.activeField === 'upper' ? rec.qtyUpper : rec.qtyLower;
        appState.inputBuffer = (curVal === null || curVal === undefined) ? '' : String(curVal);
    }
}

function setActiveField(field) {
    if (appState.fieldLock === 'upper' && field === 'lower') return showToast('🔒 現在「棚上専用ロック」中です');
    if (appState.fieldLock === 'lower' && field === 'upper') return showToast('🔒 現在「棚下専用ロック」中です');
    appState.activeField = field;
    const rec = getCurrentRecord();
    if (rec) {
        const curVal = field === 'upper' ? rec.qtyUpper : rec.qtyLower;
        appState.inputBuffer = (curVal === null || curVal === undefined) ? '' : String(curVal);
    }
    renderMobileCard();
}

function getCurrentSheetRecords() {
    return inventoryRecords
        .filter(r => Number(r.sheetNo) === Number(appState.currentSheetNo))
        .sort((a, b) => (a.rowOrder || 0) - (b.rowOrder || 0));
}

function getCurrentRecord() {
    const list = getCurrentSheetRecords();
    return list.find(r => r.id === appState.selectedRecordId) || list[0] || null;
}

// ==========================================================
// 2. 異常値・差異チェック
// ==========================================================
function checkRecordAnomalies(r) {
    const cfg = masterData.alertSettings || defaultMaster.alertSettings;
    const reasons = [];
    const qU = Number(r.qtyUpper) || 0;
    const qL = Number(r.qtyLower) || 0;
    const total = qU + qL;
    const amt = total * (Number(r.price) || 0);
    const prevTot = (Number(r.prevUpper) || 0) + (Number(r.prevLower) || 0);
    const hasPrev = (r.prevUpper !== null && r.prevUpper !== undefined) || (r.prevLower !== null && r.prevLower !== undefined);

    if (total >= (Number(cfg.maxQty) || 100)) reasons.push(`数量${total}個`);
    if (amt >= (Number(cfg.maxAmount) || 50000)) reasons.push(`金額¥${amt.toLocaleString()}`);
    if (hasPrev && prevTot > 0) {
        if (cfg.warnZeroFromPrev && (r.status === 'uncounted' || total === 0)) {
            reasons.push(`先月${prevTot}→今回0/未`);
        } else if (total > 0) {
            const ratio = Math.max(total / prevTot, prevTot / total);
            if (ratio >= (Number(cfg.prevRatio) || 2.0)) reasons.push(`先月比${ratio.toFixed(1)}倍`);
        }
    }
    return reasons;
}

// ==========================================================
// 3. バーコードスキャン・手入力・やり直し・削除・備考・追加発見
// ==========================================================
function handleBarcodeScan(rawCode) {
    const jan = normalizeJan(rawCode);
    if (!jan) return;
    const inpM = document.getElementById('barcode-input');
    const inpP = document.getElementById('pickup-barcode-input');
    if (inpM) inpM.value = '';
    if (inpP) inpP.value = '';
    SFX.scan();

    const sheetList = getCurrentSheetRecords();

    // 当日カウント画面のとき：同じ用紙内に「未入力の同一JAN」があれば呼び出す
    if (appState.currentView === 'mobile') {
        const uncountedHit = sheetList.find(r => normalizeJan(r.jan) === jan && r.status !== 'done');
        if (uncountedHit) {
            selectRecord(uncountedHit.id, true);
            showToast(`🔍 呼出: ${uncountedHit.name}`);
            return;
        }
    }

    // 40行上限チェック
    if (sheetList.length >= 40) {
        SFX.err();
        alert(`用紙 No.${appState.currentSheetNo} は上限40行に達しています！次の用紙No.へ切り替えてください。`);
        return;
    }

    const info = lookupProductByJan(jan);
    const maxOrder = sheetList.reduce((m, r) => Math.max(m, r.rowOrder || 0), 0);
    const newRec = {
        id: 'REC-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        sheetNo: appState.currentSheetNo,
        rowOrder: maxOrder + 1,
        jan: info.jan, name: info.name, catMid: info.catMid, catSmall: info.catSmall, price: info.price,
        qtyUpper: null, qtyLower: null, prevUpper: null, prevLower: null,
        memo: '', addedQty: 0, status: 'uncounted', worker: appState.currentWorker, updatedAt: formatNow()
    };

    inventoryRecords.push(newRec);
    appState.selectedRecordId = newRec.id;
    appState.inputBuffer = '';
    saveToLocalStorage();
    postToGasApi({ action: 'saveRecord', record: newRec });
    renderAllViews();

    if (appState.currentView === 'pickup') {
        const lastEl = document.getElementById('pickup-last-added');
        if (lastEl) {
            lastEl.innerHTML = `<span class="text-emerald-300 font-bold truncate">✅ 行${sheetList.length + 1} 追加: ${newRec.name}</span><span class="font-mono text-amber-300 shrink-0">¥${newRec.price}</span>`;
        }
        showToast(`➕ 行${sheetList.length + 1}: ${newRec.name}`);
    } else {
        speakCurrentRecord(false);
        showToast(`➕ 行${sheetList.length + 1}に追加: ${newRec.name}`);
    }
}

function resetCurrentRecord() {
    const rec = getCurrentRecord();
    if (!rec) return;
    if (!confirm(`「${rec.name}」の今回カウント（棚上・棚下）を空欄に戻してやり直しますか？`)) return;
    rec.qtyUpper = null;
    rec.qtyLower = null;
    rec.status = 'uncounted';
    rec.updatedAt = formatNow();
    appState.inputBuffer = '';
    saveToLocalStorage();
    postToGasApi({ action: 'saveRecord', record: rec });
    renderAllViews();
    showToast('🔄 未入力状態に戻しました');
}

function deleteCurrentRecord() {
    const rec = getCurrentRecord();
    if (!rec) return;
    deleteRecordById(rec.id);
}

function deleteRecordById(id) {
    const rec = inventoryRecords.find(r => r.id === id);
    if (!rec) return;
    if (!confirm(`本当に削除しますか？\n用紙 No.${rec.sheetNo}\n「${rec.name}」`)) return;
    inventoryRecords = inventoryRecords.filter(r => r.id !== id);
    if (appState.selectedRecordId === id) {
        const nextList = getCurrentSheetRecords();
        appState.selectedRecordId = nextList.length > 0 ? nextList[0].id : null;
        appState.inputBuffer = '';
    }
    saveToLocalStorage();
    postToGasApi({ action: 'deleteRecord', id });
    renderAllViews();
    showToast('🗑️ 商品行を削除しました');
}

function openMemoModal() {
    const rec = getCurrentRecord();
    if (!rec) return;
    const tags = ['要確認', '破損・汚損', '値札なし', '別場所あり', '賞味期限近', '未登録JAN'];
    openModal(`📝 備考欄：${rec.name}`, `
        <div class="flex flex-wrap gap-1.5">
            ${tags.map(t => `<button onclick="appendMemoTag('${t}')" class="bg-amber-100 border border-amber-300 text-amber-900 font-bold text-xs px-2 py-1 rounded-lg">＋${t}</button>`).join('')}
        </div>
        <textarea id="inp-rec-memo" rows="3" placeholder="イレギュラーや確認事項を入力" class="w-full border rounded-lg p-2 text-xs">${rec.memo || ''}</textarea>
        <button onclick="saveCurrentMemo()" class="w-full bg-blue-600 text-white font-bold py-2.5 rounded-xl">備考を保存</button>
    `);
}

function appendMemoTag(tag) {
    const el = document.getElementById('inp-rec-memo');
    el.value = el.value ? `${el.value} / ${tag}` : tag;
}

function saveCurrentMemo() {
    const rec = getCurrentRecord();
    if (!rec) return;
    rec.memo = document.getElementById('inp-rec-memo').value.trim();
    rec.updatedAt = formatNow();
    saveToLocalStorage();
    postToGasApi({ action: 'saveRecord', record: rec });
    closeModal();
    renderAllViews();
    showToast('📝 備考を保存しました');
}

function openAddFoundStockModal() {
    const rec = getCurrentRecord();
    if (!rec) return;
    openModal(`➕ 追加発見の登録：${rec.name}`, `
        <p class="text-xs text-slate-600">現在のカウント（棚上:${rec.qtyUpper ?? 0} / 棚下:${rec.qtyLower ?? 0}）に後から見つかった在庫を履歴付きで加算します。</p>
        <div class="grid grid-cols-2 gap-2">
            <div>
                <label class="font-bold text-xs block mb-1">反映先</label>
                <select id="add-target-field" class="w-full border rounded-lg p-2 text-xs font-bold">
                    <option value="棚上">📦 棚上へ加算</option>
                    <option value="棚下">🗄️ 棚下へ加算</option>
                </select>
            </div>
            <div>
                <label class="font-bold text-xs block mb-1">追加数量</label>
                <input id="add-found-qty" type="number" inputmode="numeric" value="1" min="1" class="w-full border-2 border-amber-400 rounded-lg p-2 font-mono font-bold">
            </div>
        </div>
        <div>
            <label class="font-bold text-xs block mb-1">発見場所・メモ</label>
            <input id="add-found-memo" type="text" placeholder="例：バックヤード奥の箱から発見" class="w-full border rounded-lg p-2 text-xs">
        </div>
        <button onclick="commitAddFoundStock()" class="w-full bg-amber-500 text-slate-950 font-bold py-2.5 rounded-xl">＋ 追加発見を記録</button>
    `);
}

function commitAddFoundStock() {
    const rec = getCurrentRecord();
    if (!rec) return;
    const field = document.getElementById('add-target-field').value;
    const qty = parseInt(document.getElementById('add-found-qty').value || '0', 10);
    const memo = document.getElementById('add-found-memo').value.trim() || '後から追加発見';
    if (!qty || qty <= 0) return alert('1以上の数量を入力してください');

    if (field === '棚上') rec.qtyUpper = (Number(rec.qtyUpper) || 0) + qty;
    else rec.qtyLower = (Number(rec.qtyLower) || 0) + qty;

    rec.addedQty = (Number(rec.addedQty) || 0) + qty;
    rec.status = (rec.qtyUpper !== null && rec.qtyLower !== null) ? 'done' : 'partial';
    rec.worker = appState.currentWorker;
    rec.updatedAt = formatNow();

    const log = {
        logId: 'LOG-' + Date.now(),
        timestamp: formatNow(),
        worker: appState.currentWorker,
        recordId: rec.id,
        sheetNo: rec.sheetNo,
        jan: rec.jan, name: rec.name, targetField: field, addedQty: qty, memo
    };
    addStockLogs.unshift(log);
    saveToLocalStorage();
    postToGasApi({ action: 'saveRecord', record: rec, addLog: log });
    closeModal();
    SFX.next();
    renderAllViews();
    showToast(`➕ ${field}に +${qty} 追加記録しました`);
}

function openManualAddProductModal() {
    openModal(`＋ 商品を手入力追加`, `
        <div class="space-y-2">
            <div class="grid grid-cols-2 gap-2">
                <div>
                    <label class="font-bold text-xs block">用紙No. (1〜200)</label>
                    <input id="man-sheet" type="number" min="1" max="200" value="${appState.currentSheetNo}" class="w-full border rounded-lg p-1.5 font-mono">
                </div>
                <div>
                    <label class="font-bold text-xs block">部門(中分類)</label>
                    <select id="man-cat" class="w-full border rounded-lg p-1.5 text-xs">
                        <option value="一般">一般</option>
                        <option value="酒">酒</option>
                        <option value="その他">その他</option>
                    </select>
                </div>
            </div>
            <div>
                <label class="font-bold text-xs block">JANコード（空欄可）</label>
                <div class="flex gap-1">
                    <input id="man-jan" type="text" inputmode="numeric" placeholder="49..." class="flex-1 border rounded-lg p-1.5 font-mono">
                    <button onclick="autofillManualJan()" class="bg-slate-800 text-white text-xs px-2.5 rounded-lg">台帳検索</button>
                </div>
            </div>
            <div>
                <label class="font-bold text-xs block">商品名（必須）</label>
                <input id="man-name" type="text" placeholder="商品名を入力" class="w-full border rounded-lg p-1.5">
            </div>
            <div class="grid grid-cols-3 gap-2">
                <div><label class="font-bold text-xs block">上代税抜</label><input id="man-price" type="number" value="0" class="w-full border rounded-lg p-1.5 font-mono"></div>
                <div><label class="font-bold text-xs block">棚上(任意)</label><input id="man-upper" type="number" class="w-full border rounded-lg p-1.5 font-mono"></div>
                <div><label class="font-bold text-xs block">棚下(任意)</label><input id="man-lower" type="number" class="w-full border rounded-lg p-1.5 font-mono"></div>
            </div>
            <div>
                <label class="font-bold text-xs block">備考（任意）</label>
                <input id="man-memo" type="text" class="w-full border rounded-lg p-1.5 text-xs">
            </div>
            <button onclick="saveManualProduct()" class="w-full bg-blue-600 text-white font-bold py-2.5 rounded-xl">この内容で追加</button>
        </div>
    `);
}

function autofillManualJan() {
    const info = lookupProductByJan(document.getElementById('man-jan').value);
    document.getElementById('man-name').value = info.name;
    document.getElementById('man-price').value = info.price;
    if (info.catMid) document.getElementById('man-cat').value = info.catMid === '酒' ? '酒' : '一般';
}

function saveManualProduct() {
    const sheetNo = Number(document.getElementById('man-sheet').value) || appState.currentSheetNo;
    const jan = normalizeJan(document.getElementById('man-jan').value);
    const name = document.getElementById('man-name').value.trim();
    const catMid = document.getElementById('man-cat').value;
    const price = Number(document.getElementById('man-price').value) || 0;
    const uRaw = document.getElementById('man-upper').value.trim();
    const lRaw = document.getElementById('man-lower').value.trim();
    const memo = document.getElementById('man-memo').value.trim();
    if (!name) return alert('商品名を入力してください');

    const sheetList = inventoryRecords.filter(r => Number(r.sheetNo) === sheetNo);
    if (sheetList.length >= 40) return alert(`用紙 No.${sheetNo} は上限40行です`);

    const qU = uRaw === '' ? null : Number(uRaw);
    const qL = lRaw === '' ? null : Number(lRaw);
    const status = (qU !== null && qL !== null) ? 'done' : (qU !== null || qL !== null) ? 'partial' : 'uncounted';
    const maxOrder = sheetList.reduce((m, r) => Math.max(m, r.rowOrder || 0), 0);

    const newRec = {
        id: 'REC-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        sheetNo, rowOrder: maxOrder + 1, jan, name, catMid, catSmall: '', price,
        qtyUpper: qU, qtyLower: qL, prevUpper: null, prevLower: null,
        memo, addedQty: 0, status, worker: appState.currentWorker, updatedAt: formatNow()
    };
    inventoryRecords.push(newRec);
    appState.currentSheetNo = sheetNo;
    appState.selectedRecordId = newRec.id;
    initSheetNoSelects();
    saveToLocalStorage();
    postToGasApi({ action: 'saveRecord', record: newRec });
    closeModal();
    renderAllViews();
    showToast(`✅ 用紙No.${sheetNo}に追加しました`);
}

function openEditSheetNameModal() {
    const no = String(appState.currentSheetNo);
    const cur = (masterData.sheetNames && masterData.sheetNames[no]) || '';
    openModal(`✏️ 用紙 No.${no} の区画名設定`, `
        <input id="inp-sheet-name" type="text" value="${cur}" placeholder="例：入口特設、酒コーナー" class="w-full border rounded-lg p-2 text-sm">
        <button onclick="saveSheetName()" class="w-full bg-blue-600 text-white font-bold py-2 rounded-lg">区画名を保存</button>
    `);
}

function saveSheetName() {
    const no = String(appState.currentSheetNo);
    const val = document.getElementById('inp-sheet-name').value.trim();
    if (!masterData.sheetNames) masterData.sheetNames = {};
    if (val) masterData.sheetNames[no] = val;
    else delete masterData.sheetNames[no];
    saveToLocalStorage();
    postToGasApi({ action: 'saveMaster', masterData });
    initSheetNoSelects();
    closeModal();
    showToast(`✅ 用紙 No.${no} の区画名を更新しました`);
}

// ==========================================================
// 4. テンキー操作・確定
// ==========================================================
function pressNumKey(digit) {
    SFX.key();
    if (appState.inputBuffer === '0') appState.inputBuffer = digit;
    else appState.inputBuffer += digit;
    applyBufferToCurrentRecord();
}

function adjustQty(delta) {
    SFX.key();
    const cur = parseInt(appState.inputBuffer || '0', 10) || 0;
    appState.inputBuffer = String(Math.max(0, cur + delta));
    applyBufferToCurrentRecord();
}

function clearQtyInput() { SFX.key(); appState.inputBuffer = ''; applyBufferToCurrentRecord(); }
function backspaceQty() { SFX.key(); appState.inputBuffer = appState.inputBuffer.slice(0, -1); applyBufferToCurrentRecord(); }

function applyBufferToCurrentRecord() {
    const rec = getCurrentRecord();
    if (!rec) return;
    const val = appState.inputBuffer === '' ? null : parseInt(appState.inputBuffer, 10);
    if (appState.activeField === 'upper') rec.qtyUpper = val;
    else rec.qtyLower = val;
    renderMobileCard();
}

function copyPrevMonthQty() {
    const rec = getCurrentRecord();
    if (!rec) return;
    SFX.key();
    const prevVal = appState.activeField === 'upper' ? (rec.prevUpper ?? 0) : (rec.prevLower ?? 0);
    appState.inputBuffer = String(prevVal);
    applyBufferToCurrentRecord();
}

function confirmAndNextRecord() {
    const rec = getCurrentRecord();
    if (!rec) return;

    const qU = Number(rec.qtyUpper) || 0;
    const qL = Number(rec.qtyLower) || 0;
    if (qU >= 10000 || qL >= 10000) {
        SFX.err();
        if (!confirm(`⚠️ 桁数が大きすぎます（棚上:${qU} / 棚下:${qL}）。バーコード誤入力ではありませんか？`)) return;
    } else {
        const tempRec = Object.assign({}, rec, { status: 'done' });
        const anomalies = checkRecordAnomalies(tempRec);
        if (anomalies.length > 0) {
            SFX.err();
            if (!confirm(`⚠️ 確認アラート（${anomalies.join(' / ')}）\n${rec.name}\nこのまま確定してよろしいですか？`)) return;
        }
    }

    if (rec.qtyUpper !== null && rec.qtyLower !== null) rec.status = 'done';
    else if (rec.qtyUpper !== null || rec.qtyLower !== null) rec.status = 'partial';
    else rec.status = 'uncounted';

    rec.worker = appState.currentWorker;
    rec.updatedAt = formatNow();
    saveToLocalStorage();
    postToGasApi({ action: 'saveRecord', record: rec });
    SFX.next();

    const list = getCurrentSheetRecords();
    const idx = list.findIndex(r => r.id === rec.id);
    if (idx >= 0 && idx < list.length - 1) {
        selectRecord(list[idx + 1].id, true);
    } else {
        renderAllViews();
        speakText(`用紙${appState.currentSheetNo}番、完了`);
        showToast(`✅ 用紙 No.${appState.currentSheetNo} の最終行まで完了しました`);
    }
}

function movePrevRecord() {
    const list = getCurrentSheetRecords();
    const idx = list.findIndex(r => r.id === appState.selectedRecordId);
    if (idx > 0) selectRecord(list[idx - 1].id, true);
}

function selectRecord(id, autoSpeak = false) {
    appState.selectedRecordId = id;
    applyFieldLockState();
    renderMobileView();
    if (autoSpeak && appState.currentView === 'mobile') speakCurrentRecord(false);
}

// ==========================================================
// 5. 画面描画（当日カウント / ピックアップ専用 / 進捗金額比較マップ）
// ==========================================================
function renderAllViews() {
    renderMobileView();
    renderPickupView();
    if (appState.isAdminUnlocked) renderAdminDashboard();
}

function renderMobileView() {
    const list = getCurrentSheetRecords();
    const uncounted = list.filter(r => r.status === 'uncounted').length;
    document.getElementById('m-sheet-count-badge').textContent = `${list.length}/40`;
    document.getElementById('m-uncounted-badge').textContent = `未${uncounted}`;
    document.getElementById('m-master-badge').textContent = `台帳:${productMap.size.toLocaleString()}`;
    renderMobileCard();
    renderMobileList();
}

function renderMobileCard() {
    const rec = getCurrentRecord();
    const boxU = document.getElementById('box-qty-upper');
    const boxL = document.getElementById('box-qty-lower');
    boxU.className = appState.activeField === 'upper'
        ? 'text-left bg-blue-950 rounded-lg px-2 py-1 border-2 border-amber-400'
        : 'text-left bg-slate-800 rounded-lg px-2 py-1 border-2 border-slate-600 opacity-75';
    boxL.className = appState.activeField === 'lower'
        ? 'text-left bg-blue-950 rounded-lg px-2 py-1 border-2 border-amber-400'
        : 'text-left bg-slate-800 rounded-lg px-2 py-1 border-2 border-slate-600 opacity-75';

    if (!rec) {
        document.getElementById('m-cur-meta').textContent = `No.${appState.currentSheetNo} / 商品未登録`;
        document.getElementById('m-cur-name').textContent = 'スキャンまたは「＋手入力」で追加';
        document.getElementById('m-cur-prev-info').textContent = '先月:-';
        document.getElementById('m-cur-price-amt').textContent = '¥0';
        document.getElementById('m-val-upper').textContent = '-';
        document.getElementById('m-val-lower').textContent = '-';
        document.getElementById('m-val-total').textContent = '0';
        document.getElementById('btn-memo-badge').textContent = '📝備考';
        return;
    }

    const list = getCurrentSheetRecords();
    const rowIdx = list.findIndex(r => r.id === rec.id) + 1;
    const total = (Number(rec.qtyUpper) || 0) + (Number(rec.qtyLower) || 0);
    const amt = total * (Number(rec.price) || 0);
    document.getElementById('m-cur-meta').textContent = `No.${rec.sheetNo} / ${rowIdx}行目 / JAN:${rec.jan || '-'}`;
    document.getElementById('m-cur-name').textContent = rec.name;
    document.getElementById('m-cur-prev-info').textContent = `先月 上:${rec.prevUpper ?? '-'} 下:${rec.prevLower ?? '-'}`;
    document.getElementById('m-cur-price-amt').textContent = `¥${amt.toLocaleString()}`;
    document.getElementById('m-val-upper').textContent = rec.qtyUpper === null ? '-' : rec.qtyUpper;
    document.getElementById('m-val-lower').textContent = rec.qtyLower === null ? '-' : rec.qtyLower;
    document.getElementById('m-val-total').textContent = total;
    document.getElementById('btn-memo-badge').textContent = rec.memo ? '📝備考あり' : '📝備考';
}

function renderMobileList() {
    const onlyUncounted = document.getElementById('chk-only-uncounted').checked;
    const list = getCurrentSheetRecords();
    const filtered = onlyUncounted ? list.filter(r => r.status !== 'done') : list;
    const container = document.getElementById('m-inventory-list');
    if (filtered.length === 0) {
        container.innerHTML = `<div class="p-4 text-center text-slate-400">該当する商品がありません</div>`;
        return;
    }
    container.innerHTML = filtered.map((r) => {
        const rowNum = list.findIndex(x => x.id === r.id) + 1;
        const isSel = r.id === appState.selectedRecordId;
        const badge = r.status === 'done'
            ? '<span class="bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-bold">済</span>'
            : r.status === 'partial'
                ? '<span class="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold">片方</span>'
                : '<span class="bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded font-bold">未</span>';
        return `
        <div onclick="selectRecord('${r.id}', true)" class="p-2 flex items-center justify-between gap-2 cursor-pointer ${isSel ? 'bg-blue-50 border-l-4 border-blue-600' : 'hover:bg-slate-50'}">
            <div class="min-w-0 flex-1">
                <div class="font-bold text-slate-800 truncate">${rowNum}. ${r.name} ${r.memo ? '📝' : ''}</div>
                <div class="text-[10px] text-slate-500 font-mono">JAN:${r.jan || '-'} | ¥${r.price}</div>
            </div>
            <div class="text-right shrink-0">
                <div class="font-mono font-bold text-slate-900">上:${r.qtyUpper ?? '-'} / 下:${r.qtyLower ?? '-'}</div>
                <div class="mt-0.5">${badge}</div>
            </div>
        </div>`;
    }).join('');
}

function renderPickupView() {
    const list = getCurrentSheetRecords();
    const badge = document.getElementById('p-sheet-count-badge');
    if (badge) badge.textContent = `${list.length} / 40行`;
    const container = document.getElementById('p-inventory-list');
    if (!container) return;
    if (list.length === 0) {
        container.innerHTML = `<div class="p-6 text-center text-slate-400">まだ商品がありません。カメラで連続スキャンしてください。</div>`;
        return;
    }
    container.innerHTML = list.map((r, idx) => `
        <div class="p-2 flex items-center justify-between gap-2 hover:bg-slate-50">
            <div class="min-w-0 flex-1">
                <div class="font-bold text-slate-800 truncate">${idx + 1}. ${r.name}</div>
                <div class="text-[10px] text-slate-500 font-mono">JAN:${r.jan || '-'} | 上代:¥${r.price}</div>
            </div>
            <button onclick="deleteRecordById('${r.id}')" class="bg-rose-100 text-rose-700 font-bold text-[11px] px-2 py-1 rounded-lg shrink-0">削除</button>
        </div>
    `).join('');
}

/**
 * 進捗マップ（今月金額 vs 先月金額・差額を比較表示）
 */
function buildProgressMapHtml(clickHandlerName) {
    const bySheet = new Map();
    inventoryRecords.forEach(r => {
        const n = Number(r.sheetNo) || 1;
        if (!bySheet.has(n)) bySheet.set(n, []);
        bySheet.get(n).push(r);
    });
    let html = '';
    for (let i = 1; i <= 200; i++) {
        const list = bySheet.get(i) || [];
        const total = list.length;
        const done = list.filter(r => r.status === 'done').length;
        const partial = list.filter(r => r.status === 'partial').length;
        const hasMemo = list.some(r => r.memo);
        const lastWorker = list.find(r => r.worker)?.worker || '';

        let curAmt = 0, prevAmt = 0;
        list.forEach(r => {
            const p = Number(r.price) || 0;
            curAmt += ((Number(r.qtyUpper) || 0) + (Number(r.qtyLower) || 0)) * p;
            prevAmt += ((Number(r.prevUpper) || 0) + (Number(r.prevLower) || 0)) * p;
        });
        const diff = curAmt - prevAmt;
        const diffStr = diff > 0 ? `+¥${diff.toLocaleString()}` : diff < 0 ? `-¥${Math.abs(diff).toLocaleString()}` : '±¥0';
        const diffColor = diff > 0 ? 'text-blue-700' : diff < 0 ? 'text-rose-700' : 'text-slate-500';

        let bg = 'bg-slate-50 border-slate-200 text-slate-400';
        if (total > 0 && done === total) bg = 'bg-emerald-100 border-emerald-500 text-emerald-950';
        else if (done > 0 || partial > 0) bg = 'bg-amber-100 border-amber-400 text-amber-950';
        else if (total > 0) bg = 'bg-white border-slate-300 text-slate-800';

        const memoBorder = hasMemo ? 'ring-2 ring-rose-500' : '';
        const areaName = (masterData.sheetNames && masterData.sheetNames[String(i)]) || '';

        html += `
        <button onclick="${clickHandlerName}(${i})" class="p-2 rounded-xl border text-left text-[10px] leading-snug ${bg} ${memoBorder}">
            <div class="flex justify-between items-center font-extrabold">
                <span>No.${i}</span>
                <span class="text-[9px]">${total > 0 ? `${done}/${total}` : '-'}</span>
            </div>
            ${areaName ? `<div class="truncate text-[9px] font-bold text-indigo-800">${areaName}</div>` : ''}
            ${total > 0 ? `
            <div class="mt-1 font-mono text-[10px] font-bold">今:¥${curAmt.toLocaleString()}</div>
            <div class="font-mono text-[9px] text-slate-600">先:¥${prevAmt.toLocaleString()}</div>
            <div class="font-mono text-[9px] font-bold ${diffColor}">差:${diffStr}</div>
            ` : `<div class="mt-1 text-[9px]">未使用</div>`}
            ${lastWorker ? `<div class="truncate text-[9px] text-slate-500 mt-0.5">${lastWorker.split(':')[1] || lastWorker}</div>` : ''}
        </button>`;
    }
    return html;
}

function openSheetProgressMapModal() {
    openModal('🗺️ 用紙進捗 ＆ 金額比較マップ', `
        <p class="text-[11px] text-slate-600">今月金額・先月金額・差額を確認できます。タップでその用紙へ移動します。</p>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-[62vh] overflow-y-auto">${buildProgressMapHtml('jumpToSheetFromModal')}</div>
    `);
}

function jumpToSheetFromModal(no) {
    onSheetNoChange(no);
    closeModal();
}

// ==========================================================
// 6. PC管理画面・セル形式設定（担当者・読み上げ辞書）
// ==========================================================
function requestAdminView() {
    if (appState.isAdminUnlocked) return switchView('admin');
    const pin = prompt('管理者PINコードを入力してください（初期値: 1234）');
    if (pin === masterData.adminPin) {
        appState.isAdminUnlocked = true;
        switchView('admin');
    } else if (pin !== null) alert('PINコードが違います');
}

function switchAdminTab(tabId) {
    ['tab-excel', 'tab-map', 'tab-import', 'tab-logs', 'tab-settings'].forEach(id => {
        document.getElementById(id).classList.toggle('hidden', id !== tabId);
        const btn = document.getElementById('btn-' + id);
        btn.className = id === tabId
            ? 'bg-blue-600 text-white font-bold text-xs px-3.5 py-2 rounded-xl'
            : 'bg-white text-slate-700 border border-slate-300 font-bold text-xs px-3.5 py-2 rounded-xl';
    });
    if (tabId === 'tab-map') {
        document.getElementById('pc-progress-map-grid').innerHTML = buildProgressMapHtml('jumpToSheetInAdmin');
    }
    if (tabId === 'tab-settings') {
        loadSettingsToCellTables();
    }
}

function jumpToSheetInAdmin(no) {
    document.getElementById('pc-export-sheet-no').value = no;
    document.getElementById('pc-filter-mode').value = 'sheet';
    switchAdminTab('tab-excel');
    renderAdminExportTable();
}

function renderAdminDashboard() {
    let totalAmt = 0, prevAmt = 0, genAmt = 0, sakeAmt = 0, anomalyCnt = 0, memoCnt = 0, uncounted = 0;
    const sheets = new Set();

    inventoryRecords.forEach(r => {
        sheets.add(r.sheetNo);
        const tot = (Number(r.qtyUpper) || 0) + (Number(r.qtyLower) || 0);
        const pTot = (Number(r.prevUpper) || 0) + (Number(r.prevLower) || 0);
        const amt = tot * (Number(r.price) || 0);
        totalAmt += amt;
        prevAmt += pTot * (Number(r.price) || 0);
        if (r.catMid === '酒') sakeAmt += amt;
        else genAmt += amt;
        if (r.status === 'uncounted') uncounted++;
        if (r.memo) memoCnt++;
        if (checkRecordAnomalies(r).length > 0) anomalyCnt++;
    });

    document.getElementById('pc-kpi-amount').textContent = `¥${totalAmt.toLocaleString()}`;
    document.getElementById('pc-kpi-prev-amount').textContent = `先月計: ¥${prevAmt.toLocaleString()}`;
    document.getElementById('pc-kpi-general').textContent = `¥${genAmt.toLocaleString()}`;
    document.getElementById('pc-kpi-sake').textContent = `¥${sakeAmt.toLocaleString()}`;
    document.getElementById('pc-kpi-rows').textContent = `${inventoryRecords.length}行 (未${uncounted})`;
    document.getElementById('pc-kpi-alerts').textContent = `異常:${anomalyCnt} / 備考:${memoCnt}`;
    document.getElementById('pc-kpi-master-count').textContent = `${productMap.size.toLocaleString()} 件`;
    document.getElementById('pc-kpi-sheets').textContent = `使用中: ${sheets.size} 枚`;

    renderAdminExportTable();
    renderAdminAddLogsTable();
}

function renderAdminExportTable() {
    const mode = document.getElementById('pc-filter-mode').value;
    const sheetNo = Number(document.getElementById('pc-export-sheet-no').value) || 1;
    let list = [...inventoryRecords].sort((a, b) => (a.sheetNo - b.sheetNo) || (a.rowOrder - b.rowOrder));
    if (mode === 'sheet') list = list.filter(r => Number(r.sheetNo) === sheetNo);
    else if (mode === 'anomaly') list = list.filter(r => checkRecordAnomalies(r).length > 0);
    else if (mode === 'memo') list = list.filter(r => Boolean(r.memo));
    else if (mode === 'uncounted') list = list.filter(r => r.status === 'uncounted');

    const tbody = document.getElementById('pc-export-tbody');
    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="12" class="p-6 text-center text-slate-400">該当データがありません</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map((r) => {
        const total = (Number(r.qtyUpper) || 0) + (Number(r.qtyLower) || 0);
        const amt = total * (Number(r.price) || 0);
        const anomalies = checkRecordAnomalies(r);
        const rowBg = anomalies.length > 0 ? 'bg-rose-50' : 'hover:bg-slate-50';
        return `
        <tr class="${rowBg}">
            <td class="p-2 font-mono text-slate-500">No.${r.sheetNo}-${r.rowOrder}</td>
            <td class="p-2 font-mono font-bold">${r.jan}</td>
            <td class="p-2 font-bold">${r.name}</td>
            <td class="p-2 text-right font-mono">¥${(r.price || 0).toLocaleString()}</td>
            <td class="p-2 text-right font-mono text-amber-700">${r.prevUpper ?? '-'}/${r.prevLower ?? '-'}</td>
            <td class="p-2 text-right font-mono font-bold bg-blue-50">${r.qtyUpper ?? ''}</td>
            <td class="p-2 text-right font-mono font-bold bg-blue-50">${r.qtyLower ?? ''}</td>
            <td class="p-2 text-right font-mono font-bold">${total}</td>
            <td class="p-2 text-right font-mono">¥${amt.toLocaleString()}</td>
            <td class="p-2 text-[11px]">
                ${anomalies.length > 0 ? `<div class="text-rose-700 font-bold">⚠️ ${anomalies.join(' / ')}</div>` : ''}
                ${r.memo ? `<div class="text-slate-700">📝 ${r.memo}</div>` : ''}
            </td>
            <td class="p-2 text-[11px]">${r.worker || ''}</td>
            <td class="p-2 text-center"><button onclick="deleteRecordById('${r.id}')" class="text-rose-600 font-bold">削除</button></td>
        </tr>`;
    }).join('');
}

function renderAdminAddLogsTable() {
    const tbody = document.getElementById('pc-addlogs-tbody');
    if (addStockLogs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-400">追加発見の履歴はありません</td></tr>`;
        return;
    }
    tbody.innerHTML = addStockLogs.map(l => `
        <tr>
            <td class="p-2 font-mono">${l.timestamp}</td>
            <td class="p-2 font-bold">${l.worker}</td>
            <td class="p-2 font-mono">No.${l.sheetNo}</td>
            <td class="p-2 font-bold">${l.name} <span class="text-slate-400 font-mono">(${l.jan})</span></td>
            <td class="p-2">${l.targetField}</td>
            <td class="p-2 text-right font-mono font-bold text-amber-700">+${l.addedQty}</td>
            <td class="p-2">${l.memo}</td>
        </tr>
    `).join('');
}

// セル形式UI：担当者15名 ＆ 読み上げ辞書
function loadSettingsToCellTables() {
    const cfg = masterData.alertSettings || defaultMaster.alertSettings;
    document.getElementById('set-alert-qty').value = cfg.maxQty;
    document.getElementById('set-alert-amt').value = cfg.maxAmount;
    document.getElementById('set-alert-ratio').value = cfg.prevRatio;
    document.getElementById('set-alert-zero').checked = Boolean(cfg.warnZeroFromPrev);
    document.getElementById('mst-admin-pin').value = masterData.adminPin;

    renderWorkersCellTable();
    renderDictCellTable();
}

function renderWorkersCellTable() {
    const tbody = document.getElementById('workers-cell-tbody');
    let html = '';
    for (let i = 0; i < 15; i++) {
        const val = (masterData.workers && masterData.workers[i]) ? masterData.workers[i] : '';
        html += `
        <tr>
            <td class="p-1 text-center font-mono text-slate-500 bg-slate-50 border-r">${i + 1}</td>
            <td class="p-0"><input type="text" class="worker-cell-input w-full px-2 py-1.5 outline-none focus:bg-blue-50" value="${val}" placeholder="担当者名を入力"></td>
        </tr>`;
    }
    tbody.innerHTML = html;
}

function saveWorkersFromCells() {
    const inputs = document.querySelectorAll('.worker-cell-input');
    const list = [];
    inputs.forEach(inp => {
        const v = inp.value.trim();
        if (v) list.push(v);
    });
    if (list.length === 0) return alert('担当者を1名以上入力してください');
    masterData.workers = list;
    saveToLocalStorage();
    postToGasApi({ action: 'saveMaster', masterData });
    renderWorkerSelect();
    showToast(`✅ 担当者 ${list.length}名を保存しました（シート連動済）`);
}

function renderDictCellTable() {
    const tbody = document.getElementById('dict-cell-tbody');
    if (readingDict.length === 0) readingDict.push(['', '']);
    tbody.innerHTML = readingDict.map((pair, idx) => `
        <tr>
            <td class="p-0 border-r"><input type="text" class="dict-k-input w-full px-2 py-1.5 outline-none focus:bg-indigo-50" value="${pair[0] || ''}" placeholder="例：紅花"></td>
            <td class="p-0 border-r"><input type="text" class="dict-v-input w-full px-2 py-1.5 outline-none focus:bg-indigo-50" value="${pair[1] || ''}" placeholder="例：べにばな"></td>
            <td class="p-1 text-center"><button onclick="removeDictRow(${idx})" class="text-rose-600 font-bold px-1">×</button></td>
        </tr>
    `).join('');
}

function addDictRow() {
    syncDictFromDom();
    readingDict.push(['', '']);
    renderDictCellTable();
}

function removeDictRow(idx) {
    syncDictFromDom();
    readingDict.splice(idx, 1);
    renderDictCellTable();
}

function syncDictFromDom() {
    const ks = document.querySelectorAll('.dict-k-input');
    const vs = document.querySelectorAll('.dict-v-input');
    const next = [];
    for (let i = 0; i < ks.length; i++) {
        next.push([ks[i].value.trim(), vs[i].value.trim()]);
    }
    readingDict = next;
}

function saveReadingDictFromCells() {
    syncDictFromDom();
    readingDict = readingDict.filter(p => p[0] && p[1]);
    saveToLocalStorage();
    postToGasApi({ action: 'saveReadingDict', readingDict });
    renderDictCellTable();
    showToast(`✅ 読み上げ辞書（${readingDict.length}語）を保存しました`);
}

function saveAlertSettings() {
    masterData.alertSettings = {
        maxQty: Number(document.getElementById('set-alert-qty').value) || 100,
        maxAmount: Number(document.getElementById('set-alert-amt').value) || 50000,
        prevRatio: Number(document.getElementById('set-alert-ratio').value) || 2.0,
        warnZeroFromPrev: document.getElementById('set-alert-zero').checked
    };
    saveToLocalStorage();
    postToGasApi({ action: 'saveMaster', masterData });
    renderAdminDashboard();
    showToast('✅ 異常値・差異アラート設定を保存しました');
}

function updateAdminPin() {
    const pin = document.getElementById('mst-admin-pin').value.trim();
    if (!pin) return;
    masterData.adminPin = pin;
    saveToLocalStorage();
    postToGasApi({ action: 'saveMaster', masterData });
    showToast('✅ 管理者PINを変更しました');
}

// ==========================================================
// 7. Excel貼付コピー / 投げ込み取込 / 完成版Excel自動生成
// ==========================================================
function copyExcelColumnA() {
    const sheetNo = Number(document.getElementById('pc-export-sheet-no').value) || 1;
    const list = inventoryRecords.filter(r => Number(r.sheetNo) === sheetNo).sort((a, b) => (a.rowOrder || 0) - (b.rowOrder || 0));
    navigator.clipboard.writeText(list.map(r => r.jan).join('\n')).then(() => showToast(`✅ 用紙No.${sheetNo}のA列（JAN ${list.length}行）をコピーしました`));
}

function copyExcelColumnJK() {
    const sheetNo = Number(document.getElementById('pc-export-sheet-no').value) || 1;
    const list = inventoryRecords.filter(r => Number(r.sheetNo) === sheetNo).sort((a, b) => (a.rowOrder || 0) - (b.rowOrder || 0));
    navigator.clipboard.writeText(list.map(r => `${r.qtyUpper ?? ''}\t${r.qtyLower ?? ''}`).join('\n')).then(() => showToast(`✅ 用紙No.${sheetNo}のJ・K列（棚上・棚下 ${list.length}行）をコピーしました`));
}

function downloadAllCsv() {
    const header = ['用紙No', '行順', 'JANコード', '商品名', '中分類', '上代税抜', '先月棚上', '先月棚下', '棚上', '棚下', '合計', '金額', '備考', '担当者', '更新日時'];
    const sorted = [...inventoryRecords].sort((a, b) => (a.sheetNo - b.sheetNo) || (a.rowOrder - b.rowOrder));
    const rows = sorted.map(r => {
        const t = (Number(r.qtyUpper) || 0) + (Number(r.qtyLower) || 0);
        return [r.sheetNo, r.rowOrder, `="${r.jan}"`, `"${r.name}"`, r.catMid, r.price, r.prevUpper ?? '', r.prevLower ?? '', r.qtyUpper ?? '', r.qtyLower ?? '', t, t * (r.price || 0), `"${r.memo || ''}"`, r.worker, r.updatedAt].join(',');
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\uFEFF' + [header.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' }));
    a.download = `道の駅おけがわ_棚卸データ_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
}

function setupExcelDropZones() {
    const bindZone = (zoneId, inputId, handler) => {
        const zone = document.getElementById(zoneId);
        const input = document.getElementById(inputId);
        zone.onclick = () => input.click();
        zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('opacity-75'); };
        zone.ondragleave = () => zone.classList.remove('opacity-75');
        zone.ondrop = (e) => {
            e.preventDefault();
            zone.classList.remove('opacity-75');
            if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]);
        };
    };
    bindZone('drop-zone', 'excel-file-input', handleExcelDropFile);
    bindZone('export-drop-zone', 'excel-template-input', generateFilledExcelFromTemplate);
}

async function handleExcelDropFile(file) {
    if (!file) return;
    const doProducts = document.getElementById('chk-import-products').checked;
    const doLastMonth = document.getElementById('chk-import-lastmonth').checked;
    const box = document.getElementById('import-status-box');
    box.classList.remove('hidden');
    box.textContent = `⏳ 「${file.name}」を解析中...`;

    try {
        const data = await file.arrayBuffer();
        const wb = XLSX.read(data, { type: 'array' });
        const url = getActiveGasUrl();
        let logMsg = '';

        if (doProducts) {
            const prodSheetName = wb.SheetNames.find(n => n.includes('商品台帳'));
            if (prodSheetName) {
                const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[prodSheetName], { header: 1 });
                const parsed = [];
                for (let i = 1; i < rawRows.length; i++) {
                    const r = rawRows[i];
                    const jan = normalizeJan(r && r[0]);
                    if (!jan) continue;
                    parsed.push([jan, String(r[1] || '').trim(), Number(r[3]) || 0, String(r[18] || '').trim(), String(r[19] || '').trim()]);
                }
                const savedCount = await saveProductsToIDB(parsed);
                logMsg += `✅ 商品台帳: ${savedCount.toLocaleString()}件を端末へ登録\n`;
                box.textContent = logMsg + '☁️ 商品台帳をスプレッドシートへ送信中...';
                if (url) {
                    const CHUNK = 4000;
                    for (let c = 0; c < parsed.length; c += CHUNK) {
                        await postToGasApi({ action: 'uploadProductsChunk', chunkIndex: c, rows: parsed.slice(c, c + CHUNK) }, false);
                    }
                    logMsg += `☁️ 商品台帳: スプレッドシートへ登録完了\n`;
                }
            }
        }

        if (doLastMonth) {
            const invSheetName = wb.SheetNames.find(n => n.includes('棚卸し表'));
            if (invSheetName) {
                const rawInv = XLSX.utils.sheet_to_json(wb.Sheets[invSheetName], { header: 1 });
                const importedRecs = [];
                const gasRows = [];
                let sheetNo = 1;

                for (let blockStart = 0; blockStart < rawInv.length; blockStart += 47) {
                    let rowOrder = 1;
                    for (let offset = 6; offset <= 45; offset++) {
                        const r = rawInv[blockStart + offset];
                        if (!r) continue;
                        const jan = normalizeJan(r[0]);
                        if (!jan) continue;
                        const info = lookupProductByJan(jan);
                        const name = (r[7] && String(r[7]).trim() !== '0') ? String(r[7]).trim() : info.name;
                        const price = (Number(r[6]) > 0) ? Number(r[6]) : info.price;
                        const prevU = (r[9] !== undefined && r[9] !== null && r[9] !== '') ? Number(r[9]) : null;
                        const prevL = (r[10] !== undefined && r[10] !== null && r[10] !== '') ? Number(r[10]) : null;
                        const id = `PRE-${sheetNo}-${rowOrder}-${Date.now()}`;

                        importedRecs.push({
                            id, sheetNo, rowOrder, jan, name,
                            catMid: info.catMid, catSmall: info.catSmall, price,
                            qtyUpper: null, qtyLower: null, prevUpper: prevU, prevLower: prevL,
                            memo: '', addedQty: 0, status: 'uncounted', worker: '', updatedAt: ''
                        });
                        gasRows.push([
                            id, sheetNo, rowOrder, jan, name, info.catMid, info.catSmall, price,
                            '', '', 0, 0, 'uncounted', '', '',
                            prevU === null ? '' : prevU, prevL === null ? '' : prevL, '', 0
                        ]);
                        rowOrder++;
                    }
                    sheetNo++;
                }

                inventoryRecords = importedRecs;
                saveToLocalStorage();
                logMsg += `✅ 先月棚卸し表: ${importedRecs.length.toLocaleString()}行を取り込み\n`;
                box.textContent = logMsg + '☁️ 先月棚卸し表をスプレッドシートへ送信中...';

                if (url && gasRows.length > 0) {
                    const CHUNK = 1000;
                    for (let c = 0; c < gasRows.length; c += CHUNK) {
                        await postToGasApi({ action: 'uploadRecordsChunk', chunkIndex: c, rows: gasRows.slice(c, c + CHUNK) }, false);
                    }
                    logMsg += `☁️ 先月棚卸し表: スプレッドシートへ登録完了\n`;
                }
            }
        }
        box.textContent = logMsg + '🎉 すべての取込が完了しました！';
        renderAllViews();
    } catch (err) {
        box.textContent = `⚠️ 読込エラー: ${err.message}`;
    }
}

async function generateFilledExcelFromTemplate(file) {
    if (!file) return;
    const box = document.getElementById('export-status-box');
    box.classList.remove('hidden');
    box.textContent = `⏳ 元Excel「${file.name}」を読み込んでデータを流し込み中...`;

    try {
        const buffer = await file.arrayBuffer();
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);

        const ws = workbook.worksheets.find(s => s.name.includes('棚卸し表'));
        if (!ws) throw new Error('「棚卸し表」シートが見つかりません');

        const bySheet = new Map();
        inventoryRecords.forEach(r => {
            const n = Number(r.sheetNo) || 1;
            if (!bySheet.has(n)) bySheet.set(n, []);
            bySheet.get(n).push(r);
        });

        let writtenRows = 0;
        for (let sheetNo = 1; sheetNo <= 200; sheetNo++) {
            const blockDataStart = (sheetNo - 1) * 47 + 7;
            const list = (bySheet.get(sheetNo) || []).sort((a, b) => (a.rowOrder || 0) - (b.rowOrder || 0));

            for (let i = 0; i < 40; i++) {
                const row = ws.getRow(blockDataStart + i);
                const rec = list[i];
                if (rec) {
                    const janVal = /^\d{1,15}$/.test(rec.jan) ? Number(rec.jan) : rec.jan;
                    row.getCell(1).value = janVal || null;
                    row.getCell(10).value = rec.qtyUpper === null ? null : Number(rec.qtyUpper);
                    row.getCell(11).value = rec.qtyLower === null ? null : Number(rec.qtyLower);
                    writtenRows++;
                } else {
                    row.getCell(1).value = null;
                    row.getCell(10).value = null;
                    row.getCell(11).value = null;
                }
            }
        }

        const outBuffer = await workbook.xlsx.writeBuffer();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([outBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        a.download = `完成版_棚卸表_道の駅おけがわ_${new Date().toISOString().slice(0, 10)}.xlsx`;
        a.click();

        box.textContent = `🎉 完成版Excel（計 ${writtenRows}行を反映・数式と書式を完全保持）をダウンロードしました！`;
    } catch (err) {
        box.textContent = `⚠️ 生成エラー: ${err.message}`;
    }
}

// ==========================================================
// 8. 接続QRモーダル ＆ コード全文バックアップモーダル
// ==========================================================
function openGasUrlModal() {
    const curUrl = getActiveGasUrl();
    const baseUrl = window.location.origin + window.location.pathname;
    const shareUrl = curUrl ? `${baseUrl}?gas=${encodeURIComponent(curUrl)}` : '';

    openModal('⚙️ 接続設定 ＆ スタッフ配布用2次元バーコード', `
        <div class="space-y-3">
            <p class="text-xs text-slate-600">GAS URLは端末に永久保存されるため、今後のアプリ更新で消えません。</p>
            <input id="inp-gas-url" type="url" value="${curUrl}" placeholder="https://script.google.com/macros/s/.../exec" class="w-full border-2 border-blue-400 rounded-lg p-2 font-mono text-xs">
            <button onclick="saveGasUrl()" class="w-full bg-blue-600 text-white font-bold py-2 rounded-xl">💾 URLを保存して今すぐ同期</button>
            ${shareUrl ? `
            <div class="pt-3 border-t text-center space-y-2">
                <div class="font-bold text-xs text-slate-800">📱 スタッフ配布用 2次元バーコード（スマホで読取）</div>
                <div id="qr-code-container" class="flex justify-center p-2 bg-white border rounded-xl"></div>
                <button onclick="copyShareUrlText('${shareUrl}')" class="w-full bg-slate-800 text-amber-300 font-bold py-2 rounded-xl text-xs">📋 配布用リンクをコピー</button>
            </div>` : '<p class="text-xs text-amber-700">※URLを保存すると、ここにスタッフ配布用の2次元バーコードが表示されます。</p>'}
        </div>
    `);

    if (shareUrl && window.QRCode) {
        setTimeout(() => {
            const el = document.getElementById('qr-code-container');
            if (el) {
                el.innerHTML = '';
                new QRCode(el, { text: shareUrl, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
            }
        }, 50);
    }
}

function saveGasUrl() {
    setActiveGasUrl(document.getElementById('inp-gas-url').value.trim());
    closeModal();
    fetchAllFromGasApi(true);
}

function copyShareUrlText(url) {
    navigator.clipboard.writeText(url).then(() => showToast('📋 配布用リンクをコピーしました'));
}

async function buildFullSourceBundleText() {
    const htmlContent = document.documentElement.outerHTML;
    let coreJs = '', uiJs = '';
    try { const r1 = await fetch('app-core.js?v=11'); if (r1.ok) coreJs = await r1.text(); } catch (e) {}
    try { const r2 = await fetch('app-ui.js?v=11'); if (r2.ok) uiJs = await r2.text(); } catch (e) {}
    if (coreJs && uiJs) {
        return `<!-- ===== index.html ===== -->\n<!DOCTYPE html>\n${htmlContent}\n\n/* ===== app-core.js ===== */\n${coreJs}\n\n/* ===== app-ui.js ===== */\n${uiJs}`;
    }
    return `<!DOCTYPE html>\n${htmlContent}`;
}

function openBackupModal() {
    const fullJson = JSON.stringify({
        exportedAt: formatNow(),
        masterData,
        inventoryRecords,
        addStockLogs,
        readingDict
    }, null, 2);

    openModal('💾 バックアップ ＆ コード全文出力', `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button onclick="copyBackupDataJson()" class="bg-blue-600 text-white font-bold py-2 px-3 rounded-xl text-xs">📋 ① 全データをコピー</button>
            <button onclick="downloadBackupDataJson()" class="bg-emerald-600 text-white font-bold py-2 px-3 rounded-xl text-xs">⬇️ ② 全データ(JSON)保存</button>
            <button onclick="copyAppSourceCode()" class="bg-indigo-600 text-white font-bold py-2 px-3 rounded-xl text-xs">📄 ③ コード全文をコピー</button>
            <button onclick="downloadAppSourceCode()" class="bg-slate-800 text-white font-bold py-2 px-3 rounded-xl text-xs">💾 ④ コード自体をダウンロード</button>
        </div>
        <textarea id="backup-textarea" rows="7" class="w-full border rounded-lg p-2 font-mono text-[11px] bg-slate-50">${fullJson}</textarea>
        <div class="flex justify-between items-center pt-2 border-t">
            <button onclick="restoreFromBackupJson()" class="bg-amber-500 text-slate-950 font-bold px-3 py-2 rounded-xl text-xs">🔄 上記JSONから復元</button>
            <button onclick="closeModal()" class="bg-slate-200 px-3 py-2 rounded-xl font-bold text-xs">閉じる</button>
        </div>
    `);
}

function copyBackupDataJson() {
    navigator.clipboard.writeText(document.getElementById('backup-textarea').value)
        .then(() => showToast('📋 バックアップデータをコピーしました'));
}

function downloadBackupDataJson() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([document.getElementById('backup-textarea').value], { type: 'application/json' }));
    a.download = `okegawa_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
}

async function copyAppSourceCode() {
    const code = await buildFullSourceBundleText();
    document.getElementById('backup-textarea').value = code;
    navigator.clipboard.writeText(code).then(() => showToast('📄 アプリのコード全文をコピーしました'));
}

async function downloadAppSourceCode() {
    const code = await buildFullSourceBundleText();
    document.getElementById('backup-textarea').value = code;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([code], { type: 'text/html;charset=utf-8;' }));
    a.download = `okegawa_inventory_app_code_v11_${new Date().toISOString().slice(0, 10)}.html`;
    a.click();
    showToast('💾 コードファイルをダウンロードしました');
}

function restoreFromBackupJson() {
    try {
        const parsed = JSON.parse(document.getElementById('backup-textarea').value.trim());
        if (parsed.masterData) masterData = Object.assign(JSON.parse(JSON.stringify(defaultMaster)), parsed.masterData);
        if (Array.isArray(parsed.inventoryRecords)) inventoryRecords = parsed.inventoryRecords;
        if (Array.isArray(parsed.addStockLogs)) addStockLogs = parsed.addStockLogs;
        if (Array.isArray(parsed.readingDict)) readingDict = parsed.readingDict;
        saveToLocalStorage();
        initSheetNoSelects();
        renderWorkerSelect();
        renderAllViews();
        closeModal();
        showToast('✅ バックアップから復元しました');
    } catch (err) { alert('有効なJSONデータではありません'); }
}

function openModal(title, html) {
    appState.isModalOpen = true;
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('modal-overlay').classList.add('flex');
}

function closeModal() {
    appState.isModalOpen = false;
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('modal-overlay').classList.remove('flex');
}

let toastTimer = null;
function showToast(msg) {
    const box = document.getElementById('toast-box');
    box.textContent = msg;
    box.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.add('hidden'), 3200);
}
