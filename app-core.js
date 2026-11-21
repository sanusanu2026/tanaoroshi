/**
 * app-core.js (v7)
 * ・ノンストップ連続カメラスキャン（一時停止画面を廃止、同一JANのみ2.5秒クールダウン、別商品は即連続読取）
 * ・バーコード高精度化（連続オートフォーカス有効化 + 標準/高コントラスト4パターン交互解析 + 直近1秒間の多数決2回一致）
 * ・モーダル表示中のみ自動スキップ＆解析詰まり時の1.5秒自動リセット保護
 * ・マイクと読み上げの排他制御＋タップ即割り込み＋明るい声（pitch=1.25 / rate=1.18）
 */

const APP_VERSION = 'v7';
const STORAGE_KEY = 'smart_inventory_solution_b_v7';
const GAS_URL_STORAGE_KEY = 'smart_inventory_gas_api_url_v4';

const defaultMaster = {
    adminPin: '1234',
    gasWebhookUrl: '',
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

function checkUrlQueryForGasConfig() {
    try {
        const params = new URLSearchParams(window.location.search);
        const gasParam = params.get('gas');
        if (gasParam && gasParam.startsWith('https://script.google.com/')) {
            localStorage.setItem(GAS_URL_STORAGE_KEY, gasParam.trim());
            masterData.gasWebhookUrl = gasParam.trim();
            const cleanUrl = window.location.origin + window.location.pathname;
            window.history.replaceState({}, document.title, cleanUrl);
        }
    } catch (e) {}
}

function getActiveGasUrl() {
    const dedicated = localStorage.getItem(GAS_URL_STORAGE_KEY);
    return (dedicated || masterData.gasWebhookUrl || '').trim();
}

function setActiveGasUrl(newUrl) {
    const cleaned = (newUrl || '').trim();
    localStorage.setItem(GAS_URL_STORAGE_KEY, cleaned);
    masterData.gasWebhookUrl = cleaned;
    saveToLocalStorage();
}

function updateSyncStatusDot(stateStr) {
    const dot = document.getElementById('sync-status-dot');
    if (!dot) return;
    if (stateStr === 'ok') {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
    } else if (stateStr === 'syncing') {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping';
    } else {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-rose-500';
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
    checkUrlQueryForGasConfig();
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.masterData) {
                masterData = Object.assign(masterData, parsed.masterData);
            }
            if (parsed.inventoryRecords && parsed.inventoryRecords.length > 0) inventoryRecords = parsed.inventoryRecords;
            if (parsed.addStockLogs) addStockLogs = parsed.addStockLogs;
            if (parsed.currentWorker) appState.currentWorker = parsed.currentWorker;
        }
        const savedGasUrl = localStorage.getItem(GAS_URL_STORAGE_KEY);
        if (savedGasUrl) {
            masterData.gasWebhookUrl = savedGasUrl;
        }
        if (!inventoryRecords.some(r => r.id === appState.selectedRecordId)) {
            appState.selectedRecordId = inventoryRecords[0].id;
        }
    } catch (e) {}
}

async function fetchAllFromGasApi(showNotification = true) {
    const url = getActiveGasUrl();
    if (!url) {
        updateSyncStatusDot('offline');
        if (showNotification) {
            showToast('左上の「⚙️接続」ボタンからGASのURLを設定してください');
            openGasConfigModal();
        }
        return;
    }

    if (!url.startsWith('https://script.google.com/macros/s/') || !url.endsWith('/exec')) {
        updateSyncStatusDot('offline');
        if (showNotification) {
            showToast('⚠️ URL形式エラー: 末尾が「/exec」のウェブアプリURLを設定してください');
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

        const rawText = await res.text();
        if (rawText.trim().startsWith('<')) {
            throw new Error('GASの公開権限が「全員」になっていないか、古いHTML版コードのままです');
        }

        const json = JSON.parse(rawText);
        if (json && json.status === 'ok' && json.data) {
            if (json.data.masterData) {
                masterData = Object.assign(masterData, json.data.masterData);
                masterData.gasWebhookUrl = url;
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
            throw new Error(json.message || 'GASから無効なレスポンスが返りました');
        }
    } catch (err) {
        updateSyncStatusDot('offline');
        if (showNotification) {
            const msg = err.message.includes('Failed to fetch')
                ? '⚠️ 通信ブロック: GASのデプロイ設定で「アクセスできるユーザー：全員」か確認してください'
                : '⚠️ GAS通信エラー: ' + err.message;
            showToast(msg);
        }
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
// 1. スキャン音・操作音（iOS/Android対応 WAV + Web Audio API）
// ==========================================================
let audioCtx = null;
let beepAudioEl = null;

function initWavBeep() {
    if (beepAudioEl) return;
    const sampleRate = 22050;
    const duration = 0.09;
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

    const freq = 2300;
    for (let i = 0; i < numSamples; i++) {
        const wave = Math.sin(2 * Math.PI * freq * (i / sampleRate)) >= 0 ? 220 : 36;
        view.setUint8(44 + i, wave);
    }

    const blob = new Blob([buffer], { type: 'audio/wav' });
    beepAudioEl = new Audio(URL.createObjectURL(blob));
    beepAudioEl.playsInline = true;
}

function triggerIosScanBeep(silent = false) {
    if (!appState.soundOn && !silent) return;
    try {
        initWavBeep();
        if (beepAudioEl) {
            beepAudioEl.volume = silent ? 0.01 : 1.0;
            beepAudioEl.currentTime = 0;
            beepAudioEl.play().catch(() => {});
        }
    } catch (e) {}
    playTone(2350, 'square', 0.08, silent ? 0.001 : 0.16);
}

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
    scan:    () => triggerIosScanBeep(false),
    key:     () => playTone(980, 'sine', 0.04, 0.05),
    next:    () => { playTone(1046, 'sine', 0.06, 0.07); setTimeout(() => playTone(1318, 'sine', 0.09, 0.07), 65); },
    voiceOk: () => playTone(1568, 'triangle', 0.08, 0.07),
    err:     () => { playTone(260, 'sawtooth', 0.14, 0.08); }
};

function toggleSound() {
    appState.soundOn = !appState.soundOn;
    document.getElementById('btn-sound').textContent = appState.soundOn ? '🔊音' : '🔇音';
    if (appState.soundOn) SFX.key();
}

// ==========================================================
// 2. 明るい声の音声読み上げ ＆ マイク排他制御（スマホ安定方式）
// ==========================================================
let isSpeaking = false;
let speechWatchdogTimer = null;
let micRestartTimer = null;

function toggleTts() {
    appState.ttsOn = !appState.ttsOn;
    const btn = document.getElementById('btn-tts');
    btn.textContent = appState.ttsOn ? '🗣️声:ON' : '🔇声:OFF';
    btn.className = appState.ttsOn
        ? 'bg-amber-600 text-white font-bold text-[11px] px-1.5 py-1 rounded'
        : 'bg-slate-800 border border-slate-700 text-slate-300 text-[11px] px-1.5 py-1 rounded';

    if (!appState.ttsOn && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        isSpeaking = false;
        if (appState.isListening) startRecognitionSafely();
    } else {
        speakText('音声オン！', true);
    }
}

function startRecognitionSafely() {
    if (!appState.isListening || isSpeaking || !recognition) return;
    clearTimeout(micRestartTimer);
    try {
        recognition.start();
    } catch (e) {}
}

function interruptSpeechAndListenNow() {
    clearTimeout(speechWatchdogTimer);
    clearTimeout(micRestartTimer);
    if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
    }
    isSpeaking = false;
    SFX.key();
    const trEl = document.getElementById('voice-transcript');
    if (trEl) trEl.textContent = '👂 録音中...（数字・次へ・前回同数）';
    if (!appState.isListening) {
        toggleVoiceRecognition();
    } else {
        setTimeout(startRecognitionSafely, 120);
    }
}

function speakText(text, force = false) {
    const subEl = document.getElementById('tts-subtitle');
    if (subEl) subEl.textContent = text;

    if ((!appState.ttsOn && !force) || !('speechSynthesis' in window)) {
        isSpeaking = false;
        if (appState.isListening) {
            micRestartTimer = setTimeout(startRecognitionSafely, 200);
        }
        return;
    }

    try {
        clearTimeout(speechWatchdogTimer);
        clearTimeout(micRestartTimer);
        window.speechSynthesis.cancel();
        if (window.speechSynthesis.paused) {
            window.speechSynthesis.resume();
        }

        isSpeaking = true;
        if (recognition) {
            try { recognition.abort(); } catch (e) {}
        }
        const trEl = document.getElementById('voice-transcript');
        if (appState.isListening && trEl) {
            trEl.textContent = '🗣️ 読み上げ中（すぐマイクに切り替わります）';
        }

        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'ja-JP';
        utter.rate = 1.18;
        utter.pitch = 1.25;
        utter.volume = 1.0;

        const finishSpeak = () => {
            clearTimeout(speechWatchdogTimer);
            if (!isSpeaking) return;
            isSpeaking = false;
            if (appState.isListening) {
                if (trEl) trEl.textContent = '👂 聞き取り中...（数字・次へ・前回同数）';
                micRestartTimer = setTimeout(startRecognitionSafely, 260);
            }
        };

        utter.onend = finishSpeak;
        utter.onerror = finishSpeak;

        const estDuration = Math.max(1500, text.length * 155);
        speechWatchdogTimer = setTimeout(finishSpeak, estDuration);

        window.speechSynthesis.speak(utter);
    } catch (e) {
        isSpeaking = false;
        if (appState.isListening) {
            micRestartTimer = setTimeout(startRecognitionSafely, 260);
        }
    }
}

function speakCurrentRecord(force = false, prefix = '') {
    const rec = getCurrentRecord();
    if (!rec) return;
    const msg = `${prefix}${rec.name}、単位${rec.unit}、前回${rec.prevQty}。`;
    speakText(msg, force);
}

// ==========================================================
// 3. 連続音声認識エンジン
// ==========================================================
let recognition = null;
let lastProcessedTranscript = '';
let lastProcessedTime = 0;

function toggleVoiceRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        showToast('このブラウザは音声認識APIに非対応です');
        speakCurrentRecord(true);
        return;
    }

    if (appState.isListening) {
        appState.isListening = false;
        isSpeaking = false;
        clearTimeout(speechWatchdogTimer);
        clearTimeout(micRestartTimer);
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        if (recognition) {
            try { recognition.abort(); } catch (e) {}
        }
        updateVoiceUI(false);
        showToast('音声入力を停止しました');
        return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;

    recognition.onstart = () => {
        if (!isSpeaking) {
            const trEl = document.getElementById('voice-transcript');
            if (trEl) trEl.textContent = '🔴 録音中...（声を出してください）';
        }
    };

    recognition.onresult = (event) => {
        if (isSpeaking) return;
        let interimText = '';
        let finalText = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
            const res = event.results[i];
            if (res.isFinal) {
                finalText += res[0].transcript;
            } else {
                interimText += res[0].transcript;
            }
        }

        const trEl = document.getElementById('voice-transcript');
        if (interimText && trEl) {
            trEl.textContent = `認識中: 「${interimText}」...`;
        }

        if (finalText) {
            const cleaned = finalText.trim();
            const now = Date.now();
            if (cleaned && !(cleaned === lastProcessedTranscript && now - lastProcessedTime < 1200)) {
                lastProcessedTranscript = cleaned;
                lastProcessedTime = now;
                processVoiceCommand(cleaned);
            }
        }
    };

    recognition.onerror = (event) => {
        const trEl = document.getElementById('voice-transcript');
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            appState.isListening = false;
            updateVoiceUI(false);
            showToast('⚠️ マイクの使用が許可されていません。ブラウザ設定でマイクを許可してください');
            return;
        }
        if (trEl && event.error !== 'aborted' && event.error !== 'no-speech') {
            trEl.textContent = `⚠️ マイク待機再接続中 (${event.error})`;
        }
        if (appState.isListening && !isSpeaking) {
            micRestartTimer = setTimeout(startRecognitionSafely, 350);
        }
    };

    recognition.onend = () => {
        if (appState.isListening && !isSpeaking) {
            micRestartTimer = setTimeout(startRecognitionSafely, 180);
        } else if (!appState.isListening) {
            updateVoiceUI(false);
        }
    };

    appState.isListening = true;
    updateVoiceUI(true);
    showToast('🎤 ハンズフリー開始（読み上げ終了後に録音開始します）');

    startRecognitionSafely();
    setTimeout(() => {
        if (appState.isListening) {
            speakCurrentRecord(true, '開始！');
        }
    }, 400);
}

function updateVoiceUI(active) {
    const btn = document.getElementById('btn-voice-toggle');
    const label = document.getElementById('voice-btn-label');
    const dot = document.getElementById('voice-status-dot');
    const bar = document.getElementById('voice-transcript-bar');
    if (active) {
        btn.classList.add('mic-active', 'bg-red-700');
        if (label) label.textContent = '停止';
        if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-red-500 animate-ping shrink-0';
        if (bar) bar.classList.remove('hidden');
    } else {
        btn.classList.remove('mic-active', 'bg-red-700');
        if (label) label.textContent = '音声';
        if (dot) dot.className = 'w-2 h-2 rounded-full bg-slate-500 shrink-0';
        if (bar) bar.classList.add('hidden');
    }
}

function processVoiceCommand(rawText) {
    const trEl = document.getElementById('voice-transcript');
    if (trEl) trEl.textContent = `✅ 認識: 「${rawText}」`;

    const rec = getCurrentRecord();
    const unit = rec ? rec.unit : '個';

    if (/もう一回|もう一度|もういっかい|もういちど|読み上げ|よみあげ|なに|何/.test(rawText)) {
        speakCurrentRecord(true);
        return;
    }

    if (/戻る|もどる|前の|まえの/.test(rawText)) {
        movePrevRecord();
        return;
    }

    if (/クリア|リセット|取り消し|とりけし|ゼロ|ぜろ/.test(rawText)) {
        clearQtyInput();
        SFX.voiceOk();
        speakText('ゼロ！');
        return;
    }

    if (/前回|ぜんかい|同じ|おなじ|同数|どうすう/.test(rawText)) {
        copyPrevQty();
        SFX.voiceOk();
        if (/次|つぎ|確定|かくてい|はい/.test(rawText)) {
            setTimeout(confirmAndNextRecord, 200);
        } else {
            speakText(`${rec.prevQty}${unit}。次へ？`);
        }
        return;
    }

    const parsedNum = extractJapaneseNumber(rawText);
    if (parsedNum !== null) {
        SFX.voiceOk();
        appState.inputBuffer = String(parsedNum);
        applyBufferToCurrentRecord();

        if (/次|つぎ|確定|かくてい|オッケー|OK|はい/i.test(rawText)) {
            setTimeout(confirmAndNextRecord, 200);
        } else {
            speakText(`${parsedNum}${unit}。次へ？`);
        }
        return;
    }

    if (/次|つぎ|確定|かくてい|オッケー|おっけー|OK|はい|完了|かんりょう/i.test(rawText)) {
        confirmAndNextRecord();
        return;
    }

    if (trEl) trEl.textContent = `❓ 「${rawText}」（数字 または「次へ」と話してください）`;
}

function extractJapaneseNumber(str) {
    let norm = str
        .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
        .replace(/[\u30a1-\u30f6]/g, m => String.fromCharCode(m.charCodeAt(0) - 0x60));

    const digitMatch = norm.match(/\d+/);
    if (digitMatch) return parseInt(digitMatch[0], 10);

    const hiraReplacements = [
        ['さんびゃく', '三百'], ['ろっぴゃく', '六百'], ['はっぴゃく', '八百'], ['ひゃく', '百'],
        ['じゅう', '十'],
        ['ぜろ', '〇'], ['れい', '〇'],
        ['いち', '一'], ['ひと', '一'],
        ['に', '二'], ['ふた', '二'],
        ['さん', '三'], ['みっ', '三'],
        ['よん', '四'], ['し', '四'], ['よっ', '四'],
        ['ご', '五'], ['いつ', '五'],
        ['ろく', '六'], ['むっ', '六'],
        ['なな', '七'], ['しち', '七'],
        ['はち', '八'], ['やっ', '八'],
        ['きゅう', '九'], ['く', '九']
    ];
    for (const [hira, kanji] of hiraReplacements) {
        norm = norm.split(hira).join(kanji);
    }

    const kanjiMap = { '零':0, '〇':0, '一':1, '二':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9 };
    let total = 0, current = 0, matched = false;
    for (const ch of norm) {
        if (kanjiMap[ch] !== undefined) {
            current = kanjiMap[ch];
            matched = true;
        } else if (ch === '十') {
            total += (current || 1) * 10;
            current = 0;
            matched = true;
        } else if (ch === '百') {
            total += (current || 1) * 100;
            current = 0;
            matched = true;
        }
    }
    total += current;
    return matched ? total : null;
}

// ==========================================================
// 4. ノンストップ連続JANスキャナー（v7：連続AF + 4パターン交互解析 + 1秒多数決）
// ==========================================================
let mediaStream = null;
let offscreenVideo = null;
let isCameraRunning = false;
let digitalZoom = 1.6;
let previewLoopId = null;
let decodeTimerId = null;
let isDecodingFrame = false;
let decodingStartedAt = 0;
let scanFramePhase = 0;
let scanAttemptCount = 0;

// 直近1.2秒間の候補バッファ（多数決判定用）
let recentScanHits = [];
// 同一JANの連続二重読み防止用クールダウン（2.5秒）
let lastAcceptedCode = '';
let lastAcceptedTime = 0;
let successBannerTimer = null;

let nativeBarcodeDetector = null;
if ('BarcodeDetector' in window) {
    try {
        nativeBarcodeDetector = new BarcodeDetector({
            formats: ['ean_13', 'ean_8']
        });
    } catch (e) {
        nativeBarcodeDetector = null;
    }
}

function isModalCurrentlyOpen() {
    const el = document.getElementById('modal-overlay');
    return el && !el.classList.contains('hidden');
}

function calcCoverCrop(vw, vh, destW, destH, zoom) {
    const srcRatio = vw / vh;
    const destRatio = destW / destH;
    let baseW, baseH;
    if (srcRatio > destRatio) {
        baseH = vh;
        baseW = vh * destRatio;
    } else {
        baseW = vw;
        baseH = vw / destRatio;
    }
    const cropW = baseW / zoom;
    const cropH = baseH / zoom;
    return {
        cropX: (vw - cropW) / 2,
        cropY: (vh - cropH) / 2,
        cropW,
        cropH
    };
}

function getQuaggaAverageError(result) {
    try {
        const codes = result?.codeResult?.decodedCodes;
        if (!Array.isArray(codes) || codes.length === 0) return 1.0;
        const errors = codes.filter(c => typeof c.error === 'number').map(c => c.error);
        if (errors.length === 0) return 1.0;
        const sum = errors.reduce((a, b) => a + b, 0);
        return sum / errors.length;
    } catch (e) {
        return 1.0;
    }
}

function isValidJanCheckDigit(code) {
    if (!/^\d{13}$|^\d{8}$/.test(code)) return false;
    const digits = code.split('').map(Number);
    const checkDigit = digits.pop();
    let sum = 0;
    const len = digits.length;
    for (let i = 0; i < len; i++) {
        const weight = ((len - 1 - i) % 2 === 0) ? 3 : 1;
        sum += digits[i] * weight;
    }
    const calc = (10 - (sum % 10)) % 10;
    return calc === checkDigit;
}

/**
 * 候補JANを1.2秒バッファへ投入し、2回以上一致したら確定（別商品なら即座に連続読取可能）
 */
function registerScanCandidate(code) {
    const now = Date.now();
    // 同じJANだけ2.5秒間クールダウン（別JANなら待たずに即反応）
    if (code === lastAcceptedCode && now - lastAcceptedTime < 2500) {
        return false;
    }

    // 1.2秒以内のヒットのみ残す
    recentScanHits = recentScanHits.filter(h => now - h.time < 1200);
    recentScanHits.push({ code, time: now });

    const matchCount = recentScanHits.filter(h => h.code === code).length;
    if (matchCount >= 2) {
        recentScanHits = [];
        lastAcceptedCode = code;
        lastAcceptedTime = now;
        flashScanSuccessVisual(code);
        handleBarcodeScan(code);
        return true;
    }
    return false;
}

/**
 * カメラを止めずに読取成功を緑フラッシュ＋バナーで通知
 */
function flashScanSuccessVisual(code) {
    const guide = document.getElementById('scan-guide-box');
    const banner = document.getElementById('scan-success-banner');
    if (guide) {
        guide.classList.remove('border-emerald-400/90');
        guide.classList.add('border-amber-400', 'bg-emerald-400/20');
        setTimeout(() => {
            guide.classList.remove('border-amber-400', 'bg-emerald-400/20');
            guide.classList.add('border-emerald-400/90');
        }, 350);
    }
    if (banner) {
        banner.textContent = `✅ 読取: ${code}（次をかざせます）`;
        banner.classList.remove('hidden');
        clearTimeout(successBannerTimer);
        successBannerTimer = setTimeout(() => banner.classList.add('hidden'), 1600);
    }
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
    triggerIosScanBeep(true);

    try {
        offscreenVideo = document.createElement('video');
        offscreenVideo.setAttribute('playsinline', '');
        offscreenVideo.setAttribute('webkit-playsinline', 'true');
        offscreenVideo.muted = true;
        offscreenVideo.autoplay = true;

        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        });

        // 対応スマホで連続オートフォーカス（continuous focus）を有効化してピンボケを防止
        try {
            const videoTrack = mediaStream.getVideoTracks()[0];
            if (videoTrack && typeof videoTrack.getCapabilities === 'function') {
                const caps = videoTrack.getCapabilities();
                if (caps.focusMode && caps.focusMode.includes('continuous')) {
                    await videoTrack.applyConstraints({
                        advanced: [{ focusMode: 'continuous' }]
                    });
                }
            }
        } catch (e) {}

        offscreenVideo.srcObject = mediaStream;
        await offscreenVideo.play();

        isCameraRunning = true;
        isDecodingFrame = false;
        scanAttemptCount = 0;
        recentScanHits = [];
        lastAcceptedCode = '';
        lastAcceptedTime = 0;

        document.getElementById('camera-wrapper').classList.remove('hidden');
        const btn = document.getElementById('btn-cam-toggle');
        btn.classList.remove('bg-emerald-600');
        btn.classList.add('bg-slate-700');
        document.getElementById('cam-btn-label').textContent = '停止';

        const previewCanvas = document.getElementById('preview-canvas');
        const previewCtx = previewCanvas.getContext('2d', { alpha: false });

        const renderPreview = () => {
            if (!isCameraRunning || !offscreenVideo) return;
            if (offscreenVideo.readyState >= offscreenVideo.HAVE_CURRENT_DATA && offscreenVideo.videoWidth > 0) {
                const vw = offscreenVideo.videoWidth;
                const vh = offscreenVideo.videoHeight;
                const rect = previewCanvas.getBoundingClientRect();
                const dpr = Math.min(window.devicePixelRatio || 1, 2);
                const targetW = Math.max(280, Math.round(rect.width * dpr));
                const targetH = Math.max(160, Math.round(rect.height * dpr));

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
            if (!isCameraRunning || !offscreenVideo) return;

            // モーダルが開いている間だけ解析をスキップ（閉じれば自動で即復帰）
            if (isModalCurrentlyOpen()) {
                const debugEl = document.getElementById('scan-debug-info');
                if (debugEl) debugEl.textContent = `[${APP_VERSION}] 入力画面表示中...`;
                return;
            }

            // 万が一Quaggaコールバックが返らず詰まっても1.5秒で自動リセットしてフリーズを完全防止
            if (isDecodingFrame) {
                if (Date.now() - decodingStartedAt > 1500) {
                    isDecodingFrame = false;
                } else {
                    return;
                }
            }

            if (offscreenVideo.readyState < offscreenVideo.HAVE_ENOUGH_DATA || offscreenVideo.videoWidth === 0) return;

            isDecodingFrame = true;
            decodingStartedAt = Date.now();
            scanAttemptCount++;

            const debugEl = document.getElementById('scan-debug-info');
            if (debugEl) {
                debugEl.textContent = `[${APP_VERSION}] 連続解析: ${scanAttemptCount}回`;
            }

            // 1. ネイティブBarcodeDetector（対応端末で超高速＆高精度）
            if (nativeBarcodeDetector) {
                try {
                    const barcodes = await nativeBarcodeDetector.detect(previewCanvas);
                    if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                        const nativeCode = barcodes[0].rawValue.trim();
                        if (isValidJanCheckDigit(nativeCode)) {
                            const accepted = registerScanCandidate(nativeCode);
                            if (accepted) {
                                isDecodingFrame = false;
                                return;
                            }
                        }
                    }
                } catch (e) {}
            }

            // 2. Quagga2（4パターン交互：0°標準 / 90°標準 / 0°コントラスト強調 / 90°コントラスト強調）
            const vw = offscreenVideo.videoWidth;
            const vh = offscreenVideo.videoHeight;
            const rect = previewCanvas.getBoundingClientRect();
            const destW = Math.max(280, rect.width || 320);
            const destH = Math.max(160, rect.height || 176);

            const { cropX, cropY, cropW, cropH } = calcCoverCrop(vw, vh, destW, destH, digitalZoom);
            const bandX = Math.floor(cropX + cropW * 0.14);
            const bandY = Math.floor(cropY + cropH * 0.12);
            const bandW = Math.floor(cropW * 0.72);
            const bandH = Math.floor(cropH * 0.76);

            const phase = scanFramePhase % 4;
            scanFramePhase++;
            const rotate90 = (phase === 1 || phase === 3);
            const useContrast = (phase === 2 || phase === 3);
            const targetSize = 540;

            if (!rotate90) {
                decodeCanvas.width = targetSize;
                decodeCanvas.height = Math.max(240, Math.floor(targetSize * (bandH / bandW)));
                decodeCtx.setTransform(1, 0, 0, 1, 0, 0);
                decodeCtx.drawImage(offscreenVideo, bandX, bandY, bandW, bandH, 0, 0, decodeCanvas.width, decodeCanvas.height);
            } else {
                decodeCanvas.width = Math.max(240, Math.floor(targetSize * (bandH / bandW)));
                decodeCanvas.height = targetSize;
                decodeCtx.save();
                decodeCtx.translate(decodeCanvas.width / 2, decodeCanvas.height / 2);
                decodeCtx.rotate(Math.PI / 2);
                decodeCtx.drawImage(offscreenVideo, bandX, bandY, bandW, bandH, -decodeCanvas.height / 2, -decodeCanvas.width / 2, decodeCanvas.height, decodeCanvas.width);
                decodeCtx.restore();
            }

            if (useContrast) {
                enhanceBarcodeContrast(decodeCtx, decodeCanvas.width, decodeCanvas.height);
            }
            const dataUrl = decodeCanvas.toDataURL('image/jpeg', 0.86);

            if (typeof Quagga === 'undefined') {
                isDecodingFrame = false;
                return;
            }

            Quagga.decodeSingle({
                src: dataUrl,
                numOfWorkers: 0,
                locate: true,
                inputStream: { size: Math.max(decodeCanvas.width, decodeCanvas.height) },
                decoder: {
                    readers: ['ean_reader', 'ean_8_reader']
                }
            }, (result) => {
                isDecodingFrame = false;
                if (!isCameraRunning || isModalCurrentlyOpen()) return;
                if (result && result.codeResult && result.codeResult.code) {
                    const code = result.codeResult.code.trim();
                    const avgErr = getQuaggaAverageError(result);
                    if (avgErr < 0.14 && isValidJanCheckDigit(code)) {
                        registerScanCandidate(code);
                    }
                }
            });
        }, 70);
    } catch (err) {
        showToast('カメラ起動エラー: ' + err.message);
        await stopCameraScanner();
    }
}

function enhanceBarcodeContrast(ctx, w, h) {
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const contrast = 1.6;
    const intercept = 128 * (1 - contrast);
    for (let i = 0; i < data.length; i += 4) {
        const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        let adj = gray * contrast + intercept;
        data[i] = data[i + 1] = data[i + 2] = adj < 0 ? 0 : adj > 255 ? 255 : adj;
    }
    ctx.putImageData(imgData, 0, 0);
}

function setDigitalZoom(zoom) {
    digitalZoom = zoom;
    ['z-btn-10', 'z-btn-16', 'z-btn-22'].forEach(id => {
        document.getElementById(id).className = 'bg-slate-900/85 text-white border border-slate-600 text-[10px] font-bold px-2 py-0.5 rounded';
    });
    const activeId = zoom === 1.0 ? 'z-btn-10' : zoom === 1.6 ? 'z-btn-16' : 'z-btn-22';
    document.getElementById(activeId).className = 'bg-emerald-600 text-white text-[10px] font-bold px-2 py-0.5 rounded';
}

async function stopCameraScanner() {
    isCameraRunning = false;
    isDecodingFrame = false;
    recentScanHits = [];
    if (previewLoopId) { cancelAnimationFrame(previewLoopId); previewLoopId = null; }
    if (decodeTimerId) { clearInterval(decodeTimerId); decodeTimerId = null; }
    if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
    }
    if (offscreenVideo) {
        offscreenVideo.srcObject = null;
        offscreenVideo = null;
    }
    document.getElementById('camera-wrapper').classList.add('hidden');
    const btn = document.getElementById('btn-cam-toggle');
    btn.classList.remove('bg-slate-700');
    btn.classList.add('bg-emerald-600');
    document.getElementById('cam-btn-label').textContent = 'カメラ';
}
