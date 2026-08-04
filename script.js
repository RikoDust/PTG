/* =========================================================
   QuizMaster — script.js
   Gère : chargement des questions, sélection d'un QCM de 20
   questions (thèmes équilibrés + jamais 2x le même thème à la
   suite + jamais 2x la même question), le déroulé du QCM,
   les statistiques (localStorage).
   ========================================================= */

const STORAGE_KEY = "quizmaster_stats_v1";
const QUESTIONS_PER_QUIZ = 20;

/* ---------- État global ---------- */
let allQuestions = [];
let currentQuiz = [];      // les 20 questions de la session en cours
let currentIndex = 0;      // index de la question affichée
let currentCorrectCount = 0;
let hasAnsweredCurrent = false;

/* =========================================================
   1. STATISTIQUES (localStorage)
   ========================================================= */

function loadStats() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return { totalCorrect: 0, totalQuestions: 0 };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      totalCorrect: parsed.totalCorrect || 0,
      totalQuestions: parsed.totalQuestions || 0
    };
  } catch (e) {
    return { totalCorrect: 0, totalQuestions: 0 };
  }
}

function saveStats(stats) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
}

function getGlobalScoreOn100(stats) {
  if (stats.totalQuestions === 0) return null;
  return Math.round((stats.totalCorrect / stats.totalQuestions) * 100);
}

/* Met à jour les stats globales à la fin d'un QCM complet */
function registerQuizResult(correctCount, totalQuestionsInQuiz) {
  const stats = loadStats();
  stats.totalCorrect += correctCount;
  stats.totalQuestions += totalQuestionsInQuiz;
  saveStats(stats);
  return stats;
}

/* =========================================================
   2. SÉLECTION DES 20 QUESTIONS DU QCM
   ========================================================= */

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* Regroupe les questions par thème */
function groupByCategory(questions) {
  const groups = {};
  questions.forEach(q => {
    if (!groups[q.category]) groups[q.category] = [];
    groups[q.category].push(q);
  });
  return groups;
}

/*
  Choisit QUESTIONS_PER_QUIZ questions en répartissant le nombre
  de manière la plus égale possible entre chaque thème disponible.
  Si un thème n'a pas assez de questions, le manque est réparti
  sur les autres thèmes.
*/
function pickBalancedQuestions(questions, total) {
  const groups = groupByCategory(questions);
  const categories = shuffleArray(Object.keys(groups));
  const n = categories.length;

  const base = Math.floor(total / n);
  let remainder = total % n;

  // quota initial par thème
  const quota = {};
  categories.forEach(cat => { quota[cat] = base; });
  // distribue le reste aléatoirement (1 question de plus) sur des thèmes différents
  for (let i = 0; i < remainder; i++) {
    quota[categories[i]] += 1;
  }

  // mélange le pool de chaque thème pour piocher aléatoirement dedans
  const shuffledPools = {};
  categories.forEach(cat => { shuffledPools[cat] = shuffleArray(groups[cat]); });

  const selected = [];
  let missing = 0;

  categories.forEach(cat => {
    const need = quota[cat];
    const available = shuffledPools[cat];
    const take = Math.min(need, available.length);
    selected.push(...available.slice(0, take));
    shuffledPools[cat] = available.slice(take); // ce qu'il reste dans le pool
    if (take < need) missing += (need - take);
  });

  // s'il manque des questions (thème trop petit), on complète avec
  // ce qui reste dans les autres thèmes, au hasard
  if (missing > 0) {
    let leftover = [];
    categories.forEach(cat => { leftover.push(...shuffledPools[cat]); });
    leftover = shuffleArray(leftover);
    selected.push(...leftover.slice(0, missing));
  }

  return selected;
}

/*
  Réordonne une liste de questions afin qu'il n'y ait jamais deux
  questions du même thème l'une à la suite de l'autre (algorithme
  glouton : à chaque étape on prend le thème qui a le plus de
  questions restantes parmi ceux différents de la précédente).
*/
function arrangeNoAdjacentSameCategory(questions) {
  const groups = groupByCategory(questions);
  let pool = Object.keys(groups).map(cat => ({
    category: cat,
    items: shuffleArray(groups[cat])
  }));

  const result = [];
  let lastCategory = null;

  while (result.length < questions.length) {
    pool = pool.filter(p => p.items.length > 0);
    if (pool.length === 0) break;

    pool.sort((a, b) => b.items.length - a.items.length);

    let chosen = pool.find(p => p.category !== lastCategory);
    if (!chosen) chosen = pool[0]; // cas limite : on force (très rare)

    const question = chosen.items.shift();
    result.push(question);
    lastCategory = chosen.category;
  }

  return result;
}

/* Construit un nouveau QCM de 20 questions prêt à être joué */
function buildNewQuiz() {
  const balanced = pickBalancedQuestions(allQuestions, QUESTIONS_PER_QUIZ);
  return arrangeNoAdjacentSameCategory(balanced);
}

/* =========================================================
   3. CHARGEMENT DES QUESTIONS
   ========================================================= */

async function loadQuestions() {
  const res = await fetch("questions.json");
  const data = await res.json();
  allQuestions = data.questions;
}

/* =========================================================
   4. RÉFÉRENCES DOM
   ========================================================= */

const els = {
  burgerBtn: document.getElementById("burgerBtn"),
  burgerOverlay: document.getElementById("burgerOverlay"),

  homeScreen: document.getElementById("home-screen"),
  quizScreen: document.getElementById("quiz-screen"),
  resultScreen: document.getElementById("result-screen"),

  scoreRingValue: document.getElementById("scoreRingValue"),
  globalScore: document.getElementById("globalScore"),
  totalCorrect: document.getElementById("totalCorrect"),
  totalAnswered: document.getElementById("totalAnswered"),
  homeHint: document.getElementById("homeHint"),
  startQuizBtn: document.getElementById("startQuizBtn"),

  progressFill: document.getElementById("progressFill"),
  abandonBtn: document.getElementById("abandonBtn"),
  questionIndex: document.getElementById("questionIndex"),
  questionText: document.getElementById("questionText"),
  questionImageWrap: document.getElementById("questionImageWrap"),
  questionImage: document.getElementById("questionImage"),
  answersGrid: document.getElementById("answersGrid"),
  feedback: document.getElementById("feedback"),
  feedbackStatus: document.getElementById("feedbackStatus"),
  feedbackCorrect: document.getElementById("feedbackCorrect"),
  continueBtn: document.getElementById("continueBtn"),

  resultScore: document.getElementById("resultScore"),
  resultCorrect: document.getElementById("resultCorrect"),
  retryQuizBtn: document.getElementById("retryQuizBtn"),
  backHomeBtn: document.getElementById("backHomeBtn"),

  abandonModal: document.getElementById("abandonModal"),
  abandonYes: document.getElementById("abandonYes"),
  abandonNo: document.getElementById("abandonNo"),
};

const CIRCUMFERENCE = 2 * Math.PI * 60; // r=60, cf. SVG

/* =========================================================
   5. AFFICHAGE : ÉCRAN D'ACCUEIL
   ========================================================= */

function renderHomeScreen() {
  const stats = loadStats();
  const score = getGlobalScoreOn100(stats);

  if (score === null) {
    els.globalScore.textContent = "--";
    els.scoreRingValue.style.strokeDashoffset = CIRCUMFERENCE;
    els.homeHint.textContent = "Réponds à 20 questions choisies dans 6 thèmes différents.";
  } else {
    els.globalScore.textContent = score;
    const offset = CIRCUMFERENCE - (score / 100) * CIRCUMFERENCE;
    els.scoreRingValue.style.strokeDasharray = CIRCUMFERENCE;
    els.scoreRingValue.style.strokeDashoffset = offset;
  }

  els.totalCorrect.textContent = stats.totalCorrect;
  els.totalAnswered.textContent = stats.totalQuestions;
}

function showScreen(name) {
  els.homeScreen.classList.add("hidden");
  els.quizScreen.classList.add("hidden");
  els.resultScreen.classList.add("hidden");

  if (name === "home") els.homeScreen.classList.remove("hidden");
  if (name === "quiz") els.quizScreen.classList.remove("hidden");
  if (name === "result") els.resultScreen.classList.remove("hidden");
}

/* =========================================================
   6. DÉROULÉ DU QCM
   ========================================================= */

function startQuiz() {
  currentQuiz = buildNewQuiz();
  currentIndex = 0;
  currentCorrectCount = 0;
  showScreen("quiz");
  renderQuestion();
}

function updateProgressBar() {
  const pct = (currentIndex / currentQuiz.length) * 100;
  els.progressFill.style.width = pct + "%";
}

function renderQuestion() {
  hasAnsweredCurrent = false;
  const q = currentQuiz[currentIndex];

  updateProgressBar();

  els.questionIndex.textContent = `Question ${currentIndex + 1}`;
  els.questionText.textContent = q.question;

  if (q.image) {
    els.questionImage.src = q.image;
    els.questionImageWrap.classList.add("is-visible");
  } else {
    els.questionImageWrap.classList.remove("is-visible");
    els.questionImage.src = "";
  }

  // reset feedback
  els.feedback.classList.remove("is-visible");
  els.feedbackStatus.textContent = "";
  els.feedbackStatus.className = "feedback__status";
  els.feedbackCorrect.textContent = "";
  els.continueBtn.classList.add("hidden");

  // construit les 4 boutons de réponse
  els.answersGrid.innerHTML = "";
  q.options.forEach((optionText, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "answer-btn";
    btn.textContent = optionText;
    btn.addEventListener("click", () => handleAnswer(idx, btn));
    els.answersGrid.appendChild(btn);
  });
}

function handleAnswer(selectedIdx, selectedBtn) {
  if (hasAnsweredCurrent) return;
  hasAnsweredCurrent = true;

  const q = currentQuiz[currentIndex];
  const isCorrect = selectedIdx === q.answer;

  // désactive tous les boutons et estompe ceux qui ne sont pas choisis
  const allBtns = Array.from(els.answersGrid.children);
  allBtns.forEach(btn => { btn.disabled = true; });

  if (isCorrect) {
    selectedBtn.classList.add("is-correct");
    currentCorrectCount++;
  } else {
    selectedBtn.classList.add("is-wrong");
  }

  allBtns.forEach(btn => {
    if (btn !== selectedBtn) btn.classList.add("is-faded");
  });

  // feedback texte
  els.feedback.classList.add("is-visible");
  if (isCorrect) {
    els.feedbackStatus.textContent = "VRAI";
    els.feedbackStatus.classList.add("is-correct");
  } else {
    els.feedbackStatus.textContent = "FAUX";
    els.feedbackStatus.classList.add("is-wrong");
    els.feedbackCorrect.textContent = `Bonne réponse : ${q.options[q.answer]}`;
  }

  const isLastQuestion = currentIndex === currentQuiz.length - 1;
  els.continueBtn.textContent = isLastQuestion ? "Voir le score" : "Continuer";
  els.continueBtn.classList.remove("hidden");
}

function handleContinue() {
  const isLastQuestion = currentIndex === currentQuiz.length - 1;

  if (isLastQuestion) {
    finishQuiz();
  } else {
    currentIndex++;
    renderQuestion();
  }
}

function finishQuiz() {
  // jauge complète et verte
  els.progressFill.style.width = "100%";
  els.progressFill.classList.add("progress-fill--done");

  const scoreOn100 = Math.round((currentCorrectCount / currentQuiz.length) * 100);

  els.resultScore.innerHTML = `${scoreOn100}<small>/100</small>`;
  els.resultCorrect.textContent = currentCorrectCount;

  // Sauvegarde des stats globales (uniquement ici, quand on voit le score)
  registerQuizResult(currentCorrectCount, currentQuiz.length);

  showScreen("result");
}

/* Réinitialise l'état visuel de la barre de progression pour un nouveau QCM */
function resetProgressBarVisual() {
  els.progressFill.classList.remove("progress-fill--done");
  els.progressFill.style.width = "0%";
}

/* =========================================================
   7. ABANDON DU QCM
   ========================================================= */

function openAbandonModal() {
  els.abandonModal.classList.remove("hidden");
}
function closeAbandonModal() {
  els.abandonModal.classList.add("hidden");
}
function confirmAbandon() {
  closeAbandonModal();
  resetProgressBarVisual();
  showScreen("home");
  renderHomeScreen();
}

/* =========================================================
   8. MENU BURGER
   ========================================================= */

function toggleBurgerMenu() {
  const isOpen = !els.burgerOverlay.classList.contains("hidden");
  if (isOpen) {
    els.burgerOverlay.classList.add("hidden");
    els.burgerBtn.classList.remove("is-open");
  } else {
    els.burgerOverlay.classList.remove("hidden");
    els.burgerBtn.classList.add("is-open");
  }
}

/* =========================================================
   9. ÉVÉNEMENTS
   ========================================================= */

function bindEvents() {
  els.burgerBtn.addEventListener("click", toggleBurgerMenu);
  els.burgerOverlay.addEventListener("click", (e) => {
    if (e.target === els.burgerOverlay) toggleBurgerMenu();
  });

  els.startQuizBtn.addEventListener("click", () => {
    resetProgressBarVisual();
    startQuiz();
  });

  els.continueBtn.addEventListener("click", handleContinue);

  els.abandonBtn.addEventListener("click", openAbandonModal);
  els.abandonNo.addEventListener("click", closeAbandonModal);
  els.abandonYes.addEventListener("click", confirmAbandon);

  els.retryQuizBtn.addEventListener("click", () => {
    resetProgressBarVisual();
    startQuiz();
  });
  els.backHomeBtn.addEventListener("click", () => {
    resetProgressBarVisual();
    showScreen("home");
    renderHomeScreen();
  });
}

/* =========================================================
   10. INITIALISATION
   ========================================================= */

async function init() {
  bindEvents();
  await loadQuestions();
  renderHomeScreen();
  showScreen("home");
}

init();
