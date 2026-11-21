/**
 * app-core.js (v10)
 * ・GAS接続URLの永久固定キー管理（バージョンアップしても消えない）＆URLパラメータ(?gas=)自動取込
 * ・オフライン送信待ちキュー＆自動リトライ（バックヤード電波対策）
 * ・AppSheet並みの全方向スキャン（ネイティブBarcodeDetector + ZXing-JS TRY_HARDER）
 * ・読み上げ辞書変換付き 明るい声TTS ＆ ハンズフリー音声入力
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
    currentWorker: '1:佐藤',
    currentSheetNo: 1,
    workMode: 'count',      // 'count' | 'pickup'
    fieldLock: 'both',      // 'both' | 'upper' | 'lower'
    activeField: 'upper',   // 'upper' | 'lower'
    selectedRecordId: null,
    inputBuffer: '',
    isAdminUnlocked: false,
    soundOn: true,
    ttsOn: true,
    isListening: false
};

// ==========================================================
// 1. 永久固定キーでのGAS URL管理 ＆ QRパラメータ自動取込
// ==========================================================
function normalizeJan(raw) {
    return String(raw ?? '').replace(/[^\d]/g, '');
}

function getActiveGasUrl() {
    try {
        return (localStorage.getItem(PERMANENT_GAS_URL_KEY) || '').trim();
    } catch (e) { return ''; }
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
            // アドレスバーからGAS URLを隠す
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
// 2. IndexedDB（2.1万件の商品台帳 高速検索）
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
// 3. GAS通信 ＆ オフライン送信待ちキュー（機能④）
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
        if (showNotification) showToast('「⚙️接続」からGAS URLを設定（またはQR読込）してください');
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
            if (Array.isArray(json.data.workers) && json.data.workers.length > 0) {
                masterData.workers = json.data.workers;
            }
            if (Array.isArray(json.data.readingDict)) {
                readingDict = json.data.readingDict;
            }
            if (Array.isArray(json.data.records)) {
                inventoryRecords = json.data.records;
            }
            if (Array.isArray(json.data.addLogs)) {
                addStockLogs = json.data.addLogs;
            }
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
// 4. 電子音（SFX） ＆ 読み上げ辞書対応 明るい声TTS
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
    err:  () => playTone(260, 'sawtooth', 0.16, 0.1)
};

function toggleSound() {
    appState.soundOn = !appState.soundOn;
    document.getElementById('btn-sound').textContent = appState.soundOn ? '🔊音' : '🔇音';
    if (appState.soundOn) SFX.key();
}

let speakDelayTimer = null;
let isSpeaking = false;

function applyReadingDict(text) {
    let out = String(text || '');
    for (const pair of readingDict) {
        if (pair[0] && pair[1]) {
            out = out.split(pair[0]).join(pair[1]);
        }
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
    } else {
        speakText('音声読み上げをオンにしました！', true);
    }
}

function speakText(text, force = false) {
    if ((!appState.ttsOn && !force) || !('speechSynthesis' in window)) return;
    try {
        clearTimeout(speakDelayTimer);
        window.speechSynthesis.cancel();
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
        const converted = applyReadingDict(text);
        speakDelayTimer = setTimeout(() => {
            try {
                isSpeaking = true;
                const utter = new SpeechSynthesisUtterance(converted);
                utter.lang = 'ja-JP';
                utter.rate = 1.15;
                utter.pitch = 1.25;
                utter.volume = 1.0;
                utter.onend = () => { isSpeaking = false; };
                utter.onerror = () => { isSpeaking = false; };
                window.speechSynthesis.speak(utter);
            } catch (e) { isSpeaking = false; }
        }, 40);
    } catch (e) { isSpeaking = false; }
}

function speakCurrentRecord(force = false, prefix = '') {
    const rec = getCurrentRecord();
    if (!rec) return;
    const prevTot = (Number(rec.prevUpper) || 0) + (Number(rec.prevLower) || 0);
    const prevMsg = (rec.prevUpper !== null || rec.prevLower !== null) ? `先月${prevTot}。` : '';
    const fieldMsg = appState.activeField === 'upper' ? '棚上' : '棚下';
    speakText(`${prefix}${rec.name}。${prevMsg}${fieldMsg}をどうぞ！`, force);
}

// ==========================================================
// 5. AppSheet並み高精度・全方向バーコードスキャナー（BarcodeDetector + ZXing-JS）
// ==========================================================
let isCameraRunning = false;
let scannerStream = null;
let zxingReader = null;
let nativeDetector = null;
let nativeScanRaf = null;
let lastAcceptedCode = '';
let lastAcceptedTime = 0;

if ('BarcodeDetector' in window) {
    try {
        nativeDetector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
    } catch (e) { nativeDetector = null; }
}

async function toggleCameraScanner() {
    if (isCameraRunning) await stopCameraScanner();
    else await startCameraScanner();
}

function acceptScannedBarcode(rawText) {
    const clean = normalizeJan(rawText);
    if (clean.length < 7) return;
    const now = Date.now();
    if (clean === lastAcceptedCode && now - lastAcceptedTime < 1600) return;
    lastAcceptedCode = clean;
    lastAcceptedTime = now;
    handleBarcodeScan(clean);
}

async function startCameraScanner() {
    if (isCameraRunning) return;
    const videoEl = document.getElementById('scanner-video');
    const wrapper = document.getElementById('camera-wrapper');
    const badge = document.getElementById('scan-engine-badge');

    try {
        scannerStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1280 },
                height: { ideal: 720 },
                focusMode: 'continuous'
            },
            audio: false
        });
        videoEl.srcObject = scannerStream;
        await videoEl.play();

        // ハードウェアの連続オートフォーカスを強制適用（対応端末のみ）
        try {
            const track = scannerStream.getVideoTracks()[0];
            const caps = track.getCapabilities ? track.getCapabilities() : {};
            if (caps.focusMode && caps.focusMode.includes('continuous')) {
                await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
            }
        } catch (e) {}

        isCameraRunning = true;
        wrapper.classList.remove('hidden');
        document.getElementById('cam-btn-label').textContent = '停止';

        // エンジン①：ネイティブBarcodeDetector（Android Chrome等で最速・縦横斜め完全対応）
        if (nativeDetector) {
            badge.textContent = '⚡ Native全方向スキャン';
            const detectLoop = async () => {
                if (!isCameraRunning) return;
                if (videoEl.readyState >= 2) {
                    try {
                        const codes = await nativeDetector.detect(videoEl);
                        if (codes && codes.length > 0 && codes[0].rawValue) {
                            acceptScannedBarcode(codes[0].rawValue);
                        }
                    } catch (e) {}
                }
                nativeScanRaf = requestAnimationFrame(detectLoop);
            };
            detectLoop();
        } else if (window.ZXing) {
            // エンジン②：ZXing-JS TRY_HARDER（iPhone Safariでも縦・横・斜めを高精度認識）
            badge.textContent = '⚡ ZXing全方向スキャン';
            const hints = new Map();
            hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
            hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
                ZXing.BarcodeFormat.EAN_13,
                ZXing.BarcodeFormat.EAN_8,
                ZXing.BarcodeFormat.UPC_A,
                ZXing.BarcodeFormat.CODE_128
            ]);
            zxingReader = new ZXing.BrowserMultiFormatReader(hints, 120);
            zxingReader.decodeFromStream(scannerStream, videoEl, (result, err) => {
                if (!isCameraRunning) return;
                if (result && result.getText) {
                    acceptScannedBarcode(result.getText());
                }
            });
        } else {
            badge.textContent = '⚠️ スキャナー読込中';
        }
    } catch (err) {
        showToast('カメラ起動エラー: ' + err.message);
        await stopCameraScanner();
    }
}

async function stopCameraScanner() {
    isCameraRunning = false;
    if (nativeScanRaf) { cancelAnimationFrame(nativeScanRaf); nativeScanRaf = null; }
    if (zxingReader) { try { zxingReader.reset(); } catch (e) {} zxingReader = null; }
    if (scannerStream) {
        scannerStream.getTracks().forEach(t => t.stop());
        scannerStream = null;
    }
    const videoEl = document.getElementById('scanner-video');
    if (videoEl) videoEl.srcObject = null;
    document.getElementById('camera-wrapper').classList.add('hidden');
    document.getElementById('cam-btn-label').textContent = 'スキャン';
}

// ==========================================================
// 6. ハンズフリー音声入力（読み上げ途中割り込み・ひらがな/漢数字対応）
// ==========================================================
let recognition = null;
function extractJapaneseNumber(str) {
    let norm = str
        .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
        .replace(/[\u30a1-\u30f6]/g, m => String.fromCharCode(m.charCodeAt(0) - 0x60));
    const digitMatch = norm.match(/\d+/);
    if (digitMatch) return parseInt(digitMatch[0], 10);

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
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return showToast('このブラウザは音声入力に非対応です');

    if (appState.isListening) {
        appState.isListening = false;
        if (recognition) try { recognition.abort(); } catch (e) {}
        document.getElementById('btn-voice-toggle').classList.remove('mic-active');
        document.getElementById('voice-btn-label').textContent = '声';
        document.getElementById('voice-transcript-bar').classList.add('hidden');
        return;
    }

    recognition = new SR();
    recognition.lang = 'ja-JP';
    recognition.continuous = false;
    recognition.onresult = (e) => {
        const text = e.results[0][0].transcript.trim();
        // 読み上げ中でも割り込みコマンドを受け付け
        if (window.speechSynthesis && isSpeaking) {
            window.speechSynthesis.cancel();
            isSpeaking = false;
        }
        document.getElementById('voice-transcript').textContent = `認識: 「${text}」`;
        if (/棚上|たなうえ/.test(text)) setActiveField('upper');
        if (/棚下|たなした/.test(text)) setActiveField('lower');
        if (/先月|前回|同じ/.test(text)) copyPrevMonthQty();
        const num = extractJapaneseNumber(text);
        if (num !== null) {
            appState.inputBuffer = String(num);
            applyBufferToCurrentRecord();
        }
        if (/次|つぎ|確定|かくてい|はい|オッケー|OK/i.test(text)) confirmAndNextRecord();
    };
    recognition.onend = () => {
        if (appState.isListening) setTimeout(() => { try { recognition.start(); } catch (e) {} }, 220);
    };

    appState.isListening = true;
    document.getElementById('btn-voice-toggle').classList.add('mic-active');
    document.getElementById('voice-btn-label').textContent = '止';
    document.getElementById('voice-transcript-bar').classList.remove('hidden');
    recognition.start();
}
