/**
 * app-ui.js (v10)
 * ・進捗マップ / 異常値設定＆ハイライト / 棚上・棚下ロック / 部門別リアルタイム速報
 * ・追加発見ログ / 備考欄＋定型タグ / 削除・やり直し確認 / 2次元バーコード配布
 * ・元Excelの数式・書式を保持した完成版Excel自動生成 (ExcelJS)
 * ・コード全文コピー・ダウンロード付き完全バックアップ
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

function initSheetNoSelects() {
    const mSel = document.getElementById('m-sheet-no');
    const pSel = document.getElementById('pc-export-sheet-no');
    const names = masterData.sheetNames || {};
    let html = '';
    for (let i = 1; i <= 200; i++) {
        const label = names[String(i)] ? `No.${i} (${names[String(i)]})` : `用紙 No.${i}`;
        html += `<option value="${i}">${label}</option>`;
    }
    mSel.innerHTML = html;
    pSel.innerHTML = html;
    mSel.value = appState.currentSheetNo;
    pSel.value = appState.currentSheetNo;
}

function renderWorkerSelect() {
    const sel = document.getElementById('worker-select');
    sel.innerHTML = masterData.workers.map(w => `<option value="${w}">${w}</option>`).join('');
    if (!masterData.workers.includes(appState.currentWorker) && masterData.workers.length > 0) {
        appState.currentWorker = masterData.workers[0];
    }
    sel.value = appState.currentWorker;
}

function onWorkerChange(val) {
    appState.currentWorker = val;
    saveToLocalStorage();
}

function onSheetNoChange(val) {
    appState.currentSheetNo = Number(val) || 1;
    const list = getCurrentSheetRecords();
    appState.selectedRecordId = list.length > 0 ? list[0].id : null;
    appState.inputBuffer = '';
    saveToLocalStorage();
    renderMobileView();
}

// 機能③：棚上専用 / 棚下専用 入力ロック切替
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

function setWorkMode(mode) {
    appState.workMode = mode;
    const btnC = document.getElementById('mode-btn-count');
    const btnP = document.getElementById('mode-btn-pickup');
    const card = document.getElementById('count-card-area');
    const pad = document.getElementById('keypad-area');
    if (mode === 'pickup') {
        btnP.className = 'py-1 rounded-md bg-amber-500 text-slate-950 shadow';
        btnC.className = 'py-1 rounded-md text-slate-600';
        card.classList.add('hidden');
        pad.classList.add('hidden');
    } else {
        btnC.className = 'py-1 rounded-md bg-blue-600 text-white shadow';
        btnP.className = 'py-1 rounded-md text-slate-600';
        card.classList.remove('hidden');
        pad.classList.remove('hidden');
    }
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
// 1. 異常値・先月比差異チェック（機能②・設定値連動）
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
            if (ratio >= (Number(cfg.prevRatio) || 2.0)) {
                reasons.push(`先月比${ratio.toFixed(1)}倍`);
            }
        }
    }
    return reasons;
}

// ==========================================================
// 2. スキャン・手入力追加・やり直し・削除・備考・追加発見
// ==========================================================
function handleBarcodeScan(rawCode) {
    const jan = normalizeJan(rawCode);
    if (!jan) return;
    document.getElementById('barcode-input').value = '';
    SFX.scan();

    const sheetList = getCurrentSheetRecords();
    if (appState.workMode === 'count') {
        const uncountedHit = sheetList.find(r => normalizeJan(r.jan) === jan && r.status !== 'done');
        if (uncountedHit) {
            selectRecord(uncountedHit.id, true);
            showToast(`🔍 呼出: ${uncountedHit.name}`);
            return;
        }
    }

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
    speakCurrentRecord(false);
    showToast(`➕ 行${sheetList.length + 1}に追加: ${newRec.name}`);
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
    const list = getCurrentSheetRecords();
    const rowNum = list.findIndex(r => r.id === rec.id) + 1;
    if (!confirm(`本当に削除しますか？\n用紙 No.${rec.sheetNo} / ${rowNum}行目\n「${rec.name}」`)) return;
    inventoryRecords = inventoryRecords.filter(r => r.id !== rec.id);
    const nextList = getCurrentSheetRecords();
    appState.selectedRecordId = nextList.length > 0 ? nextList[0].id : null;
    appState.inputBuffer = '';
    saveToLocalStorage();
    postToGasApi({ action: 'deleteRecord', id: rec.id });
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
        <p class="text-xs text-slate-600">現在のカウント（棚上:${rec.qtyUpper ?? 0} / 棚下:${rec.qtyLower ?? 0}）に、後から見つかった在庫を履歴付きで加算します。</p>
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
        jan: rec.jan,
        name: rec.name,
        targetField: field,
        addedQty: qty,
        memo: memo
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
    document.getElementById('m-sheet-no').value = sheetNo;
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
// 3. テンキー操作・確定
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
        speakText(`用紙${appState.currentSheetNo}番の最終行まで完了しました！`);
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
    if (autoSpeak) speakCurrentRecord(false);
}

// ==========================================================
// 4. スマホ画面描画 ＆ 進捗マップモーダル（機能①）
// ==========================================================
function renderAllViews() {
    renderMobileView();
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

        let bg = 'bg-slate-50 border-slate-200 text-slate-400';
        if (total > 0 && done === total) bg = 'bg-emerald-100 border-emerald-500 text-emerald-900';
        else if (done > 0 || partial > 0) bg = 'bg-amber-100 border-amber-400 text-amber-900';
        else if (total > 0) bg = 'bg-white border-slate-300 text-slate-700';

        const memoBorder = hasMemo ? 'ring-2 ring-rose-500' : '';
        const areaName = (masterData.sheetNames && masterData.sheetNames[String(i)]) || '';

        html += `
        <button onclick="${clickHandlerName}(${i})" class="p-1.5 rounded-lg border text-left text-[10px] leading-tight ${bg} ${memoBorder}">
            <div class="font-extrabold">No.${i}</div>
            <div class="truncate text-[9px]">${areaName || (total > 0 ? `${done}/${total}行` : '-')}</div>
            <div class="truncate text-[9px] font-bold">${lastWorker ? lastWorker.split(':')[1] || lastWorker : ''}</div>
        </button>`;
    }
    return html;
}

function openSheetProgressMapModal() {
    openModal('🗺️ 用紙 No.1〜200 進捗マップ', `
        <p class="text-[11px] text-slate-600">緑＝完了 / 黄＝作業中 / 白＝未着手 / 赤枠＝備考あり。タップでその用紙へ移動します。</p>
        <div class="grid grid-cols-4 sm:grid-cols-5 gap-1.5 max-h-[60vh] overflow-y-auto">${buildProgressMapHtml('jumpToSheetFromModal')}</div>
    `);
}

function jumpToSheetFromModal(no) {
    document.getElementById('m-sheet-no').value = no;
    onSheetNoChange(no);
    closeModal();
}

// ==========================================================
// 5. PC管理画面・部門別速報・異常値・Excel自動生成
// ==========================================================
function requestAdminView() {
    if (appState.isAdminUnlocked) return switchToAdminView();
    const pin = prompt('管理者PINコードを入力してください（初期値: 1234）');
    if (pin === masterData.adminPin) {
        appState.isAdminUnlocked = true;
        switchToAdminView();
    } else if (pin !== null) alert('PINコードが違います');
}

function switchToAdminView() {
    document.getElementById('mobile-view').classList.add('hidden');
    document.getElementById('admin-view').classList.remove('hidden');
    loadSettingsToInputs();
    renderAdminDashboard();
}

function switchToMobileView() {
    document.getElementById('admin-view').classList.add('hidden');
    document.getElementById('mobile-view').classList.remove('hidden');
    renderMobileView();
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

function deleteRecordById(id) {
    const rec = inventoryRecords.find(r => r.id === id);
    if (!confirm(`「${rec ? rec.name : id}」を削除しますか？`)) return;
    inventoryRecords = inventoryRecords.filter(r => r.id !== id);
    saveToLocalStorage();
    postToGasApi({ action: 'deleteRecord', id });
    renderAllViews();
}

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

// ==========================================================
// 6. Excel投げ込み読込 ＆ 元Excelへの数式保護自動流し込み生成（ExcelJS）
// ==========================================================
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

        // 用紙No.ごとにグルーピング
        const bySheet = new Map();
        inventoryRecords.forEach(r => {
            const n = Number(r.sheetNo) || 1;
            if (!bySheet.has(n)) bySheet.set(n, []);
            bySheet.get(n).push(r);
        });

        let writtenRows = 0;
        for (let sheetNo = 1; sheetNo <= 200; sheetNo++) {
            const blockDataStart = (sheetNo - 1) * 47 + 7; // Excel行番号(1始まり)
            const list = (bySheet.get(sheetNo) || []).sort((a, b) => (a.rowOrder || 0) - (b.rowOrder || 0));

            for (let i = 0; i < 40; i++) {
                const rowIdx = blockDataStart + i;
                const row = ws.getRow(rowIdx);
                const rec = list[i];
                if (rec) {
                    const janVal = /^\d{1,15}$/.test(rec.jan) ? Number(rec.jan) : rec.jan;
                    row.getCell(1).value = janVal || null;                           // A列: JANコード
                    row.getCell(10).value = rec.qtyUpper === null ? null : Number(rec.qtyUpper); // J列: 棚上
                    row.getCell(11).value = rec.qtyLower === null ? null : Number(rec.qtyLower); // K列: 棚下
                    writtenRows++;
                } else {
                    row.getCell(1).value = null;
                    row.getCell(10).value = null;
                    row.getCell(11).value = null;
                }
            }
        }

        const outBuffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([outBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `完成版_棚卸表_道の駅おけがわ_${new Date().toISOString().slice(0, 10)}.xlsx`;
        a.click();

        box.textContent = `🎉 完成版Excel（計 ${writtenRows}行を反映・数式と書式を完全保持）をダウンロードしました！`;
    } catch (err) {
        box.textContent = `⚠️ 生成エラー: ${err.message}`;
    }
}

// ==========================================================
// 7. 設定保存・QR配布・完全バックアップ（コード全文出力含む）
// ==========================================================
function loadSettingsToInputs() {
    const cfg = masterData.alertSettings || defaultMaster.alertSettings;
    document.getElementById('set-alert-qty').value = cfg.maxQty;
    document.getElementById('set-alert-amt').value = cfg.maxAmount;
    document.getElementById('set-alert-ratio').value = cfg.prevRatio;
    document.getElementById('set-alert-zero').checked = Boolean(cfg.warnZeroFromPrev);
    document.getElementById('mst-workers-input').value = masterData.workers.join(', ');
    document.getElementById('mst-admin-pin').value = masterData.adminPin;
    document.getElementById('mst-dict-input').value = readingDict.map(p => `${p[0]},${p[1]}`).join('\n');
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

function saveWorkersList() {
    const list = document.getElementById('mst-workers-input').value.split(/,|、|\n/).map(s => s.trim()).filter(Boolean).slice(0, 15);
    if (!list.length) return;
    masterData.workers = list;
    saveToLocalStorage();
    postToGasApi({ action: 'saveMaster', masterData });
    renderWorkerSelect();
    showToast('✅ 担当者リストを保存しました（スプレッドシートへも反映）');
}

function updateAdminPin() {
    const pin = document.getElementById('mst-admin-pin').value.trim();
    if (!pin) return;
    masterData.adminPin = pin;
    saveToLocalStorage();
    postToGasApi({ action: 'saveMaster', masterData });
    showToast('✅ 管理者PINを変更しました');
}

function saveReadingDictFromUi() {
    const lines = document.getElementById('mst-dict-input').value.split('\n');
    const nextDict = [];
    for (const line of lines) {
        const parts = line.split(/,|、/).map(s => s.trim());
        if (parts[0] && parts[1]) nextDict.push([parts[0], parts[1]]);
    }
    readingDict = nextDict;
    saveToLocalStorage();
    postToGasApi({ action: 'saveReadingDict', readingDict });
    showToast(`✅ 読み上げ辞書（${readingDict.length}語）を保存しました`);
}

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
    try { const r1 = await fetch('app-core.js?v=10'); if (r1.ok) coreJs = await r1.text(); } catch (e) {}
    try { const r2 = await fetch('app-ui.js?v=10'); if (r2.ok) uiJs = await r2.text(); } catch (e) {}
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
    a.download = `okegawa_inventory_app_code_${new Date().toISOString().slice(0, 10)}.html`;
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
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('modal-overlay').classList.add('flex');
}

function closeModal() {
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
