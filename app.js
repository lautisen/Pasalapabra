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
let currentUser = localStorage.getItem('pasapalabra_current_user') || null;

function initFirebase() {
    try {
        const app = window.firebaseApp(firebaseConfig);
        db = window.firebaseFirestore.getFirestore(app);

        // Setup Analytics if measurementId exists
        if (window.firebaseAnalytics && firebaseConfig.measurementId) {
            analytics = window.firebaseAnalytics(app);
        }

        console.log("Firebase inicializado correctamente.");
    } catch (e) {
        console.error("Error inicializando Firebase:", e);
    }
}

// Global State
let wordsData = [];
let currentCardIndex = -1;
let userData = {
    progress: {} // { wordId: { correctCount: 0, daysPlayed: [], status: 'learning' } }
};
// Shuffle queue: words are played in shuffled order, never repeating until all have been seen
let shuffleQueue = [];  // indices into wordsData
let lastPlayedIndex = -1;

// Set of wordIds with pending reports — excluded from the shuffle queue
let pendingReportWordIds = new Set();

function fisherYates(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function buildShuffleQueue() {
    // Build weighted pool: learning x3, practicing x2, learned x1
    // Words with pending reports are excluded
    const weighted = [];
    wordsData.forEach((w, idx) => {
        if (pendingReportWordIds.has(w.id)) return; // skip reported words
        const p = userData.progress[w.id];
        const status = p ? p.status : 'learning';
        const weight = status === 'learning' ? 3 : status === 'practicing' ? 2 : 1;
        for (let i = 0; i < weight; i++) weighted.push(idx);
    });
    if (weighted.length === 0) {
        // Fallback: all words are reported — include everything
        wordsData.forEach((_, idx) => weighted.push(idx));
    }
    let q = fisherYates(weighted);
    while (q.length > 1 && q[0] === lastPlayedIndex) {
        q = fisherYates(weighted);
    }
    shuffleQueue = q;
    console.log(`Queue rebuilt: ${shuffleQueue.length} slots for ${wordsData.length} words (${pendingReportWordIds.size} excluded).`);
}

// DOM Elements
const loader = document.getElementById('loader');
const gameContainer = document.getElementById('game-container');
const card = document.getElementById('flashcard');
const gameControls = document.getElementById('game-controls');

const cardLetter = document.getElementById('card-letter');
const cardRule = document.getElementById('card-rule');
const cardDefinition = document.getElementById('card-definition');
const cardWord = document.getElementById('card-word');
const cardDefinitionBack = document.getElementById('card-definition-back');

// Initialize Icons
lucide.createIcons();

// --- Initialization ---

async function init() {
    try {
        initFirebase();
        updateUIForUser();

        console.log("Fetching CSV...");
        // 1. Fetch Data (do first so login screen appears while data loads)
        await fetchWordsData();

        console.log("Loaded", wordsData.length, "words.");

        // 2. Require login before playing
        if (!currentUser) {
            await promptLogin();
            // If ADMIN logged in, promptLogin handles the flow separately
            if (currentUser === 'ADMIN') {
                loader.classList.add('hidden');
                gameContainer.classList.remove('hidden');
                await loadPendingReports();
                setupEventListeners();
                await showAdminPanel();
                return;
            }
        }

        // 3. Load Progress
        if (db && currentUser) {
            await loadFirebaseProgress();
        } else {
            loadLocalProgress();
        }

        // 4. Load pending reports (exclude flagged words from queue)
        await loadPendingReports();

        // 5. Setup Events
        setupEventListeners();

        // 6. Start Game
        showNextCard();

        // Show UI
        loader.classList.add('hidden');
        gameContainer.classList.remove('hidden');
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
    localStorage.setItem('pasapalabra_current_user', currentUser);
    updateUIForUser();
}

function setupEventListeners() {
    console.log("Configurando event listeners...");

    // Card Flip
    if (card) {
        card.addEventListener('click', () => {
            if (!card.classList.contains('flipped')) {
                card.classList.add('flipped');
                gameControls.classList.remove('hidden');
            }
        });
    }

    // Answer Buttons
    const btnCorrect = document.getElementById('btn-correct');
    const btnPractice = document.getElementById('btn-practice');
    const btnWrong = document.getElementById('btn-wrong');
    const btnResetStats = document.getElementById('btn-reset-stats');
    const btnReport = document.getElementById('btn-report');
    const authBtn = document.getElementById('auth-btn');

    if (btnCorrect) btnCorrect.addEventListener('click', (e) => { e.stopPropagation(); handleAnswer('correct'); });
    if (btnPractice) btnPractice.addEventListener('click', (e) => { e.stopPropagation(); handleAnswer('practice'); });
    if (btnWrong) btnWrong.addEventListener('click', (e) => { e.stopPropagation(); handleAnswer('wrong'); });

    // Reset Button
    if (btnResetStats) {
        btnResetStats.addEventListener('click', async (e) => {
            e.stopPropagation();
            console.log("Reset clicked");
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
                if (db && currentUser) {
                    try {
                        await window.firebaseFirestore.setDoc(
                            window.firebaseFirestore.doc(db, "users", currentUser),
                            { progress: {}, lastUpdated: new Date().toISOString() },
                            { merge: true }
                        );
                    } catch (e) {
                        console.error("Firebase reset error:", e);
                    }
                }
                localStorage.setItem('pasapalabra_progress_' + (currentUser || 'guest'), JSON.stringify(userData));
                updateStatsUI();
                shuffleQueue = [];
                lastPlayedIndex = -1;
                showNextCard();
                Swal.fire('Reseteado', 'Tu progreso ha sido reiniciado.', 'success');
            }
        });
    }

    // Report Button
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
                            {
                                wordId: word.id,
                                word: word.word,
                                issue: issue,
                                reportedBy: currentUser || 'Invitado',
                                timestamp: new Date().toISOString(),
                                status: 'pending'
                            }
                        );
                        Swal.fire('¡Gracias!', 'Reporte enviado.', 'success');
                    } catch (e) {
                        console.error(e);
                        Swal.fire('Error', 'No se pudo enviar.', 'error');
                    }
                } else {
                    Swal.fire('Modo Local', 'Reporte simulado: ' + issue, 'info');
                }
            }
        });
    }

    // Auth Button
    if (authBtn) {
        authBtn.addEventListener('click', handleAuth);
    }
}

// --- Data Fetching ---

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

                    if (/^\d+$/.test(String(letter).trim())) {
                        letter = values[1];
                    }

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
            error: function (error) {
                console.error("PapaParse error:", error);
                reject(error);
            }
        });
    });
}

// --- Progress Tracking ---

function loadLocalProgress() {
    const saved = localStorage.getItem('pasapalabra_progress_' + (currentUser || 'guest'));
    if (saved) {
        userData = JSON.parse(saved);
        updateStatsUI();
    }
}

async function loadFirebaseProgress() {
    if (!db || !currentUser) return false;
    try {
        const docRef = window.firebaseFirestore.doc(db, "users", currentUser);
        const docSnap = await window.firebaseFirestore.getDoc(docRef);
        if (docSnap.exists()) {
            userData.progress = docSnap.data().progress || {};
            updateStatsUI();
            return true;
        }
    } catch (e) {
        console.error("Error al cargar desde Firebase", e);
    }
    loadLocalProgress();
    return false;
}

async function saveProgress() {
    localStorage.setItem('pasapalabra_progress_' + (currentUser || 'guest'), JSON.stringify(userData));
    updateStatsUI();

    if (db && currentUser) {
        try {
            await window.firebaseFirestore.setDoc(
                window.firebaseFirestore.doc(db, "users", currentUser),
                { progress: userData.progress, lastUpdated: new Date().toISOString() },
                { merge: true }
            );
        } catch (e) {
            console.error("Error al guardar en Firebase", e);
        }
    }
}

async function loadPendingReports() {
    if (!db) return;
    try {
        const { getDocs, collection } = window.firebaseFirestore;
        // Get ALL reports and filter client-side to avoid needing a Firestore index
        const snap = await getDocs(collection(db, 'reports'));
        pendingReportWordIds.clear();
        snap.forEach(d => {
            const data = d.data();
            if (data.status === 'pending') pendingReportWordIds.add(data.wordId);
        });
        console.log(`Pending reports loaded: ${pendingReportWordIds.size} word(s) excluded.`);
    } catch (e) {
        console.error('Error loading pending reports:', e);
    }
}

async function showAdminPanel() {
    if (!db) {
        Swal.fire('Sin conexión', 'El panel de admin requiere Firebase activo.', 'warning');
        return;
    }
    Swal.fire({ title: 'Cargando reportes...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    let reports = [];
    try {
        const { getDocs, collection } = window.firebaseFirestore;
        // Fetch all and filter client-side to avoid needing a Firestore composite index
        const snap = await getDocs(collection(db, 'reports'));
        snap.forEach(d => {
            const data = d.data();
            if (data.status === 'pending') reports.push({ id: d.id, ...data });
        });
    } catch (e) {
        console.error('Error loading reports for admin:', e);
        Swal.fire('Error', 'No se pudieron cargar los reportes. Revisa la consola.', 'error');
        showNextCard();
        return;
    }
    Swal.close();

    if (reports.length === 0) {
        await Swal.fire({
            icon: 'success',
            title: '¡Todo limpio!',
            text: 'No hay reportes pendientes.',
            confirmButtonText: 'Ir al juego'
        });
        showNextCard();
        return;
    }

    // Review each report one by one
    for (let i = 0; i < reports.length; i++) {
        const r = reports[i];
        const reportDate = r.timestamp ? new Date(r.timestamp).toLocaleString('es-ES') : '—';

        const result = await Swal.fire({
            title: `<span style="font-size:1rem;opacity:0.6">Reporte ${i + 1} de ${reports.length}</span>`,
            html: `
                <div style="text-align:left;line-height:1.8;">
                    <p><strong>🔤 Palabra:</strong> <code style="font-size:1.1rem;font-weight:700">${r.word || '—'}</code></p>
                    <p><strong>📖 Definición:</strong> ${r.definition || '—'}</p>
                    <hr style="margin:0.75rem 0;opacity:0.2">
                    <p><strong>⚠️ Problema reportado:</strong></p>
                    <blockquote style="background:rgba(255,255,255,0.05);border-left:3px solid #ef4444;padding:0.5rem 0.75rem;border-radius:4px;margin:0.25rem 0;">${r.issue}</blockquote>
                    <p style="font-size:0.8rem;opacity:0.6;margin-top:0.5rem">👤 Reportado por <strong>${r.reportedBy}</strong> · ${reportDate}</p>
                </div>`,
            showCancelButton: true,
            confirmButtonColor: '#10b981',
            cancelButtonColor: '#6b7280',
            confirmButtonText: '✅ Resuelto',
            cancelButtonText: '⏭ Siguiente',
            allowOutsideClick: false
        });

        if (result.isConfirmed) {
            // Mark as resolved in Firestore
            try {
                await window.firebaseFirestore.setDoc(
                    window.firebaseFirestore.doc(db, 'reports', r.id),
                    { status: 'resolved', resolvedBy: 'ADMIN', resolvedAt: new Date().toISOString() },
                    { merge: true }
                );
                pendingReportWordIds.delete(r.wordId);
                // Flush queue so the word can re-appear
                shuffleQueue = [];
            } catch (e) {
                console.error('Error resolving report:', e);
                Swal.fire('Error', 'No se pudo actualizar el reporte.', 'error');
            }
        }
    }

    await Swal.fire({ icon: 'info', title: 'Revisión completada', text: 'Puedes seguir jugando.', timer: 2000, showConfirmButton: false });
    showNextCard();
}

// --- Game Logic ---

function showNextCard() {
    const wasFlipped = card.classList.contains('flipped');
    card.classList.remove('flipped');
    gameControls.classList.add('hidden');

    if (wordsData.length === 0) return;

    // Rebuild queue when empty
    if (shuffleQueue.length === 0) {
        buildShuffleQueue();
    }

    currentCardIndex = shuffleQueue.shift();
    lastPlayedIndex = currentCardIndex;
    const word = wordsData[currentCardIndex];


    const updateDOM = () => {
        cardLetter.style.display = word.letter ? 'flex' : 'none';
        cardLetter.textContent = word.letter || '';
        cardRule.textContent = word.rule;
        // Colour-code the rule pill: 'Contiene' → amber, everything else (Empieza) → green
        const isContains = word.rule.toLowerCase().includes('contiene');
        cardRule.className = 'rule-text ' + (isContains ? 'rule-contains' : 'rule-starts');
        cardDefinition.textContent = word.definition;
        cardWord.textContent = word.word;
        cardDefinitionBack.textContent = word.definition;
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

function updateStatsUI() {
    let learnedCount = 0;
    let practicingCount = 0;

    Object.values(userData.progress).forEach(item => {
        if (item.status === 'learned') learnedCount++;
        else practicingCount++;
    });

    document.getElementById('stat-learned-count').textContent = learnedCount;
    document.getElementById('stat-learning-count').textContent = practicingCount;

    if (wordsData.length > 0) {
        const perc = (learnedCount / wordsData.length) * 100;
        document.getElementById('progress-bar').style.width = `${Math.min(perc, 100)}%`;
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
    setTimeout(() => { showNextCard(); }, 600);
}

// --- Auth Logic ---

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

async function handleAuth() {
    if (currentUser) {
        // Logout → clear session and re-prompt (login is mandatory)
        currentUser = null;
        localStorage.removeItem('pasapalabra_current_user');
        userData = { progress: {} };
        updateUIForUser();
        await promptLogin();
        // After re-login, if ADMIN go to admin panel
        if (currentUser === 'ADMIN') {
            await showAdminPanel();
            return;
        }
        if (db) {
            await loadFirebaseProgress();
            await loadPendingReports();
            shuffleQueue = [];
        } else {
            loadLocalProgress();
        }
        updateStatsUI();
        showNextCard();
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
        localStorage.setItem('pasapalabra_current_user', currentUser);
        updateUIForUser();

        // --- ADMIN MODE ---
        if (currentUser === 'ADMIN') {
            await showAdminPanel();
            return;
        }

        // --- Regular user ---
        userData = { progress: {} };
        if (db) {
            Swal.fire({ title: 'Cargando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            await loadFirebaseProgress();
            await loadPendingReports(); // refresh exclusions after login
            Swal.close();
            // Flush queue so exclusions take effect immediately
            shuffleQueue = [];
        } else {
            loadLocalProgress();
        }
        updateStatsUI();
        showNextCard();
    }
}

document.addEventListener('DOMContentLoaded', init);
