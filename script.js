/* =========================================================
   QuizMaster — script.js
   Gère : chargement des questions, sélection d'un QCM de 20
   questions (thèmes équilibrés + jamais 2x le même thème à la
   suite + jamais 2x la même question), le déroulé du QCM,
   les statistiques (localStorage).
   ========================================================= */

const STORAGE_KEY = "quizmaster_stats_v1";
const THEMES_CONFIG_PATH = "themes.json";

/* ---------- État global ---------- */
let themesConfig = [];     // liste des thèmes { id, label, file, quota, flashGroup } depuis themes.json
let flashConfig = { poolPickCount: 3 }; // paramètres du QCM Flash depuis themes.json
let questionsByTheme = {}; // { themeId: [questions...] } après chargement de tous les fichiers
let quizLength = 0;        // = somme des quotas (généralement 20)
let currentQuiz = [];      // les questions de la session en cours
let currentIndex = 0;      // index de la question affichée
let currentCorrectCount = 0;
let hasAnsweredCurrent = false;
let lastQuizScoreOn100 = 0; // score du dernier QCM terminé, pour le bouton "Partager"
let currentQuizType = "classic"; // "classic" (20 questions), "flash" (10 questions) ou "survival"
let survivalMistakes = 0;         // nombre d'erreurs commises dans la partie Survie en cours
let lastSurvivalCorrectCount = 0; // record atteint lors du dernier QCM Survie, pour le partage
let lastSurvivalCompletedFullPool = false; // true si le dernier QCM Survie s'est terminé par épuisement de la base
// ordre de vidage des cœurs (index dans le DOM) : 1ère erreur -> cœur de droite,
// 2ème erreur -> cœur du milieu, 3ème erreur -> cœur de gauche
const SURVIVAL_HEART_DRAIN_ORDER = [2, 1, 0];

/* =========================================================
   1. STATISTIQUES (localStorage)
   ========================================================= */

function loadStats() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return {
      totalCorrect: 0, totalQuestions: 0,
      streakCount: 0, lastPlayedDate: null,
      perfectClassicCount: 0, perfectFlashCount: 0,
      survivalBest: 0
    };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      totalCorrect: parsed.totalCorrect || 0,
      totalQuestions: parsed.totalQuestions || 0,
      streakCount: parsed.streakCount || 0,
      lastPlayedDate: parsed.lastPlayedDate || null,
      // migration douce : l'ancien champ "perfectCount" (avant l'ajout du Flash)
      // devient perfectClassicCount s'il existe encore
      perfectClassicCount: parsed.perfectClassicCount ?? parsed.perfectCount ?? 0,
      perfectFlashCount: parsed.perfectFlashCount || 0,
      survivalBest: parsed.survivalBest || 0
    };
  } catch (e) {
    return {
      totalCorrect: 0, totalQuestions: 0,
      streakCount: 0, lastPlayedDate: null,
      perfectClassicCount: 0, perfectFlashCount: 0,
      survivalBest: 0
    };
  }
}

function saveStats(stats) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
}

function getGlobalScoreOn100(stats) {
  if (stats.totalQuestions === 0) return null;
  return Math.round((stats.totalCorrect / stats.totalQuestions) * 100);
}

/* ---------- Utilitaires de date (série de jours consécutifs) ---------- */

/* Date du jour au format AAAA-MM-JJ, en heure locale */
function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseISODate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/* Nombre de jours calendaires entre deux dates AAAA-MM-JJ (b - a) */
function diffDays(aStr, bStr) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((parseISODate(bStr) - parseISODate(aStr)) / MS_PER_DAY);
}

/*
  Streak affichée à l'écran d'accueil : si le dernier QCM date d'hier
  ou d'aujourd'hui, la série stockée est encore valable. Si le dernier
  QCM remonte à plus d'un jour, la série est considérée comme perdue
  (elle ne sera remise à 0 dans le storage qu'au prochain QCM joué,
  mais on l'affiche déjà à 0 pour refléter la réalité).
*/
function getDisplayStreak(stats) {
  if (!stats.lastPlayedDate) return 0;
  const diff = diffDays(stats.lastPlayedDate, todayISO());
  if (diff <= 1) return stats.streakCount || 0;
  return 0;
}

/* Met à jour la série de jours consécutifs après un QCM joué aujourd'hui */
function updateStreak(stats) {
  const today = todayISO();
  if (!stats.lastPlayedDate) {
    stats.streakCount = 1;
  } else {
    const diff = diffDays(stats.lastPlayedDate, today);
    if (diff === 0) {
      // déjà joué aujourd'hui : la série ne bouge pas
    } else if (diff === 1) {
      stats.streakCount = (stats.streakCount || 0) + 1;
    } else {
      // au moins un jour manqué : la série repart de 1 (le QCM du jour compte)
      stats.streakCount = 1;
    }
  }
  stats.lastPlayedDate = today;
}

/* Met à jour les stats globales à la fin d'un QCM Classique ou Flash */
function registerQuizResult(correctCount, totalQuestionsInQuiz, quizType) {
  const stats = loadStats();
  stats.totalCorrect += correctCount;
  stats.totalQuestions += totalQuestionsInQuiz;

  updateStreak(stats);

  const isPerfect = correctCount === totalQuestionsInQuiz;
  if (quizType === "classic" && isPerfect) {
    stats.perfectClassicCount += 1;
  } else if (quizType === "flash" && isPerfect) {
    stats.perfectFlashCount += 1;
  }

  saveStats(stats);
  return stats;
}

/*
  Met à jour les stats après un QCM Survie. Conformément à la
  consigne, ce mode n'a AUCUNE incidence sur le score global
  (totalCorrect / totalQuestions / perfects) : on met seulement à
  jour la série de jours consécutifs (jouer un QCM Survie compte
  comme "avoir joué aujourd'hui") et le record personnel du nombre
  de bonnes réponses enchaînées.
*/
function registerSurvivalResult(correctCount) {
  const stats = loadStats();
  updateStreak(stats);
  if (correctCount > stats.survivalBest) {
    stats.survivalBest = correctCount;
  }
  saveStats(stats);
  return stats;
}

/* =========================================================
   2. SÉLECTION DES QUESTIONS DU QCM (quotas fixes par thème)
   ========================================================= */

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* Regroupe les questions par thème (utile pour l'algorithme d'agencement) */
function groupByCategory(questions) {
  const groups = {};
  questions.forEach(q => {
    if (!groups[q.category]) groups[q.category] = [];
    groups[q.category].push(q);
  });
  return groups;
}

/*
  Pioche, pour chaque thème défini dans themes.json, exactement le
  nombre de questions indiqué par son "quota" (ex : Histoire = 3,
  Sport = 1, etc.). La somme des quotas définit la taille du QCM.
  Si un thème ne contient pas assez de questions pour son quota
  (cas anormal), on prend tout ce qui est disponible pour ce thème
  et on complète avec des questions piochées au hasard parmi les
  autres thèmes, afin de ne jamais faire planter le QCM.
*/
function pickQuizQuestions() {
  const selected = [];
  const shortfalls = []; // thèmes n'ayant pas pu fournir leur quota complet
  const usedIds = new Set();

  themesConfig.forEach(theme => {
    const pool = shuffleArray(questionsByTheme[theme.id] || []);
    const take = pool.slice(0, theme.quota);
    take.forEach(q => usedIds.add(q.id));
    selected.push(...take);
    if (take.length < theme.quota) {
      shortfalls.push(theme.quota - take.length);
    }
  });

  const missing = shortfalls.reduce((a, b) => a + b, 0);
  if (missing > 0) {
    let leftover = [];
    themesConfig.forEach(theme => {
      (questionsByTheme[theme.id] || []).forEach(q => {
        if (!usedIds.has(q.id)) leftover.push(q);
      });
    });
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

/* Construit un nouveau QCM Classique (quotas fixes par thème, cf. themes.json) */
function buildClassicQuiz() {
  const picked = pickQuizQuestions();
  return arrangeNoAdjacentSameCategory(picked);
}

/*
  Construit un QCM Flash de 10 questions :
  - 1 question pour chacun des thèmes "mandatory" (obligatoires)
  - + N questions (flash.poolPickCount, généralement 3) tirées parmi
    des thèmes "pool" DIFFÉRENTS les uns des autres (jamais deux
    questions du même thème parmi les tirées).
  Comme chaque thème n'apparaît qu'une seule fois au total dans le
  QCM Flash, il ne peut jamais y avoir deux questions du même thème
  l'une à la suite de l'autre : un simple mélange final suffit.
*/
function pickFlashQuizQuestions() {
  const mandatoryThemes = themesConfig.filter(t => t.flashGroup === "mandatory");
  const poolThemes = shuffleArray(themesConfig.filter(t => t.flashGroup === "pool"));
  const poolPickCount = (flashConfig && flashConfig.poolPickCount) || 3;

  const selected = [];
  const usedIds = new Set();

  mandatoryThemes.forEach(theme => {
    const pool = shuffleArray(questionsByTheme[theme.id] || []);
    if (pool.length > 0) {
      selected.push(pool[0]);
      usedIds.add(pool[0].id);
    }
  });

  poolThemes.slice(0, poolPickCount).forEach(theme => {
    const pool = shuffleArray(questionsByTheme[theme.id] || []);
    if (pool.length > 0) {
      selected.push(pool[0]);
      usedIds.add(pool[0].id);
    }
  });

  return selected;
}

/* Construit un nouveau QCM Flash prêt à être joué */
function buildFlashQuiz() {
  const picked = pickFlashQuizQuestions();
  return shuffleArray(picked); // thèmes déjà tous uniques : un simple mélange suffit
}

/*
  Construit le pool du QCM Survie : TOUTES les questions de TOUS les
  thèmes (mélangées, jamais deux du même thème à la suite grâce à
  l'algorithme déjà utilisé pour le Classique). La partie s'arrête
  dès que le joueur perd ses 3 cœurs (ou, cas limite très rare, s'il
  répond juste à absolument toutes les questions de la base).
*/
function buildSurvivalPool() {
  const all = [];
  themesConfig.forEach(theme => {
    (questionsByTheme[theme.id] || []).forEach(q => all.push(q));
  });
  return arrangeNoAdjacentSameCategory(shuffleArray(all));
}

/* =========================================================
   3. CHARGEMENT DES QUESTIONS (1 fichier de config + 1 fichier par thème)
   ========================================================= */

async function loadQuestions() {
  const configRes = await fetch(THEMES_CONFIG_PATH);
  const configData = await configRes.json();
  themesConfig = configData.themes;
  flashConfig = configData.flash || { poolPickCount: 3 };

  const fetches = themesConfig.map(theme => fetch(theme.file).then(r => r.json()));
  const results = await Promise.all(fetches);

  questionsByTheme = {};
  results.forEach((fileData, i) => {
    const theme = themesConfig[i];
    // la propriété "category" de chaque question est toujours forcée
    // à l'id du thème, pour garantir la cohérence avec themes.json
    questionsByTheme[theme.id] = fileData.questions.map(q => ({
      ...q,
      category: theme.id
    }));
  });

  quizLength = themesConfig.reduce((sum, t) => sum + t.quota, 0);
}

/* =========================================================
   4. RÉFÉRENCES DOM
   ========================================================= */

const els = {
  burgerBtn: document.getElementById("burgerBtn"),
  burgerOverlay: document.getElementById("burgerOverlay"),

  homeScreen: document.getElementById("home-screen"),
  selectScreen: document.getElementById("select-screen"),
  quizScreen: document.getElementById("quiz-screen"),
  resultScreen: document.getElementById("result-screen"),

  scoreRingValue: document.getElementById("scoreRingValue"),
  globalScore: document.getElementById("globalScore"),
  totalCorrect: document.getElementById("totalCorrect"),
  totalAnswered: document.getElementById("totalAnswered"),
  streakCount: document.getElementById("streakCount"),
  perfectFlashCount: document.getElementById("perfectFlashCount"),
  perfectClassicCount: document.getElementById("perfectClassicCount"),
  survivalBestCount: document.getElementById("survivalBestCount"),
  startQuizBtn: document.getElementById("startQuizBtn"),

  selectBackBtn: document.getElementById("selectBackBtn"),
  flashQuizBtn: document.getElementById("flashQuizBtn"),
  classicQuizBtn: document.getElementById("classicQuizBtn"),
  survivalQuizBtn: document.getElementById("survivalQuizBtn"),

  progressTrack: document.getElementById("progressTrack"),
  progressFill: document.getElementById("progressFill"),
  survivalBar: document.getElementById("survivalBar"),
  survivalHearts: document.querySelectorAll("#survivalHearts i"),
  survivalCorrectCount: document.getElementById("survivalCorrectCount"),
  abandonBtn: document.getElementById("abandonBtn"),
  questionIndex: document.getElementById("questionIndex"),
  questionText: document.getElementById("questionText"),
  questionImageWrap: document.getElementById("questionImageWrap"),
  questionImage: document.getElementById("questionImage"),
  answersGrid: document.getElementById("answersGrid"),
  feedback: document.getElementById("feedback"),
  feedbackStatus: document.getElementById("feedbackStatus"),
  feedbackCorrect: document.getElementById("feedbackCorrect"),
  infoAccordion: document.getElementById("infoAccordion"),
  infoToggleBtn: document.getElementById("infoToggleBtn"),
  infoChevron: document.getElementById("infoChevron"),
  infoPanel: document.getElementById("infoPanel"),
  infoText: document.getElementById("infoText"),
  continueBtn: document.getElementById("continueBtn"),

  resultBlockScore: document.getElementById("resultBlockScore"),
  resultScore: document.getElementById("resultScore"),
  resultCorrect: document.getElementById("resultCorrect"),
  resultTotal: document.getElementById("resultTotal"),
  resultBlockSurvival: document.getElementById("resultBlockSurvival"),
  resultSurvivalScore: document.getElementById("resultSurvivalScore"),
  resultSurvivalSubtitle: document.getElementById("resultSurvivalSubtitle"),
  shareScoreBtn: document.getElementById("shareScoreBtn"),
  retryQuizBtn: document.getElementById("retryQuizBtn"),
  backHomeBtn: document.getElementById("backHomeBtn"),

  abandonModal: document.getElementById("abandonModal"),
  abandonYes: document.getElementById("abandonYes"),
  abandonNo: document.getElementById("abandonNo"),

  resetDataBtn: document.getElementById("resetDataBtn"),
  resetModal: document.getElementById("resetModal"),
  resetYes: document.getElementById("resetYes"),
  resetNo: document.getElementById("resetNo"),
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
  } else {
    els.globalScore.textContent = score;
    const offset = CIRCUMFERENCE - (score / 100) * CIRCUMFERENCE;
    els.scoreRingValue.style.strokeDasharray = CIRCUMFERENCE;
    els.scoreRingValue.style.strokeDashoffset = offset;
  }

  els.totalCorrect.textContent = stats.totalCorrect;
  els.totalAnswered.textContent = stats.totalQuestions;
  els.streakCount.textContent = getDisplayStreak(stats);
  els.perfectFlashCount.textContent = stats.perfectFlashCount;
  els.perfectClassicCount.textContent = stats.perfectClassicCount;
  els.survivalBestCount.textContent = stats.survivalBest;
}

function showScreen(name) {
  els.homeScreen.classList.add("hidden");
  els.selectScreen.classList.add("hidden");
  els.quizScreen.classList.add("hidden");
  els.resultScreen.classList.add("hidden");

  if (name === "home") els.homeScreen.classList.remove("hidden");
  if (name === "select") els.selectScreen.classList.remove("hidden");
  if (name === "quiz") els.quizScreen.classList.remove("hidden");
  if (name === "result") els.resultScreen.classList.remove("hidden");
}

/* =========================================================
   6. DÉROULÉ DU QCM
   ========================================================= */

function startQuiz(quizType = "classic") {
  currentQuizType = quizType;

  if (quizType === "flash") {
    currentQuiz = buildFlashQuiz();
  } else if (quizType === "survival") {
    currentQuiz = buildSurvivalPool();
    survivalMistakes = 0;
  } else {
    currentQuiz = buildClassicQuiz();
  }

  currentIndex = 0;
  currentCorrectCount = 0;

  updateQuizTopBarForType(quizType);
  showScreen("quiz");
  renderQuestion();
}

/* Affiche la barre de progression (Classique/Flash) OU la barre Survie (cœurs) */
function updateQuizTopBarForType(quizType) {
  if (quizType === "survival") {
    els.progressTrack.classList.add("hidden");
    els.survivalBar.classList.remove("hidden");
  } else {
    els.survivalBar.classList.add("hidden");
    els.progressTrack.classList.remove("hidden");
  }
}

function updateProgressBar() {
  const pct = (currentIndex / currentQuiz.length) * 100;
  els.progressFill.style.width = pct + "%";
}

/* Met à jour l'affichage des 3 cœurs et du compteur de bonnes réponses (mode Survie) */
function updateSurvivalBar() {
  els.survivalHearts.forEach((heart, i) => {
    const isEmpty = SURVIVAL_HEART_DRAIN_ORDER.slice(0, survivalMistakes).includes(i);
    heart.classList.toggle("fa-solid", !isEmpty);
    heart.classList.toggle("fa-regular", isEmpty);
    heart.classList.toggle("is-empty", isEmpty);
  });
  els.survivalCorrectCount.textContent = currentCorrectCount;
}

/* Ferme (referme) l'accordéon "Plus d'infos" sans le masquer */
function closeInfoAccordion() {
  els.infoToggleBtn.classList.remove("is-open");
  els.infoPanel.style.maxHeight = null;
}

/* Ouvre/ferme l'accordéon "Plus d'infos" (animation via max-height) */
function toggleInfoAccordion() {
  const isOpen = els.infoToggleBtn.classList.contains("is-open");
  if (isOpen) {
    closeInfoAccordion();
  } else {
    els.infoToggleBtn.classList.add("is-open");
    els.infoPanel.style.maxHeight = els.infoPanel.scrollHeight + "px";
  }
}

function renderQuestion() {
  hasAnsweredCurrent = false;
  const q = currentQuiz[currentIndex];

  if (currentQuizType === "survival") {
    updateSurvivalBar();
  } else {
    updateProgressBar();
  }

  els.questionIndex.textContent = `Question ${currentIndex + 1}`;
  els.questionText.textContent = q.question;

  if (q.image) {
    els.questionImage.onerror = () => {
      // si l'image locale est introuvable (pas encore ajoutée dans assets/images/...),
      // on masque le bloc image ET on log le chemin exact en console pour diagnostiquer
      console.warn(`[QuizMaster] Image introuvable pour la question "${q.id}" : ${q.image}`);
      els.questionImageWrap.classList.remove("is-visible");
    };
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

  // reset de l'accordéon "Plus d'infos" (masqué et refermé jusqu'à la réponse)
  els.infoAccordion.classList.add("hidden");
  closeInfoAccordion();
  els.infoText.textContent = "";

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

  // accordéon "Plus d'infos" : affiche l'explication si elle existe dans le JSON,
  // sinon un texte par défaut (pratique pour repérer les questions à compléter)
  const explanationText = (q.explication || "").trim();
  els.infoText.textContent = explanationText || "Explication bientôt disponible.";
  els.infoText.classList.toggle("is-empty", !explanationText);
  els.infoAccordion.classList.remove("hidden");

  if (currentQuizType === "survival") {
    if (!isCorrect) {
      survivalMistakes++;
    }
    updateSurvivalBar();
    const isOutOfHearts = survivalMistakes >= 3;
    const isLastQuestionOfPool = currentIndex === currentQuiz.length - 1;
    els.continueBtn.textContent = (isOutOfHearts || isLastQuestionOfPool) ? "Résultat" : "Continuer";
    els.continueBtn.classList.remove("hidden");
    return;
  }

  const isLastQuestion = currentIndex === currentQuiz.length - 1;
  els.continueBtn.textContent = isLastQuestion ? "Voir le score" : "Continuer";
  els.continueBtn.classList.remove("hidden");
}

function handleContinue() {
  if (currentQuizType === "survival") {
    const isOutOfHearts = survivalMistakes >= 3;
    const isPoolExhausted = currentIndex === currentQuiz.length - 1;
    if (isOutOfHearts || isPoolExhausted) {
      finishSurvivalQuiz(isPoolExhausted);
    } else {
      currentIndex++;
      renderQuestion();
    }
    return;
  }

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
  lastQuizScoreOn100 = scoreOn100;

  els.resultBlockSurvival.classList.add("hidden");
  els.resultBlockScore.classList.remove("hidden");
  els.resultScore.innerHTML = `${scoreOn100}<small>/100</small>`;
  els.resultCorrect.textContent = currentCorrectCount;
  els.resultTotal.textContent = currentQuiz.length;

  // Sauvegarde des stats globales (uniquement ici, quand on voit le score)
  registerQuizResult(currentCorrectCount, currentQuiz.length, currentQuizType);

  showScreen("result");
}

/* Fin d'un QCM Survie : n'a AUCUNE incidence sur le score global (cf. consigne) */
function finishSurvivalQuiz(completedFullPool = false) {
  lastSurvivalCorrectCount = currentCorrectCount;
  lastSurvivalCompletedFullPool = completedFullPool;

  els.resultBlockScore.classList.add("hidden");
  els.resultBlockSurvival.classList.remove("hidden");
  els.resultSurvivalScore.textContent = currentCorrectCount;

  if (completedFullPool) {
    // le joueur a répondu à toutes les questions disponibles dans la base de données
    els.resultSurvivalSubtitle.textContent =
      "Vous avez répondu à toutes les questions de la base de données. Félicitations, vous êtes un maître du QCM !";
    els.resultSurvivalSubtitle.classList.add("is-mastery");
  } else {
    els.resultSurvivalSubtitle.textContent = "bonne(s) réponse(s) enchaînée(s)";
    els.resultSurvivalSubtitle.classList.remove("is-mastery");
  }

  registerSurvivalResult(currentCorrectCount);

  showScreen("result");
}

/* Réinitialise l'état visuel de la barre de progression pour un nouveau QCM */
function resetProgressBarVisual() {
  els.progressFill.classList.remove("progress-fill--done");
  els.progressFill.style.width = "0%";
}

/* Réinitialise l'état visuel des cœurs pour un nouveau QCM Survie */
function resetSurvivalBarVisual() {
  survivalMistakes = 0;
  els.survivalHearts.forEach(heart => {
    heart.classList.add("fa-solid");
    heart.classList.remove("fa-regular", "is-empty");
  });
  els.survivalCorrectCount.textContent = "0";
}

/* Réinitialise les deux barres (progression ET cœurs), quel que soit le type de QCM lancé ensuite */
function resetQuizVisuals() {
  resetProgressBarVisual();
  resetSurvivalBarVisual();
}

/* =========================================================
   7. PARTAGE DU SCORE
   ========================================================= */

function shareScore() {
  const survivalMessage = lastSurvivalCompletedFullPool
    ? `Salut, j'ai répondu à toutes les questions du QCM Survie de culture générale de PointG (${lastSurvivalCorrectCount} bonnes réponses). Je suis un maître du QCM !`
    : `Salut, j'ai enchaîné ${lastSurvivalCorrectCount} bonne(s) réponse(s) au QCM Survie de culture générale de PointG.`;

  const message = currentQuizType === "survival"
    ? survivalMessage
    : `Salut, je viens d'obtenir le score de ${lastQuizScoreOn100}/100 au qcm de culture générale de PointG.`;

  if (navigator.share) {
    // API de partage native (mobile / navigateurs compatibles)
    navigator.share({ text: message }).catch(() => {
      // l'utilisateur a annulé le partage ou l'API a échoué : on ne fait rien de plus
    });
    return;
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    // fallback : copie du message dans le presse-papiers avec confirmation visuelle
    navigator.clipboard.writeText(message).then(() => {
      const original = els.shareScoreBtn.innerHTML;
      els.shareScoreBtn.innerHTML = '<i class="fa-solid fa-check"></i><span>Copié !</span>';
      setTimeout(() => { els.shareScoreBtn.innerHTML = original; }, 1800);
    }).catch(() => {
      window.prompt("Copie ton score :", message);
    });
    return;
  }

  // dernier recours si aucune API n'est disponible
  window.prompt("Copie ton score :", message);
}

/* =========================================================
   8. ABANDON DU QCM
   ========================================================= */

function openAbandonModal() {
  els.abandonModal.classList.remove("hidden");
}
function closeAbandonModal() {
  els.abandonModal.classList.add("hidden");
}
function confirmAbandon() {
  closeAbandonModal();
  resetQuizVisuals();
  showScreen("home");
  renderHomeScreen();
}

/* =========================================================
   9. RÉINITIALISATION DES DONNÉES
   ========================================================= */

function openResetModal() {
  els.resetModal.classList.remove("hidden");
}
function closeResetModal() {
  els.resetModal.classList.add("hidden");
}
function confirmReset() {
  localStorage.removeItem(STORAGE_KEY);
  closeResetModal();
  toggleBurgerMenu(); // referme aussi le menu burger
  renderHomeScreen();
}

/* =========================================================
   10. MENU BURGER
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
   11. ÉVÉNEMENTS
   ========================================================= */

function bindEvents() {
  els.burgerBtn.addEventListener("click", toggleBurgerMenu);
  els.burgerOverlay.addEventListener("click", (e) => {
    if (e.target === els.burgerOverlay) toggleBurgerMenu();
  });

  els.startQuizBtn.addEventListener("click", () => {
    showScreen("select");
  });

  els.selectBackBtn.addEventListener("click", () => {
    showScreen("home");
  });

  els.classicQuizBtn.addEventListener("click", () => {
    resetQuizVisuals();
    startQuiz("classic");
  });

  els.flashQuizBtn.addEventListener("click", () => {
    resetQuizVisuals();
    startQuiz("flash");
  });

  els.survivalQuizBtn.addEventListener("click", () => {
    resetQuizVisuals();
    startQuiz("survival");
  });

  els.continueBtn.addEventListener("click", handleContinue);

  els.infoToggleBtn.addEventListener("click", toggleInfoAccordion);

  els.shareScoreBtn.addEventListener("click", shareScore);

  els.abandonBtn.addEventListener("click", openAbandonModal);
  els.abandonNo.addEventListener("click", closeAbandonModal);
  els.abandonYes.addEventListener("click", confirmAbandon);

  els.resetDataBtn.addEventListener("click", openResetModal);
  els.resetNo.addEventListener("click", closeResetModal);
  els.resetYes.addEventListener("click", confirmReset);

  els.retryQuizBtn.addEventListener("click", () => {
    resetQuizVisuals();
    startQuiz(currentQuizType);
  });
  els.backHomeBtn.addEventListener("click", () => {
    resetQuizVisuals();
    showScreen("home");
    renderHomeScreen();
  });
}

/* =========================================================
   12. INITIALISATION
   ========================================================= */

async function init() {
  bindEvents();
  await loadQuestions();
  renderHomeScreen();
  showScreen("home");
}

init();
