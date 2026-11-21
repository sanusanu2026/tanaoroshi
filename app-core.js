/**
 * app-core.js (v9)
 * ・JANコード完全正規化（数字のみ統一）＋先頭2インストアコード自動価格抽出
 * ・縦横全方向スキャン（正方形クロップ＋0°/90°交互回転＋高コントラスト＋BarcodeDetector併用）
 * ・明るい声の音声読み上げ（pitch=1.25 / rate=1.15 / 40ms遅延でスマホ無音バグ解消）
 */

const STORAGE_KEY = 'okegawa_inventory_v9';
const IDB_NAME = 'OkegawaProductMasterDB';
const IDB_STORE = 'products';

const defaultMaster = {
    adminPin: '1234',
    gasWebhookUrl: '',
    sheetNames: {}, // 例: { "1": "入口特設", "2": "菓子棚A" }
    workers: [
        '1:佐藤', '2:鈴木', '3:高橋', '4:田中', '5:伊藤',
        '6:渡辺', '7:山本', '8:中村', '9:小林', '10:加藤',
        '11:吉田', '12:山田', '13:佐々木', '14:山口', '15:松本'
    ]
};

let masterData = JSON.parse(JSON.stringify(defaultMaster));
let inventoryRecords = [];
let productMap = new Map();

const appState = {
    currentWorker: '1:佐藤',
    currentSheetNo: 1,
    workMode: 'count',      // 'count' | 'pickup'
    activeField: 'upper',   // 'upper' | 'lower'
    selectedRecordId: null,
    inputBuffer: '',
    isAdminUnlocked: false,
    soundOn: true,
    ttsOn: true,
    isListening: false
};

// ==========================================================
// 1. JAN正規化 ＆ IndexedDB（2.1万件の商品台帳）
// ==========================================================
function normalizeJan(raw) {
    return String(raw ?? '').replace(/[^\d]/g, '');
}

function saveToLocalStorage() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            masterData,
            inventoryRecords,
            currentWorker: appState.currentWorker,
            currentSheetNo: appState.currentSheetNo
        }));
    } catch (e) {}
}

function loadFromLocalStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed.masterData) {
            masterData = Object.assign(masterData, parsed.masterData);
            if (!masterData.sheetNames) masterData.sheetNames = {};
        }
        if (Array.isArray(parsed.inventoryRecords)) inventoryRecords = parsed.inventoryRecords;
        if (parsed.currentWorker) appState.currentWorker = parsed.currentWorker;
        if (parsed.currentSheetNo) appState.currentSheetNo = Number(parsed.currentSheetNo) || 1;
    } catch (e) {}
}

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
                jan: jan,
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
    } catch (e) {
        return 0;
    }
}

function lookupProductByJan(rawJan) {
    const jan = normalizeJan(rawJan);
    if (!jan) return { jan: '', name: '未登録商品', price: 0, catMid: '', catSmall: '' };

    // 先頭「2」のインストアコード（先頭7桁で検索、8〜11桁目を税抜価格とする）
    if (jan.startsWith('2') && jan.length >= 11) {
        const key7 = jan.substring(0, 7);
        const extractedPrice = parseInt(jan.substring(7, 11), 10) || 0;
        const hit = productMap.get(key7);
        return {
            jan: jan,
            name: hit ? hit.name : `インストア商品(${key7})`,
            price: extractedPrice,
            catMid: hit ? hit.catMid : '一般',
            catSmall: hit ? hit.catSmall : ''
        };
    }

    const hit = productMap.get(jan) || productMap.get(jan.replace(/^0+/, ''));
    if (hit) {
        return { jan: jan, name: hit.name, price: hit.price, catMid: hit.catMid, catSmall: hit.catSmall };
    }
    return { jan: jan, name: '未登録商品（要確認）', price: 0, catMid: '', catSmall: '' };
}

// ==========================================================
// 2. GAS API通信
// ==========================================================
function getActiveGasUrl() {
    return (masterData.gasWebhookUrl || '').trim();
}

function updateSyncStatusDot(stateStr) {
    const dot = document.getElementById('sync-status-dot');
    if (!dot) return;
    if (stateStr === 'ok') dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0';
    else if (stateStr === 'syncing') dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping shrink-0';
    else dot.className = 'w-2.5 h-2.5 rounded-full bg-slate-500 shrink-0';
}

async function fetchAllFromGasApi(showNotification = true) {
    const url = getActiveGasUrl();
    if (!url) {
        updateSyncStatusDot('offline');
        if (showNotification) showToast('「⚙️接続」からGASのURLを設定してください');
        return;
    }
    updateSyncStatusDot('syncing');
    if (showNotification) showToast('🔄 スプレッドシートと同期中...');
    try {
        const res = await fetch(url + '?type=all&t=' + Date.now(), { method: 'GET', redirect: 'follow' });
        const json = await res.json();
        if (json.status === 'ok' && json.data) {
            const keepUrl = getActiveGasUrl();
            if (json.data.masterData) {
                masterData = Object.assign(masterData, json.data.masterData);
                masterData.gasWebhookUrl = keepUrl;
                if (!masterData.sheetNames) masterData.sheetNames = {};
            }
            if (Array.isArray(json.data.records)) {
                inventoryRecords = json.data.records;
            }
            saveToLocalStorage();
            initSheetNoSelects();
            renderWorkerSelect();
            renderAllViews();
            updateSyncStatusDot('ok');
            if (showNotification) showToast('✅ 最新データを同期しました');

            // 端末に商品台帳マスタが0件で、スプレッドシート側にある場合は自動ダウンロード
            if (productMap.size === 0 && (json.data.productCount || 0) > 0) {
                await downloadProductsFromGas();
            }
        }
    } catch (err) {
        updateSyncStatusDot('offline');
        if (showNotification) showToast('⚠️ 同期エラー（ローカル保存中）');
    }
}

async function downloadProductsFromGas() {
    const url = getActiveGasUrl();
    if (!url) return showToast('先に「⚙️接続」からGASのURLを設定してください');
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

async function postToGasApi(payloadObj) {
    const url = getActiveGasUrl();
    if (!url) return;
    updateSyncStatusDot('syncing');
    try {
        await fetch(url, {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payloadObj)
        });
        updateSyncStatusDot('ok');
    } catch (e) {
        updateSyncStatusDot('offline');
    }
}

function formatNow() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ==========================================================
// 3. 電子音（SFX） ＆ 明るい音声読み上げ（TTS）
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
function toggleTts() {
    appState.ttsOn = !appState.ttsOn;
    const btn = document.getElementById('btn-tts');
    btn.textContent = appState.ttsOn ? '🗣️声:ON' : '🔇声:OFF';
    btn.className = appState.ttsOn
        ? 'bg-amber-600 text-white font-bold text-[11px] px-1.5 py-1 rounded'
        : 'bg-slate-800 border border-slate-700 text-slate-300 text-[11px] px-1.5 py-1 rounded';
    if (!appState.ttsOn && window.speechSynthesis) window.speechSynthesis.cancel();
    else speakText('音声読み上げをオンにしました！', true);
}

function speakText(text, force = false) {
    if ((!appState.ttsOn && !force) || !('speechSynthesis' in window)) return;
    try {
        clearTimeout(speakDelayTimer);
        window.speechSynthesis.cancel();
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
        speakDelayTimer = setTimeout(() => {
            try {
                const utter = new SpeechSynthesisUtterance(text);
                utter.lang = 'ja-JP';
                utter.rate = 1.15;
                utter.pitch = 1.25;
                utter.volume = 1.0;
                window.speechSynthesis.speak(utter);
            } catch (e) {}
        }, 40);
    } catch (e) {}
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
// 4. 縦横全方向・高コントラスト連続カメラスキャナー
// ==========================================================
let mediaStream = null, offscreenVideo = null, isCameraRunning = false;
let digitalZoom = 1.6, previewLoopId = null, decodeTimerId = null;
let isDecodingFrame = false, scanFrameParity = 0, scanAttemptCount = 0;
let lastCandidateCode = '', candidateHitCount = 0;
let lastAcceptedCode = '', lastAcceptedTime = 0;
let nativeBarcodeDetector = null;

if ('BarcodeDetector' in window) {
    try {
        nativeBarcodeDetector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
    } catch (e) { nativeBarcodeDetector = null; }
}

function isValidJanCheckDigit(code) {
    if (!/^\d{13}$|^\d{8}$/.test(code)) return false;
    const digits = code.split('').map(Number);
    const checkDigit = digits.pop();
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        sum += digits[i] * (((digits.length - 1 - i) % 2 === 0) ? 3 : 1);
    }
    return ((10 - (sum % 10)) % 10) === checkDigit;
}

function enhanceBarcodeContrast(ctx, w, h) {
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const contrast = 1.65;
    const intercept = 128 * (1 - contrast);
    for (let i = 0; i < d.length; i += 4) {
        const gray = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        const adj = gray * contrast + intercept;
        d[i] = d[i + 1] = d[i + 2] = adj < 0 ? 0 : adj > 255 ? 255 : adj;
    }
    ctx.putImageData(imgData, 0, 0);
}

function calcCoverCrop(vw, vh, destW, destH, zoom) {
    const srcRatio = vw / vh, destRatio = destW / destH;
    let baseW = srcRatio > destRatio ? vh * destRatio : vw;
    let baseH = srcRatio > destRatio ? vh : vw / destRatio;
    const cropW = baseW / zoom, cropH = baseH / zoom;
    return { cropX: (vw - cropW) / 2, cropY: (vh - cropH) / 2, cropW, cropH };
}

async function toggleCameraScanner() {
    if (isCameraRunning) await stopCameraScanner();
    else await startCameraScanner();
}

async function startCameraScanner() {
    if (isCameraRunning) return;
    try {
        offscreenVideo = document.createElement('video');
        offscreenVideo.setAttribute('playsinline', '');
        offscreenVideo.muted = true;
        offscreenVideo.autoplay = true;
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
        offscreenVideo.srcObject = mediaStream;
        await offscreenVideo.play();

        isCameraRunning = true;
        scanAttemptCount = 0;
        document.getElementById('camera-wrapper').classList.remove('hidden');
        document.getElementById('cam-btn-label').textContent = '停止';

        const previewCanvas = document.getElementById('preview-canvas');
        const previewCtx = previewCanvas.getContext('2d', { alpha: false });

        const renderPreview = () => {
            if (!isCameraRunning || !offscreenVideo) return;
            if (offscreenVideo.readyState >= 2 && offscreenVideo.videoWidth > 0) {
                const vw = offscreenVideo.videoWidth, vh = offscreenVideo.videoHeight;
                const rect = previewCanvas.getBoundingClientRect();
                const targetW = Math.max(280, Math.round(rect.width * 1.5));
                const targetH = Math.max(176, Math.round(rect.height * 1.5));
                if (previewCanvas.width !== targetW || previewCanvas.height !== targetH) {
                    previewCanvas.width = targetW;
                    previewCanvas.height = targetH;
                }
                const { cropX, cropY, cropW, cropH } = calcCoverCrop(vw, vh, targetW, targetH, digitalZoom);
                previewCtx.drawImage(offscreenVideo, cropX, cropY, cropW, cropH, 0, 0, targetW, targetH);
            }
            previewLoopId = requestAnimationFrame(renderPreview);
        };
        renderPreview();

        const decodeCanvas = document.getElementById('decode-canvas');
        const decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true });

        decodeTimerId = setInterval(async () => {
            if (!isCameraRunning || isDecodingFrame || !offscreenVideo || offscreenVideo.readyState < 3) return;
            isDecodingFrame = true;
            scanAttemptCount++;
            const dbg = document.getElementById('scan-debug-info');
            if (dbg) dbg.textContent = `解析:${scanAttemptCount}`;

            const acceptCode = (code) => {
                const clean = normalizeJan(code);
                if (clean.length < 8) return;
                const now = Date.now();
                if (clean === lastAcceptedCode && now - lastAcceptedTime < 1800) return;
                lastAcceptedCode = clean;
                lastAcceptedTime = now;
                lastCandidateCode = '';
                candidateHitCount = 0;
                handleBarcodeScan(clean);
            };

            // 1. ネイティブBarcodeDetector（縦横問わず超高速）
            if (nativeBarcodeDetector) {
                try {
                    const barcodes = await nativeBarcodeDetector.detect(previewCanvas);
                    if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                        isDecodingFrame = false;
                        acceptCode(barcodes[0].rawValue);
                        return;
                    }
                } catch (e) {}
            }

            // 2. Quagga2 正方形クロップ＋0°/90°交互回転＋高コントラスト解析
            const vw = offscreenVideo.videoWidth, vh = offscreenVideo.videoHeight;
            const sqSize = Math.floor(Math.min(vw, vh) / digitalZoom);
            const sx = Math.floor((vw - sqSize) / 2);
            const sy = Math.floor((vh - sqSize) / 2);

            const rotate90 = (scanFrameParity % 2 === 1);
            scanFrameParity++;
            const size = 560;
            decodeCanvas.width = size;
            decodeCanvas.height = size;

            decodeCtx.save();
            decodeCtx.setTransform(1, 0, 0, 1, 0, 0);
            if (rotate90) {
                decodeCtx.translate(size / 2, size / 2);
                decodeCtx.rotate(Math.PI / 2);
                decodeCtx.drawImage(offscreenVideo, sx, sy, sqSize, sqSize, -size / 2, -size / 2, size, size);
            } else {
                decodeCtx.drawImage(offscreenVideo, sx, sy, sqSize, sqSize, 0, 0, size, size);
            }
            decodeCtx.restore();

            enhanceBarcodeContrast(decodeCtx, size, size);
            const dataUrl = decodeCanvas.toDataURL('image/jpeg', 0.88);

            Quagga.decodeSingle({
                src: dataUrl, numOfWorkers: 0, locate: true,
                inputStream: { size: size },
                decoder: { readers: ['ean_reader', 'ean_8_reader', 'upc_reader', 'code_128_reader'] }
            }, (result) => {
                isDecodingFrame = false;
                if (!isCameraRunning) return;
                if (result && result.codeResult && result.codeResult.code) {
                    const code = normalizeJan(result.codeResult.code);
                    if (code === lastCandidateCode) candidateHitCount++;
                    else { lastCandidateCode = code; candidateHitCount = 1; }
                    if (candidateHitCount >= 2 || isValidJanCheckDigit(code)) {
                        acceptCode(code);
                    }
                }
            });
        }, 70);
    } catch (err) {
        showToast('カメラ起動エラー: ' + err.message);
        await stopCameraScanner();
    }
}

function setDigitalZoom(z) {
    digitalZoom = z;
    ['z-btn-10', 'z-btn-16', 'z-btn-22'].forEach(id => {
        document.getElementById(id).className = 'bg-slate-900/80 text-white text-[10px] font-bold px-1.5 py-0.5 rounded';
    });
    const act = z === 1.0 ? 'z-btn-10' : z === 1.6 ? 'z-btn-16' : 'z-btn-22';
    document.getElementById(act).className = 'bg-emerald-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded';
}

async function stopCameraScanner() {
    isCameraRunning = false;
    if (previewLoopId) cancelAnimationFrame(previewLoopId);
    if (decodeTimerId) clearInterval(decodeTimerId);
    if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null; offscreenVideo = null;
    document.getElementById('camera-wrapper').classList.add('hidden');
    document.getElementById('cam-btn-label').textContent = 'スキャン';
}

// ==========================================================
// 5. 音声入力（数字・棚上・棚下・先月同数・次へ）
// ==========================================================
let recognition = null;
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
        document.getElementById('voice-transcript').textContent = `認識: 「${text}」`;
        if (/棚上|たなうえ/.test(text)) setActiveField('upper');
        if (/棚下|たなした/.test(text)) setActiveField('lower');
        if (/先月|前回|同じ/.test(text)) copyPrevMonthQty();
        const numMatch = text.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).match(/\d+/);
        if (numMatch) {
            appState.inputBuffer = numMatch[0];
            applyBufferToCurrentRecord();
        }
        if (/次|つぎ|確定|かくてい|はい/.test(text)) confirmAndNextRecord();
    };
    recognition.onend = () => {
        if (appState.isListening) setTimeout(() => { try { recognition.start(); } catch (e) {} }, 200);
    };

    appState.isListening = true;
    document.getElementById('btn-voice-toggle').classList.add('mic-active');
    document.getElementById('voice-btn-label').textContent = '止';
    document.getElementById('voice-transcript-bar').classList.remove('hidden');
    recognition.start();
}
