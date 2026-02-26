const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTwNPNMY-W9MhaO0M_mr5XN5sHbDn6vROm6kEjDk23q0hhSXmR5oOaDu9Byz6fv-VATaQ207ScuUede/pub?gid=0&single=true&output=csv';

// --- Firebase Configuration ---
const firebaseConfig = {
    apiKey: "AIzaSyCX1nQLA8yaaIyy6bxHUdj6TfaAWyix3sg",
    authDomain: "pasalapabra.firebaseapp.com",
    projectId: "pasalapabra",
    storageBucket: "pasalapabra.firebasestorage.app",
    messagingSenderId: "144070010039",
    appId: "1:144070010039:web:a4cd3f6d65271ac421d932",
    measurementId: "G-WRZ9SLZGH0"
};

let db = null;
let analytics = null;
let currentUser = localStorage.getItem('pasalapabra_current_user') || null;

// --- Admin Security ---
const ADMIN_PASSWORD_HASH = 'c9976f2b1a59565defa9a604f370987dae81b71207b6ced4f0ac7dd452ed5868';

async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function verifyAdminPassword() {
    const { value: pw } = await Swal.fire({
        title: '🔐 Acceso Admin',
        text: 'Introduce la contraseña de administrador:',
        input: 'password',
        inputPlaceholder: 'Contraseña...',
        confirmButtonText: 'Entrar',
        showCancelButton: true,
        allowOutsideClick: false,
        allowEscapeKey: false,
        inputAttributes: { autocomplete: 'current-password' }
    });
    if (!pw) return false;
    const hashed = await hashPassword(pw);
    if (hashed !== ADMIN_PASSWORD_HASH) {
        await Swal.fire('❌ Contraseña incorrecta', 'Acceso denegado.', 'error');
        currentUser = null;
        localStorage.removeItem('pasalapabra_current_user');
        updateUIForUser();
        return false;
    }
    return true;
}

function initFirebase() {
    try {
        const app = window.firebaseApp(firebaseConfig);
        db = window.firebaseFirestore.getFirestore(app);
        if (window.firebaseAnalytics && firebaseConfig.measurementId) {
            analytics = window.firebaseAnalytics(app);
        }
        console.log("Firebase inicializado correctamente.");
    } catch (e) {
        console.error("Error inicializando Firebase:", e);
    }
}

// ════════════════════════════════════════════
// Global State
// ════════════════════════════════════════════
let wordsData = [];
let currentCardIndex = -1;
let userData = { progress: {}, roscoBest: null };
let shuffleQueue = [];
let lastPlayedIndex = -1;
let pendingReportWordIds = new Set();

// Current game mode: 'classic' | 'inverted' | 'rosco'
let currentMode = null;

function fisherYates(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function buildShuffleQueue() {
    const weighted = [];
    wordsData.forEach((w, idx) => {
        if (pendingReportWordIds.has(w.id)) return;
        const p = userData.progress[w.id];
        const status = p ? p.status : 'learning';
        const weight = status === 'learning' ? 3 : status === 'practicing' ? 2 : 1;
        for (let i = 0; i < weight; i++) weighted.push(idx);
    });
    if (weighted.length === 0) wordsData.forEach((_, idx) => weighted.push(idx));
    let q = fisherYates(weighted);
    while (q.length > 1 && q[0] === lastPlayedIndex) q = fisherYates(weighted);
    shuffleQueue = q;
}

// ════════════════════════════════════════════
// DOM Elements
// ════════════════════════════════════════════
const loader = document.getElementById('loader');
const modeSelector = document.getElementById('mode-selector');
const gameContainer = document.getElementById('game-container');
const roscoContainer = document.getElementById('rosco-container');
const card = document.getElementById('flashcard');
const gameControls = document.getElementById('game-controls');

const cardLetter = document.getElementById('card-letter');
const cardRule = document.getElementById('card-rule');
const cardDefinition = document.getElementById('card-definition');
const cardWord = document.getElementById('card-word');
const cardDefinitionBack = document.getElementById('card-definition-back');

lucide.createIcons();

// ════════════════════════════════════════════
// Initialization
// ════════════════════════════════════════════
async function init() {
    try {
        initFirebase();
        updateUIForUser();

        await fetchWordsData();
        console.log("Loaded", wordsData.length, "words.");

        if (!currentUser) {
            await promptLogin();
            if (currentUser === 'ADMIN') {
                const ok = await verifyAdminPassword();
                if (!ok) {
                    await promptLogin();
                } else {
                    loader.classList.add('hidden');
                    gameContainer.classList.remove('hidden');
                    await loadPendingReports();
                    setupFlashcardListeners();
                    await showAdminPanel();
                    return;
                }
            }
        }

        if (db && currentUser) {
            await loadFirebaseProgress();
        } else {
            loadLocalProgress();
        }

        await loadPendingReports();
        setupFlashcardListeners();
        setupRoscoListeners();

        // Show mode selector
        loader.classList.add('hidden');
        showModeSelector();

        // Logo returns to home
        const logo = document.getElementById('header-logo');
        if (logo) logo.addEventListener('click', () => {
            if (currentUser) showModeSelector();
        });

    } catch (error) {
        console.error("Error initializing app:", error);
        loader.innerHTML = `
            <i data-lucide="alert-circle" style="color: var(--danger); width: 48px; height: 48px;"></i>
            <p style="color: var(--danger);">Error cargando las palabras.</p>
            <p style="font-size: 0.8rem;">Verifica la consola para más detalles.</p>
        `;
        lucide.createIcons();
    }
}

// ════════════════════════════════════════════
// Mode Selector
// ════════════════════════════════════════════
function showModeSelector() {
    modeSelector.classList.remove('hidden');
    gameContainer.classList.add('hidden');
    roscoContainer.classList.add('hidden');
    stopRoscoTimer();
    lucide.createIcons();
}

function startMode(mode) {
    currentMode = mode;
    modeSelector.classList.add('hidden');

    if (mode === 'classic' || mode === 'inverted') {
        gameContainer.classList.remove('hidden');
        roscoContainer.classList.add('hidden');
        applyFlashcardMode(mode);
        shuffleQueue = [];
        lastPlayedIndex = -1;
        showNextCard();
    } else if (mode === 'rosco') {
        gameContainer.classList.add('hidden');
        roscoContainer.classList.remove('hidden');
        startRosco();
    }
}

// Wire mode card buttons once DOM ready
function setupModeListeners() {
    document.querySelectorAll('.mode-card').forEach(btn => {
        btn.addEventListener('click', () => startMode(btn.dataset.mode));
    });
    const backBtn = document.getElementById('btn-back-to-menu');
    if (backBtn) backBtn.addEventListener('click', showModeSelector);
    const roscoBackBtn = document.getElementById('rosco-back-btn');
    if (roscoBackBtn) roscoBackBtn.addEventListener('click', showModeSelector);
}

// ════════════════════════════════════════════
// Flashcard Game (Classic & Inverted)
// ════════════════════════════════════════════
function applyFlashcardMode(mode) {
    const frontFace = document.querySelector('.card__face--front');
    const backFace = document.querySelector('.card__face--back');

    if (mode === 'inverted') {
        // Front: word | Back: definition
        frontFace.dataset.mode = 'inverted';
        backFace.dataset.mode = 'inverted';
    } else {
        frontFace.dataset.mode = 'classic';
        backFace.dataset.mode = 'classic';
    }
}

function showNextCard() {
    const wasFlipped = card.classList.contains('flipped');
    card.classList.remove('flipped');
    gameControls.classList.add('hidden');
    if (wordsData.length === 0) return;

    if (shuffleQueue.length === 0) buildShuffleQueue();

    currentCardIndex = shuffleQueue.shift();
    lastPlayedIndex = currentCardIndex;
    const word = wordsData[currentCardIndex];

    const updateDOM = () => {
        if (currentMode === 'inverted') {
            // Front shows: word (big) + letter badge
            cardLetter.style.display = word.letter ? 'flex' : 'none';
            cardLetter.textContent = word.letter || '';
            cardRule.textContent = word.rule;
            const isContains = word.rule.toLowerCase().includes('contiene');
            cardRule.className = 'rule-text ' + (isContains ? 'rule-contains' : 'rule-starts');
            // Replace definition with word on front
            cardDefinition.textContent = word.word;
            cardDefinition.style.fontSize = '2.5rem';
            cardDefinition.style.fontWeight = '700';
            // Back shows: definition
            cardWord.textContent = '📖';
            cardWord.style.fontSize = '2rem';
            cardDefinitionBack.textContent = word.definition;
        } else {
            // Classic mode
            cardLetter.style.display = word.letter ? 'flex' : 'none';
            cardLetter.textContent = word.letter || '';
            cardRule.textContent = word.rule;
            const isContains = word.rule.toLowerCase().includes('contiene');
            cardRule.className = 'rule-text ' + (isContains ? 'rule-contains' : 'rule-starts');
            cardDefinition.textContent = word.definition;
            cardDefinition.style.fontSize = '';
            cardDefinition.style.fontWeight = '';
            cardWord.textContent = word.word;
            cardWord.style.fontSize = '';
            cardDefinitionBack.textContent = word.definition;
        }
    };

    if (wasFlipped) {
        cardDefinition.style.opacity = '0';
        cardRule.style.opacity = '0';
        cardLetter.style.opacity = '0';
        setTimeout(() => {
            updateDOM();
            cardDefinition.style.opacity = '1';
            cardRule.style.opacity = '1';
            cardLetter.style.opacity = '1';
        }, 400);
    } else {
        updateDOM();
        cardDefinition.style.opacity = '1';
        cardRule.style.opacity = '1';
        cardLetter.style.opacity = '1';
    }
}

function setupFlashcardListeners() {
    if (card) {
        card.addEventListener('click', () => {
            if (!card.classList.contains('flipped')) {
                card.classList.add('flipped');
                gameControls.classList.remove('hidden');
            }
        });
    }

    const btnCorrect = document.getElementById('btn-correct');
    const btnPractice = document.getElementById('btn-practice');
    const btnWrong = document.getElementById('btn-wrong');
    const btnResetStats = document.getElementById('btn-reset-stats');
    const btnReport = document.getElementById('btn-report');
    const authBtn = document.getElementById('auth-btn');

    if (btnCorrect) btnCorrect.addEventListener('click', (e) => { e.stopPropagation(); handleAnswer('correct'); });
    if (btnPractice) btnPractice.addEventListener('click', (e) => { e.stopPropagation(); handleAnswer('practice'); });
    if (btnWrong) btnWrong.addEventListener('click', (e) => { e.stopPropagation(); handleAnswer('wrong'); });

    if (btnResetStats) {
        btnResetStats.addEventListener('click', async (e) => {
            e.stopPropagation();
            const { isConfirmed } = await Swal.fire({
                title: '¿Resetear progreso?',
                text: 'Perderás todas las estadísticas. Esto no se puede deshacer.',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: 'var(--danger)',
                confirmButtonText: 'Sí, resetear',
                cancelButtonText: 'Cancelar'
            });
            if (isConfirmed) {
                userData.progress = {};
                userData.roscoBest = null;
                if (db && currentUser) {
                    try {
                        await window.firebaseFirestore.setDoc(
                            window.firebaseFirestore.doc(db, "users", currentUser),
                            { progress: {}, roscoBest: null, lastUpdated: new Date().toISOString() },
                            { merge: true }
                        );
                    } catch (e) { console.error("Firebase reset error:", e); }
                }
                localStorage.setItem('pasalapabra_progress_' + (currentUser || 'guest'), JSON.stringify(userData));
                updateStatsUI();
                shuffleQueue = [];
                lastPlayedIndex = -1;
                showNextCard();
                Swal.fire('Reseteado', 'Tu progreso ha sido reiniciado.', 'success');
            }
        });
    }

    if (btnReport) {
        btnReport.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (currentCardIndex < 0 || !wordsData[currentCardIndex]) return;
            const word = wordsData[currentCardIndex];
            const { value: issue } = await Swal.fire({
                title: 'Reportar palabra',
                text: `¿Qué ocurre con "${word.word}"?`,
                input: 'textarea',
                showCancelButton: true
            });
            if (issue) {
                if (db) {
                    try {
                        const reportId = `${word.id}_${Date.now()}`;
                        await window.firebaseFirestore.setDoc(
                            window.firebaseFirestore.doc(db, "reports", reportId),
                            { wordId: word.id, word: word.word, issue, reportedBy: currentUser || 'Invitado', timestamp: new Date().toISOString(), status: 'pending' }
                        );
                        Swal.fire('¡Gracias!', 'Reporte enviado.', 'success');
                    } catch (e) {
                        Swal.fire('Error', 'No se pudo enviar.', 'error');
                    }
                } else {
                    Swal.fire('Modo Local', 'Reporte simulado: ' + issue, 'info');
                }
            }
        });
    }

    if (authBtn) authBtn.addEventListener('click', handleAuth);
}

// ════════════════════════════════════════════
// ROSCO MODE
// ════════════════════════════════════════════
const SPANISH_ALPHABET = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'Ñ', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];

let roscoWords = [];  // [{letter, word, definition, rule, status}] status: 'pending'|'correct'|'wrong'|'skip'
let roscoCurrentIdx = 0;
let roscoTimerInterval = null;
let roscoSecondsElapsed = 0;
let roscoCorrect = 0;
let roscoWrong = 0;
let roscoSkipped = 0;
let roscoFinished = false;

function buildRoscoWords() {
    const letters = SPANISH_ALPHABET;
    const result = [];
    for (const letter of letters) {
        // Look for words that start with this letter (Empieza por) first
        const pool = wordsData.filter(w =>
            w.letter === letter && !pendingReportWordIds.has(w.id)
        );
        if (pool.length === 0) continue;
        const chosen = pool[Math.floor(Math.random() * pool.length)];
        result.push({ ...chosen, status: 'pending' });
    }
    return result;
}

function startRosco() {
    roscoWords = buildRoscoWords();
    roscoCurrentIdx = 0;
    roscoCorrect = 0;
    roscoWrong = 0;
    roscoSkipped = 0;
    roscoFinished = false;
    roscoSecondsElapsed = 0;

    drawRoscoWheel();
    updateRoscoStats();
    updateRoscoTimer();
    showCurrentRoscoQuestion();

    stopRoscoTimer();
    roscoTimerInterval = setInterval(() => {
        roscoSecondsElapsed++;
        updateRoscoTimer();
    }, 1000);
}

function stopRoscoTimer() {
    if (roscoTimerInterval) {
        clearInterval(roscoTimerInterval);
        roscoTimerInterval = null;
    }
}

function updateRoscoTimer() {
    const m = Math.floor(roscoSecondsElapsed / 60);
    const s = roscoSecondsElapsed % 60;
    const timerEl = document.getElementById('rosco-timer');
    if (timerEl) {
        timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
        timerEl.className = 'rosco-timer';
    }
}

function updateRoscoStats() {
    const cEl = document.getElementById('rosco-correct');
    const wEl = document.getElementById('rosco-wrong');
    const sEl = document.getElementById('rosco-skipped');
    if (cEl) cEl.textContent = roscoCorrect;
    if (wEl) wEl.textContent = roscoWrong;
    if (sEl) sEl.textContent = roscoSkipped;
}

function showCurrentRoscoQuestion() {
    if (roscoWords.length === 0) {
        endRosco('no-words');
        return;
    }

    // Find next pending word starting from current index
    let attempts = 0;
    while (roscoWords[roscoCurrentIdx].status !== 'pending' && attempts < roscoWords.length) {
        roscoCurrentIdx = (roscoCurrentIdx + 1) % roscoWords.length;
        attempts++;
    }

    // All done
    if (attempts >= roscoWords.length && roscoWords[roscoCurrentIdx].status !== 'pending') {
        endRosco('complete');
        return;
    }

    const w = roscoWords[roscoCurrentIdx];
    document.getElementById('rosco-center-letter').textContent = w.letter;
    document.getElementById('rosco-center-rule').textContent = w.rule;
    document.getElementById('rosco-question').textContent = w.definition;
    document.getElementById('rosco-answer').value = '';
    document.getElementById('rosco-answer').focus();

    highlightRoscoLetter(roscoCurrentIdx);
    lucide.createIcons();
}

function submitRoscoAnswer() {
    if (roscoFinished) return;
    const input = document.getElementById('rosco-answer');
    const answer = (input.value || '').trim().toUpperCase();
    if (!answer) return;

    const w = roscoWords[roscoCurrentIdx];
    const correct = w.word.toUpperCase();

    let delay = 600;

    if (answer === correct || levenshtein(answer, correct) <= 1) {
        roscoWords[roscoCurrentIdx].status = 'correct';
        roscoCorrect++;
        showRoscoFeedback(true, w.word);
    } else {
        roscoWords[roscoCurrentIdx].status = 'wrong';
        roscoWrong++;
        showRoscoFeedback(false, w.word);
        delay = 2000;
    }

    updateRoscoStats();
    drawRoscoWheel();
    input.value = '';

    // Check if all done
    const pending = roscoWords.filter(w => w.status === 'pending');
    if (pending.length === 0) {
        setTimeout(() => endRosco('complete'), delay);
        return;
    }

    // Move to next
    roscoCurrentIdx = (roscoCurrentIdx + 1) % roscoWords.length;
    setTimeout(() => showCurrentRoscoQuestion(), delay);
}

function roscoPassaWord() {
    if (roscoFinished) return;
    const w = roscoWords[roscoCurrentIdx];
    // Keep status as 'pending'
    roscoSkipped++;
    updateRoscoStats();

    // Instead of drawing wheel skipping the dot color, pending dots remain default color.
    // If we wanted them to look skipped but come back, we'd need a separate status like 'passed' 
    // that operates exactly like 'pending'. But let's just keep it simple: pending.
    drawRoscoWheel();

    const pending = roscoWords.filter(w => w.status === 'pending');
    if (pending.length === 0) {
        setTimeout(() => endRosco('complete'), 400);
        return;
    }

    // Find next pending
    let attempts = 0;
    do {
        roscoCurrentIdx = (roscoCurrentIdx + 1) % roscoWords.length;
        attempts++;
    } while (roscoWords[roscoCurrentIdx].status !== 'pending' && attempts < roscoWords.length);

    setTimeout(() => showCurrentRoscoQuestion(), 200);
}

function showRoscoFeedback(isCorrect, word) {
    const box = document.querySelector('.rosco-question-box');
    if (!box) return;
    const cls = isCorrect ? 'rosco-feedback-correct' : 'rosco-feedback-wrong';
    box.classList.add(cls);

    if (!isCorrect) {
        const textEl = document.getElementById('rosco-question');
        textEl.innerHTML = `<strong>¡Incorrecto!</strong> Era: <span style="text-transform: uppercase; color: #ef4444; font-weight: bold;">${word}</span>`;
    }

    setTimeout(() => box.classList.remove(cls), isCorrect ? 500 : 2000);
}

async function endRosco(reason) {
    roscoFinished = true;
    stopRoscoTimer();

    const total = roscoWords.length;
    const correct = roscoWords.filter(w => w.status === 'correct').length;
    const wrong = roscoWords.filter(w => w.status === 'wrong').length;
    const skip = roscoWords.filter(w => w.status === 'skip').length;
    const pending = roscoWords.filter(w => w.status === 'pending').length;
    const timeUsed = roscoSecondsElapsed;
    const mm = Math.floor(timeUsed / 60);
    const ss = timeUsed % 60;

    let icon = correct === total ? 'success' : wrong === 0 && pending === 0 ? 'info' : 'warning';
    let title = correct === total
        ? '🏆 ¡Rosco completado!'
        : '📊 Resultados del Rosco';

    // Track Personal Best
    let isNewBest = false;
    if (correct > 0) {
        if (!userData.roscoBest || correct > userData.roscoBest.correct || (correct === userData.roscoBest.correct && timeUsed < userData.roscoBest.time)) {
            userData.roscoBest = { correct, time: timeUsed };
            isNewBest = true;
            saveProgress();
        }
    }

    let pbHtml = '';
    if (userData.roscoBest) {
        const pbM = Math.floor(userData.roscoBest.time / 60);
        const pbS = userData.roscoBest.time % 60;
        pbHtml = `<div style="margin-top: 1rem; padding: 0.5rem; border: 1px dashed rgba(255,255,255,0.2); border-radius: 0.5rem;">
            ${isNewBest ? '<span style="color:#f59e0b; font-weight:bold;">¡Nuevo Récord Personal! 🌟</span><br>' : '<span style="color:#94a3b8; font-size:0.85rem;">Mejor marca personal:</span><br>'}
            <strong style="color:var(--text-main);">${userData.roscoBest.correct} correctas</strong> en ${pbM}:${String(pbS).padStart(2, '0')}
        </div>`;
    }

    await Swal.fire({
        title,
        icon,
        html: `
            <div style="text-align:center;font-family:'Outfit',sans-serif;">
                <div style="display:flex;justify-content:center;gap:1.5rem;margin:1rem 0;flex-wrap:wrap;">
                    <div style="background:rgba(16,185,129,0.15);border:1px solid #10b981;border-radius:1rem;padding:0.75rem 1.25rem;">
                        <div style="font-size:2rem;font-weight:700;color:#10b981">${correct}</div>
                        <div style="font-size:0.8rem;color:#94a3b8">Correctas</div>
                    </div>
                    <div style="background:rgba(239,68,68,0.15);border:1px solid #ef4444;border-radius:1rem;padding:0.75rem 1.25rem;">
                        <div style="font-size:2rem;font-weight:700;color:#ef4444">${wrong}</div>
                        <div style="font-size:0.8rem;color:#94a3b8">Errores</div>
                    </div>
                    <div style="background:rgba(245,158,11,0.15);border:1px solid #f59e0b;border-radius:1rem;padding:0.75rem 1.25rem;">
                        <div style="font-size:2rem;font-weight:700;color:#f59e0b">${skip}</div>
                        <div style="font-size:0.8rem;color:#94a3b8">Pasadas</div>
                    </div>
                </div>
                <p style="color:#94a3b8;font-size:0.9rem;margin-top:0.5rem">
                    Tiempo consumido: <strong>${mm}:${String(ss).padStart(2, '0')}</strong>
                </p>
                ${pbHtml}
            </div>`,
        confirmButtonText: 'Jugar de nuevo',
        showDenyButton: true,
        denyButtonText: 'Volver al menú',
        denyButtonColor: '#6366f1'
    }).then(result => {
        if (result.isDenied || result.isDismissed) {
            showModeSelector();
        } else {
            startRosco(); // restart rosco
        }
    });
}

// ── Rosco SVG Wheel ──────────────────────────────────
function drawRoscoWheel() {
    const svg = document.getElementById('rosco-svg');
    if (!svg || roscoWords.length === 0) return;

    svg.innerHTML = '';
    const cx = 200, cy = 200, r = 165, letterR = 185;
    const N = roscoWords.length;

    roscoWords.forEach((w, i) => {
        const angle = (2 * Math.PI * i / N) - Math.PI / 2;
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        const lx = cx + letterR * Math.cos(angle);
        const ly = cy + letterR * Math.sin(angle);

        // Circle
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', x);
        circle.setAttribute('cy', y);
        circle.setAttribute('r', 17);
        const isActive = (i === roscoCurrentIdx) && !roscoFinished;
        circle.setAttribute('fill',
            w.status === 'correct' ? '#10b981' :
                w.status === 'wrong' ? '#ef4444' :
                    isActive ? '#6366f1' :
                        'rgba(30,41,59,0.85)'
        );
        circle.setAttribute('stroke', isActive ? '#a5b4fc' : 'rgba(255,255,255,0.15)');
        circle.setAttribute('stroke-width', isActive ? '3' : '1.5');
        svg.appendChild(circle);

        // Letter text
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', x);
        text.setAttribute('y', y + 5);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', '13');
        text.setAttribute('font-weight', '700');
        text.setAttribute('font-family', 'Outfit, sans-serif');
        text.setAttribute('fill', 'white');
        text.textContent = w.letter;
        svg.appendChild(text);
    });
}

function highlightRoscoLetter(idx) {
    drawRoscoWheel(); // redraws with new active idx
}

function setupRoscoListeners() {
    const submitBtn = document.getElementById('rosco-submit');
    const answerIn = document.getElementById('rosco-answer');
    const passaBtn = document.getElementById('rosco-pasapalabra');

    if (submitBtn) submitBtn.addEventListener('click', submitRoscoAnswer);
    if (answerIn) {
        answerIn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitRoscoAnswer();
        });
    }
    if (passaBtn) passaBtn.addEventListener('click', roscoPassaWord);
}

// Levenshtein for near-match tolerance
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

// ════════════════════════════════════════════
// Data Fetching
// ════════════════════════════════════════════
function fetchWordsData() {
    return new Promise((resolve, reject) => {
        Papa.parse(SPREADSHEET_URL, {
            download: true,
            header: true,
            complete: function (results) {
                const data = results.data.filter(row => Object.keys(row).length > 1);
                wordsData = data.map((row, index) => {
                    let values = Object.values(row);
                    let letter = '', word = '', definition = '', rule = '';
                    if (/^\d+$/.test(String(values[0]).trim())) {
                        letter = values[1] || '';
                        rule = values[2] || 'Empieza por';
                        definition = values[3] || '';
                        word = values[4] || '';
                    } else {
                        letter = values[0] || '';
                        rule = values[1] || 'Empieza por';
                        definition = values[2] || '';
                        word = values[3] || '';
                    }
                    if (/^\d+$/.test(String(letter).trim())) letter = values[1];
                    return {
                        id: `word_${index}`,
                        letter: String(letter || '').trim().toUpperCase(),
                        word: String(word || '').trim(),
                        definition: String(definition || '').trim(),
                        rule: String(rule || 'Empieza por').trim()
                    };
                }).filter(w => w.word !== '');
                resolve(wordsData);
            },
            error: function (error) { reject(error); }
        });
    });
}

// ════════════════════════════════════════════
// Progress Tracking
// ════════════════════════════════════════════
function loadLocalProgress() {
    const saved = localStorage.getItem('pasalapabra_progress_' + (currentUser || 'guest'));
    if (saved) { userData = JSON.parse(saved); updateStatsUI(); }
}

async function loadFirebaseProgress() {
    if (!db || !currentUser) return false;
    try {
        const docRef = window.firebaseFirestore.doc(db, "users", currentUser);
        const docSnap = await window.firebaseFirestore.getDoc(docRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            userData.progress = data.progress || {};
            userData.roscoBest = data.roscoBest || null;
            updateStatsUI();
            return true;
        }
    } catch (e) { console.error("Error al cargar desde Firebase", e); }
    loadLocalProgress();
    return false;
}

async function saveProgress() {
    localStorage.setItem('pasalapabra_progress_' + (currentUser || 'guest'), JSON.stringify(userData));
    updateStatsUI();
    if (db && currentUser) {
        try {
            await window.firebaseFirestore.setDoc(
                window.firebaseFirestore.doc(db, "users", currentUser),
                { progress: userData.progress, roscoBest: userData.roscoBest, lastUpdated: new Date().toISOString() },
                { merge: true }
            );
        } catch (e) { console.error("Error al guardar en Firebase", e); }
    }
}

async function loadPendingReports() {
    if (!db) return;
    try {
        const { getDocs, collection } = window.firebaseFirestore;
        const snap = await getDocs(collection(db, 'reports'));
        pendingReportWordIds.clear();
        snap.forEach(d => {
            const data = d.data();
            if (data.status === 'pending') pendingReportWordIds.add(data.wordId);
        });
    } catch (e) { console.error('Error loading pending reports:', e); }
}

async function showAdminPanel() {
    if (!db) { Swal.fire('Sin conexión', 'El panel de admin requiere Firebase activo.', 'warning'); return; }
    Swal.fire({ title: 'Cargando reportes...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    let reports = [];
    try {
        const { getDocs, collection } = window.firebaseFirestore;
        const snap = await getDocs(collection(db, 'reports'));
        snap.forEach(d => {
            const data = d.data();
            if (data.status === 'pending') reports.push({ id: d.id, ...data });
        });
    } catch (e) {
        Swal.fire('Error', 'No se pudieron cargar los reportes.', 'error');
        showModeSelector();
        return;
    }
    Swal.close();
    if (reports.length === 0) {
        await Swal.fire({ icon: 'success', title: '¡Todo limpio!', text: 'No hay reportes pendientes.', confirmButtonText: 'Ir al juego' });
        showModeSelector();
        return;
    }
    for (let i = 0; i < reports.length; i++) {
        const r = reports[i];
        const reportDate = r.timestamp ? new Date(r.timestamp).toLocaleString('es-ES') : '—';
        const result = await Swal.fire({
            title: `<span style="font-size:1rem;opacity:0.6">Reporte ${i + 1} de ${reports.length}</span>`,
            html: `<div style="text-align:left;line-height:1.8;">
                <p><strong>🔤 Palabra:</strong> <code style="font-size:1.1rem;font-weight:700">${r.word || '—'}</code></p>
                <p><strong>⚠️ Problema:</strong></p>
                <blockquote style="background:rgba(255,255,255,0.05);border-left:3px solid #ef4444;padding:0.5rem 0.75rem;border-radius:4px;margin:0.25rem 0;">${r.issue}</blockquote>
                <p style="font-size:0.8rem;opacity:0.6;margin-top:0.5rem">👤 Por <strong>${r.reportedBy}</strong> · ${reportDate}</p>
            </div>`,
            showCancelButton: true,
            confirmButtonColor: '#10b981',
            cancelButtonColor: '#6b7280',
            confirmButtonText: '✅ Resuelto',
            cancelButtonText: '⏭ Siguiente',
            allowOutsideClick: false
        });
        if (result.isConfirmed) {
            try {
                await window.firebaseFirestore.setDoc(
                    window.firebaseFirestore.doc(db, 'reports', r.id),
                    { status: 'resolved', resolvedBy: 'ADMIN', resolvedAt: new Date().toISOString() },
                    { merge: true }
                );
                pendingReportWordIds.delete(r.wordId);
                shuffleQueue = [];
            } catch (e) { Swal.fire('Error', 'No se pudo actualizar.', 'error'); }
        }
    }
    await Swal.fire({ icon: 'info', title: 'Revisión completada', timer: 2000, showConfirmButton: false });
    showModeSelector();
}

// ════════════════════════════════════════════
// Stats UI
// ════════════════════════════════════════════
function updateStatsUI() {
    let learnedCount = 0, practicingCount = 0;
    Object.values(userData.progress).forEach(item => {
        if (item.status === 'learned') learnedCount++;
        else practicingCount++;
    });
    const lc = document.getElementById('stat-learned-count');
    const pc = document.getElementById('stat-learning-count');
    const pb = document.getElementById('progress-bar');
    if (lc) lc.textContent = learnedCount;
    if (pc) pc.textContent = practicingCount;
    if (pb && wordsData.length > 0) {
        pb.style.width = `${Math.min((learnedCount / wordsData.length) * 100, 100)}%`;
    }
}

function handleAnswer(status) {
    const word = wordsData[currentCardIndex];
    if (!word) return;
    const today = new Date().toISOString().split('T')[0];
    if (!userData.progress[word.id]) {
        userData.progress[word.id] = { correctCount: 0, daysPlayed: [], status: 'learning' };
    }
    const p = userData.progress[word.id];
    if (status === 'correct') {
        p.correctCount++;
        if (!p.daysPlayed.includes(today)) p.daysPlayed.push(today);
        if (p.correctCount >= 10 || p.daysPlayed.length >= 5) p.status = 'learned';
        else p.status = 'practicing';
    } else if (status === 'practice') {
        p.status = 'practicing';
    } else {
        p.status = 'learning';
    }
    saveProgress();
    gameControls.classList.add('hidden');
    setTimeout(() => showNextCard(), 600);
}

// ════════════════════════════════════════════
// Auth Logic
// ════════════════════════════════════════════
function updateUIForUser() {
    const statusEl = document.getElementById('user-status');
    const authBtn = document.getElementById('auth-btn');
    if (currentUser) {
        statusEl.innerHTML = `<i data-lucide="user" style="width: 16px; height: 16px;"></i> ${currentUser}`;
        authBtn.textContent = 'Cerrar Sesión';
        authBtn.classList.remove('btn-outline');
    } else {
        statusEl.innerHTML = `Invitado`;
        authBtn.textContent = 'Iniciar Sesión';
        authBtn.classList.add('btn-outline');
    }
    lucide.createIcons();
}

async function promptLogin() {
    let username = '';
    while (!username.trim()) {
        const result = await Swal.fire({
            title: '👋 ¡Bienvenido/a!',
            text: 'Introduce tu nombre para empezar a jugar.',
            input: 'text',
            inputPlaceholder: 'Tu nombre o alias...',
            confirmButtonText: 'Empezar',
            allowOutsideClick: false,
            allowEscapeKey: false,
            inputValidator: (value) => {
                if (!value || !value.trim()) return '¡Necesitas un nombre para continuar!';
            }
        });
        username = result.value || '';
    }
    currentUser = username.trim();
    localStorage.setItem('pasalapabra_current_user', currentUser);
    updateUIForUser();
}

async function handleAuth() {
    if (currentUser) {
        currentUser = null;
        localStorage.removeItem('pasalapabra_current_user');
        userData = { progress: {}, roscoBest: null };
        updateUIForUser();
        await promptLogin();
        if (currentUser === 'ADMIN') {
            const ok = await verifyAdminPassword();
            if (ok) { await showAdminPanel(); return; }
        }
        if (db) {
            await loadFirebaseProgress();
            await loadPendingReports();
            shuffleQueue = [];
        } else {
            loadLocalProgress();
        }
        updateStatsUI();
        showModeSelector();
        return;
    }

    const { value: username } = await Swal.fire({
        title: 'Iniciar Sesión',
        input: 'text',
        inputPlaceholder: 'Ej. jugador123 (o ADMIN)',
        confirmButtonText: 'Entrar',
        showCancelButton: true
    });

    if (username && username.trim() !== '') {
        currentUser = username.trim();
        localStorage.setItem('pasalapabra_current_user', currentUser);
        updateUIForUser();

        if (currentUser === 'ADMIN') {
            const ok = await verifyAdminPassword();
            if (!ok) {
                const result2 = await Swal.fire({ title: 'Iniciar Sesión', input: 'text', inputPlaceholder: 'Tu nombre...', confirmButtonText: 'Entrar', showCancelButton: true });
                if (result2.value && result2.value.trim()) {
                    currentUser = result2.value.trim();
                    localStorage.setItem('pasalapabra_current_user', currentUser);
                    updateUIForUser();
                } else return;
            } else {
                await showAdminPanel();
                return;
            }
        }

        userData = { progress: {}, roscoBest: null };
        if (db) {
            Swal.fire({ title: 'Cargando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            await loadFirebaseProgress();
            await loadPendingReports();
            Swal.close();
            shuffleQueue = [];
        } else {
            loadLocalProgress();
        }
        updateStatsUI();
        showModeSelector();
    }
}

// ════════════════════════════════════════════
// Boot
// ════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    setupModeListeners();
    init();
});
