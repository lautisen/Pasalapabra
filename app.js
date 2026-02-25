const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTwNPNMY-W9MhaO0M_mr5XN5sHbDn6vROm6kEjDk23q0hhSXmR5oOaDu9Byz6fv-VATaQ207ScuUede/pub?gid=0&single=true&output=csv';

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
        console.log("Fetching CSV...");
        // 1. Fetch Data
        await fetchWordsData();

        console.log("Loaded", wordsData.length, "words.");

        // 2. Load Local Progress (we will add Firebase later)
        loadLocalProgress();

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
                    const keys = Object.keys(row);
                    // Expected columns: ID, Letter, Rule, Definition, Word
                    // Based on spreadsheet: ID, L, T, D, R
                    let letter = '', word = '', definition = '', rule = '';

                    if (keys.length >= 5) {
                        letter = row[keys[1]];
                        rule = row[keys[2]];
                        definition = row[keys[3]];
                        word = row[keys[4]];
                    } else if (keys.length === 4) {
                        // fallback if no ID column
                        letter = row[keys[0]];
                        word = row[keys[1]];
                        definition = row[keys[2]];
                        rule = row[keys[3]];
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

// --- Progress Tracking (Local Storage for now) ---

function loadLocalProgress() {
    const saved = localStorage.getItem('pasapalabra_progress');
    if (saved) {
        userData = JSON.parse(saved);
        updateStatsUI();
    }
}

function saveProgress() {
    localStorage.setItem('pasapalabra_progress', JSON.stringify(userData));
    updateStatsUI();
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

// Boot
document.addEventListener('DOMContentLoaded', init);
