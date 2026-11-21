/**
 * app-core.js（解決策B：外部ホスト画面 × GAS JSON API 双方向通信エンジン）
 * ・GASのiframe制限を完全回避し、iOS Safari / Android Chromeでリアルタイムカメラ＆音声認識を100%稼働
 * ・CORSプリフライトを発生させない text/plain POST通信と GET JSON同期
 */

// ★ステップ1でデプロイしたGASウェブアプリのURL（https://script.google.com/macros/s/XXXX/exec）をここに貼り付けてください
const DEFAULT_GAS_API_URL = 'https://script.google.com/a/macros/ttc-gr.co.jp/s/AKfycbzgpH2_jLWeUel0gOOyebZOOmG9n9Zv7iWNAIUJFUa_dOD0AuSTn8vQPIc3YVASFm5jGg/exec';

const STORAGE_KEY = 'smart_inventory_solution_b_v1';

const defaultMaster = {
    adminPin: '1234',
    gasWebhookUrl: DEFAULT_GAS_API_URL,
    units: ['個', '箱', 'ケース', '本', '袋', 'パック', 'セット', 'kg', 'g', 'L'],
    areas: ['1F売場', '冷蔵・日配', '日用品コーナー', 'バックヤード', '2F倉庫'],
    shelves: ['棚A-01', '棚A-02', '棚B-01', '棚C-01', '棚Z-01'],
    levels: ['1段目', '2段目', '3段目', '4段目'],
    makers: ['サンプルフーズ', '関東飲料', '日本デイリー', 'クリーン生活'],
    workers: [
        '1:佐藤', '2:鈴木', '3:高橋', '4:田中', '5:伊藤',
        '6:渡辺', '7:山本', '8:中村', '9:小林', '10:加藤',
        '11:吉田', '12:山田', '13:佐々木', '14:山口', '15:松本'
    ]
};

const defaultRecords = [
    {
        id: 'REC-001', jan: '490123400101', name: '手巻おにぎり 紅しゃけ', maker: 'サンプルフーズ',
        unit: '個', price: 148, area: '1F売場', shelf: '棚A-01', level: '1段目',
        prevQty: 20, baseQty: 20, addedQty: 0, counted: true, worker: '1:佐藤', updatedAt: '2026/11/21 09:30'
    },
    {
        id: 'REC-002', jan: '490123400101', name: '手巻おにぎり 紅しゃけ', maker: 'サンプルフーズ',
        unit: '個', price: 148, area: 'バックヤード', shelf: '棚Z-01', level: '2段目',
        prevQty: 15, baseQty: 10, addedQty: 4, counted: true, worker: '2:鈴木', updatedAt: '2026/11/21 09:45'
    },
    {
        id: 'REC-003', jan: '490123400102', name: '特選幕の内弁当', maker: 'サンプルフーズ',
        unit: '個', price: 580, area: '1F売場', shelf: '棚A-01', level: '2段目',
        prevQty: 12, baseQty: 0, addedQty: 0, counted: false, worker: '1:佐藤', updatedAt: '-'
    },
    {
        id: 'REC-004', jan: '490123400103', name: 'おいしい牛乳 1000ml', maker: '日本デイリー',
        unit: '本', price: 238, area: '冷蔵・日配', shelf: '棚B-01', level: '1段目',
        prevQty: 30, baseQty: 0, addedQty: 0, counted: false, worker: '1:佐藤', updatedAt: '-'
    },
    {
        id: 'REC-005', jan: '490123400105', name: '緑茶ペットボトル 600ml', maker: '関東飲料',
        unit: '箱', price: 1800, area: 'バックヤード', shelf: '棚Z-01', level: '1段目',
        prevQty: 10, baseQty: 8, addedQty: 2, counted: true, worker: '3:高橋', updatedAt: '2026/11/21 10:00'
    },
    {
        id: 'REC-006', jan: '490123400105', name: '緑茶ペットボトル 600ml', maker: '関東飲料',
        unit: '本', price: 118, area: '1F売場', shelf: '棚A-02', level: '2段目',
        prevQty: 48, baseQty: 0, addedQty: 0, counted: false, worker: '1:佐藤', updatedAt: '-'
    },
    {
        id: 'REC-007', jan: '490234500201', name: 'ボックスティッシュ 5箱パック', maker: 'クリーン生活',
        unit: 'パック', price: 398, area: '日用品コーナー', shelf: '棚C-01', level: '1段目',
        prevQty: 20, baseQty: 0, addedQty: 0, counted: false, worker: '1:佐藤', updatedAt: '-'
    }
];

const defaultAddLogs = [
    {
        logId: 'LOG-001',
        timestamp: '2026/11/21 09:50',
        worker: '2:鈴木',
        recordId: 'REC-002',
        jan: '490123400101',
        name: '手巻おにぎり 紅しゃけ',
        unit: '個',
        area: 'バックヤード',
        shelf: '棚Z-01',
        level: '2段目',
        addedQty: 4,
        memo: '冷蔵コンテナ脇の番重から追加発見'
    },
    {
        logId: 'LOG-002',
        timestamp: '2026/11/21 10:05',
        worker: '3:高橋',
        recordId: 'REC-005',
        jan: '490123400105',
        name: '緑茶ペットボトル 600ml',
        unit: '箱',
        area: 'バックヤード',
        shelf: '棚Z-01',
        level: '1段目',
        addedQty: 2,
        memo: 'パレット裏側の段ボール2箱を追加'
    }
];

let masterData = JSON.parse(JSON.stringify(defaultMaster));
let inventoryRecords = JSON.parse(JSON.stringify(defaultRecords));
let addStockLogs = JSON.parse(JSON.stringify(defaultAddLogs));

const appState = {
    currentWorker: '1:佐藤',
    selectedRecordId: 'REC-001',
    inputBuffer: '',
    filterArea: 'すべて',
    filterShelf: 'すべて',
    filterLevel: 'すべて',
    isAdminUnlocked: false,
    isListening: false,
    soundOn: true,
    ttsOn: true
};

function getActiveGasUrl() {
    return (masterData.gasWebhookUrl || DEFAULT_GAS_API_URL || '').trim();
}

function updateSyncStatusDot(stateStr) {
    const dot = document.getElementById('sync-status-dot');
    if (!dot) return;
    if (stateStr === 'ok') {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
    } else if (stateStr === 'syncing') {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping';
    } else {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-slate-500';
    }
}

function saveToLocalStorage() {
    try {
        const payload = {
            masterData,
            inventoryRecords,
            addStockLogs,
            currentWorker: appState.currentWorker
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {}
}

function loadFromLocalStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed.masterData) {
            const savedUrl = parsed.masterData.gasWebhookUrl || DEFAULT_GAS_API_URL;
            masterData = Object.assign(masterData, parsed.masterData);
            masterData.gasWebhookUrl = savedUrl;
        }
        if (parsed.inventoryRecords && parsed.inventoryRecords.length > 0) inventoryRecords = parsed.inventoryRecords;
        if (parsed.addStockLogs) addStockLogs = parsed.addStockLogs;
        if (parsed.currentWorker) appState.currentWorker = parsed.currentWorker;
        if (!inventoryRecords.some(r => r.id === appState.selectedRecordId)) {
            appState.selectedRecordId = inventoryRecords[0].id;
        }
    } catch (e) {}
}

/**
 * GAS JSON API (doGet) からスプレッドシート最新データを取得
 */
async function fetchAllFromGasApi(showNotification = true) {
    const url = getActiveGasUrl();
    if (!url) {
        updateSyncStatusDot('offline');
        if (showNotification) {
            showToast('GASのURLが未設定です。「📊GAS接続設定」からURLを登録してください');
        }
        return;
    }

    updateSyncStatusDot('syncing');
    if (showNotification) showToast('🔄 スプレッドシートと同期中...');

    try {
        const res = await fetch(url + '?t=' + Date.now(), {
            method: 'GET',
            redirect: 'follow'
        });
        const json = await res.json();
        if (json && json.status === 'ok' && json.data) {
            const currentUrl = getActiveGasUrl();
            if (json.data.masterData) {
                masterData = Object.assign(masterData, json.data.masterData);
                masterData.gasWebhookUrl = currentUrl;
            }
            if (json.data.inventoryRecords && json.data.inventoryRecords.length > 0) {
                inventoryRecords = json.data.inventoryRecords;
                if (!inventoryRecords.some(r => r.id === appState.selectedRecordId)) {
                    appState.selectedRecordId = inventoryRecords[0].id;
                }
            }
            if (json.data.addStockLogs) {
                addStockLogs = json.data.addStockLogs;
            }
            saveToLocalStorage();
            renderWorkerSelect();
            renderLocationFilters();
            renderAllViews();
            updateSyncStatusDot('ok');
            if (showNotification) showToast('✅ スプレッドシートから最新データを読み込みました');
        } else {
            throw new Error(json.message || 'Invalid response');
        }
    } catch (err) {
        updateSyncStatusDot('offline');
        if (showNotification) showToast('⚠️ GAS通信エラー（オフライン保存中）: ' + err.message);
    }
}

/**
 * GAS JSON API (doPost) へ1件の確定データ（および後から追加ログ）を送信
 * ※Content-Typeを text/plain にすることでCORSプリフライトエラーを完全に防止
 */
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
    } catch (err) {
        updateSyncStatusDot('offline');
    }
}

function syncRecordToGasSheet(rec, addLogObj = null) {
    postToGasApi({
        action: 'saveRecord',
        record: rec,
        addLog: addLogObj
    });
}

function syncMasterToGasSheet() {
    postToGasApi({
        action: 'saveMaster',
        masterData: masterData
    });
}

function formatNow() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getRecordTotalQty(rec) {
    return (Number(rec.baseQty) || 0) + (Number(rec.addedQty) || 0);
}

function getCurrentRecord() {
    return inventoryRecords.find(r => r.id === appState.selectedRecordId) || inventoryRecords[0];
}

function getFilteredMobileRecords() {
    return inventoryRecords.filter(r => {
        if (appState.filterArea !== 'すべて' && r.area !== appState.filterArea) return false;
        if (appState.filterShelf !== 'すべて' && r.shelf !== appState.filterShelf) return false;
        if (appState.filterLevel !== 'すべて' && r.level !== appState.filterLevel) return false;
        return true;
    });
}

function getProductAggregatedList() {
    const map = new Map();
    inventoryRecords.forEach(rec => {
        const key = `${rec.jan}__${rec.unit}`;
        const recTotal = getRecordTotalQty(rec);
        if (!map.has(key)) {
            map.set(key, {
                jan: rec.jan,
                name: rec.name,
                maker: rec.maker,
                unit: rec.unit,
                price: rec.price,
                prevTotal: 0,
                actualTotal: 0,
                addedTotal: 0,
                locations: []
            });
        }
        const entry = map.get(key);
        entry.prevTotal += Number(rec.prevQty) || 0;
        entry.actualTotal += recTotal;
        entry.addedTotal += Number(rec.addedQty) || 0;
        entry.locations.push({
            id: rec.id,
            area: rec.area,
            shelf: rec.shelf,
            level: rec.level,
            baseQty: rec.baseQty,
            addedQty: rec.addedQty,
            totalQty: recTotal,
            counted: rec.counted
        });
    });
    return Array.from(map.values());
}

// ==========================================================
// スキャン音・操作音エンジン（iOS / Android Web Audio API + WAV）
// ==========================================================
let audioCtx = null;
let beepAudioEl = null;

function initWavBeep() {
    if (beepAudioEl) return;
    const sampleRate = 22050;
    const duration = 0.08;
    const numSamples = Math.floor(sampleRate * duration);
    const buffer = new ArrayBuffer(44 + numSamples);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples, true);
    const freq = 2350;
    for (let i = 0; i < numSamples; i++) {
        view.setUint8(44 + i, Math.sin(2 * Math.PI * freq * (i / sampleRate)) >= 0 ? 220 : 35);
    }
    beepAudioEl = new Audio(URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' })));
    beepAudioEl.playsInline = true;
}

function playTone(freq, type = 'sine', dur = 0.06, vol = 0.07) {
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
    scan: () => {
        if (!appState.soundOn) return;
        try { initWavBeep(); beepAudioEl.currentTime = 0; beepAudioEl.play().catch(()=>{}); } catch(e){}
        playTone(2350, 'square', 0.08, 0.14);
    },
    key: () => playTone(980, 'sine', 0.04, 0.05),
    next: () => { playTone(1046, 'sine', 0.06, 0.07); setTimeout(() => playTone(1318, 'sine', 0.09, 0.07), 60); },
    err: () => playTone(260, 'sawtooth', 0.14, 0.09)
};

function toggleSound() {
    appState.soundOn = !appState.soundOn;
    document.getElementById('btn-sound').textContent = appState.soundOn ? '🔊音' : '🔇音';
    if (appState.soundOn) SFX.key();
}

// ==========================================================
// 音声ガイド（TTS）＆ハンズフリー音声認識（iOS / Android対応）
// ==========================================================
let isSpeaking = false;
let recognition = null;
let speechWatchdog = null;

function toggleTts() {
    appState.ttsOn = !appState.ttsOn;
    document.getElementById('btn-tts').textContent = appState.ttsOn ? '🗣️声' : '🔇声';
    if (!appState.ttsOn && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        isSpeaking = false;
    } else {
        speakCurrentRecord(true);
    }
}

function speakText(text, force = false) {
    if ((!appState.ttsOn && !force) || !('speechSynthesis' in window)) return;
    try {
        clearTimeout(speechWatchdog);
        window.speechSynthesis.cancel();
        isSpeaking = true;
        if (recognition) { try { recognition.abort(); } catch (e) {} }
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ja-JP';
        u.rate = 1.15;
        const done = () => {
            clearTimeout(speechWatchdog);
            isSpeaking = false;
            if (appState.isListening && recognition) {
                setTimeout(() => { try { recognition.start(); } catch(e){} }, 250);
            }
        };
        u.onend = done;
        u.onerror = done;
        speechWatchdog = setTimeout(done, Math.max(1800, text.length * 160));
        window.speechSynthesis.speak(u);
    } catch (e) {
        isSpeaking = false;
    }
}

function speakCurrentRecord(force = false, prefix = '') {
    const rec = getCurrentRecord();
    if (!rec) return;
    speakText(`${prefix}${rec.area}、${rec.shelf}。${rec.name}、単位は${rec.unit}。前回${rec.prevQty}${rec.unit}。`, force);
}

function toggleVoiceRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
        showToast('このブラウザは音声認識非対応です');
        return;
    }
    const btn = document.getElementById('btn-voice-toggle');
    if (appState.isListening) {
        appState.isListening = false;
        if (recognition) { try { recognition.abort(); } catch (e) {} }
        btn.classList.remove('mic-active', 'bg-red-700');
        btn.textContent = '🎤声';
        showToast('音声入力を停止しました');
        return;
    }

    recognition = new SR();
    recognition.lang = 'ja-JP';
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onresult = (e) => {
        if (isSpeaking) return;
        const transcript = e.results[e.results.length - 1][0].transcript.trim();
        handleVoiceCommand(transcript);
    };
    recognition.onend = () => {
        if (appState.isListening && !isSpeaking) {
            setTimeout(() => { try { recognition.start(); } catch (err) {} }, 200);
        }
    };
    recognition.onerror = (e) => {
        if (e.error === 'not-allowed') {
            appState.isListening = false;
            btn.classList.remove('mic-active', 'bg-red-700');
            showToast('マイク権限を許可してください');
        }
    };

    appState.isListening = true;
    btn.classList.add('mic-active', 'bg-red-700');
    btn.textContent = '🎤聴取';
    try { recognition.start(); } catch (e) {}
    speakCurrentRecord(true, 'ハンズフリー開始。');
}

function handleVoiceCommand(text) {
    showToast(`🎤 認識: 「${text}」`);
    if (/次|確定|OK|オッケー|はい/i.test(text)) {
        confirmAndNextRecord();
        return;
    }
    if (/戻|前/.test(text)) {
        movePrevRecord();
        return;
    }
    if (/同数|同じ/.test(text)) {
        copyPrevQty();
        return;
    }
    const numMatch = text.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).match(/\d+/);
    if (numMatch) {
        appState.inputBuffer = numMatch[0];
        applyBufferToCurrentRecord();
        speakText(`${numMatch[0]}。よければ次へと言ってください`);
    }
}

// ==========================================================
// カメラスキャナー（連続スキャン ＋ OS標準カメラ撮影スキャン両対応）
// ==========================================================
let mediaStream = null;
let offscreenVideo = null;
let isCameraRunning = false;
let isScanPaused = false;
let digitalZoom = 1.6;
let previewLoopId = null;
let decodeTimerId = null;
let isDecodingFrame = false;
let scanParity = 0;
let lastCode = '';
let hitCount = 0;

function calcCoverCrop(vw, vh, destW, destH, zoom) {
    const srcRatio = vw / vh;
    const destRatio = destW / destH;
    let baseW = srcRatio > destRatio ? vh * destRatio : vw;
    let baseH = srcRatio > destRatio ? vh : vw / destRatio;
    const cropW = baseW / zoom;
    const cropH = baseH / zoom;
    return { cropX: (vw - cropW) / 2, cropY: (vh - cropH) / 2, cropW, cropH };
}

async function toggleCameraScanner() {
    if (isCameraRunning) {
        await stopCameraScanner();
    } else {
        await startCameraScanner();
    }
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
        resumeCameraScan();

        const previewCanvas = document.getElementById('preview-canvas');
        const previewCtx = previewCanvas.getContext('2d', { alpha: false });

        const renderLoop = () => {
            if (!isCameraRunning || !offscreenVideo) return;
            if (offscreenVideo.readyState >= 2 && offscreenVideo.videoWidth > 0) {
                const rect = previewCanvas.getBoundingClientRect();
                const targetW = Math.max(260, Math.round(rect.width * 1.5));
                const targetH = Math.max(130, Math.round(rect.height * 1.5));
                if (previewCanvas.width !== targetW || previewCanvas.height !== targetH) {
                    previewCanvas.width = targetW;
                    previewCanvas.height = targetH;
                }
                const { cropX, cropY, cropW, cropH } = calcCoverCrop(offscreenVideo.videoWidth, offscreenVideo.videoHeight, targetW, targetH, digitalZoom);
                previewCtx.drawImage(offscreenVideo, cropX, cropY, cropW, cropH, 0, 0, targetW, targetH);
            }
            previewLoopId = requestAnimationFrame(renderLoop);
        };
        renderLoop();

        const decodeCanvas = document.getElementById('decode-canvas');
        const decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true });

        decodeTimerId = setInterval(() => {
            if (!isCameraRunning || isScanPaused || isDecodingFrame || !offscreenVideo || offscreenVideo.videoWidth === 0) return;
            isDecodingFrame = true;
            const { cropX, cropY, cropW, cropH } = calcCoverCrop(offscreenVideo.videoWidth, offscreenVideo.videoHeight, 320, 160, digitalZoom);
            const rotate90 = (scanParity++ % 2 === 1);
            decodeCanvas.width = rotate90 ? 280 : 480;
            decodeCanvas.height = rotate90 ? 480 : 280;
            decodeCtx.save();
            if (rotate90) {
                decodeCtx.translate(decodeCanvas.width / 2, decodeCanvas.height / 2);
                decodeCtx.rotate(Math.PI / 2);
                decodeCtx.drawImage(offscreenVideo, cropX, cropY, cropW, cropH, -240, -140, 480, 280);
            } else {
                decodeCtx.drawImage(offscreenVideo, cropX, cropY, cropW, cropH, 0, 0, 480, 280);
            }
            decodeCtx.restore();

            Quagga.decodeSingle({
                src: decodeCanvas.toDataURL('image/jpeg', 0.82),
                numOfWorkers: 0,
                locate: true,
                inputStream: { size: 480 },
                decoder: { readers: ['ean_reader', 'ean_8_reader', 'upc_reader', 'code_128_reader'] }
            }, (res) => {
                isDecodingFrame = false;
                if (!isCameraRunning || isScanPaused) return;
                if (res && res.codeResult && res.codeResult.code) {
                    const code = res.codeResult.code;
                    hitCount = (code === lastCode) ? hitCount + 1 : 1;
                    lastCode = code;
                    if (hitCount >= 2) {
                        hitCount = 0;
                        pauseCameraScan();
                        handleBarcodeScan(code);
                    }
                }
            });
        }, 75);
    } catch (err) {
        showToast('連続カメラを起動できません。隣の「📸写す」ボタンをお使いください');
        await stopCameraScanner();
    }
}

/**
 * OS標準カメラシャッター（📸写す）で撮影した写真からバーコードを高速解析
 */
function handleNativePhotoScan(inputEl) {
    const file = inputEl.files && inputEl.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const imgUrl = e.target.result;
        Quagga.decodeSingle({
            src: imgUrl,
            numOfWorkers: 0,
            locate: true,
            inputStream: { size: 800 },
            decoder: { readers: ['ean_reader', 'ean_8_reader', 'upc_reader', 'code_128_reader'] }
        }, (result) => {
            inputEl.value = '';
            if (result && result.codeResult && result.codeResult.code) {
                handleBarcodeScan(result.codeResult.code);
            } else {
                SFX.err();
                showToast('バーコードを読み取れませんでした。もう少し近づいて撮影してください');
            }
        });
    };
    reader.readAsDataURL(file);
}

function setDigitalZoom(z) {
    digitalZoom = z;
    ['z-btn-10', 'z-btn-16', 'z-btn-22'].forEach(id => {
        document.getElementById(id).className = 'bg-slate-900/80 text-white text-[10px] font-bold px-1.5 py-0.5 rounded';
    });
    const active = z === 1.0 ? 'z-btn-10' : z === 1.6 ? 'z-btn-16' : 'z-btn-22';
    document.getElementById(active).className = 'bg-emerald-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded';
}

function pauseCameraScan() {
    isScanPaused = true;
    document.getElementById('scan-overlay').classList.add('hidden');
    document.getElementById('scan-paused-overlay').classList.remove('hidden');
}

function resumeCameraScan() {
    isScanPaused = false;
    lastCode = '';
    hitCount = 0;
    document.getElementById('scan-overlay').classList.remove('hidden');
    document.getElementById('scan-paused-overlay').classList.add('hidden');
}

async function stopCameraScanner() {
    isCameraRunning = false;
    if (previewLoopId) cancelAnimationFrame(previewLoopId);
    if (decodeTimerId) clearInterval(decodeTimerId);
    if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    document.getElementById('camera-wrapper').classList.add('hidden');
    document.getElementById('cam-btn-label').textContent = '連続カメラ';
}