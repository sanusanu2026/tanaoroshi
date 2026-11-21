/**
 * app-core.js (v12)
 * ・DOM安全配置videoによるカメラ停止/復帰の完全安定化 ＋ 連続スキャン/1回停止の切替
 * ・maxAlternatives=5 ＋ 日本語同音異義語テーブルによる高精度な数字音声認識
 * ・スピードUP読み上げ「商品名、先月〇〇個、棚上/棚下、数量どうぞ」＋完全排他マイク
 */

const PERMANENT_GAS_URL_KEY = 'OKEGAWA_PERMANENT_GAS_URL';
const OFFLINE_QUEUE_KEY     = 'OKEGAWA_OFFLINE_QUEUE';
const STORAGE_KEY           = 'okegawa_inventory_v10';
const IDB_NAME              = 'OkegawaProductMasterDB';
const IDB_STORE             = 'products';

const defaultMaster = {
    adminPin: '1234',
    sheetNames: {},
    alertSettings: {
        maxQty: 100,
        maxAmount: 50000,
        prevRatio: 2.0,
        warnZeroFromPrev: true
    },
    workers: [
        '1:佐藤', '2:鈴木', '3:高橋', '4:田中', '5:伊藤',
        '6:渡辺', '7:山本', '8:中村', '9:小林', '10:加藤',
        '11:吉田', '12:山田', '13:佐々木', '14:山口', '15:松本'
    ]
};

let masterData = JSON.parse(JSON.stringify(defaultMaster));
let inventoryRecords = [];
let addStockLogs = [];
let readingDict = [['桶川', 'おけがわ'], ['紅花', 'べにばな'], ['道の駅', 'みちのえき']];
let productMap = new Map();
let offlineQueue = [];

const appState = {
    currentView: 'mobile',      // 'mobile' | 'pickup' | 'admin'
    mobileListFilter: 'all',    // 'all' | 'uncounted' | 'anomaly' | 'memo'
    cameraContinuous: true,     // true: 連続スキャン / false: 1回読取で自動停止
    currentWorker: '1:佐藤',
    currentSheetNo: 1,
    fieldLock: 'both',          // 'both' | 'upper' | 'lower'
    activeField: 'upper',       // 'upper' | 'lower'
    selectedRecordId: null,
    inputBuffer: '',
    isAdminUnlocked: false,
    isModalOpen: false,
    soundOn: true,
    ttsOn: true,
    isListening: false
};

// ==========================================================
// 1. 永久固定GASキー ＆ ローカル保存
// ==========================================================
function normalizeJan(raw) {
    return String(raw ?? '').replace(/[^\d]/g, '');
}

function getActiveGasUrl() {
    try { return (localStorage.getItem(PERMANENT_GAS_URL_KEY) || '').trim(); } catch (e) { return ''; }
}

function setActiveGasUrl(url) {
    try {
        const clean = (url || '').trim();
        if (clean) localStorage.setItem(PERMANENT_GAS_URL_KEY, clean);
        else localStorage.removeItem(PERMANENT_GAS_URL_KEY);
    } catch (e) {}
}

function captureGasUrlFromQuery() {
    try {
        const params = new URLSearchParams(window.location.search);
        const gasParam = params.get('gas');
        if (gasParam && gasParam.startsWith('http')) {
            setActiveGasUrl(gasParam);
            window.history.replaceState({}, document.title, window.location.pathname);
            return true;
        }
    } catch (e) {}
    return false;
}

function saveToLocalStorage() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            masterData,
            inventoryRecords,
            addStockLogs,
            readingDict,
            currentWorker: appState.currentWorker,
            currentSheetNo: appState.currentSheetNo,
            fieldLock: appState.fieldLock
        }));
    } catch (e) {}
}

function loadFromLocalStorage() {
    try {
        const rawQ = localStorage.getItem(OFFLINE_QUEUE_KEY);
        if (rawQ) offlineQueue = JSON.parse(rawQ) || [];
    } catch (e) { offlineQueue = []; }

    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed.masterData) {
            masterData = Object.assign(JSON.parse(JSON.stringify(defaultMaster)), parsed.masterData);
            masterData.alertSettings = Object.assign(JSON.parse(JSON.stringify(defaultMaster.alertSettings)), parsed.masterData.alertSettings || {});
            if (!masterData.sheetNames) masterData.sheetNames = {};
        }
        if (Array.isArray(parsed.inventoryRecords)) inventoryRecords = parsed.inventoryRecords;
        if (Array.isArray(parsed.addStockLogs)) addStockLogs = parsed.addStockLogs;
        if (Array.isArray(parsed.readingDict)) readingDict = parsed.readingDict;
        if (parsed.currentWorker) appState.currentWorker = parsed.currentWorker;
        if (parsed.currentSheetNo) appState.currentSheetNo = Number(parsed.currentSheetNo) || 1;
        if (parsed.fieldLock) appState.fieldLock = parsed.fieldLock;
    } catch (e) {}
}

// ==========================================================
// 2. IndexedDB（2.1万件の商品台帳）
// ==========================================================
function openProductDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: 'jan' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveProductsToIDB(rows) {
    const db = await openProductDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        store.clear();
        productMap.clear();
        for (const r of rows) {
            const jan = normalizeJan(r[0]);
            if (!jan) continue;
            const obj = {
                jan,
                name: String(r[1] || '').trim(),
                price: Number(r[2]) || 0,
                catMid: String(r[3] || '').trim(),
                catSmall: String(r[4] || '').trim()
            };
            store.put(obj);
            productMap.set(jan, obj);
        }
        tx.oncomplete = () => resolve(productMap.size);
        tx.onerror = () => reject(tx.error);
    });
}

async function loadProductsFromIDB() {
    try {
        const db = await openProductDB();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).getAll();
            req.onsuccess = () => {
                productMap.clear();
                (req.result || []).forEach(p => {
                    const key = normalizeJan(p.jan);
                    if (key) productMap.set(key, p);
                });
                resolve(productMap.size);
            };
            req.onerror = () => resolve(0);
        });
    } catch (e) { return 0; }
}

function lookupProductByJan(rawJan) {
    const jan = normalizeJan(rawJan);
    if (!jan) return { jan: '', name: '未登録商品', price: 0, catMid: '一般', catSmall: '' };

    if (jan.startsWith('2') && jan.length >= 11) {
        const key7 = jan.substring(0, 7);
        const extractedPrice = parseInt(jan.substring(7, 11), 10) || 0;
        const hit = productMap.get(key7);
        return {
            jan,
            name: hit ? hit.name : `インストア商品(${key7})`,
            price: extractedPrice,
            catMid: hit ? hit.catMid : '一般',
            catSmall: hit ? hit.catSmall : ''
        };
    }

    const hit = productMap.get(jan) || productMap.get(jan.replace(/^0+/, ''));
    if (hit) return { jan, name: hit.name, price: hit.price, catMid: hit.catMid, catSmall: hit.catSmall };
    return { jan, name: '未登録商品（要確認）', price: 0, catMid: '一般', catSmall: '' };
}

// ==========================================================
// 3. GAS通信 ＆ オフライン送信待ちキュー
// ==========================================================
function updateSyncStatusDot(stateStr) {
    const dot = document.getElementById('sync-status-dot');
    if (dot) {
        if (stateStr === 'ok') dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0';
        else if (stateStr === 'syncing') dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping shrink-0';
        else dot.className = 'w-2.5 h-2.5 rounded-full bg-rose-500 shrink-0';
    }
    const qBadge = document.getElementById('offline-queue-badge');
    if (qBadge) {
        if (offlineQueue.length > 0) {
            qBadge.textContent = `未送信:${offlineQueue.length}`;
            qBadge.classList.remove('hidden');
        } else {
            qBadge.classList.add('hidden');
        }
    }
}

function saveOfflineQueue() {
    try { localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(offlineQueue)); } catch (e) {}
    updateSyncStatusDot(offlineQueue.length > 0 ? 'offline' : 'ok');
}

async function postToGasApi(payloadObj, queueIfOffline = true) {
    const url = getActiveGasUrl();
    if (!url) return false;
    updateSyncStatusDot('syncing');
    try {
        const res = await fetch(url, {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payloadObj)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        updateSyncStatusDot(offlineQueue.length > 0 ? 'offline' : 'ok');
        return true;
    } catch (e) {
        if (queueIfOffline) {
            offlineQueue.push(payloadObj);
            saveOfflineQueue();
            showToast(`📶 電波不良のため一時保存（未送信:${offlineQueue.length}件）`);
        } else {
            updateSyncStatusDot('offline');
        }
        return false;
    }
}

async function flushOfflineQueue(showMsg = false) {
    if (offlineQueue.length === 0 || !getActiveGasUrl() || !navigator.onLine) return;
    if (showMsg) showToast(`🔄 未送信 ${offlineQueue.length}件を再送信中...`);
    const remaining = [];
    for (let i = 0; i < offlineQueue.length; i++) {
        const ok = await postToGasApi(offlineQueue[i], false);
        if (!ok) {
            remaining.push(...offlineQueue.slice(i));
            break;
        }
    }
    offlineQueue = remaining;
    saveOfflineQueue();
    if (showMsg && remaining.length === 0) showToast('✅ 未送信データをすべて送信しました！');
}

window.addEventListener('online', () => flushOfflineQueue(true));
setInterval(() => { if (offlineQueue.length > 0 && navigator.onLine) flushOfflineQueue(false); }, 15000);

async function fetchAllFromGasApi(showNotification = true) {
    const url = getActiveGasUrl();
    if (!url) {
        updateSyncStatusDot('offline');
        if (showNotification) showToast('「⚙️接続」からGAS URLを設定してください');
        return;
    }
    if (offlineQueue.length > 0) await flushOfflineQueue(false);

    updateSyncStatusDot('syncing');
    if (showNotification) showToast('🔄 スプレッドシートと同期中...');
    try {
        const res = await fetch(url + '?type=all&t=' + Date.now(), { method: 'GET', redirect: 'follow' });
        const json = await res.json();
        if (json.status === 'ok' && json.data) {
            if (json.data.masterData) {
                masterData = Object.assign(JSON.parse(JSON.stringify(defaultMaster)), json.data.masterData);
                masterData.alertSettings = Object.assign(JSON.parse(JSON.stringify(defaultMaster.alertSettings)), json.data.masterData.alertSettings || {});
                if (!masterData.sheetNames) masterData.sheetNames = {};
            }
            if (Array.isArray(json.data.workers) && json.data.workers.length > 0) masterData.workers = json.data.workers;
            if (Array.isArray(json.data.readingDict)) readingDict = json.data.readingDict;
            if (Array.isArray(json.data.records)) inventoryRecords = json.data.records;
            if (Array.isArray(json.data.addLogs)) addStockLogs = json.data.addLogs;

            saveToLocalStorage();
            initSheetNoSelects();
            renderWorkerSelect();
            renderAllViews();
            updateSyncStatusDot('ok');
            if (showNotification) showToast('✅ 最新データを同期しました');

            if (productMap.size === 0 && (json.data.productCount || 0) > 0) {
                await downloadProductsFromGas();
            }
        }
    } catch (err) {
        updateSyncStatusDot('offline');
        if (showNotification) showToast('⚠️ 同期エラー（ローカル動作中）');
    }
}

async function downloadProductsFromGas() {
    const url = getActiveGasUrl();
    if (!url) return showToast('先に「⚙️接続」からGAS URLを設定してください');
    showToast('☁️ 商品台帳マスタをダウンロード中...');
    try {
        const res = await fetch(url + '?type=products&t=' + Date.now(), { method: 'GET', redirect: 'follow' });
        const json = await res.json();
        if (json.status === 'ok' && Array.isArray(json.products)) {
            const cnt = await saveProductsToIDB(json.products);
            renderAllViews();
            showToast(`✅ 商品台帳 ${cnt.toLocaleString()}件を端末に保存しました`);
        }
    } catch (err) {
        showToast('⚠️ マスタ取得エラー: ' + err.message);
    }
}

function formatNow() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ==========================================================
// 4. 電子音（SFX）＆ 高精度数字音声認識（5候補＋同音異義語辞書）
// ==========================================================
let audioCtx = null;
function playTone(freq, type = 'square', dur = 0.07, vol = 0.08) {
    if (!appState.soundOn) return;
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(vol, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + dur);
    } catch (e) {}
}

const SFX = {
    scan: () => playTone(2350, 'square', 0.08, 0.14),
    key:  () => playTone(980, 'sine', 0.04, 0.05),
    next: () => { playTone(1046, 'sine', 0.06, 0.07); setTimeout(() => playTone(1318, 'sine', 0.09, 0.07), 65); },
    voiceOk: () => playTone(1568, 'triangle', 0.08, 0.07),
    err:  () => playTone(260, 'sawtooth', 0.16, 0.1)
};

function toggleSound() {
    appState.soundOn = !appState.soundOn;
    document.getElementById('btn-sound').textContent = appState.soundOn ? '🔊音' : '🔇音';
    if (appState.soundOn) SFX.key();
}

let isSpeaking = false;
let speechWatchdog = null;
let recognition = null;

function applyReadingDict(text) {
    let out = String(text || '');
    for (const pair of readingDict) {
        if (pair[0] && pair[1]) out = out.split(pair[0]).join(pair[1]);
    }
    return out;
}

function toggleTts() {
    appState.ttsOn = !appState.ttsOn;
    const btn = document.getElementById('btn-tts');
    btn.textContent = appState.ttsOn ? '🗣️声' : '🔇声';
    btn.className = appState.ttsOn
        ? 'bg-amber-600 text-white font-bold text-[11px] px-1.5 py-1 rounded'
        : 'bg-slate-800 border border-slate-700 text-slate-300 text-[11px] px-1.5 py-1 rounded';
    if (!appState.ttsOn && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        isSpeaking = false;
    } else if (appState.currentView === 'mobile') {
        speakText('音声オン', true);
    }
}

function startRecognitionSafely() {
    if (!appState.isListening || isSpeaking || appState.currentView !== 'mobile' || !recognition) return;
    try { recognition.start(); } catch (e) {}
}

function speakText(text, force = false) {
    if (appState.currentView === 'pickup') return;
    if ((!appState.ttsOn && !force) || !('speechSynthesis' in window)) {
        isSpeaking = false;
        startRecognitionSafely();
        return;
    }
    try {
        clearTimeout(speechWatchdog);
        window.speechSynthesis.cancel();
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();

        isSpeaking = true;
        if (recognition) { try { recognition.abort(); } catch (e) {} }
        const trEl = document.getElementById('voice-transcript');
        if (appState.isListening && trEl) trEl.textContent = '🗣️ 読み上げ中...';

        const utter = new SpeechSynthesisUtterance(applyReadingDict(text));
        utter.lang = 'ja-JP';
        utter.rate = 1.22;
        utter.pitch = 1.25;
        utter.volume = 1.0;

        const finishSpeak = () => {
            clearTimeout(speechWatchdog);
            if (!isSpeaking) return;
            isSpeaking = false;
            if (appState.isListening && appState.currentView === 'mobile') {
                if (trEl) trEl.textContent = '👂 聞き取り中...（数字 / 次へ）';
                setTimeout(startRecognitionSafely, 220);
            }
        };

        utter.onend = finishSpeak;
        utter.onerror = finishSpeak;
        speechWatchdog = setTimeout(finishSpeak, Math.max(1500, text.length * 145));

        window.speechSynthesis.speak(utter);
    } catch (e) {
        isSpeaking = false;
        startRecognitionSafely();
    }
}

function speakCurrentRecord(force = false) {
    if (appState.currentView !== 'mobile') return;
    const rec = getCurrentRecord();
    if (!rec) return;
    const hasPrev = (rec.prevUpper !== null && rec.prevUpper !== undefined) || (rec.prevLower !== null && rec.prevLower !== undefined);
    const prevTot = (Number(rec.prevUpper) || 0) + (Number(rec.prevLower) || 0);
    const prevPart = hasPrev ? `先月${prevTot}個、` : '';
    const fieldPart = appState.activeField === 'upper' ? '棚上' : '棚下';
    speakText(`${rec.name}、${prevPart}${fieldPart}、数量どうぞ`, force);
}

function interruptSpeakAndListen() {
    if (!appState.isListening) return;
    clearTimeout(speechWatchdog);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    isSpeaking = false;
    const trEl = document.getElementById('voice-transcript');
    if (trEl) trEl.textContent = '👂 聞き取り中...（どうぞ！）';
    setTimeout(startRecognitionSafely, 80);
}

function stopVoiceAll() {
    appState.isListening = false;
    isSpeaking = false;
    clearTimeout(speechWatchdog);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (recognition) { try { recognition.abort(); } catch (e) {} }
    const btn = document.getElementById('btn-voice-toggle');
    if (btn) btn.classList.remove('mic-active');
    const lbl = document.getElementById('voice-btn-label');
    if (lbl) lbl.textContent = '声';
    const bar = document.getElementById('voice-transcript-bar');
    if (bar) bar.classList.add('hidden');
}

/**
 * 短い日本語の数字・誤変換しやすい漢字（位置→1、後→5、蜂→8 等）を完全変換
 */
function extractJapaneseNumber(str) {
    let norm = String(str || '')
        .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
        .replace(/[\u30a1-\u30f6]/g, m => String.fromCharCode(m.charCodeAt(0) - 0x60))
        .replace(/個|こ|本|ほん|ぽん|ぼん|箱|はこ|つ|枚|まい|袋|ふくろ|パック|ケース|です|だよ|ね/g, '')
        .trim();

    const digitMatch = norm.match(/\d+/);
    if (digitMatch) return parseInt(digitMatch[0], 10);

    // 短い数字でスマホが誤変換しがちな漢字・単語を完全網羅
    const exactHomophones = {
        '例': 0, '霊': 0, '礼': 0, 'ゼロ': 0, 'ぜろ': 0, 'れい': 0, 'まる': 0, '丸': 0, 'なし': 0, '無し': 0,
        '位置': 1, '市': 1, '壱': 1, 'いち': 1, 'ひとつ': 1, '一つ': 1,
        '荷': 2, '似': 2, '煮': 2, '弐': 2, 'に': 2, 'ふたつ': 2, '二つ': 2,
        '山': 3, '産': 3, '参': 3, 'さん': 3, 'みっつ': 3, '三つ': 3,
        '世': 4, '夜': 4, '余': 4, 'よん': 4, 'し': 4, 'よっつ': 4, '四つ': 4,
        '語': 5, '後': 5, '午': 5, '期': 5, 'ご': 5, 'いつつ': 5, '五つ': 5,
        '録': 6, '緑': 6, 'ろく': 6, 'むっつ': 6, '六つ': 6,
        '菜々': 7, 'なな': 7, 'しち': 7, 'ななつ': 7, '七つ': 7,
        '蜂': 8, '鉢': 8, '橋': 8, '端': 8, 'はち': 8, 'やっつ': 8, '八つ': 8,
        '球': 9, '急': 9, '旧': 9, '救': 9, 'きゅう': 9, 'く': 9, 'ここのつ': 9, '九つ': 9,
        '銃': 10, '中': 10, '重': 10, '自由': 10, 'じゅう': 10, 'とお': 10,
        '二十': 20, 'はたち': 20, 'にじゅう': 20
    };
    if (exactHomophones[norm] !== undefined) return exactHomophones[norm];

    const rep = [
        ['さんびゃく', '三百'], ['ろっぴゃく', '六百'], ['はっぴゃく', '八百'], ['ひゃく', '百'],
        ['じゅう', '十'], ['ぜろ', '〇'], ['れい', '〇'],
        ['いち', '一'], ['ひと', '一'], ['に', '二'], ['ふた', '二'],
        ['さん', '三'], ['みっ', '三'], ['よん', '四'], ['し', '四'], ['よっ', '四'],
        ['ご', '五'], ['いつ', '五'], ['ろく', '六'], ['むっ', '六'],
        ['なな', '七'], ['しち', '七'], ['はち', '八'], ['やっ', '八'], ['きゅう', '九'], ['く', '九']
    ];
    for (const [h, k] of rep) norm = norm.split(h).join(k);
    const map = { '零':0, '〇':0, '一':1, '二':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9 };
    let total = 0, cur = 0, ok = false;
    for (const ch of norm) {
        if (map[ch] !== undefined) { cur = map[ch]; ok = true; }
        else if (ch === '十') { total += (cur || 1) * 10; cur = 0; ok = true; }
        else if (ch === '百') { total += (cur || 1) * 100; cur = 0; ok = true; }
    }
    return ok ? total + cur : null;
}

function toggleVoiceRecognition() {
    if (appState.currentView !== 'mobile') return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return showToast('このブラウザは音声認識に非対応です');

    if (appState.isListening) {
        stopVoiceAll();
        return;
    }

    recognition = new SR();
    recognition.lang = 'ja-JP';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 5; // 最大5候補すべてから数字を探索

    recognition.onstart = () => {
        const trEl = document.getElementById('voice-transcript');
        if (trEl && !isSpeaking) trEl.textContent = '👂 聞き取り中...（数字 / 次へ）';
    };

    recognition.onresult = (e) => {
        if (isSpeaking) return;
        const resultItem = e.results[0];
        const alts = [];
        for (let i = 0; i < resultItem.length; i++) {
            alts.push(resultItem[i].transcript.trim());
        }
        const primaryText = alts[0] || '';
        const allJoined = alts.join(' ');
        const trEl = document.getElementById('voice-transcript');
        if (trEl) trEl.textContent = `✅ 認識: 「${primaryText}」`;

        if (/もう一回|もう一度|読み上げ/.test(allJoined)) { speakCurrentRecord(true); return; }
        if (/戻る|前/.test(allJoined)) { movePrevRecord(); return; }
        if (/クリア|取り消し/.test(allJoined)) { clearQtyInput(); SFX.voiceOk(); speakText('クリア'); return; }
        if (/棚上|たなうえ/.test(allJoined)) setActiveField('upper');
        if (/棚下|たなした/.test(allJoined)) setActiveField('lower');
        if (/先月|前回|同じ|同数/.test(allJoined)) {
            copyPrevMonthQty();
            SFX.voiceOk();
            if (/次|確定|はい|オッケー|OK/i.test(allJoined)) { confirmAndNextRecord(); return; }
            speakText('先月同数、次へで確定');
            return;
        }

        // 5候補の中から最初にヒットした数字を採用
        let foundNum = null;
        for (const cand of alts) {
            const n = extractJapaneseNumber(cand);
            if (n !== null) { foundNum = n; break; }
        }

        if (foundNum !== null) {
            SFX.voiceOk();
            appState.inputBuffer = String(foundNum);
            applyBufferToCurrentRecord();
            if (trEl) trEl.textContent = `✅ 数字認識: ${foundNum}（「${primaryText}」）`;
            if (/次|確定|はい|オッケー|OK/i.test(allJoined)) {
                confirmAndNextRecord();
            } else {
                speakText(`${foundNum}、次へで確定`);
            }
            return;
        }

        if (/次|つぎ|確定|かくてい|はい|オッケー|OK/i.test(allJoined)) {
            confirmAndNextRecord();
        }
    };

    recognition.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            stopVoiceAll();
            showToast('⚠️ マイク権限を許可してください');
            return;
        }
        if (appState.isListening && !isSpeaking) setTimeout(startRecognitionSafely, 300);
    };

    recognition.onend = () => {
        if (appState.isListening && !isSpeaking) setTimeout(startRecognitionSafely, 160);
    };

    appState.isListening = true;
    document.getElementById('btn-voice-toggle').classList.add('mic-active');
    document.getElementById('voice-btn-label').textContent = '止';
    document.getElementById('voice-transcript-bar').classList.remove('hidden');
    speakCurrentRecord(true);
}

// ==========================================================
// 5. DOM配置videoによる縦・横交互全方向スキャナー（確実に停止・復帰）
// ==========================================================
let isCameraRunning = false;
let scannerStream = null;
let previewLoopId = null;
let decodeTimerId = null;
let digitalZoom = 1.5;
let isDecodingFrame = false;
let decodeStartTime = 0;
let scanParity = 0;
let scanCount = 0;
let lastAcceptedCode = '';
let lastAcceptedTime = 0;

let nativeDetector = null;
if ('BarcodeDetector' in window) {
    try { nativeDetector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] }); } catch (e) {}
}

let zxingImageReader = null;
function getZxingReader() {
    if (!zxingImageReader && window.ZXing) {
        const hints = new Map();
        hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
        hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
            ZXing.BarcodeFormat.EAN_13,
            ZXing.BarcodeFormat.EAN_8,
            ZXing.BarcodeFormat.UPC_A,
            ZXing.BarcodeFormat.CODE_128
        ]);
        zxingImageReader = new ZXing.BrowserMultiFormatReader(hints);
    }
    return zxingImageReader;
}

function enhanceContrast(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const c = 1.55, ic = 128 * (1 - c);
    for (let i = 0; i < d.length; i += 4) {
        const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        const v = g * c + ic;
        d[i] = d[i + 1] = d[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    ctx.putImageData(img, 0, 0);
}

function calcCoverCrop(vw, vh, destW, destH, zoom) {
    const sr = vw / vh, dr = destW / destH;
    const bw = sr > dr ? vh * dr : vw;
    const bh = sr > dr ? vh : vw / dr;
    const cw = bw / zoom, ch = bh / zoom;
    return { cropX: (vw - cw) / 2, cropY: (vh - ch) / 2, cropW: cw, cropH: ch };
}

function toggleCameraContinuousMode() {
    appState.cameraContinuous = !appState.cameraContinuous;
    document.querySelectorAll('.cam-mode-btn').forEach(btn => {
        btn.textContent = appState.cameraContinuous ? '連続ON' : '1回で閉じる';
        btn.className = appState.cameraContinuous
            ? 'cam-mode-btn bg-blue-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded'
            : 'cam-mode-btn bg-amber-500 text-slate-950 text-[10px] font-bold px-1.5 py-0.5 rounded';
    });
}

function acceptScannedCode(raw) {
    const clean = normalizeJan(raw);
    if (clean.length < 7) return;
    const now = Date.now();
    if (clean === lastAcceptedCode && now - lastAcceptedTime < 1800) return;
    lastAcceptedCode = clean;
    lastAcceptedTime = now;

    // 「1回で閉じる」モード時はスキャン成功後にカメラを確実に閉じる
    if (!appState.cameraContinuous) {
        stopCameraScanner();
    }
    handleBarcodeScan(clean);
}

function updateCameraContainersVisibility() {
    const wm = document.getElementById('camera-wrapper-mobile');
    const wp = document.getElementById('camera-wrapper-pickup');
    if (wm) wm.classList.toggle('hidden', !(isCameraRunning && appState.currentView === 'mobile'));
    if (wp) wp.classList.toggle('hidden', !(isCameraRunning && appState.currentView === 'pickup'));
    const lm = document.getElementById('cam-btn-label-mobile');
    const lp = document.getElementById('cam-btn-label-pickup');
    if (lm) lm.textContent = isCameraRunning ? '停止' : 'スキャン';
    if (lp) lp.textContent = isCameraRunning ? '連続スキャン停止' : '連続スキャン開始';
}

async function toggleCameraScanner() {
    if (isCameraRunning) await stopCameraScanner();
    else await startCameraScanner();
}

async function startCameraScanner() {
    if (isCameraRunning) return;
    const videoEl = document.getElementById('camera-source-video');
    try {
        scannerStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
        videoEl.srcObject = scannerStream;
        await videoEl.play();

        try {
            const track = scannerStream.getVideoTracks()[0];
            const caps = track.getCapabilities ? track.getCapabilities() : {};
            if (caps.focusMode && caps.focusMode.includes('continuous')) {
                await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
            }
        } catch (e) {}

        isCameraRunning = true;
        isDecodingFrame = false;
        scanCount = 0;
        updateCameraContainersVisibility();

        const renderPreview = () => {
            if (!isCameraRunning) return;
            const canvasId = appState.currentView === 'pickup' ? 'preview-canvas-pickup' : 'preview-canvas-mobile';
            const pCanvas = document.getElementById(canvasId);
            if (pCanvas && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
                const rect = pCanvas.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    const tw = Math.max(280, Math.round(rect.width * 1.5));
                    const th = Math.max(160, Math.round(rect.height * 1.5));
                    if (pCanvas.width !== tw || pCanvas.height !== th) { pCanvas.width = tw; pCanvas.height = th; }
                    const ctx = pCanvas.getContext('2d', { alpha: false });
                    const { cropX, cropY, cropW, cropH } = calcCoverCrop(videoEl.videoWidth, videoEl.videoHeight, tw, th, digitalZoom);
                    ctx.drawImage(videoEl, cropX, cropY, cropW, cropH, 0, 0, tw, th);
                }
            }
            previewLoopId = requestAnimationFrame(renderPreview);
        };
        renderPreview();

        const dCanvas = document.getElementById('decode-canvas');
        const dCtx = dCanvas.getContext('2d', { willReadFrequently: true });

        decodeTimerId = setInterval(async () => {
            if (!isCameraRunning || appState.isModalOpen || appState.currentView === 'admin') return;
            if (videoEl.readyState < 3 || videoEl.videoWidth === 0) return;

            if (isDecodingFrame) {
                if (Date.now() - decodeStartTime > 1500) isDecodingFrame = false;
                else return;
            }

            isDecodingFrame = true;
            decodeStartTime = Date.now();
            scanCount++;
            const step = scanParity % 4;
            scanParity++;
            const isVertical = (step % 2 === 1);
            const useContrast = (step >= 2);

            const dbgId = appState.currentView === 'pickup' ? 'scan-debug-pickup' : 'scan-debug-mobile';
            const dbgEl = document.getElementById(dbgId);
            if (dbgEl) dbgEl.textContent = `${isVertical ? '縦' : '横'}解析:${scanCount}`;

            try {
                const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
                const sq = Math.floor(Math.min(vw, vh) / digitalZoom);
                const sx = Math.floor((vw - sq) / 2);
                const sy = Math.floor((vh - sq) / 2);
                const size = 600;
                dCanvas.width = size;
                dCanvas.height = size;

                dCtx.save();
                dCtx.setTransform(1, 0, 0, 1, 0, 0);
                if (isVertical) {
                    dCtx.translate(size / 2, size / 2);
                    dCtx.rotate(Math.PI / 2);
                    dCtx.drawImage(videoEl, sx, sy, sq, sq, -size / 2, -size / 2, size, size);
                } else {
                    dCtx.drawImage(videoEl, sx, sy, sq, sq, 0, 0, size, size);
                }
                dCtx.restore();

                if (nativeDetector && !useContrast) {
                    const codes = await nativeDetector.detect(dCanvas);
                    if (codes && codes.length > 0 && codes[0].rawValue) {
                        acceptScannedCode(codes[0].rawValue);
                        return;
                    }
                }

                if (useContrast) enhanceContrast(dCtx, size, size);
                const reader = getZxingReader();
                if (reader) {
                    const dataUrl = dCanvas.toDataURL('image/jpeg', 0.85);
                    try {
                        const res = await reader.decodeFromImageUrl(dataUrl);
                        if (res && res.getText) acceptScannedCode(res.getText());
                    } catch (notFoundErr) {}
                }
            } catch (e) {
            } finally {
                isDecodingFrame = false;
            }
        }, 90);
    } catch (err) {
        showToast('カメラ起動エラー: ' + err.message);
        await stopCameraScanner();
    }
}

function setDigitalZoom(z) {
    digitalZoom = z;
    document.querySelectorAll('.zoom-btn-10,.zoom-btn-15,.zoom-btn-22').forEach(el => {
        el.classList.remove('bg-emerald-600');
        el.classList.add('bg-slate-900/80');
    });
    const cls = z === 1.0 ? '.zoom-btn-10' : z === 1.5 ? '.zoom-btn-15' : '.zoom-btn-22';
    document.querySelectorAll(cls).forEach(el => {
        el.classList.remove('bg-slate-900/80');
        el.classList.add('bg-emerald-600');
    });
}

async function stopCameraScanner() {
    isCameraRunning = false;
    isDecodingFrame = false;
    if (previewLoopId) { cancelAnimationFrame(previewLoopId); previewLoopId = null; }
    if (decodeTimerId) { clearInterval(decodeTimerId); decodeTimerId = null; }
    if (scannerStream) {
        scannerStream.getTracks().forEach(t => t.stop());
        scannerStream = null;
    }
    const videoEl = document.getElementById('camera-source-video');
    if (videoEl) {
        try { videoEl.pause(); } catch (e) {}
        videoEl.srcObject = null;
    }
    updateCameraContainersVisibility();
}
