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
        // 1. Fetch Data
        await fetchWordsData();

        console.log("Loaded", wordsData.length, "words.");

        // 2. Load Progress
        if (db && currentUser) {
            await loadFirebaseProgress();
        } else {
            loadLocalProgress();
        }

        // 3. Start Game
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

                    // Comprobación robusta por si hay o no ID en la primera columna
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

                    // Salvavidas por si la letra mapeada es un número (evita "39")
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
    loadLocalProgress(); // Fallback
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

// --- Game Logic ---

function showNextCard() {
    // Reset Card State
    card.classList.remove('flipped');
    gameControls.classList.add('hidden');

    if (wordsData.length === 0) {
        cardRule.textContent = "Error";
        cardDefinition.textContent = "No logramos cargar las palabras. Verifica tu conexión o el enlace.";
        cardWord.textContent = "Error";
        cardLetter.style.display = 'none';
        return;
    }

    // Pick next card using Spaced Repetition Logic
    const learningPool = [];
    const practicingPool = [];
    const learnedPool = [];

    wordsData.forEach((w, index) => {
        const p = userData.progress[w.id];
        if (!p || p.status === 'learning') {
            learningPool.push(index);
        } else if (p.status === 'practicing') {
            practicingPool.push(index);
        } else {
            learnedPool.push(index);
        }
    });

    // Weight: 60% Learning, 30% Practicing, 10% Learned
    const rand = Math.random();
    let targetPool = learningPool;

    if (rand < 0.6 && learningPool.length > 0) {
        targetPool = learningPool;
    } else if (rand < 0.9 && practicingPool.length > 0) {
        targetPool = practicingPool;
    } else if (learnedPool.length > 0) {
        targetPool = learnedPool;
    } else if (learningPool.length > 0) {
        targetPool = learningPool;
    } else {
        targetPool = practicingPool;
    }

    // Fallback if somehow empty
    if (targetPool.length === 0) {
        targetPool = [Math.floor(Math.random() * wordsData.length)];
    }

    // Pick random from target pool
    currentCardIndex = targetPool[Math.floor(Math.random() * targetPool.length)];
    const word = wordsData[currentCardIndex];

    // Update DOM
    if (!word.letter) {
        cardLetter.style.display = 'none';
    } else {
        cardLetter.style.display = 'flex';
        cardLetter.textContent = word.letter;
    }

    cardRule.textContent = word.rule;
    cardDefinition.textContent = word.definition;

    cardWord.textContent = word.word;
    cardDefinitionBack.textContent = word.definition;
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

    // Update Progress bar roughly
    if (wordsData.length > 0) {
        const perc = (learnedCount / wordsData.length) * 100;
        document.getElementById('progress-bar').style.width = `${Math.min(perc, 100)}%`;
    }
}

function handleAnswer(status) {
    const word = wordsData[currentCardIndex];
    const today = new Date().toISOString().split('T')[0];

    if (!userData.progress[word.id]) {
        userData.progress[word.id] = { correctCount: 0, daysPlayed: [], status: 'learning' };
    }

    const p = userData.progress[word.id];

    if (status === 'correct') {
        p.correctCount++;
        if (!p.daysPlayed.includes(today)) {
            p.daysPlayed.push(today);
        }

        // Graduation Logic: 10 times OR 5 different days
        if (p.correctCount >= 10 || p.daysPlayed.length >= 5) {
            p.status = 'learned';
        } else {
            p.status = 'practicing';
        }
    } else if (status === 'practice') {
        p.status = 'practicing';
    } else {
        p.status = 'learning'; // Reset to learning priority
    }

    saveProgress();
    showNextCard();
}

// --- Event Listeners ---

card.addEventListener('click', () => {
    if (!card.classList.contains('flipped')) {
        card.classList.add('flipped');
        gameControls.classList.remove('hidden');
    }
});

document.getElementById('btn-correct').addEventListener('click', () => handleAnswer('correct'));
document.getElementById('btn-practice').addEventListener('click', () => handleAnswer('practice'));
document.getElementById('btn-wrong').addEventListener('click', () => handleAnswer('wrong'));

// Report Button
document.getElementById('btn-report').addEventListener('click', async () => {
    if (currentCardIndex < 0 || !wordsData[currentCardIndex]) return;
    const word = wordsData[currentCardIndex];

    const { value: issue } = await Swal.fire({
        title: 'Reportar palabra',
        text: `¿Qué ocurre con la palabra "${word.word}"?`,
        input: 'textarea',
        inputPlaceholder: 'Ej. La definición está incompleta, hay una falta de ortografía...',
        showCancelButton: true,
        confirmButtonText: 'Enviar reporte',
        cancelButtonText: 'Cancelar'
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
                        definition: word.definition,
                        issue: issue,
                        reportedBy: currentUser || 'Invitado',
                        timestamp: new Date().toISOString(),
                        status: 'pending' // ADMIN will change this
                    }
                );
                Swal.fire('¡Gracias!', 'El "ADMIN" revisará el reporte pronto.', 'success');
            } catch (e) {
                console.error(e);
                Swal.fire('Error', 'No se pudo enviar el reporte revisa el log de consola.', 'error');
            }
        } else {
            Swal.fire('Modo Local', 'El reporte no se enviará porque aún no has configurado Firebase en app.js. Reporte simulado: ' + issue, 'info');
        }
    }
});

// Auth Logic
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

document.getElementById('auth-btn').addEventListener('click', async () => {
    if (currentUser) {
        // Logout
        currentUser = null;
        localStorage.removeItem('pasapalabra_current_user');
        userData = { progress: {} };
        loadLocalProgress();
        updateUIForUser();
        showNextCard();
        return;
    }

    // Login
    const { value: username } = await Swal.fire({
        title: 'Iniciar Sesión',
        input: 'text',
        inputLabel: 'Tu nombre de usuario',
        inputPlaceholder: 'Ej. jugador123',
        showCancelButton: true,
        confirmButtonText: 'Entrar',
        cancelButtonText: 'Cancelar'
    });

    if (username && username.trim() !== '') {
        currentUser = username.trim();
        localStorage.setItem('pasapalabra_current_user', currentUser);
        updateUIForUser();

        userData = { progress: {} };
        if (db) {
            Swal.fire({ title: 'Cargando tu progreso...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            await loadFirebaseProgress();
            Swal.close();
        } else {
            loadLocalProgress();
        }

        updateStatsUI();
        showNextCard();
    }
});

// Boot
document.addEventListener('DOMContentLoaded', init);
