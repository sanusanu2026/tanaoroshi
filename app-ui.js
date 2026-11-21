/**
 * app-ui.js
 * ・用紙No.運用 / 前日ピックアップ＆当日カウント / 棚上・棚下入力
 * ・桁違いガード（100個以上・5万円以上・6桁以上）
 * ・商品台帳Excel投げ込み登録 / Excel数式保護2ステップコピー / バックアップ
 */

window.addEventListener('DOMContentLoaded', async () => {
    loadFromLocalStorage();
    await loadProductsFromIDB();
    initSheetNoSelects();
    renderWorkerSelect();
    setupExcelDropZone();
    renderAllViews();
    if (getActiveGasUrl()) fetchAllFromGasApi(false);
});

function initSheetNoSelects() {
    const mSel = document.getElementById('m-sheet-no');
    const pSel = document.getElementById('pc-export-sheet-no');
    let html = '';
    for (let i = 1; i <= 200; i++) {
        html += `<option value="${i}">用紙 No.${i}</option>`;
    }
    mSel.innerHTML = html;
    pSel.innerHTML = html;
    mSel.value = appState.currentSheetNo;
    pSel.value = appState.currentSheetNo;
}

function renderWorkerSelect() {
    const sel = document.getElementById('worker-select');
    sel.innerHTML = masterData.workers.map(w => `<option value="${w}">${w}</option>`).join('');
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

function setWorkMode(mode) {
    appState.workMode = mode;
    const btnC = document.getElementById('mode-btn-count');
    const btnP = document.getElementById('mode-btn-pickup');
    const card = document.getElementById('count-card-area');
    const pad = document.getElementById('keypad-area');

    if (mode === 'pickup') {
        btnP.className = 'py-1.5 rounded-md bg-amber-500 text-slate-950 shadow';
        btnC.className = 'py-1.5 rounded-md text-slate-600';
        card.classList.add('hidden');
        pad.classList.add('hidden');
        document.getElementById('scan-mode-hint').textContent = '📋 事前ピックアップ中：スキャンするたび別行で追加されます';
    } else {
        btnC.className = 'py-1.5 rounded-md bg-blue-600 text-white shadow';
        btnP.className = 'py-1.5 rounded-md text-slate-600';
        card.classList.remove('hidden');
        pad.classList.remove('hidden');
        document.getElementById('scan-mode-hint').textContent = '🔢 カウント中：スキャンした商品を呼び出し（なければ新規行追加）';
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
// 1. バーコードスキャン処理（同一JAN別行登録対応）
// ==========================================================
function handleBarcodeScan(rawCode) {
    const jan = String(rawCode || '').trim();
    if (!jan) return;
    document.getElementById('barcode-input').value = '';
    SFX.scan();

    const sheetList = getCurrentSheetRecords();

    // 当日カウントモード：同じ用紙内に「未入力の同一JAN」があればそれを呼び出す
    if (appState.workMode === 'count') {
        const uncountedHit = sheetList.find(r => r.jan === jan && r.status !== 'done');
        if (uncountedHit) {
            selectRecord(uncountedHit.id);
            showToast(`🔍 呼出: ${uncountedHit.name}`);
            return;
        }
    }

    // 40行上限チェック（Excelの1用紙＝40行）
    if (sheetList.length >= 40) {
        SFX.err();
        alert(`用紙 No.${appState.currentSheetNo} は上限40行に達しています！\n次の用紙No.に切り替えてください。`);
        return;
    }

    // 新規行として追加（前日ピックアップ or 当日別場所での追加発見）
    const info = lookupProductByJan(jan);
    const maxOrder = sheetList.reduce((m, r) => Math.max(m, r.rowOrder || 0), 0);
    const newRec = {
        id: 'REC-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        sheetNo: appState.currentSheetNo,
        rowOrder: maxOrder + 1,
        jan: info.jan,
        name: info.name,
        catMid: info.catMid,
        catSmall: info.catSmall,
        price: info.price,
        qtyUpper: null,
        qtyLower: null,
        status: 'uncounted',
        worker: appState.currentWorker,
        updatedAt: formatNow()
    };

    inventoryRecords.push(newRec);
    appState.selectedRecordId = newRec.id;
    appState.inputBuffer = '';
    saveToLocalStorage();
    postToGasApi({ action: 'saveRecord', record: newRec });
    renderAllViews();
    showToast(`➕ 行${sheetList.length + 1}に追加: ${newRec.name}`);
}

// ==========================================================
// 2. 棚上・棚下 数量入力 ＆ 桁違いガード
// ==========================================================
function setActiveField(field) {
    appState.activeField = field;
    const rec = getCurrentRecord();
    if (rec) {
        const curVal = field === 'upper' ? rec.qtyUpper : rec.qtyLower;
        appState.inputBuffer = (curVal === null || curVal === undefined) ? '' : String(curVal);
    }
    renderMobileCard();
}

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

function clearQtyInput() {
    SFX.key();
    appState.inputBuffer = '';
    applyBufferToCurrentRecord();
}

function backspaceQty() {
    SFX.key();
    appState.inputBuffer = appState.inputBuffer.slice(0, -1);
    applyBufferToCurrentRecord();
}

function applyBufferToCurrentRecord() {
    const rec = getCurrentRecord();
    if (!rec) return;
    const val = appState.inputBuffer === '' ? null : parseInt(appState.inputBuffer, 10);
    if (appState.activeField === 'upper') rec.qtyUpper = val;
    else rec.qtyLower = val;
    renderMobileCard();
}

function setZeroAndNext() {
    appState.inputBuffer = '0';
    applyBufferToCurrentRecord();
    confirmAndNextRecord();
}

function confirmAndNextRecord() {
    const rec = getCurrentRecord();
    if (!rec) return;

    const qU = Number(rec.qtyUpper) || 0;
    const qL = Number(rec.qtyLower) || 0;
    const total = qU + qL;
    const amount = total * (Number(rec.price) || 0);

    // ★桁違い・JAN誤入力ガード
    if (qU >= 10000 || qL >= 10000) {
        SFX.err();
        if (!confirm(`⚠️ 桁数が大きすぎます（棚上:${qU} / 棚下:${qL}）。\nバーコードを数量欄に入力していませんか？\nこのまま確定しますか？`)) return;
    } else if (total >= 100 || amount >= 50000) {
        SFX.err();
        if (!confirm(`⚠️ 数量または金額が大きいです。\n${rec.name}\n合計: ${total}個（金額: ¥${amount.toLocaleString()}）\n間違いありませんか？`)) return;
    }

    // 状態更新（棚上・棚下の両方に値があれば done、片方のみなら partial）
    if (rec.qtyUpper !== null && rec.qtyLower !== null) rec.status = 'done';
    else if (rec.qtyUpper !== null || rec.qtyLower !== null) rec.status = 'partial';
    else rec.status = 'uncounted';

    rec.worker = appState.currentWorker;
    rec.updatedAt = formatNow();
    saveToLocalStorage();
    postToGasApi({ action: 'saveRecord', record: rec });
    SFX.next();

    // 次の行へ移動
    const list = getCurrentSheetRecords();
    const idx = list.findIndex(r => r.id === rec.id);
    if (idx >= 0 && idx < list.length - 1) {
        selectRecord(list[idx + 1].id);
    } else {
        renderAllViews();
        showToast(`✅ 用紙 No.${appState.currentSheetNo} の最終行まで完了しました`);
    }
}

function movePrevRecord() {
    const list = getCurrentSheetRecords();
    const idx = list.findIndex(r => r.id === appState.selectedRecordId);
    if (idx > 0) selectRecord(list[idx - 1].id);
}

function selectRecord(id) {
    appState.selectedRecordId = id;
    const rec = getCurrentRecord();
    if (rec) {
        const curVal = appState.activeField === 'upper' ? rec.qtyUpper : rec.qtyLower;
        appState.inputBuffer = (curVal === null || curVal === undefined) ? '' : String(curVal);
    }
    renderMobileView();
}

// ==========================================================
// 3. 画面描画（スマホ・PC管理）
// ==========================================================
function renderAllViews() {
    renderMobileView();
    if (appState.isAdminUnlocked) renderAdminDashboard();
}

function renderMobileView() {
    const list = getCurrentSheetRecords();
    const uncounted = list.filter(r => r.status === 'uncounted').length;
    document.getElementById('m-sheet-count-badge').textContent = `${list.length}/40行`;
    document.getElementById('m-uncounted-badge').textContent = `未${uncounted}`;
    renderMobileCard();
    renderMobileList();
}

function renderMobileCard() {
    const rec = getCurrentRecord();
    const boxU = document.getElementById('box-qty-upper');
    const boxL = document.getElementById('box-qty-lower');

    boxU.className = appState.activeField === 'upper'
        ? 'text-left bg-blue-950 rounded-lg px-2 py-1 border-2 border-amber-400'
        : 'text-left bg-slate-800 rounded-lg px-2 py-1 border-2 border-slate-600';
    boxL.className = appState.activeField === 'lower'
        ? 'text-left bg-blue-950 rounded-lg px-2 py-1 border-2 border-amber-400'
        : 'text-left bg-slate-800 rounded-lg px-2 py-1 border-2 border-slate-600';

    if (!rec) {
        document.getElementById('m-cur-meta').textContent = `No.${appState.currentSheetNo} / 商品未登録`;
        document.getElementById('m-cur-name').textContent = 'スキャンして商品を追加してください';
        document.getElementById('m-cur-price-amt').textContent = '¥0';
        document.getElementById('m-val-upper').textContent = '-';
        document.getElementById('m-val-lower').textContent = '-';
        document.getElementById('m-val-total').textContent = '0';
        return;
    }

    const list = getCurrentSheetRecords();
    const rowIdx = list.findIndex(r => r.id === rec.id) + 1;
    const total = (Number(rec.qtyUpper) || 0) + (Number(rec.qtyLower) || 0);
    const amt = total * (Number(rec.price) || 0);

    document.getElementById('m-cur-meta').textContent = `No.${rec.sheetNo} / ${rowIdx}行目 / JAN:${rec.jan}`;
    document.getElementById('m-cur-name').textContent = rec.name;
    document.getElementById('m-cur-price-amt').textContent = `¥${(rec.price || 0).toLocaleString()} × ${total} = ¥${amt.toLocaleString()}`;
    document.getElementById('m-val-upper').textContent = rec.qtyUpper === null ? '-' : rec.qtyUpper;
    document.getElementById('m-val-lower').textContent = rec.qtyLower === null ? '-' : rec.qtyLower;
    document.getElementById('m-val-total').textContent = total;
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
                ? '<span class="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold">片方済</span>'
                : '<span class="bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded font-bold">未</span>';
        return `
        <div onclick="selectRecord('${r.id}')" class="p-2 flex items-center justify-between gap-2 cursor-pointer ${isSel ? 'bg-blue-50 border-l-4 border-blue-600' : 'hover:bg-slate-50'}">
            <div class="min-w-0 flex-1">
                <div class="font-bold text-slate-800 truncate">${rowNum}. ${r.name}</div>
                <div class="text-[10px] text-slate-500 font-mono">JAN:${r.jan} | ¥${r.price}</div>
            </div>
            <div class="text-right shrink-0">
                <div class="font-mono font-bold text-slate-900">上:${r.qtyUpper ?? '-'} / 下:${r.qtyLower ?? '-'}</div>
                <div class="mt-0.5">${badge}</div>
            </div>
        </div>`;
    }).join('');
}

// ==========================================================
// 4. PC管理画面・Excel投げ込み・2ステップ貼り付けコピー
// ==========================================================
function requestAdminView() {
    if (appState.isAdminUnlocked) {
        switchToAdminView();
        return;
    }
    const pin = prompt('管理者PINコードを入力してください（初期値: 1234）');
    if (pin === masterData.adminPin) {
        appState.isAdminUnlocked = true;
        switchToAdminView();
    } else if (pin !== null) {
        alert('PINコードが違います');
    }
}

function switchToAdminView() {
    document.getElementById('mobile-view').classList.add('hidden');
    document.getElementById('admin-view').classList.remove('hidden');
    document.getElementById('mst-workers-input').value = masterData.workers.join(', ');
    document.getElementById('mst-admin-pin').value = masterData.adminPin;
    renderAdminDashboard();
}

function switchToMobileView() {
    document.getElementById('admin-view').classList.add('hidden');
    document.getElementById('mobile-view').classList.remove('hidden');
    renderMobileView();
}

function switchAdminTab(tabId) {
    ['tab-excel', 'tab-import', 'tab-settings'].forEach(id => {
        document.getElementById(id).classList.toggle('hidden', id !== tabId);
        const btn = document.getElementById('btn-' + id);
        btn.className = id === tabId
            ? 'bg-blue-600 text-white font-bold text-xs px-4 py-2 rounded-xl'
            : 'bg-white text-slate-700 border border-slate-300 font-bold text-xs px-4 py-2 rounded-xl';
    });
}

function renderAdminDashboard() {
    const totalRows = inventoryRecords.length;
    const uncounted = inventoryRecords.filter(r => r.status === 'uncounted').length;
    const totalAmt = inventoryRecords.reduce((s, r) => s + ((Number(r.qtyUpper) || 0) + (Number(r.qtyLower) || 0)) * (Number(r.price) || 0), 0);
    const usedSheets = new Set(inventoryRecords.map(r => r.sheetNo)).size;

    document.getElementById('pc-kpi-rows').textContent = `${totalRows}行 (未${uncounted})`;
    document.getElementById('pc-kpi-amount').textContent = `¥${totalAmt.toLocaleString()}`;
    document.getElementById('pc-kpi-master-count').textContent = `${productMap.size.toLocaleString()} 件`;
    document.getElementById('pc-kpi-sheets').textContent = `${usedSheets} 枚`;
    renderAdminExportTable();
}

function renderAdminExportTable() {
    const sheetNo = Number(document.getElementById('pc-export-sheet-no').value) || 1;
    const list = inventoryRecords.filter(r => Number(r.sheetNo) === sheetNo).sort((a, b) => (a.rowOrder || 0) - (b.rowOrder || 0));
    const tbody = document.getElementById('pc-export-tbody');

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" class="p-6 text-center text-slate-400">用紙 No.${sheetNo} に登録されたデータはありません</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map((r, i) => {
        const total = (Number(r.qtyUpper) || 0) + (Number(r.qtyLower) || 0);
        const amt = total * (Number(r.price) || 0);
        return `
        <tr class="hover:bg-slate-50">
            <td class="p-2 font-mono text-slate-500">${i + 1}</td>
            <td class="p-2 font-mono font-bold">${r.jan}</td>
            <td class="p-2">${r.catMid || '-'} / ${r.catSmall || '-'}</td>
            <td class="p-2 font-bold">${r.name}</td>
            <td class="p-2 text-right font-mono">¥${(r.price || 0).toLocaleString()}</td>
            <td class="p-2 text-right font-mono font-bold bg-blue-50">${r.qtyUpper ?? ''}</td>
            <td class="p-2 text-right font-mono font-bold bg-blue-50">${r.qtyLower ?? ''}</td>
            <td class="p-2 text-right font-mono font-bold">${total}</td>
            <td class="p-2 text-right font-mono">¥${amt.toLocaleString()}</td>
            <td class="p-2">${r.worker || ''} (${r.status})</td>
            <td class="p-2 text-center">
                <button onclick="deleteRecordById('${r.id}')" class="text-rose-600 font-bold hover:underline">削除</button>
            </td>
        </tr>`;
    }).join('');
}

function deleteRecordById(id) {
    if (!confirm('この行を削除しますか？')) return;
    inventoryRecords = inventoryRecords.filter(r => r.id !== id);
    saveToLocalStorage();
    postToGasApi({ action: 'deleteRecord', id: id });
    renderAllViews();
}

function copyExcelColumnA() {
    const sheetNo = Number(document.getElementById('pc-export-sheet-no').value) || 1;
    const list = inventoryRecords.filter(r => Number(r.sheetNo) === sheetNo).sort((a, b) => (a.rowOrder || 0) - (b.rowOrder || 0));
    const text = list.map(r => r.jan).join('\n');
    navigator.clipboard.writeText(text).then(() => showToast(`✅ 用紙No.${sheetNo}のA列（JAN ${list.length}行）をコピーしました`));
}

function copyExcelColumnJK() {
    const sheetNo = Number(document.getElementById('pc-export-sheet-no').value) || 1;
    const list = inventoryRecords.filter(r => Number(r.sheetNo) === sheetNo).sort((a, b) => (a.rowOrder || 0) - (b.rowOrder || 0));
    const text = list.map(r => `${r.qtyUpper ?? ''}\t${r.qtyLower ?? ''}`).join('\n');
    navigator.clipboard.writeText(text).then(() => showToast(`✅ 用紙No.${sheetNo}のJ・K列（棚上・棚下 ${list.length}行）をコピーしました`));
}

function downloadAllCsv() {
    const header = ['用紙No', '行順', 'JANコード', '商品名', '中分類', '小分類', '上代税抜', '棚上', '棚下', '合計', '金額', '担当者', '更新日時'];
    const sorted = [...inventoryRecords].sort((a, b) => (a.sheetNo - b.sheetNo) || (a.rowOrder - b.rowOrder));
    const rows = sorted.map(r => {
        const t = (Number(r.qtyUpper) || 0) + (Number(r.qtyLower) || 0);
        return [r.sheetNo, r.rowOrder, `="${r.jan}"`, `"${r.name}"`, r.catMid, r.catSmall, r.price, r.qtyUpper ?? '', r.qtyLower ?? '', t, t * (r.price || 0), r.worker, r.updatedAt].join(',');
    });
    const csv = '\uFEFF' + [header.join(','), ...rows].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `道の駅おけがわ_棚卸データ_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
}

// ==========================================================
// 5. 商品台帳Excel 投げ込み登録（SheetJS + GASチャンク送信）
// ==========================================================
function setupExcelDropZone() {
    const zone = document.getElementById('drop-zone');
    const input = document.getElementById('excel-file-input');
    zone.onclick = () => input.click();
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('bg-blue-200'); };
    zone.ondragleave = () => zone.classList.remove('bg-blue-200');
    zone.ondrop = (e) => {
        e.preventDefault();
        zone.classList.remove('bg-blue-200');
        if (e.dataTransfer.files[0]) handleExcelDropFile(e.dataTransfer.files[0]);
    };
}

async function handleExcelDropFile(file) {
    if (!file) return;
    const box = document.getElementById('import-status-box');
    box.classList.remove('hidden');
    box.textContent = `⏳ 「${file.name}」を解析中...`;

    try {
        const data = await file.arrayBuffer();
        const wb = XLSX.read(data, { type: 'array' });
        const targetSheetName = wb.SheetNames.find(n => n.includes('商品台帳')) || wb.SheetNames[0];
        const ws = wb.Sheets[targetSheetName];
        const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1 });

        // 添付Excel「商品台帳」の列構成：0=商品コード, 1=商品名称, 3=POS売価, 18=中分類, 19=小分類
        const parsed = [];
        for (let i = 1; i < rawRows.length; i++) {
            const r = rawRows[i];
            if (!r || !r[0]) continue;
            parsed.push([
                String(r[0]).trim(),
                String(r[1] || '').trim(),
                Number(r[3]) || 0,
                String(r[18] || '').trim(),
                String(r[19] || '').trim()
            ]);
        }

        const savedCount = await saveProductsToIDB(parsed);
        box.textContent = `✅ 端末への高速キャッシュ完了（${savedCount.toLocaleString()}件）。GASへ送信中...`;

        // GASへ4,000件ずつチャンク送信
        const url = getActiveGasUrl();
        if (url) {
            const CHUNK = 4000;
            for (let c = 0; c < parsed.length; c += CHUNK) {
                const slice = parsed.slice(c, c + CHUNK);
                box.textContent = `☁️ スプレッドシートへ登録中... (${Math.min(c + CHUNK, parsed.length).toLocaleString()} / ${parsed.length.toLocaleString()}件)`;
                await postToGasApi({ action: 'uploadProductsChunk', chunkIndex: c, rows: slice });
            }
            box.textContent = `🎉 完了！「${targetSheetName}」から ${savedCount.toLocaleString()}件を端末とスプレッドシートの両方に登録しました。`;
        } else {
            box.textContent = `✅ 端末に ${savedCount.toLocaleString()}件を登録しました（※GAS URL未設定のため端末内のみ保存）。`;
        }
        renderAdminDashboard();
    } catch (err) {
        box.textContent = `⚠️ 読込エラー: ${err.message}`;
    }
}

// ==========================================================
// 6. 設定・接続・バックアップモーダル
// ==========================================================
function saveWorkersList() {
    const raw = document.getElementById('mst-workers-input').value;
    const list = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 15);
    if (list.length === 0) return;
    masterData.workers = list;
    saveToLocalStorage();
    postToGasApi({ action: 'saveMaster', masterData });
    renderWorkerSelect();
    showToast('✅ 担当者リストを更新しました');
}

function updateAdminPin() {
    const pin = document.getElementById('mst-admin-pin').value.trim();
    if (!pin) return;
    masterData.adminPin = pin;
    saveToLocalStorage();
    postToGasApi({ action: 'saveMaster', masterData });
    showToast('✅ 管理者PINを変更しました');
}

function openGasUrlModal() {
    openModal('⚙️ GASスプレッドシート接続設定', `
        <p class="text-xs text-slate-600">デプロイしたGASウェブアプリのURLを貼り付けて保存してください。</p>
        <input id="inp-gas-url" type="url" value="${masterData.gasWebhookUrl || ''}" placeholder="https://script.google.com/macros/s/.../exec" class="w-full border rounded-lg p-2 font-mono text-xs">
        <button onclick="saveGasUrl()" class="w-full bg-blue-600 text-white font-bold py-2 rounded-lg">接続先を保存して同期</button>
    `);
}

function saveGasUrl() {
    masterData.gasWebhookUrl = document.getElementById('inp-gas-url').value.trim();
    saveToLocalStorage();
    closeModal();
    fetchAllFromGasApi(true);
}

function openBackupModal() {
    openModal('💾 バックアップ・データ復元', `
        <p class="text-xs text-slate-600">万が一の通信障害に備え、端末内の全棚卸データをJSONファイルとして保存・復元できます。</p>
        <button onclick="exportBackupJson()" class="w-full bg-emerald-600 text-white font-bold py-2.5 rounded-xl">⬇️ バックアップファイル(.json)を保存</button>
        <div class="pt-3 border-t">
            <label class="font-bold text-xs block mb-1">📂 バックアップから復元</label>
            <input type="file" accept=".json" onchange="importBackupJson(this.files[0])" class="text-xs">
        </div>
    `);
}

function exportBackupJson() {
    const data = JSON.stringify({ masterData, inventoryRecords, exportedAt: formatNow() }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = `okegawa_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
}

function importBackupJson(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const parsed = JSON.parse(e.target.result);
            if (parsed.masterData) masterData = Object.assign(masterData, parsed.masterData);
            if (Array.isArray(parsed.inventoryRecords)) inventoryRecords = parsed.inventoryRecords;
            saveToLocalStorage();
            renderAllViews();
            closeModal();
            showToast('✅ バックアップから復元しました');
        } catch (err) {
            alert('復元に失敗しました');
        }
    };
    reader.readAsText(file);
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
