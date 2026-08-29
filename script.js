/* =========================================================
   QuizMaster — script.js
   Gère : chargement des questions, sélection d'un QCM de 20
   questions (thèmes équilibrés + jamais 2x le même thème à la
   suite + jamais 2x la même question), le déroulé du QCM,
   les statistiques (localStorage).
   ========================================================= */

const STORAGE_KEY = "quizmaster_stats_v1";
const ADVENTURE_STORAGE_KEY = "quizmaster_adventure_v1";
const THEMES_CONFIG_PATH = "themes.json";
const ADVENTURE_ZONES_INDEX_PATH = "adventure/zones-index.json";
const ADVENTURE_UNLOCK_THRESHOLD = 60; // % minimum pour débloquer le carré suivant
const ADVENTURE_COMPLETE_THRESHOLD = 100; // % requis pour valider un carré/zone (coche verte)

/* ---------- État global ---------- */
let themesConfig = [];     // liste des thèmes { id, label, file, quota, flashGroup, icon } depuis themes.json
let flashConfig = { poolPickCount: 3 }; // paramètres du QCM Flash depuis themes.json
let questionsByTheme = {}; // { themeId: [questions...] } après chargement de tous les fichiers
let questionsById = {};    // { questionId: question } pour une résolution rapide (mode Aventure)
let quizLength = 0;        // = somme des quotas (généralement 20)
let currentQuiz = [];      // les questions de la session en cours
let currentQuizThemeTally = {}; // { [themeId]: {correct,total} } accumulé pendant la session en cours
let currentIndex = 0;      // index de la question affichée
let currentCorrectCount = 0;
let hasAnsweredCurrent = false;
let lastQuizScoreOn100 = 0; // score du dernier QCM terminé, pour le bouton "Partager"
let currentQuizType = "classic"; // "classic", "flash", "survival" ou "adventure"
let survivalMistakes = 0;         // nombre d'erreurs commises dans la partie Survie en cours
let lastSurvivalCorrectCount = 0; // record atteint lors du dernier QCM Survie, pour le partage
let lastSurvivalCompletedFullPool = false; // true si le dernier QCM Survie s'est terminé par épuisement de la base
// ordre de vidage des cœurs (index dans le DOM) : 1ère erreur -> cœur de droite,
// 2ème erreur -> cœur du milieu, 3ème erreur -> cœur de gauche
const SURVIVAL_HEART_DRAIN_ORDER = [2, 1, 0];

/* ---------- État du mode Aventure ---------- */
let adventureZonesConfig = [];   // [{ id, label, file }] depuis zones-index.json
let adventureZonesData = {};     // { zoneId: { id, label, squares: [...] } } (fichiers de zones chargés)
let adventureOpenZoneId = null;  // id de la zone actuellement dépliée (une seule à la fois)
let currentAdventureZoneId = null;   // zone du carré en cours de jeu
let currentAdventureSquareId = null; // carré en cours de jeu

/* =========================================================
   1. STATISTIQUES (localStorage)
   ========================================================= */

function emptyStats() {
  return {
    streakCount: 0, lastPlayedDate: null,
    xp: 0,
    perfectClassicCount: 0, perfectFlashCount: 0,
    scoreableCorrect: 0, scoreableTotal: 0, // Classique + Flash + Survie (PAS Aventure) -> % / jauge
    survivalBest: 0,
    themeStats: {} // { [themeId]: { correct, total } } — Classique + Flash + Survie (Aventure calculé à part)
  };
}

function loadStats() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyStats();
  try {
    const parsed = JSON.parse(raw);
    return {
      streakCount: parsed.streakCount || 0,
      lastPlayedDate: parsed.lastPlayedDate || null,
      xp: parsed.xp || 0,
      // migration douce depuis l'ancien nom "perfectCount" (avant l'ajout du Flash)
      perfectClassicCount: parsed.perfectClassicCount ?? parsed.perfectCount ?? 0,
      perfectFlashCount: parsed.perfectFlashCount || 0,
      // migration douce depuis les anciens noms totalCorrect/totalQuestions
      scoreableCorrect: parsed.scoreableCorrect ?? parsed.totalCorrect ?? 0,
      scoreableTotal: parsed.scoreableTotal ?? parsed.totalQuestions ?? 0,
      survivalBest: parsed.survivalBest || 0,
      themeStats: (parsed.themeStats && typeof parsed.themeStats === "object") ? parsed.themeStats : {}
    };
  } catch (e) {
    return emptyStats();
  }
}

function saveStats(stats) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
}

/* Fusionne le tally de thèmes { [themeId]: {correct,total} } d'une session dans les stats persistées */
function mergeThemeTally(stats, tally) {
  Object.entries(tally || {}).forEach(([themeId, val]) => {
    if (!stats.themeStats[themeId]) stats.themeStats[themeId] = { correct: 0, total: 0 };
    stats.themeStats[themeId].correct += val.correct;
    stats.themeStats[themeId].total += val.total;
  });
}

/* % de bonnes réponses "scoreable" (Classique + Flash + Survie, PAS Aventure) */
function computeScoreablePercent(stats) {
  if (stats.scoreableTotal === 0) return null;
  return Math.round((stats.scoreableCorrect / stats.scoreableTotal) * 100);
}

/* Bonus XP du QCM Survie : +5xp au palier de 10 bonnes réponses, +10xp à 20, +15xp à 30, etc. */
function computeSurvivalXpBonus(correctCount) {
  const milestones = Math.floor(correctCount / 10);
  return 5 * (milestones * (milestones + 1)) / 2;
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

/* Met à jour la série de jours consécutifs après un QCM joué aujourd'hui (tous modes confondus) */
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
function registerQuizResult(correctCount, totalQuestionsInQuiz, quizType, themeTally) {
  const stats = loadStats();
  stats.scoreableCorrect += correctCount;
  stats.scoreableTotal += totalQuestionsInQuiz;

  updateStreak(stats);
  mergeThemeTally(stats, themeTally);

  const isPerfect = correctCount === totalQuestionsInQuiz;
  const baseXp = correctCount * 2;
  let bonusXp = 0;
  if (quizType === "classic") {
    if (isPerfect) { stats.perfectClassicCount += 1; bonusXp = 20; }
  } else if (quizType === "flash") {
    if (isPerfect) { stats.perfectFlashCount += 1; bonusXp = 10; }
  }
  stats.xp += baseXp + bonusXp;

  saveStats(stats);
  return { baseXp, bonusXp, isPerfect };
}

/*
  Met à jour les stats après un QCM Survie. Compte pour la série de
  jours ET pour le score "scoreable" (% / jauge) — seule l'Aventure
  en est exclue. totalAnswered = nombre de questions effectivement
  posées durant la partie (bonnes + mauvaises).
*/
function registerSurvivalResult(correctCount, totalAnswered, themeTally) {
  const stats = loadStats();
  stats.scoreableCorrect += correctCount;
  stats.scoreableTotal += totalAnswered;

  updateStreak(stats);
  mergeThemeTally(stats, themeTally);

  if (correctCount > stats.survivalBest) {
    stats.survivalBest = correctCount;
  }

  const baseXp = correctCount * 2;
  const bonusXp = computeSurvivalXpBonus(correctCount);
  stats.xp += baseXp + bonusXp;

  saveStats(stats);
  return { baseXp, bonusXp };
}

/* =========================================================
   2. PROGRESSION DU MODE AVENTURE (localStorage dédié)
   ========================================================= */

/*
  { scores: { [squareId]: meilleurPourcentage },
    xpGrantedSquares: [squareId...],  // carrés ayant déjà rapporté leurs +10xp (100%, une seule fois)
    xpGrantedZones: [zoneId...] }     // zones ayant déjà rapporté leurs +40xp (100%, une seule fois)
*/
function emptyAdventureProgress() {
  return { scores: {}, xpGrantedSquares: [], xpGrantedZones: [] };
}

function loadAdventureProgress() {
  const raw = localStorage.getItem(ADVENTURE_STORAGE_KEY);
  if (!raw) return emptyAdventureProgress();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyAdventureProgress();
    return {
      scores: (parsed.scores && typeof parsed.scores === "object") ? parsed.scores : {},
      xpGrantedSquares: Array.isArray(parsed.xpGrantedSquares) ? parsed.xpGrantedSquares : [],
      xpGrantedZones: Array.isArray(parsed.xpGrantedZones) ? parsed.xpGrantedZones : []
    };
  } catch (e) {
    return emptyAdventureProgress();
  }
}

function saveAdventureProgress(progress) {
  localStorage.setItem(ADVENTURE_STORAGE_KEY, JSON.stringify(progress));
}

function getSquareBestPercent(squareId) {
  const progress = loadAdventureProgress();
  return progress.scores[squareId] || 0;
}

/*
  Enregistre le résultat d'un carré Aventure : le score/100 global et
  les stats par thème ne sont JAMAIS impactés (seule la "phrase de
  positionnement" et l'indicateur Aventure les prennent en compte, en
  les recalculant dynamiquement à partir des meilleurs scores). Jouer
  un carré compte pour la série de jours. Les XP de complétion (carré
  à 100% = +10xp, zone à 100% = +40xp) ne sont accordés qu'une seule
  fois, jamais à nouveau lors d'une rejouabilité.
*/
function registerAdventureResult(zoneId, squareId, percent) {
  const stats = loadStats();
  updateStreak(stats);

  const progress = loadAdventureProgress();
  const previousBest = progress.scores[squareId] || 0;
  if (percent > previousBest) {
    progress.scores[squareId] = percent;
  }

  if (percent >= ADVENTURE_COMPLETE_THRESHOLD && !progress.xpGrantedSquares.includes(squareId)) {
    stats.xp += 10;
    progress.xpGrantedSquares.push(squareId);
  }

  const zone = adventureZonesData[zoneId];
  if (zone && isZoneComplete(zone) && !progress.xpGrantedZones.includes(zoneId)) {
    stats.xp += 40;
    progress.xpGrantedZones.push(zoneId);
  }

  saveStats(stats);
  saveAdventureProgress(progress);

  return { previousBest };
}

/* Un carré est débloqué si c'est le premier de la zone, ou si le précédent atteint >= 60% */
function isSquareUnlocked(zone, squareIndex) {
  if (squareIndex === 0) return true;
  const previousSquare = zone.squares[squareIndex - 1];
  return getSquareBestPercent(previousSquare.id) >= ADVENTURE_UNLOCK_THRESHOLD;
}

/* Une zone est complète quand TOUS ses carrés sont à 100% */
function isZoneComplete(zone) {
  return zone.squares.every(sq => getSquareBestPercent(sq.id) >= ADVENTURE_COMPLETE_THRESHOLD);
}

/* La 1ère zone est toujours accessible ; les suivantes le deviennent quand la précédente est à 100% */
function isZoneUnlocked(zoneIndex) {
  if (zoneIndex === 0) return true;
  const previousZoneConfig = adventureZonesConfig[zoneIndex - 1];
  const previousZone = adventureZonesData[previousZoneConfig.id];
  return previousZone ? isZoneComplete(previousZone) : false;
}

/* Tous les carrés (toutes zones confondues) ayant déjà été joués au moins une fois */
function getAllAttemptedAdventureSquares() {
  const results = [];
  adventureZonesConfig.forEach(zc => {
    const zone = adventureZonesData[zc.id];
    if (!zone) return;
    zone.squares.forEach(sq => {
      const percent = getSquareBestPercent(sq.id);
      if (percent > 0) results.push({ square: sq, percent });
    });
  });
  return results;
}

/* Total de bonnes réponses / questions "comptabilisées" côté Aventure (meilleur score par carré, une fois) */
function computeAdventureCorrectTotal() {
  const attempted = getAllAttemptedAdventureSquares();
  let correct = 0, total = 0;
  attempted.forEach(({ percent }) => {
    correct += Math.round((percent / 100) * 5);
    total += 5;
  });
  return { correct, total };
}

/* Contribution de l'Aventure aux stats par thème : { [themeId]: {correct,total} } */
function computeAdventureThemeContribution() {
  const themeAdd = {};
  getAllAttemptedAdventureSquares().forEach(({ square, percent }) => {
    if (!themeAdd[square.theme]) themeAdd[square.theme] = { correct: 0, total: 0 };
    themeAdd[square.theme].correct += Math.round((percent / 100) * 5);
    themeAdd[square.theme].total += 5;
  });
  return themeAdd;
}

/* Fusionne stats.themeStats (Classique/Flash/Survie) + contribution Aventure calculée dynamiquement */
function computeCombinedThemeStats(stats) {
  const combined = {};
  themesConfig.forEach(t => { combined[t.id] = { correct: 0, total: 0 }; });
  Object.entries(stats.themeStats || {}).forEach(([themeId, val]) => {
    if (!combined[themeId]) combined[themeId] = { correct: 0, total: 0 };
    combined[themeId].correct += val.correct || 0;
    combined[themeId].total += val.total || 0;
  });
  Object.entries(computeAdventureThemeContribution()).forEach(([themeId, val]) => {
    if (!combined[themeId]) combined[themeId] = { correct: 0, total: 0 };
    combined[themeId].correct += val.correct;
    combined[themeId].total += val.total;
  });
  return combined;
}

/* Thème le plus et le moins maîtrisé (null si aucune donnée encore) */
function getMostAndLeastMasteredThemes(stats) {
  const combined = computeCombinedThemeStats(stats);
  const withData = Object.entries(combined)
    .filter(([, v]) => v.total > 0)
    .map(([themeId, v]) => ({ themeId, percent: Math.round((v.correct / v.total) * 100) }));
  if (withData.length === 0) return { best: null, worst: null };
  withData.sort((a, b) => b.percent - a.percent);
  return { best: withData[0], worst: withData[withData.length - 1] };
}

/* "Phrase de positionnement" : bonnes réponses "scoreable" + contribution Aventure (comptée une fois par carré) */
function computePositionSentence(stats) {
  const adv = computeAdventureCorrectTotal();
  return {
    correct: stats.scoreableCorrect + adv.correct,
    total: stats.scoreableTotal + adv.total
  };
}

/* Nombre total de questions dans toute la base de données (tous thèmes confondus) */
function getTotalDatabaseQuestionCount() {
  return Object.values(questionsByTheme).reduce((sum, arr) => sum + arr.length, 0);
}

/* Niveau du QCM Survie, basé sur le record personnel rapporté au volume total de la base */
function getSurvivalLevel(survivalBest) {
  const totalDb = getTotalDatabaseQuestionCount();
  const percent = totalDb === 0 ? 0 : Math.min(100, Math.round((survivalBest / totalDb) * 100));
  let label;
  if (percent >= 100) label = "Maître ultime";
  else if (percent >= 90) label = "Maître";
  else if (percent >= 70) label = "Expert";
  else if (percent >= 50) label = "Connaisseur";
  else if (percent >= 25) label = "Curieux";
  else if (percent >= 10) label = "Apprenti";
  else label = "Débutant";
  return { percent, label };
}

/* Libellé de la dernière zone débloquée (la plus avancée accessible) */
function getLastUnlockedZoneLabel() {
  let lastUnlockedIndex = -1;
  adventureZonesConfig.forEach((zc, i) => { if (isZoneUnlocked(i)) lastUnlockedIndex = i; });
  if (lastUnlockedIndex === -1) return null;
  return adventureZonesConfig[lastUnlockedIndex].label;
}

/* % d'accomplissement global de l'Aventure = bonnes réponses Aventure / total de questions de la base */
function computeAdventureOverallPercent() {
  const totalDb = getTotalDatabaseQuestionCount();
  if (totalDb === 0) return 0;
  const adv = computeAdventureCorrectTotal();
  return Math.round((adv.correct / totalDb) * 100);
}

/* =========================================================
   3. SÉLECTION DES QUESTIONS DU QCM (quotas fixes par thème)
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
   4. CHARGEMENT DES QUESTIONS (1 fichier de config + 1 fichier par thème)
   ========================================================= */

async function loadQuestions() {
  const configRes = await fetch(THEMES_CONFIG_PATH);
  const configData = await configRes.json();
  themesConfig = configData.themes;
  flashConfig = configData.flash || { poolPickCount: 3 };

  const fetches = themesConfig.map(theme => fetch(theme.file).then(r => r.json()));
  const results = await Promise.all(fetches);

  questionsByTheme = {};
  questionsById = {};
  results.forEach((fileData, i) => {
    const theme = themesConfig[i];
    // la propriété "category" de chaque question est toujours forcée
    // à l'id du thème, pour garantir la cohérence avec themes.json
    questionsByTheme[theme.id] = fileData.questions.map(q => {
      const question = { ...q, category: theme.id };
      questionsById[question.id] = question; // index pour le mode Aventure
      return question;
    });
  });

  quizLength = themesConfig.reduce((sum, t) => sum + t.quota, 0);
}

/* Charge le manifeste des zones puis chaque fichier de zone qu'il référence */
async function loadAdventureData() {
  const indexRes = await fetch(ADVENTURE_ZONES_INDEX_PATH);
  const indexData = await indexRes.json();
  adventureZonesConfig = indexData.zones;

  const fetches = adventureZonesConfig.map(zone => fetch(zone.file).then(r => r.json()));
  const results = await Promise.all(fetches);

  adventureZonesData = {};
  results.forEach((zoneData, i) => {
    adventureZonesData[adventureZonesConfig[i].id] = zoneData;
  });
}

/* =========================================================
   5. RÉFÉRENCES DOM
   ========================================================= */

const els = {
  burgerBtn: document.getElementById("burgerBtn"),
  burgerOverlay: document.getElementById("burgerOverlay"),

  homeScreen: document.getElementById("home-screen"),
  selectScreen: document.getElementById("select-screen"),
  adventureScreen: document.getElementById("adventure-screen"),
  quizScreen: document.getElementById("quiz-screen"),
  resultScreen: document.getElementById("result-screen"),

  scoreRingValue: document.getElementById("scoreRingValue"),
  globalScore: document.getElementById("globalScore"),
  streakCount: document.getElementById("streakCount"),
  xpCount: document.getElementById("xpCount"),
  positionCorrect: document.getElementById("positionCorrect"),
  positionTotal: document.getElementById("positionTotal"),
  masteryBestRow: document.getElementById("masteryBestRow"),
  masteryBestIcon: document.getElementById("masteryBestIcon"),
  masteryBestLabel: document.getElementById("masteryBestLabel"),
  masteryWorstRow: document.getElementById("masteryWorstRow"),
  masteryWorstIcon: document.getElementById("masteryWorstIcon"),
  masteryWorstLabel: document.getElementById("masteryWorstLabel"),
  perfectFlashCount: document.getElementById("perfectFlashCount"),
  perfectClassicCount: document.getElementById("perfectClassicCount"),
  survivalBestLabel: document.getElementById("survivalBestLabel"),
  survivalLevelLabel: document.getElementById("survivalLevelLabel"),
  adventureZoneLabel: document.getElementById("adventureZoneLabel"),
  adventurePercentLabel: document.getElementById("adventurePercentLabel"),
  startQuizBtn: document.getElementById("startQuizBtn"),

  selectBackBtn: document.getElementById("selectBackBtn"),
  flashQuizBtn: document.getElementById("flashQuizBtn"),
  classicQuizBtn: document.getElementById("classicQuizBtn"),
  survivalQuizBtn: document.getElementById("survivalQuizBtn"),
  adventureQuizBtn: document.getElementById("adventureQuizBtn"),

  adventureBackBtn: document.getElementById("adventureBackBtn"),
  zonesList: document.getElementById("zonesList"),

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

  resultBlock: document.getElementById("resultBlock"),
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
   6. AFFICHAGE : ÉCRAN D'ACCUEIL
   ========================================================= */

function renderHomeScreen() {
  const stats = loadStats();

  // ---- Série (streak) + XP ----
  els.streakCount.textContent = getDisplayStreak(stats);
  els.xpCount.textContent = stats.xp;

  // ---- Phrase de positionnement (toutes les données de jeu, Aventure comptée une fois) ----
  const position = computePositionSentence(stats);
  els.positionCorrect.textContent = position.correct;
  els.positionTotal.textContent = position.total;

  // ---- Indicateur de bonnes réponses (jauge dégradée) : PAS l'Aventure ----
  const accuracy = computeScoreablePercent(stats);
  if (accuracy === null) {
    els.globalScore.textContent = "--";
    els.scoreRingValue.style.strokeDashoffset = CIRCUMFERENCE;
  } else {
    els.globalScore.textContent = accuracy;
    const offset = CIRCUMFERENCE - (accuracy / 100) * CIRCUMFERENCE;
    els.scoreRingValue.style.strokeDasharray = CIRCUMFERENCE;
    els.scoreRingValue.style.strokeDashoffset = offset;
  }

  // ---- Thème le plus / le moins maîtrisé ----
  const mastery = getMostAndLeastMasteredThemes(stats);
  const themeLabel = (themeId) => {
    const t = themesConfig.find(t => t.id === themeId);
    return t ? t.label : themeId;
  };
  const themeIcon = (themeId) => {
    const t = themesConfig.find(t => t.id === themeId);
    return t ? t.icon : "fa-circle-question";
  };

  if (mastery.best) {
    els.masteryBestRow.classList.remove("is-empty");
    els.masteryBestIcon.className = `fa-solid ${themeIcon(mastery.best.themeId)}`;
    els.masteryBestLabel.textContent = themeLabel(mastery.best.themeId);
  } else {
    els.masteryBestRow.classList.add("is-empty");
    els.masteryBestIcon.className = "fa-solid fa-circle-question";
    els.masteryBestLabel.textContent = "À découvrir";
  }
  if (mastery.worst) {
    els.masteryWorstRow.classList.remove("is-empty");
    els.masteryWorstIcon.className = `fa-solid ${themeIcon(mastery.worst.themeId)}`;
    els.masteryWorstLabel.textContent = themeLabel(mastery.worst.themeId);
  } else {
    els.masteryWorstRow.classList.add("is-empty");
    els.masteryWorstIcon.className = "fa-solid fa-circle-question";
    els.masteryWorstLabel.textContent = "À découvrir";
  }

  // ---- Perfects ----
  els.perfectFlashCount.textContent = stats.perfectFlashCount;
  els.perfectClassicCount.textContent = stats.perfectClassicCount;

  // ---- Niveau QCM Survie ----
  const survivalLevel = getSurvivalLevel(stats.survivalBest);
  els.survivalBestLabel.textContent = `${stats.survivalBest} question${stats.survivalBest > 1 ? "s" : ""}`;
  els.survivalLevelLabel.textContent = survivalLevel.label;

  // ---- QCM Aventure ----
  const lastZoneLabel = getLastUnlockedZoneLabel();
  els.adventureZoneLabel.textContent = lastZoneLabel || "Aucune zone";
  els.adventurePercentLabel.textContent = `${computeAdventureOverallPercent()}% de la base explorée`;
}

function showScreen(name) {
  els.homeScreen.classList.add("hidden");
  els.selectScreen.classList.add("hidden");
  els.adventureScreen.classList.add("hidden");
  els.quizScreen.classList.add("hidden");
  els.resultScreen.classList.add("hidden");

  if (name === "home") els.homeScreen.classList.remove("hidden");
  if (name === "select") els.selectScreen.classList.remove("hidden");
  if (name === "adventure") els.adventureScreen.classList.remove("hidden");
  if (name === "quiz") els.quizScreen.classList.remove("hidden");
  if (name === "result") els.resultScreen.classList.remove("hidden");
}

/* ---------- RENDU DE L'ÉCRAN AVENTURE (zones + carrés) ---------- */

/*
  Progression d'une zone en % : proportion de bonnes réponses obtenues
  (meilleur score par carré) sur le total de questions de la zone.
  Chaque carré fait 5 questions, et les paliers stockés (0/20/40/60/80/100)
  sont toujours des multiples exacts de 20, donc percent/20 redonne le
  nombre de bonnes réponses sans arrondi approximatif.
*/
function computeZoneProgressPercent(zone) {
  const totalQuestions = zone.squares.length * 5;
  if (totalQuestions === 0) return 0;
  const totalCorrect = zone.squares.reduce((sum, sq) => {
    const percent = getSquareBestPercent(sq.id);
    return sum + Math.round((percent / 100) * 5);
  }, 0);
  return Math.round((totalCorrect / totalQuestions) * 100);
}

/* Construit la liste des carrés d'une zone (état verrouillé/validé/complet + titre/sous-titre) */
function buildSquaresListElement(zone) {
  const list = document.createElement("div");
  list.className = "zone-accordion__body-inner";

  zone.squares.forEach((square, i) => {
    const theme = themesConfig.find(t => t.id === square.theme);
    const title = theme ? theme.label : square.theme;
    const subtitle = (square.subtitle || "").trim() || "Sous-titre à ajouter";
    const icon = theme ? theme.icon : "fa-circle-question";

    const percent = getSquareBestPercent(square.id);
    const unlocked = isSquareUnlocked(zone, i);

    let percentClass = "square-percent--low"; // < 60%
    if (percent >= ADVENTURE_COMPLETE_THRESHOLD) percentClass = "square-percent--complete"; // 100%
    else if (percent >= ADVENTURE_UNLOCK_THRESHOLD) percentClass = "square-percent--validated"; // >= 60%

    const row = document.createElement("button");
    row.type = "button";
    row.className = "square-row";
    row.disabled = !unlocked;
    row.innerHTML = `
      <span class="square-box"><i class="fa-solid ${icon}"></i></span>
      <span class="square-text">
        <strong class="square-text__title">${title}</strong>
        <small class="square-text__subtitle${square.subtitle ? "" : " is-empty"}">${subtitle}</small>
      </span>
      ${percent > 0 ? `<span class="square-percent ${percentClass}">${percent}%</span>` : ""}
    `;
    if (unlocked) {
      row.addEventListener("click", () => startAdventureSquare(zone.id, square.id));
    }
    list.appendChild(row);
  });

  return list;
}

/* Affiche toutes les zones (débloquées/verrouillées/terminées) sous forme d'accordéon */
function renderAdventureScreen() {
  const container = els.zonesList;
  container.innerHTML = "";

  adventureZonesConfig.forEach((zoneConfig, zoneIndex) => {
    const zone = adventureZonesData[zoneConfig.id];
    if (!zone) return;

    const unlocked = isZoneUnlocked(zoneIndex);
    const complete = unlocked && isZoneComplete(zone);
    const isOpen = unlocked && adventureOpenZoneId === zone.id;
    const progressPercent = unlocked ? computeZoneProgressPercent(zone) : 0;

    const zoneEl = document.createElement("div");
    zoneEl.className = "zone-accordion" + (unlocked ? "" : " is-locked") + (isOpen ? " is-open" : "");

    const zoneNumber = zoneIndex + 1;
    const numberIconClass = zoneNumber >= 1 && zoneNumber <= 9 ? `fa-${zoneNumber}` : "fa-hashtag";

    let rightIconHtml;
    if (complete) {
      rightIconHtml = '<i class="fa-solid fa-circle-check zone-accordion__check"></i>';
    } else if (unlocked) {
      rightIconHtml = '<i class="fa-solid fa-chevron-down zone-accordion__chevron"></i>';
    } else {
      rightIconHtml = '<i class="fa-solid fa-lock zone-accordion__lock"></i>';
    }

    zoneEl.innerHTML = `
      <button type="button" class="zone-accordion__header" ${unlocked ? "" : "disabled"}>
        <span class="zone-accordion__number"><i class="fa-solid ${numberIconClass}"></i></span>
        <span class="zone-accordion__label-wrap">
          <span class="zone-accordion__label">${zoneConfig.label}</span>
          <span class="zone-accordion__progress-track">
            <span class="zone-accordion__progress-fill" style="width: ${progressPercent}%;"></span>
          </span>
        </span>
        ${rightIconHtml}
      </button>
      <div class="zone-accordion__body"></div>
    `;

    const header = zoneEl.querySelector(".zone-accordion__header");
    const body = zoneEl.querySelector(".zone-accordion__body");

    if (unlocked) {
      header.addEventListener("click", () => {
        adventureOpenZoneId = isOpen ? null : zone.id;
        renderAdventureScreen();
      });
    }

    if (isOpen) {
      body.appendChild(buildSquaresListElement(zone));
    }

    container.appendChild(zoneEl);

    // anime l'ouverture/fermeture de la zone (même technique que l'accordéon "Plus d'infos")
    if (isOpen) {
      body.style.maxHeight = body.scrollHeight + "px";
    } else {
      body.style.maxHeight = null;
    }
  });
}

/* =========================================================
   7. DÉROULÉ DU QCM
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
  currentQuizThemeTally = {};

  updateQuizTopBarForType(quizType);
  showScreen("quiz");
  renderQuestion();
}

/* Lance le mini-QCM de 5 questions (hand-picked) associé à un carré du mode Aventure */
function startAdventureSquare(zoneId, squareId) {
  const zone = adventureZonesData[zoneId];
  const square = zone.squares.find(sq => sq.id === squareId);
  if (!square) return;

  currentQuizType = "adventure";
  currentAdventureZoneId = zoneId;
  currentAdventureSquareId = squareId;
  currentQuiz = square.questionIds.map(qid => questionsById[qid]).filter(Boolean);
  currentIndex = 0;
  currentCorrectCount = 0;
  currentQuizThemeTally = {};

  updateQuizTopBarForType("adventure");
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

  // tally par thème de la session en cours (fusionné dans les stats à la fin du QCM)
  if (!currentQuizThemeTally[q.category]) {
    currentQuizThemeTally[q.category] = { correct: 0, total: 0 };
  }
  currentQuizThemeTally[q.category].total++;
  if (isCorrect) currentQuizThemeTally[q.category].correct++;

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
    if (currentQuizType === "adventure") {
      finishAdventureQuiz();
    } else {
      finishQuiz();
    }
  } else {
    currentIndex++;
    renderQuestion();
  }
}

/* Construit la ligne HTML d'un gain XP de base ("X xp gagné de bonnes réponses") */
function xpBaseLineHtml(baseXp) {
  return `<p class="result-detail">${baseXp} xp gagné de bonnes réponses</p>`;
}

/* Construit la ligne HTML d'un bonus XP, mise en évidence (couleur accent) */
function xpBonusLineHtml(text) {
  return `<p class="result-detail result-detail--bonus">${text}</p>`;
}

function finishQuiz() {
  // jauge complète et verte
  els.progressFill.style.width = "100%";
  els.progressFill.classList.add("progress-fill--done");

  const xpResult = registerQuizResult(currentCorrectCount, currentQuiz.length, currentQuizType, currentQuizThemeTally);

  const perfectLabel = currentQuizType === "classic" ? "perfect classique" : "perfect flash";
  els.resultBlock.innerHTML = `
    ${xpBaseLineHtml(xpResult.baseXp)}
    ${xpResult.isPerfect ? xpBonusLineHtml(`+${xpResult.bonusXp} xp bonus ${perfectLabel}`) : ""}
    <p class="result-detail result-detail--count"><strong>${currentCorrectCount}</strong> bonnes réponses sur <strong>${currentQuiz.length}</strong></p>
  `;

  els.backHomeBtn.textContent = "Revenir à l'accueil";

  showScreen("result");
}

/* Fin d'un QCM Survie : n'a AUCUNE incidence sur le score "scoreable" par thème/global (cf. consigne) */
function finishSurvivalQuiz(completedFullPool = false) {
  lastSurvivalCorrectCount = currentCorrectCount;
  lastSurvivalCompletedFullPool = completedFullPool;

  const xpResult = registerSurvivalResult(currentCorrectCount, currentIndex + 1, currentQuizThemeTally);

  const masteryLine = completedFullPool
    ? `<p class="result-detail is-mastery">Vous avez répondu à toutes les questions de la base de données. Félicitations, vous êtes un maître du QCM !</p>`
    : "";

  els.resultBlock.innerHTML = `
    <p class="result-detail result-detail--count"><strong>${currentCorrectCount}</strong> bonne(s) réponse(s) enchaînée(s)</p>
    ${xpBaseLineHtml(xpResult.baseXp)}
    ${xpResult.bonusXp > 0 ? xpBonusLineHtml(`+${xpResult.bonusXp} xp bonus cumulés`) : ""}
    ${masteryLine}
  `;

  els.backHomeBtn.textContent = "Revenir à l'accueil";

  showScreen("result");
}

/*
  Fin d'un carré du mode Aventure (5 questions). N'a AUCUNE incidence
  sur le score "scoreable" ni sur les stats par thème (recalculées
  dynamiquement ailleurs) : seule la progression du carré/de la zone
  est sauvegardée, avec les XP de complétion associés.
*/
function finishAdventureQuiz() {
  els.progressFill.style.width = "100%";
  els.progressFill.classList.add("progress-fill--done");

  const percent = Math.round((currentCorrectCount / currentQuiz.length) * 100);
  lastQuizScoreOn100 = percent;

  const { previousBest } = registerAdventureResult(currentAdventureZoneId, currentAdventureSquareId, percent);
  // le carré suivant était-il déjà débloqué AVANT cette tentative ?
  const nextSquareWasAlreadyUnlocked = previousBest >= ADVENTURE_UNLOCK_THRESHOLD;

  let icon, message;
  if (percent < ADVENTURE_UNLOCK_THRESHOLD) {
    icon = "fa-lock";
    message = "Obtenez au moins 60% pour débloquer le carré suivant.";
  } else if (percent < ADVENTURE_COMPLETE_THRESHOLD) {
    icon = "fa-unlock";
    const lines = [];
    if (!nextSquareWasAlreadyUnlocked) lines.push("Carré suivant débloqué.");
    lines.push("Faites 100% pour obtenir des xp.");
    message = lines.join("<br>");
  } else {
    icon = "fa-star";
    const lines = [];
    if (!nextSquareWasAlreadyUnlocked) lines.push("Carré suivant débloqué.");
    lines.push("10 xp pour 100% du carré.");
    message = lines.join("<br>");
  }

  els.resultBlock.innerHTML = `
    <div class="result-adventure-icon"><i class="fa-solid ${icon}"></i></div>
    <p class="result-detail result-detail--count">${message}</p>
  `;

  // sur l'écran résultat spécifiquement, ce bouton ramène en réalité à la zone, pas à l'accueil
  els.backHomeBtn.textContent = "Retour à QCM aventure";

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
   8. PARTAGE DU SCORE
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
   9. ABANDON DU QCM
   ========================================================= */

function openAbandonModal() {
  els.abandonModal.classList.remove("hidden");
}
function closeAbandonModal() {
  els.abandonModal.classList.add("hidden");
}
/*
  Retour après un QCM (bouton "Revenir à l'accueil" ou abandon confirmé) :
  pour le mode Aventure, on revient à l'écran des zones (qui rouvre
  automatiquement la zone en cours) plutôt qu'à l'accueil général.
*/
function goBackAfterQuiz() {
  resetQuizVisuals();
  if (currentQuizType === "adventure") {
    showScreen("adventure");
    renderAdventureScreen();
  } else {
    showScreen("home");
    renderHomeScreen();
  }
}

function confirmAbandon() {
  closeAbandonModal();
  goBackAfterQuiz();
}

/* =========================================================
   10. RÉINITIALISATION DES DONNÉES
   ========================================================= */

function openResetModal() {
  els.resetModal.classList.remove("hidden");
}
function closeResetModal() {
  els.resetModal.classList.add("hidden");
}
function confirmReset() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(ADVENTURE_STORAGE_KEY);
  closeResetModal();
  toggleBurgerMenu(); // referme aussi le menu burger
  adventureOpenZoneId = null;
  renderHomeScreen();
}

/* =========================================================
   11. MENU BURGER
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
   12. ÉVÉNEMENTS
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
    renderHomeScreen();
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

  els.adventureQuizBtn.addEventListener("click", () => {
    showScreen("adventure");
    renderAdventureScreen();
  });

  els.adventureBackBtn.addEventListener("click", () => {
    showScreen("select");
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
    if (currentQuizType === "adventure") {
      startAdventureSquare(currentAdventureZoneId, currentAdventureSquareId);
    } else {
      startQuiz(currentQuizType);
    }
  });
  els.backHomeBtn.addEventListener("click", goBackAfterQuiz);
}

/* =========================================================
   13. INITIALISATION
   ========================================================= */

async function init() {
  bindEvents();
  await Promise.all([loadQuestions(), loadAdventureData()]);
  renderHomeScreen();
  showScreen("home");
}

init();
