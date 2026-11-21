/**
 * app-core.js (v4)
 * ・公開コード内にGASのURLを一切持たず、UIの設定モーダル(localStorage)またはURLパラメータ(?gas=...)から安全に読み込む設計
 * ・明るい声の音声読み上げ(voice強制指定を廃止しスマホ無音バグを解消、pitch=1.25 / rate=1.15)
 * ・読み上げ途中の声掛け(割り込みコマンド)対応：読み上げ中もマイクを止めず、ユーザー発話検知で即座に読み上げを中断して反応
 * ・全方向バーコードスキャン(コントラスト強調Quagga2 + ネイティブBarcodeDetectorハイブリッド + 稼働モニター表示)
 */

const STORAGE_KEY = 'smart_inventory_solution_b_v4';
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

/**
 * URLパラメータ(?gas=...)で共有リンクが開かれた場合、端末のlocalStorageへ保存してアドレスバーからURLを隠す
 */
function checkUrlQueryForGasConfig() {
    try {
        const params = new URLSearchParams(window.location.search);
        const gasParam = params.get('gas');
        if (gasParam && gasParam.startsWith('https://script.google.com/')) {
            localStorage.setItem(GAS_URL_STORAGE_KEY, gasParam.trim());
            masterData.gasWebhookUrl = gasParam.trim();
            // アドレスバーから ?gas=... を消去して画面をすっきり＆安全に保つ
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

    updateSyncStatusDot('syncing');
    if (showNotification) showToast('🔄 スプレッドシートと同期中...');

    try {
        const res = await fetch(url + '?t=' + Date.now(), {
            method: 'GET',
            redirect: 'follow'
        });
        const json = await res.json();
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
            throw new Error(json.message || 'Invalid response');
        }
    } catch (err) {
        updateSyncStatusDot('offline');
        if (showNotification) showToast('⚠️ GAS通信エラー（オフライン保存中）: ' + err.message);
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
// 2. 明るい声の音声読み上げ ＆ 読み上げ途中の声掛け（割り込み）対応
// ==========================================================
let isSpeaking = false;
let currentSpokenText = '';
let speechWatchdogTimer = null;
let speakDelayTimer = null;

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
    } else {
        speakText('音声案内をオンにしました！', true);
    }
}

function startRecognitionSafely() {
    if (!appState.isListening || !recognition) return;
    try {
        recognition.start();
    } catch (e) {}
}

/**
 * 明るくハキハキした声で読み上げ（読み上げ中もマイク認識を止めずに並行稼働）
 * ※サンプル(teraoka (1).html)と同様に utter.voice の強制上書きを行わないことでスマホ無音バグを完全防止
 */
function speakText(text, force = false) {
    const subEl = document.getElementById('tts-subtitle');
    if (subEl) subEl.textContent = text;

    if ((!appState.ttsOn && !force) || !('speechSynthesis' in window)) {
        isSpeaking = false;
        return;
    }

    try {
        clearTimeout(speechWatchdogTimer);
        clearTimeout(speakDelayTimer);
        window.speechSynthesis.cancel();
        if (window.speechSynthesis.paused) {
            window.speechSynthesis.resume();
        }

        isSpeaking = true;
        currentSpokenText = text;

        // cancel()直後にspeak()すると消えるブラウザ対策として40ms後に発声開始
        speakDelayTimer = setTimeout(() => {
            try {
                const utter = new SpeechSynthesisUtterance(text);
                utter.lang = 'ja-JP';
                // 明るく聞き取りやすいトーン（ピッチ 1.25 / 速度 1.15）
                utter.rate = 1.15;
                utter.pitch = 1.25;
                utter.volume = 1.0;

                const finishSpeak = () => {
                    clearTimeout(speechWatchdogTimer);
                    isSpeaking = false;
                    if (appState.isListening) {
                        startRecognitionSafely();
                    }
                };

                utter.onend = finishSpeak;
                utter.onerror = finishSpeak;

                const estDuration = Math.max(2000, text.length * 165);
                speechWatchdogTimer = setTimeout(finishSpeak, estDuration);

                window.speechSynthesis.speak(utter);
                // 読み上げ中もマイクが止まっていれば起動しておく（途中割り込み対応）
                if (appState.isListening) {
                    setTimeout(startRecognitionSafely, 120);
                }
            } catch (err) {
                isSpeaking = false;
            }
        }, 40);
    } catch (e) {
        isSpeaking = false;
    }
}

function speakCurrentRecord(force = false, prefix = '') {
    const rec = getCurrentRecord();
    if (!rec) return;
    // 読み上げ途中でも割り込みやすいよう、簡潔でテンポの良い案内文にする
    const msg = `${prefix}${rec.area}、${rec.shelf}。${rec.name}、単位は${rec.unit}。前回 ${rec.prevQty}。数量をどうぞ！`;
    speakText(msg, force);
}

// ==========================================================
// 3. 連続音声認識エンジン（読み上げ途中の声掛け割り込み＆エコー誤爆防止）
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
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        if (recognition) {
            try { recognition.abort(); } catch (e) {}
        }
        updateVoiceUI(false);
        return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;

    recognition.onstart = () => {
        const trEl = document.getElementById('voice-transcript');
        if (trEl) trEl.textContent = '👂 聞き取り中（読み上げ途中でも「数字」「次へ」に反応します）';
    };

    recognition.onresult = (event) => {
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

        // 読み上げ途中にユーザーが話し始めた場合、自分の読み上げ音声（エコー）でなければ即座に読み上げを止めて聞き取る
        if (isSpeaking && interimText) {
            const cleanInterim = interimText.trim();
            if (!isLikelySelfEcho(cleanInterim)) {
                if (window.speechSynthesis) window.speechSynthesis.cancel();
                isSpeaking = false;
            }
        }

        const trEl = document.getElementById('voice-transcript');
        if (interimText && trEl) {
            trEl.textContent = `認識中: 「${interimText}」...`;
        }

        if (finalText) {
            const cleaned = finalText.trim();
            if (isSpeaking && isLikelySelfEcho(cleaned)) {
                return;
            }
            const now = Date.now();
            if (cleaned && !(cleaned === lastProcessedTranscript && now - lastProcessedTime < 1000)) {
                lastProcessedTranscript = cleaned;
                lastProcessedTime = now;
                if (window.speechSynthesis) window.speechSynthesis.cancel();
                isSpeaking = false;
                processVoiceCommand(cleaned);
            }
        }
    };

    recognition.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            appState.isListening = false;
            updateVoiceUI(false);
            showToast('⚠️ マイクの使用が許可されていません。ブラウザ設定でマイクを許可してください');
            return;
        }
        if (appState.isListening) {
            setTimeout(startRecognitionSafely, 250);
        }
    };

    recognition.onend = () => {
        if (appState.isListening) {
            setTimeout(startRecognitionSafely, 120);
        } else {
            updateVoiceUI(false);
        }
    };

    appState.isListening = true;
    updateVoiceUI(true);
    showToast('🎤 ハンズフリー開始（読み上げ途中の声掛けにも反応します）');
    startRecognitionSafely();
    setTimeout(() => {
        if (appState.isListening) speakCurrentRecord(true, 'ハンズフリー開始！');
    }, 300);
}

/**
 * スピーカーから流れているアプリ自身の読み上げ音声をマイクが拾ったかどうかを判定するフィルター
 */
function isLikelySelfEcho(heardText) {
    if (!heardText) return true;
    // 明確な操作コマンドや短い数字発話ならユーザーの割り込み声掛けとして通す
    if (/^(次|つぎ|次へ|確定|かくてい|オッケー|OK|はい|戻る|もどる|クリア|ゼロ|ストップ|止めて|\d+)$/i.test(heardText)) {
        return false;
    }
    const rec = getCurrentRecord();
    if (rec && (heardText.includes(rec.name) || heardText.includes('数量をどうぞ') || heardText.includes('単位は'))) {
        return true;
    }
    return false;
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

    if (/ストップ|止めて|とめて|静かに/.test(rawText)) {
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        isSpeaking = false;
        SFX.voiceOk();
        return;
    }

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
        speakText('ゼロにクリア！数量をどうぞ');
        return;
    }

    if (/前回|ぜんかい|同じ|おなじ/.test(rawText)) {
        copyPrevQty();
        SFX.voiceOk();
        if (/次|つぎ|確定|かくてい|はい/.test(rawText)) {
            setTimeout(confirmAndNextRecord, 200);
        } else {
            speakText(`前回と同じ、${rec.prevQty}${unit}！次へ、で確定します`);
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
            speakText(`${parsedNum}${unit}！次へ、で確定します`);
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
// 4. 全方向カメラスキャナー（Quagga2高コントラスト + ネイティブBarcodeDetector併用）
// ==========================================================
let mediaStream = null;
let offscreenVideo = null;
let isCameraRunning = false;
let isScanPaused = false;
let digitalZoom = 1.6;
let previewLoopId = null;
let decodeTimerId = null;
let isDecodingFrame = false;
let scanFrameParity = 0;
let scanAttemptCount = 0;
let lastCandidateCode = '';
let candidateHitCount = 0;
let nativeBarcodeDetector = null;

// Android Chrome等で対応していればOS純正の超高速BarcodeDetectorも併用
if ('BarcodeDetector' in window) {
    try {
        nativeBarcodeDetector = new BarcodeDetector({
            formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128']
        });
    } catch (e) {
        nativeBarcodeDetector = null;
    }
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

        offscreenVideo.srcObject = mediaStream;
        await offscreenVideo.play();

        isCameraRunning = true;
        scanAttemptCount = 0;
        document.getElementById('camera-wrapper').classList.remove('hidden');
        const btn = document.getElementById('btn-cam-toggle');
        btn.classList.remove('bg-emerald-600');
        btn.classList.add('bg-slate-700');
        document.getElementById('cam-btn-label').textContent = '停止';

        resumeCameraScan();

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
            if (!isCameraRunning || isScanPaused || isDecodingFrame || !offscreenVideo) return;
            if (offscreenVideo.readyState < offscreenVideo.HAVE_ENOUGH_DATA || offscreenVideo.videoWidth === 0) return;

            isDecodingFrame = true;
            scanAttemptCount++;
            const debugEl = document.getElementById('scan-debug-info');
            if (debugEl) {
                debugEl.textContent = `解析中: ${scanAttemptCount}回 ${lastCandidateCode ? `(候補:${lastCandidateCode})` : ''}`;
            }

            // 1. OSネイティブBarcodeDetectorが使える場合は先行チェック
            if (nativeBarcodeDetector) {
                try {
                    const barcodes = await nativeBarcodeDetector.detect(previewCanvas);
                    if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                        const nativeCode = barcodes[0].rawValue.trim();
                        if (nativeCode.length >= 8) {
                            isDecodingFrame = false;
                            pauseCameraScan();
                            handleBarcodeScan(nativeCode);
                            return;
                        }
                    }
                } catch (e) {}
            }

            // 2. サンプル(teraoka (1).html)完全準拠のQuagga2全方向・高コントラスト解析
            const vw = offscreenVideo.videoWidth;
            const vh = offscreenVideo.videoHeight;
            const rect = previewCanvas.getBoundingClientRect();
            const destW = Math.max(280, rect.width || 320);
            const destH = Math.max(160, rect.height || 176);

            const { cropX, cropY, cropW, cropH } = calcCoverCrop(vw, vh, destW, destH, digitalZoom);
            const bandX = Math.floor(cropX + cropW * 0.12);
            const bandY = Math.floor(cropY + cropH * 0.10);
            const bandW = Math.floor(cropW * 0.76);
            const bandH = Math.floor(cropH * 0.80);

            const rotate90 = (scanFrameParity % 2 === 1);
            scanFrameParity++;
            const targetSize = 560;

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

            enhanceBarcodeContrast(decodeCtx, decodeCanvas.width, decodeCanvas.height);
            const dataUrl = decodeCanvas.toDataURL('image/jpeg', 0.88);

            if (typeof Quagga === 'undefined') {
                if (debugEl) debugEl.textContent = '⚠️Quagga読込エラー';
                isDecodingFrame = false;
                return;
            }

            Quagga.decodeSingle({
                src: dataUrl,
                numOfWorkers: 0,
                locate: true,
                inputStream: { size: Math.max(decodeCanvas.width, decodeCanvas.height) },
                decoder: {
                    readers: ['ean_reader', 'ean_8_reader', 'upc_reader', 'code_128_reader']
                }
            }, (result) => {
                isDecodingFrame = false;
                if (!isCameraRunning || isScanPaused) return;
                if (result && result.codeResult && result.codeResult.code) {
                    const code = result.codeResult.code.trim();
                    if (code === lastCandidateCode) {
                        candidateHitCount++;
                    } else {
                        lastCandidateCode = code;
                        candidateHitCount = 1;
                    }
                    // EAN-13/8のチェックデジットが正しいか、または2回連続一致で即確定
                    if (candidateHitCount >= 2 || isValidJanCheckDigit(code)) {
                        lastCandidateCode = '';
                        candidateHitCount = 0;
                        pauseCameraScan();
                        handleBarcodeScan(code);
                    }
                }
            });
        }, 65);
    } catch (err) {
        showToast('カメラ起動エラー: ' + err.message);
        await stopCameraScanner();
    }
}

/**
 * JANコード(13桁/8桁)のチェックデジット検証（正しいJANなら1フレーム目でも即反応させる）
 */
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

function enhanceBarcodeContrast(ctx, w, h) {
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const contrast = 1.65;
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

function pauseCameraScan() {
    if (!isCameraRunning) return;
    isScanPaused = true;
    document.getElementById('scan-overlay').classList.add('hidden');
    document.getElementById('scan-paused-overlay').classList.remove('hidden');
}

function resumeCameraScan() {
    isScanPaused = false;
    lastCandidateCode = '';
    candidateHitCount = 0;
    if (isCameraRunning) {
        document.getElementById('scan-overlay').classList.remove('hidden');
        document.getElementById('scan-paused-overlay').classList.add('hidden');
    }
}

async function stopCameraScanner() {
    isCameraRunning = false;
    isScanPaused = false;
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
