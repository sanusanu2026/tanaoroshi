/**
 * app-core.js
 * ・IndexedDBによる2.1万件の商品台帳高速検索（0.01秒）
 * ・先頭「2」インストアコード（値付バーコード）の自動価格抽出
 * ・GASスプレッドシート同期 / 全方向連続スキャン / 音声入力
 */

const STORAGE_KEY = 'okegawa_inventory_v1';
const IDB_NAME = 'OkegawaProductMasterDB';
const IDB_STORE = 'products';

const defaultMaster = {
    adminPin: '1234',
    gasWebhookUrl: '',
    workers: [
        '1:佐藤', '2:鈴木', '3:高橋', '4:田中', '5:伊藤',
        '6:渡辺', '7:山本', '8:中村', '9:小林', '10:加藤',
        '11:吉田', '12:山田', '13:佐々木', '14:山口', '15:松本'
    ]
};

let masterData = JSON.parse(JSON.stringify(defaultMaster));
let inventoryRecords = [];
let productMap = new Map(); // メモリキャッシュ（JAN -> {name, price, catMid, catSmall}）

const appState = {
    currentWorker: '1:佐藤',
    currentSheetNo: 1,
    workMode: 'count',      // 'count' | 'pickup'
    activeField: 'upper',   // 'upper' (棚上) | 'lower' (棚下)
    selectedRecordId: null,
    inputBuffer: '',
    isAdminUnlocked: false,
    soundOn: true,
    isListening: false
};

// ==========================================================
// 1. ローカル保存 ＆ IndexedDB（2.1万件の商品台帳）
// ==========================================================
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
        if (parsed.masterData) masterData = Object.assign(masterData, parsed.masterData);
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
            const obj = {
                jan: String(r[0]).trim(),
                name: String(r[1] || ''),
                price: Number(r[2]) || 0,
                catMid: String(r[3] || ''),
                catSmall: String(r[4] || '')
            };
            if (obj.jan) {
                store.put(obj);
                productMap.set(obj.jan, obj);
            }
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
                (req.result || []).forEach(p => productMap.set(p.jan, p));
                resolve(productMap.size);
            };
            req.onerror = () => resolve(0);
        });
    } catch (e) {
        return 0;
    }
}

/**
 * JANコード検索（Excel数式と同一仕様：先頭が2のインストアコードは先頭7桁で検索し、8〜11桁目を税抜価格とする）
 */
function lookupProductByJan(rawJan) {
    const jan = String(rawJan || '').trim();
    if (!jan) return { jan: '', name: '未登録商品', price: 0, catMid: '', catSmall: '' };

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

    const hit = productMap.get(jan);
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
            }
            if (Array.isArray(json.data.records)) {
                inventoryRecords = json.data.records;
            }
            saveToLocalStorage();
            renderAllViews();
            updateSyncStatusDot('ok');
            if (showNotification) showToast('✅ 最新データを同期しました');
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
// 3. 電子音（SFX）
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

// ==========================================================
// 4. ノンストップ連続カメラスキャナー（Quagga2）
// ==========================================================
let mediaStream = null, offscreenVideo = null, isCameraRunning = false;
let digitalZoom = 1.6, previewLoopId = null, decodeTimerId = null;
let isDecodingFrame = false, scanFrameParity = 0;
let lastCandidateCode = '', candidateHitCount = 0;
let lastAcceptedCode = '', lastAcceptedTime = 0;

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
                const targetH = Math.max(150, Math.round(rect.height * 1.5));
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

        decodeTimerId = setInterval(() => {
            if (!isCameraRunning || isDecodingFrame || !offscreenVideo || offscreenVideo.readyState < 3) return;
            isDecodingFrame = true;
            const vw = offscreenVideo.videoWidth, vh = offscreenVideo.videoHeight;
            const rect = previewCanvas.getBoundingClientRect();
            const { cropX, cropY, cropW, cropH } = calcCoverCrop(vw, vh, Math.max(280, rect.width), Math.max(150, rect.height), digitalZoom);
            const bx = Math.floor(cropX + cropW * 0.14), by = Math.floor(cropY + cropH * 0.12);
            const bw = Math.floor(cropW * 0.72), bh = Math.floor(cropH * 0.76);

            const rotate90 = (scanFrameParity % 2 === 1);
            scanFrameParity++;
            const targetSize = 520;
            if (!rotate90) {
                decodeCanvas.width = targetSize;
                decodeCanvas.height = Math.max(220, Math.floor(targetSize * (bh / bw)));
                decodeCtx.setTransform(1, 0, 0, 1, 0, 0);
                decodeCtx.drawImage(offscreenVideo, bx, by, bw, bh, 0, 0, decodeCanvas.width, decodeCanvas.height);
            } else {
                decodeCanvas.width = Math.max(220, Math.floor(targetSize * (bh / bw)));
                decodeCanvas.height = targetSize;
                decodeCtx.save();
                decodeCtx.translate(decodeCanvas.width / 2, decodeCanvas.height / 2);
                decodeCtx.rotate(Math.PI / 2);
                decodeCtx.drawImage(offscreenVideo, bx, by, bw, bh, -decodeCanvas.height / 2, -decodeCanvas.width / 2, decodeCanvas.height, decodeCanvas.width);
                decodeCtx.restore();
            }

            const dataUrl = decodeCanvas.toDataURL('image/jpeg', 0.82);
            Quagga.decodeSingle({
                src: dataUrl, numOfWorkers: 0, locate: true,
                inputStream: { size: Math.max(decodeCanvas.width, decodeCanvas.height) },
                decoder: { readers: ['ean_reader', 'ean_8_reader', 'code_128_reader'] }
            }, (result) => {
                isDecodingFrame = false;
                if (!isCameraRunning) return;
                if (result && result.codeResult && result.codeResult.code) {
                    const code = result.codeResult.code;
                    if (code === lastCandidateCode) candidateHitCount++;
                    else { lastCandidateCode = code; candidateHitCount = 1; }

                    if (candidateHitCount >= 2) {
                        const now = Date.now();
                        // 同一コードの連続誤爆防止（1.8秒クールダウン）
                        if (code === lastAcceptedCode && now - lastAcceptedTime < 1800) return;
                        lastAcceptedCode = code;
                        lastAcceptedTime = now;
                        lastCandidateCode = '';
                        candidateHitCount = 0;
                        handleBarcodeScan(code);
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
// 5. 音声入力（数字・棚上・棚下・次へ）
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
