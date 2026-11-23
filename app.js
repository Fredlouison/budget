/* Budget — appli web hors connexion (v1)
 * Données : copie locale (localStorage) + file d'attente des modifications,
 * synchronisée avec le script Apps Script du classeur « Budget – Base ».
 */
'use strict';

const VERSION_APP = '1.45.0';
const VERSION_SCRIPT_ATTENDUE = '2.5.0';
const LS = { config: 'budget.config', data: 'budget.data', outbox: 'budget.outbox', local: 'budget.local' };
const CLES = {
  Operations: ['id'], Series: ['id'], Comptes: ['nom'], Arretes: ['compte', 'annee', 'mois'],
  Categories: ['categorie', 'sous_categorie'], Enseignes: ['enseigne'], Paiements: ['paiement'],
  Favoris: ['id'], Parametres: ['cle']
};
const INTERVALLES = { MENSUEL: 1, BIMESTRIEL: 2, TRIMESTRIEL: 3, QUADRIMESTRIEL: 4, SEMESTRIEL: 6, ANNUEL: 12 };
// Objectif « niveau 2 » validé le 18/11/2026 (montants annuels, modifiables dans Réglages > Budget).
const BUDGET_DEFAUT = { Maison: 12800, Fred: 9750, Vacances: 4000, Voiture: 4700, Alimentation: 4000, Virgil: 4800, 'Numérique': 1200 };
const BUDGET_HORS_DEFAUT = 'Maman;Fred/Divorce';
let moisBudget = null;
let sousVueBudget = 'mois';
const COULEURS_STATS = ['#00ff7f', '#00b4ff', '#ff4d6d', '#ffd60a', '#b26bff', '#ff8c42', '#2ee6d6', '#ff5fd2'];
let statCategorieOuverte = '';
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function lire(cle, defaut) {
  try { const v = localStorage.getItem(cle); return v ? JSON.parse(v) : defaut; } catch (e) { return defaut; }
}
function ecrire(cle, v) {
  try { localStorage.setItem(cle, JSON.stringify(v)); } catch (e) { toast('Stockage local plein : ' + e.message, true); }
}

let config = lire(LS.config, { url: '', token: '' });
let data = lire(LS.data, null);
let outbox = lire(LS.outbox, []);
let local = lire(LS.local, { derniereDate: '', derniereDateTs: 0, vacances: false, derniereSync: '' });
let vueCourante = 'accueil';
let moisJournal = null;
let syncEnCours = false;
let derniereErreur = '';
let avertiScript = false;
let edition = null;   // opération en cours de modification
let ticketEdition = null;   // ticket ventilé modifié en entier : { groupe, ids }
let typeCourant = 'DEPENSE';
let favorisOuverts = false;
let idsSurlignes = new Set();
let groupesOuverts = new Set();
let positionJournal = null;   // position du journal quand on ouvre une ligne pour la modifier
const sortants = new Map();   // lignes qui viennent de changer de pointage : visibles encore un instant
const FILTRES_POINTAGE = { toutes: ['Toutes les opérations'], apointer: ['À pointer'], pointees: ['Pointées'] };
const ICONE_DRAPEAU = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 21V4m0 0h11l-2 4 2 4H5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>';
const ICONE_FILTRE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3.5 5h17l-6.5 7.6V19l-4 1.8v-8.2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';   // dépenses ventilées dépliées dans le journal   // lignes à mettre en évidence dans le journal après un enregistrement

function videData() {
  const d = {}; Object.keys(CLES).forEach(t => { d[t] = []; }); return d;
}
if (!data) data = videData();


/* ================= Outils ================= */

const pad = n => String(n).padStart(2, '0');
function aujourdhui() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function ymd(y, m, j) { return y + '-' + pad(m) + '-' + pad(j); }
function joursDansMois(y, m) { return new Date(y, m, 0).getDate(); }
function decalerJours(iso, n) {
  const [y, m, d] = iso.split('-').map(Number); const x = new Date(y, m - 1, d + n);
  return ymd(x.getFullYear(), x.getMonth() + 1, x.getDate());
}
function nouvelId() {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}
const fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
function euros(v) { return fmt.format(Number(v) || 0); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function trierFr(liste) { return liste.slice().sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' })); }
function param(cle) { const p = (data.Parametres || []).find(x => x.cle === cle); return p ? p.valeur : ''; }

/** Couleur d'un compte (paramètre « couleur:<nom> »), et sa version très claire pour le fond des lignes. */
/** Part de l'utilisateur dans les dépenses d'un compte partagé (paramètre « part:<compte> », 100 % par défaut). */
function partCompte(nom) { const v = Number(String(param('part:' + nom) || '').replace(',', '.')); return v > 0 && v <= 100 ? v / 100 : 1; }
function couleurCompte(nom) { return param('couleur:' + nom) || ''; }
/** Liseré gauche en couleur pleine du compte. */
function liseret(nom) { const c = couleurCompte(nom); return c ? 'border-left:5px solid ' + c + ';' : ''; }
function styleCase(nom) { const c = couleurCompte(nom); return c ? ' style="accent-color:' + esc(c) + '"' : ''; }
function fondCompte(nom) {
  const c = couleurCompte(nom);
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (!m) return '';
  const base = [18, 21, 25];   // couleur des cartes (thème sombre)
  const teinte = (h, i) => Math.round(base[i] + (parseInt(h, 16) - base[i]) * 0.18);   // 18 % de la couleur sur la carte
  return 'rgb(' + teinte(m[1], 0) + ',' + teinte(m[2], 1) + ',' + teinte(m[3], 2) + ')';
}

/** Première lettre de chaque mot en majuscule (le reste est laissé tel quel). */
function majusculesMots(texte) {
  return String(texte || '').replace(/(^|[\s\-\/(])(\p{Ll})/gu, (m, avant, lettre) => avant + lettre.toUpperCase());
}
function majusculesChamp(champ) {
  const v = majusculesMots(champ.value);
  if (v === champ.value) return;
  const debut = champ.selectionStart, fin = champ.selectionEnd;
  champ.value = v;
  try { champ.setSelectionRange(debut, fin); } catch (e) { /* champ sans curseur */ }
}

/** Montant saisi : accepte « 12,50 », « =12,5+3,20 », « 10*3 ». */
function calculer(texte) {
  const expr = String(texte || '').trim().replace(/^=/, '').replace(/\s/g, '').replace(/,/g, '.');
  if (!expr) return null;
  if (!/^[0-9+\-*/().]+$/.test(expr)) throw new Error('Montant invalide');
  const r = Function('"use strict";return (' + expr + ')')();
  if (typeof r !== 'number' || !isFinite(r)) throw new Error('Montant invalide');
  return Math.round((r + Number.EPSILON) * 100) / 100;
}

let minuterieToast = null;
function toast(msg, erreur) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (erreur ? ' erreur' : ''); t.hidden = false;
  clearTimeout(minuterieToast); minuterieToast = setTimeout(() => { t.hidden = true; }, erreur ? 5000 : 2200);
}


/* ================= Données locales et synchronisation ================= */

function cleDe(table, o) { return CLES[table].map(k => String(o[k] == null ? '' : o[k]).trim().toLowerCase()).join('|'); }

function appliquerLocal(m) {
  const liste = data[m.table] || (data[m.table] = []);
  const k = cleDe(m.table, m.data);
  const i = liste.findIndex(x => cleDe(m.table, x) === k);
  if (m.op === 'delete') { if (i !== -1) liste.splice(i, 1); return; }
  if (i !== -1) liste[i] = Object.assign({}, liste[i], m.data); else liste.push(Object.assign({}, m.data));
}

function modifier(mutations) {
  mutations.forEach(appliquerLocal);
  outbox.push(...mutations);
  ecrire(LS.data, data); ecrire(LS.outbox, outbox);
  rendre();
  synchroniser();
}

async function api(action, charge) {
  if (!config.url || !config.token) throw new Error('Connexion non configurée (onglet Réglages).');
  const arret = new AbortController();
  const minuterie = setTimeout(() => arret.abort(), 20000);   // un réseau mobile peut « pendre » : on abandonne au bout de 20 s
  const rep = await fetch(config.url, {
    method: 'POST', redirect: 'follow', signal: arret.signal,
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ token: config.token, action: action }, charge || {}))
  });
  clearTimeout(minuterie);
  if (!rep.ok) throw new Error('Serveur : HTTP ' + rep.status);
  const json = await rep.json();
  if (!json.ok) throw new Error(json.error || 'Erreur serveur');
  return json.data;
}

async function synchroniser() {
  if (syncEnCours || !config.url) { majEtatSync(); return; }
  if (!navigator.onLine) { majEtatSync(); return; }
  syncEnCours = true; majEtatSync();
  try {
    while (outbox.length) {
      const lot = outbox.slice(0, 300);
      await api('push', { mutations: lot });
      outbox.splice(0, lot.length);
      ecrire(LS.outbox, outbox);
    }
    const frais = await api('bootstrap');
    if (String(frais.version || '') < VERSION_SCRIPT_ATTENDUE && !avertiScript) {
      avertiScript = true;
      toast('Le script Google doit être mis à jour (version ' + VERSION_SCRIPT_ATTENDUE + ') : voir Réglages.', true);
    }
    data = frais;
    outbox.forEach(appliquerLocal);       // saisies faites pendant la synchro
    ecrire(LS.data, data);
    local.derniereSync = new Date().toISOString(); ecrire(LS.local, local);
    derniereErreur = '';
    migrerPrintyshirt();
    majEtatSync();
    rendre();
  } catch (e) {
    derniereErreur = (e instanceof TypeError || e.name === 'AbortError') ? 'Pas de réseau' : e.message;
    majEtatSync(derniereErreur);
    if (vueCourante === 'reglages') rendreReglages(e.message);
  } finally {
    syncEnCours = false; majEtatSync(derniereErreur);
    if (outbox.length && navigator.onLine) setTimeout(synchroniser, derniereErreur ? 30000 : 300);   // saisie faite pendant la synchro : on renvoie tout de suite
  }
}

function majEtatSync(erreur) {
  const b = $('#etatSync');
  b.classList.remove('ok', 'attente', 'erreur', 'encours');
  if (syncEnCours) { b.classList.add('encours'); b.title = 'Synchronisation…'; }
  if (!config.url) { b.textContent = '● non connecté'; b.classList.add('erreur'); return; }
  if (outbox.length) { b.textContent = '● ' + outbox.length + ' en attente'; b.classList.add('attente'); b.title = erreur || 'À envoyer'; return; }
  if (erreur) { b.textContent = '● erreur'; b.classList.add('erreur'); b.title = erreur; return; }
  if (!navigator.onLine) { b.textContent = '● hors ligne'; b.classList.add('attente'); return; }
  b.textContent = '●'; b.classList.add('ok'); b.title = 'À jour';
}


/* ================= Calculs de soldes ================= */

/** Pointage côté arrivée d'un virement (vide = même état que le côté départ, pour les anciens virements). */
function estPointeVers(o) {
  const v = o.pointe_vers;
  if (v === undefined || v === null || v === '') return !!o.pointe;
  return v === true || String(v).toLowerCase() === 'true';
}
/** Une opération est-elle pointée pour ce compte ? */
function pointePour(o, compte) {
  if (o.type === 'VIREMENT' && o.compte_vers === compte && o.compte !== compte) return estPointeVers(o);
  return !!o.pointe;
}

function mouvement(o, compte) {
  const m = Number(o.montant) || 0;
  if (o.type === 'VIREMENT') return (o.compte === compte ? -Math.abs(m) : 0) + (o.compte_vers === compte ? Math.abs(m) : 0);
  return o.compte === compte ? m : 0;
}

/** Reproduit les colonnes de l'ancien classeur : Aujourd'hui, Fin de mois, Engagé M+1, Différence, Pointé. */
function soldesCompte(c, jour) {
  const y = Number(jour.slice(0, 4)), m = Number(jour.slice(5, 7));
  const arr = data.Arretes.find(a => a.compte === c.nom && Number(a.annee) === y && Number(a.mois) === m);
  const dateArrete = ymd(y, m, Math.min(arr ? Number(arr.jour) : 31, joursDansMois(y, m)));
  const finMois = ymd(y, m, joursDansMois(y, m));
  const ym1 = m === 12 ? [y + 1, 1] : [y, m + 1];
  const debutSuiv = ymd(ym1[0], ym1[1], 1), finSuiv = ymd(ym1[0], ym1[1], joursDansMois(ym1[0], ym1[1]));
  const depuis = String(c.date_solde || '');
  const base = Number(c.solde_initial) || 0;
  let pointeArrete = 0, nonPointeJour = 0, nonPointeFinMois = 0, pointeJour = 0, pointeTotal = 0, engage = 0, finAnnee = 0;
  let utilise = false;
  for (const o of data.Operations) {
    if (o.date <= depuis) continue;
    const mv = mouvement(o, c.nom);
    if (!mv) continue;
    utilise = true;
    if (pointePour(o, c.nom)) {
      if (o.date <= dateArrete) pointeArrete += mv;
      if (o.date <= jour) pointeJour += mv;
      pointeTotal += mv;
    } else {
      if (o.date <= jour) nonPointeJour += mv;
      if (o.date <= finMois) nonPointeFinMois += mv;
    }
    if (o.date >= debutSuiv && o.date <= finSuiv && mv < 0) engage += mv;
    if (o.date <= y + '-12-31') finAnnee += mv;
  }
  const r = v => Math.round(v * 100) / 100;
  const fin = base + pointeArrete + nonPointeFinMois;
  return {
    aujourdhui: r(base + pointeArrete + nonPointeJour), finMois: r(fin), engage: r(engage),
    difference: r(fin + engage), pointe: r(base + pointeJour), pointeTotal: r(base + pointeTotal), finAnnee: r(base + finAnnee),
    utilise: utilise || Math.abs(base) > 0.004
  };
}


/* ================= Rendu ================= */

function rendre() {
  if (vueCourante === 'accueil') rendreAccueil();
  if (vueCourante === 'journal') rendreJournal();
  if (vueCourante === 'reglages') rendreReglages();
  if (vueCourante === 'stats') rendreStats();
  if (vueCourante === 'budget') { rendreBudget(); if (sousVueBudget === 'prevision') rendrePrevision(); }
  majEtatSync();
}

function afficherVue(vue) {
  vueCourante = vue;
  $$('.vue').forEach(s => { s.hidden = s.id !== 'vue-' + vue; });
  $$('.onglets button').forEach(b => b.classList.toggle('actif', b.dataset.vue === vue));
  document.body.classList.toggle('saisie', vue === 'saisie');
  $('#oeilSoldes').hidden = vue !== 'accueil';
  $('#titre').textContent = { accueil: 'Soldes', journal: 'Journal', saisie: ticketEdition ? 'Modifier le ticket' : edition ? 'Modifier' : 'Nouvelle opération', reglages: 'Réglages', stats: 'Statistiques', budget: 'Budget' }[vue];
  window.scrollTo(0, 0);
  rendre();
}

function rendreAccueil() {
  const jour = aujourdhui();
  if (!data.Comptes.length) {
    $('#total').innerHTML = '<span class="discret">Aucune donnée. Renseigne la connexion dans l\'onglet Réglages.</span>';
    $('#comptes').innerHTML = ''; $('#autresComptes').hidden = true; return;
  }
  const comptes = data.Comptes.filter(c => c.actif !== false).sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
  const calcules = comptes.map(c => ({ c, s: soldesCompte(c, jour) }));
  // Comptes totalisés : choix mémorisé (par défaut, tous).
  const choixTotal = Array.isArray(local.comptesTotal) ? local.comptesTotal : null;
  const total = calcules.filter(x => !choixTotal || choixTotal.indexOf(x.c.nom) !== -1).reduce((t, x) => t + x.s.aujourdhui, 0);
  const totalises = calcules.filter(x => !choixTotal || choixTotal.indexOf(x.c.nom) !== -1);
  const somme = cle => totalises.reduce((t, x) => t + x.s[cle], 0);
  const maintenant = new Date();
  const moisSuivCourt = new Date(maintenant.getFullYear(), maintenant.getMonth() + 1, 1).toLocaleDateString('fr-FR', { month: 'short' });
  const classeMontant = v => v < 0 ? 'neg' : '';
  const dateLongue = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  // Bloc héros : total des comptes choisis + résumé fin de mois / engagé / pointé
  $('#total').innerHTML =
    '<div class="hero-ligne"><span class="hero-lib"><span class="date-longue">Total aujourd\'hui</span><span class="date-courte">Total</span></span>' +
      '<span class="hero-montant ' + classeMontant(total) + '">' + euros(total) + '</span>' +
      '<span class="hero-date"><span class="date-longue">' + dateLongue + '</span><span class="date-courte">' +
      new Date().toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) + '</span></span></div>' +
    '<div class="hero-bas">' +
      '<div><span>Fin de mois</span><b class="' + classeMontant(somme('finMois')) + '">' + euros(somme('finMois')) + '</b></div>' +
      '<div><span>Engagé ' + moisSuivCourt + '</span><b class="neg">' + euros(somme('engage')) + '</b></div>' +
      '<div><span>Pointé</span><b>' + euros(somme('pointe')) + '</b></div>' +
    '</div>' +
    '<div class="hero-note">' + totalises.length + ' compte' + (totalises.length > 1 ? 's' : '') + ' · toucher pour choisir</div>';
  $('#total').onclick = ouvrirChoixTotal;

  // Carte de compte : pastille + nom, solde du jour, 4 indicateurs, halo de la couleur du compte
  const carte = ({ c, s }) => {
    const coul = couleurCompte(c.nom);
    return '<div class="carte compte-carte" data-compte="' + esc(c.nom) + '"' + (coul ? ' style="--c:' + esc(coul) + '"' : '') + '>' +
      '<div class="entete"><span class="nom"><i class="pastille-compte"></i>' + esc(c.nom) + '</span>' +
      '<span class="montant-carte ' + classeMontant(s.aujourdhui) + '">' + euros(s.aujourdhui) + '</span></div>' +
      '<div class="metriques">' +
        '<div><span>Fin de mois</span><b class="' + classeMontant(s.finMois) + '">' + euros(s.finMois) + '</b></div>' +
        '<div><span>Engagé ' + moisSuivCourt + '</span><b class="' + (s.engage < 0 ? 'neg' : '') + '">' + euros(s.engage) + '</b></div>' +
        '<div><span>Différence</span><b class="' + (s.difference < 0 ? 'neg' : 'pos') + '">' + euros(s.difference) + '</b></div>' +
        '<div><span>Pointé</span><b>' + euros(s.pointe) + '</b></div>' +
      '</div></div>';
  };
  // Autres comptes : liste compacte
  const ligneAutre = ({ c, s }) => {
    const coul = couleurCompte(c.nom);
    return '<div class="ligne-autre"' + (coul ? ' style="--c:' + esc(coul) + '"' : '') + '><span class="nom"><i class="pastille-compte"></i>' + esc(c.nom) + '</span>' +
      '<span class="pointe-autre">pointé ' + euros(s.pointe) + '</span><b class="' + classeMontant(s.aujourdhui) + '">' + euros(s.aujourdhui) + '</b></div>';
  };

  // 4 cartes choisies par l'utilisateur (par défaut : les plus utilisées) ; les autres comptes en dessous.
  const nomsCartes = comptesTuiles('tuilesAccueil', 4);
  const principaux = nomsCartes.map(n => calcules.find(x => x.c.nom === n)).filter(Boolean);
  const autres = calcules.filter(x => principaux.indexOf(x) === -1 && (x.s.utilise || Math.abs(x.s.aujourdhui) > 0.004));
  $('#comptes').innerHTML = principaux.map(carte).join('');
  $('#autresComptes').hidden = !autres.length;
  $('#autresComptes > summary').textContent = 'Autres comptes (' + autres.length + ') · ' + euros(autres.reduce((t, x) => t + x.s.aujourdhui, 0));
  $('#autresComptes > div').innerHTML = autres.map(ligneAutre).join('');
  $$('#comptes .compte-carte').forEach((el, i) => el.onclick = () => ouvrirChoixCompte(i, 'tuilesAccueil', 4));
}

/** Comptes affichés en tuiles (journal : 3, accueil : 4) : choix mémorisé, sinon les plus utilisés ces 3 derniers mois. */
function comptesTuiles(cle, nombre) {
  cle = cle || 'tuiles'; nombre = nombre || 3;
  const noms = data.Comptes.filter(c => c.actif !== false).map(c => c.nom);
  const choix = (local[cle] || []).filter(n => noms.indexOf(n) !== -1).slice(0, nombre);
  if (choix.length === nombre) return choix;
  const depuis = decalerJours(aujourdhui(), -92), usage = {};
  data.Operations.forEach(o => { if (o.date >= depuis) { usage[o.compte] = (usage[o.compte] || 0) + 1; if (o.compte_vers) usage[o.compte_vers] = (usage[o.compte_vers] || 0) + 1; } });
  const parUsage = noms.slice().sort((a, b) => (usage[b] || 0) - (usage[a] || 0));
  parUsage.forEach(n => { if (choix.length < nombre && choix.indexOf(n) === -1) choix.push(n); });
  return choix;
}

let dernieresValeursTuiles = {};
const ICONE_FILTRE_TUILE = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3 5h18l-7 8.5V19l-4 2v-7.5z" fill="currentColor"/></svg>';
const ICONE_CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Solde pointé d'un compte à une date : solde de départ + mouvements pointés jusqu'à cette date incluse. */
function pointeAu(c, jour) {
  const depuis = String(c.date_solde || '');
  let v = Number(c.solde_initial) || 0;
  for (const o of data.Operations) {
    if (o.date <= depuis || o.date > jour) continue;
    const mv = mouvement(o, c.nom);
    if (mv && pointePour(o, c.nom)) v += mv;
  }
  return Math.round(v * 100) / 100;
}

// Solde affiché dans les tuiles du journal : réel (aujourd'hui), fin du mois affiché, ou pointé.
// Mobile : fin de mois à chaque ouverture, balayage gauche/droite pour changer. PC : pointé par défaut, choix mémorisé.
const MODES_TUILES = ['reel', 'fin', 'pointe'];
let modeTuilesMobile = 'fin';
const estMobile = () => window.matchMedia('(max-width: 699px)').matches;
const modeTuiles = () => estMobile() ? modeTuilesMobile : (MODES_TUILES.includes(local.modeTuilesPC) ? local.modeTuilesPC : 'pointe');
function libelleModeTuiles(mode, y, m) {
  if (mode === 'reel') return 'réel';
  if (mode === 'pointe') return 'pointé';
  return 'fin ' + new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'short' });
}
function valeurTuile(c, mode, y, m) {
  const jour = aujourdhui();
  if (mode === 'reel') return soldesCompte(c, jour).aujourdhui;
  if (mode === 'pointe') return soldesCompte(c, jour).pointeTotal;
  const fin = ymd(y, m, joursDansMois(y, m));
  return jour.slice(0, 7) === fin.slice(0, 7) ? soldesCompte(c, jour).finMois : soldesCompte(c, fin).aujourdhui;
}
function changerModeTuiles(mode, sens) {
  if (estMobile()) modeTuilesMobile = mode; else { local.modeTuilesPC = mode; ecrire(LS.local, local); }
  rendreTuiles();
  const t = $('#tuilesPointage');
  if (sens) { t.classList.remove('glisse-g', 'glisse-d'); void t.offsetWidth; t.classList.add(sens > 0 ? 'glisse-g' : 'glisse-d'); }
}
function menuModeTuiles(ancre) {
  fermerMenuModeTuiles();
  const [y, m] = moisJournal || [Number(aujourdhui().slice(0, 4)), Number(aujourdhui().slice(5, 7))];
  const noms = { reel: 'Réel (aujourd\'hui)', fin: 'Fin de mois (' + MOIS[m - 1] + ')', pointe: 'Pointé' };
  const menu = document.createElement('div');
  menu.className = 'menu-mode-tuiles'; menu.id = 'menuModeTuiles';
  menu.innerHTML = MODES_TUILES.map(md => '<button type="button" data-mode="' + md + '" class="' + (md === modeTuiles() ? 'actif' : '') + '">' + noms[md] + '</button>').join('');
  document.body.appendChild(menu);
  const r = ancre.getBoundingClientRect();
  menu.style.left = Math.min(window.innerWidth - menu.offsetWidth - 8, Math.max(8, r.left)) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
  menu.onclick = e => { const b = e.target.closest('[data-mode]'); if (b) { fermerMenuModeTuiles(); changerModeTuiles(b.dataset.mode); } };
  setTimeout(() => document.addEventListener('click', fermerMenuModeTuiles, { once: true }), 0);
}
function fermerMenuModeTuiles() { const mn = $('#menuModeTuiles'); if (mn) mn.remove(); }

function rendreTuiles() {
  const jour = aujourdhui();
  const noms = comptesTuiles();
  const filtre = $('#filtreCompte').value;
  const [y, m] = moisJournal || [Number(jour.slice(0, 4)), Number(jour.slice(5, 7))];
  const finMois = ymd(y, m, joursDansMois(y, m));
  const mode = modeTuiles(), libMode = libelleModeTuiles(mode, y, m);
  const libFin = '<span class="long">pointé au ' + joursDansMois(y, m) + ' ' + MOIS[m - 1] + '</span><span class="court">pointé ' + joursDansMois(y, m) + '/' + String(m).padStart(2, '0') + '</span>';
  $('#tuilesPointage').innerHTML = noms.map((nom, i) => {
    const c = data.Comptes.find(x => x.nom === nom);
    const actif = filtre === nom;
    const v = c ? (actif ? pointeAu(c, finMois) : valeurTuile(c, mode, y, m)) : 0;
    const change = dernieresValeursTuiles[i] !== undefined && dernieresValeursTuiles[nom + i] !== v;
    dernieresValeursTuiles[i] = true; dernieresValeursTuiles[nom + i] = v;
    const coul = couleurCompte(nom);
    const classes = 'tuile' + (change ? ' maj' : '') + (actif ? ' filtree' : '') + (filtre && !actif ? ' estompee' : '');
    return '<button type="button" class="' + classes + '" data-index="' + i + '" data-nom="' + esc(nom) + '"' + (coul ? ' style="--c:' + esc(coul) + '"' : '') +
      ' aria-pressed="' + actif + '" title="' + (actif ? 'Afficher tous les comptes' : 'N\'afficher que ' + esc(nom)) + '">' +
      (actif ? '<span class="marque-filtre">' + ICONE_FILTRE_TUILE + '</span>' : '') +
      '<span class="n"><i class="pastille-compte"></i><span class="nom-tuile">' + esc(nom) + '</span>' +
      '<span class="changer-compte" role="button" tabindex="0" aria-label="Changer de compte" title="Changer de compte">' + ICONE_CHEVRON + '</span></span>' +
      '<span class="v' + (v < 0 ? ' neg' : '') + '">' + euros(v) + '</span><span class="p">' + (actif ? libFin : '<span class="mode-tuile" role="button" tabindex="0" title="Choisir le solde affiché">' + libMode + '<i class="fl-mode">▾</i></span>') + '</span></button>';
  }).join('') + '<div class="pager-tuiles" aria-hidden="true">' + MODES_TUILES.map(md => '<i class="' + (md === mode ? 'actif' : '') + '"></i>').join('') + '</div>';
  $$('#tuilesPointage .mode-tuile').forEach(el => el.onclick = e => { e.stopPropagation(); e.preventDefault(); menuModeTuiles(el); });
  const zone = $('#tuilesPointage');
  if (!zone.dataset.balayage) {
    zone.dataset.balayage = '1';
    let x0 = null, y0 = 0;
    zone.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    zone.addEventListener('touchend', e => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      zone.dataset.balaye = Date.now();
      const i = MODES_TUILES.indexOf(modeTuiles()), j = Math.max(0, Math.min(MODES_TUILES.length - 1, i + (dx < 0 ? 1 : -1)));
      if (j !== i) changerModeTuiles(MODES_TUILES[j], dx < 0 ? 1 : -1);
    }, { passive: true });
  }
  $$('#tuilesPointage .tuile').forEach(t => t.onclick = () => {
    if (Date.now() - Number(zone.dataset.balaye || 0) < 400) return;   // fin d'un balayage : pas un appui
    $('#filtreCompte').value = $('#filtreCompte').value === t.dataset.nom ? '' : t.dataset.nom;
    rendreJournal();
  });
  $$('#tuilesPointage .changer-compte').forEach(b => {
    const ouvrir = e => { e.stopPropagation(); e.preventDefault(); ouvrirChoixCompte(Number(b.closest('.tuile').dataset.index)); };
    b.onclick = ouvrir;
    b.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') ouvrir(e); };
  });
}

/** Fenêtre de choix des comptes additionnés dans la tuile Total (cases à cocher). */
function ouvrirChoixTotal() {
  const jour = aujourdhui();
  const comptes = data.Comptes.filter(c => c.actif !== false).sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
  const choix = Array.isArray(local.comptesTotal) ? local.comptesTotal : comptes.map(c => c.nom);
  $('#titreChoix').textContent = 'Comptes à totaliser';
  $('#fermerChoix').textContent = 'OK';
  $('#listeChoixComptes').innerHTML = comptes.map(c =>
    '<label class="choix coche"><input type="checkbox" value="' + esc(c.nom) + '"' + (choix.indexOf(c.nom) !== -1 ? ' checked' : '') + '>' +
    '<span>' + esc(c.nom) + '</span><b>' + euros(soldesCompte(c, jour).aujourdhui) + '</b></label>').join('');
  $$('#listeChoixComptes input').forEach(cb => cb.onchange = () => {
    local.comptesTotal = $$('#listeChoixComptes input').filter(x => x.checked).map(x => x.value);
    ecrire(LS.local, local);
    rendreAccueil();
  });
  $('#choixCompte').hidden = false;
}

/** Fenêtre de choix du compte d'une tuile. cle = 'tuiles' (journal) ou 'tuilesAccueil'. */
function ouvrirChoixCompte(index, cle, nombre) {
  cle = cle || 'tuiles'; nombre = nombre || 3;
  $('#titreChoix').textContent = 'Afficher quel compte ?';
  $('#fermerChoix').textContent = 'Annuler';
  const actuels = comptesTuiles(cle, nombre), jour = aujourdhui();
  const valeur = c => { const s = soldesCompte(c, jour); return cle === 'tuiles' ? s.pointeTotal : s.aujourdhui; };
  const comptes = data.Comptes.filter(c => c.actif !== false).sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
  $('#listeChoixComptes').innerHTML = comptes.map(c =>
    '<button type="button" class="choix' + (c.nom === actuels[index] ? ' courant' : '') + '" data-nom="' + esc(c.nom) + '">' +
    '<span>' + esc(c.nom) + '</span><b>' + euros(valeur(c)) + '</b></button>').join('');
  $$('#listeChoixComptes .choix').forEach(b => b.onclick = () => {
    const nouveaux = actuels.slice();
    const ailleurs = nouveaux.indexOf(b.dataset.nom);
    if (ailleurs !== -1 && ailleurs !== index) nouveaux[ailleurs] = nouveaux[index];   // échange si déjà affiché ailleurs
    nouveaux[index] = b.dataset.nom;
    local[cle] = nouveaux; ecrire(LS.local, local);
    $('#choixCompte').hidden = true;
    rendre();
  });
  $('#choixCompte').hidden = false;
}

function libelleMois(y, m) { return MOIS[m - 1] + ' ' + y; }

function garderUnInstant(ids) {
  if ((local.filtrePointage || 'toutes') === 'toutes') return;
  const fin = Date.now() + 2500;
  ids.forEach(id => sortants.set(id, fin));
  setTimeout(() => { if (vueCourante === 'journal') rendreJournal(); }, 2600);
}

function rendreJournal() {
  if (!moisJournal) { const j = aujourdhui(); moisJournal = [Number(j.slice(0, 4)), Number(j.slice(5, 7))]; }
  const [y, m] = moisJournal;
  // Mois : libellé long sur PC, court sur mobile (« nov. 2026 »)
  $('#moisLibelle').textContent = window.matchMedia('(max-width: 699px)').matches
    ? new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })
    : libelleMois(y, m);

  const sel = $('#filtreCompte'), choix = sel.value;
  sel.innerHTML = '<option value="">Tous les comptes</option>' +
    data.Comptes.map(c => '<option>' + esc(c.nom) + '</option>').join('');
  sel.value = choix;
  const compte = sel.value;
  rendreTuiles();
  const q = $('#recherche').value.trim().toLowerCase();
  const prefixe = ymd(y, m, 1).slice(0, 7);

  let ops = data.Operations.filter(o =>
    (q ? true : o.date.slice(0, 7) === prefixe) &&
    (!compte || o.compte === compte || o.compte_vers === compte) &&
    (!q || [o.designation, o.enseigne, o.categorie, o.sous_categorie, o.commentaire, o.compte, String(o.montant)].join(' ').toLowerCase().includes(q)));
  // Filtre de pointage (◐ toutes / ○ à pointer / ● pointées)
  const fp = local.filtrePointage || 'toutes';
  const btnF = $('#filtrePointage');
  if (!btnF.firstElementChild) btnF.innerHTML = ICONE_FILTRE;
  btnF.title = 'Filtre : ' + FILTRES_POINTAGE[fp][0] + ' (toucher pour changer)';
  btnF.setAttribute('aria-label', btnF.title);
  btnF.dataset.etat = fp;
  btnF.classList.toggle('actif', fp !== 'toutes');
  if (fp !== 'toutes') {
    const maintenantMs = Date.now();
    const estP = o => {
      if (o.groupe) return data.Operations.filter(x => x.groupe === o.groupe).every(x => x.pointe);
      if (o.type === 'VIREMENT') return compte ? pointePour(o, compte) : (!!o.pointe && estPointeVers(o));
      return !!o.pointe;
    };
    ops = ops.filter(o => (fp === 'pointees' ? estP(o) : !estP(o)) || (sortants.get(o.id) || 0) > maintenantMs);
  }
  ops.sort((a, b) => b.date.localeCompare(a.date) || a.designation.localeCompare(b.designation, 'fr'));
  if (q) ops = ops.slice(0, 300);

  let dep = 0, rec = 0;
  const cats = {};
  ops.forEach(o => {
    if (o.type === 'VIREMENT') return;
    const v = Number(o.montant) || 0;
    if (v < 0) { dep += v; cats[o.categorie || '—'] = (cats[o.categorie || '—'] || 0) - v; } else rec += v;
  });
  $('#resumeMois').innerHTML = '<span>Dépenses <b class="neg">' + euros(dep) + '</b></span><span>Recettes <b class="pos">' +
    euros(rec) + '</b></span><span>Solde <b>' + euros(dep + rec) + '</b></span>';
  const maxCat = Math.max(1, ...Object.values(cats));
  $('#parCategorie > div').innerHTML = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, v]) =>
    '<div class="barre-cat"><span>' + esc(c) + '</span><span class="jauge"><i style="width:' + (v / maxCat * 100).toFixed(1) + '%"></i></span><span class="v">' + euros(v) + '</span></div>'
  ).join('') || '<p class="discret">Aucune dépense.</p>';

  const jour = aujourdhui();

  // Une dépense ventilée = une seule ligne (enseigne + intitulé + total), dépliable.
  const elements = [], vus = {};
  ops.forEach(o => {
    if (!o.groupe) { elements.push({ op: o }); return; }
    if (vus[o.groupe]) return;
    vus[o.groupe] = true;
    const enfants = data.Operations.filter(x => x.groupe === o.groupe).sort((a, b) => a.designation.localeCompare(b.designation, 'fr'));
    elements.push({ groupe: o.groupe, op: o, enfants });
  });

  // Titre : « Enseigne — Désignation » (sauf détail d'un ticket ventilé, dont l'enseigne est déjà dans l'en-tête).
  const titreOp = (o, extra) => {
    const d = o.designation || o.sous_categorie || '';
    // Vacances : « LIEU — Enseigne — Sous-catégorie »
    const lieu = extra ? '' : lieuVacances(o);
    if (lieu) return [lieu, o.enseigne, o.sous_categorie].filter(Boolean).join(' — ');
    if (extra || o.type === 'VIREMENT' || !o.enseigne) return d || o.enseigne || '';
    if (!d || d.toLowerCase() === String(o.enseigne).toLowerCase()) return o.enseigne;
    return o.enseigne + ' — ' + d;
  };
  const ligneOp = (o, extra) => {
    const v = Number(o.montant) || 0;
    let montantAffiche = v, classe = v < 0 ? 'neg' : 'pos';
    if (o.type === 'VIREMENT') {
      montantAffiche = compte ? (o.compte === compte ? -Math.abs(v) : Math.abs(v)) : Math.abs(v);
      classe = compte ? (montantAffiche < 0 ? 'neg' : 'pos') : '';
    }
    const sous = o.type === 'VIREMENT'
      ? 'Virement · ' + esc(o.compte) + ' → ' + esc(o.compte_vers)
      : esc([o.categorie, o.sous_categorie].filter(Boolean).join(' › ')) + (extra ? '' : ' · ' + esc(o.compte) + (o.paiement ? ' · ' + esc(o.paiement) : ''));
    const vir = o.type === 'VIREMENT';
    // Virement : fond neutre, liseré du départ à gauche et de l'arrivée à droite, une case de chaque côté.
    const fond = vir ? '' : fondCompte(o.compte);
    const caseDepart = '<input type="checkbox" class="coche" data-cote="depart" ' + (o.pointe ? 'checked' : '') + styleCase(o.compte) + ' title="Pointé sur ' + esc(o.compte) + '" aria-label="Pointé sur ' + esc(o.compte) + '">';
    const caseArrivee = '<input type="checkbox" class="coche" data-cote="arrivee" ' + (estPointeVers(o) ? 'checked' : '') + styleCase(o.compte_vers) + ' title="Pointé sur ' + esc(o.compte_vers) + '" aria-label="Pointé sur ' + esc(o.compte_vers) + '">';
    const cases = vir ? caseDepart : '<input type="checkbox" class="coche" ' + (o.pointe ? 'checked' : '') + styleCase(o.compte) + ' aria-label="Pointée">';
    const prevue = vir ? (!o.pointe || !estPointeVers(o)) : !o.pointe;
    const lisDroit = vir && couleurCompte(o.compte_vers) ? 'border-right:5px solid ' + couleurCompte(o.compte_vers) + ';' : '';
    const style = (fond ? 'background:' + fond + ';' : '') + liseret(o.compte) + lisDroit;
    const verif = !!o.a_verifier;
    const drapeau = '<button type="button" class="drapeau' + (verif ? ' actif' : '') + '" data-verif="' + esc(o.id) + '" title="' + (verif ? 'À vérifier (toucher pour retirer)' : 'Marquer à vérifier') + '" aria-label="À vérifier">' + ICONE_DRAPEAU + '</button>';
    return '<div class="op' + (vir ? ' virement' : '') + (verif ? ' a-verifier' : '') + ((sortants.get(o.id) || 0) > Date.now() ? ' sortante' : '') + (prevue && o.date > jour ? ' prevue' : '') + (idsSurlignes.has(o.id) ? ' surligne' : '') + '" data-id="' + esc(o.id) + '"' +
      (style ? ' style="' + esc(style) + '"' : '') + '>' + cases +
      '<div class="lib"><div class="t">' + esc(titreOp(o, extra)) + (o.serie_id ? ' ↻' : '') + (o.commentaire ? ' <span class="bulle-com" data-com="' + esc(o.commentaire) + '">💬</span>' : '') + '</div>' +
      '<div class="s">' + sous + '</div></div>' +
      drapeau + '<div class="m ' + classe + '">' + euros(montantAffiche) + '</div>' + (vir ? caseArrivee : '') + '</div>';
  };

  let html = '', jourCourant = '';
  elements.forEach(el => {
    const o = el.op;
    if (o.date !== jourCourant) {
      jourCourant = o.date;
      const [a, mm, d] = o.date.split('-').map(Number);
      html += '<div class="jour">' + new Date(a, mm - 1, d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: q ? 'numeric' : undefined }) + '</div>';
    }
    if (!el.groupe) { html += ligneOp(o); return; }
    const total = el.enfants.reduce((t, x) => t + (Number(x.montant) || 0), 0);
    const toutPointe = el.enfants.every(x => x.pointe);
    const ouvert = groupesOuverts.has(el.groupe);
    const titre = [...new Set([o.enseigne, o.groupe_libelle].filter(Boolean).map(String))].filter((t, i, a) => i === 0 || t.toLowerCase() !== a[0].toLowerCase()).join(' — ') || 'Opération ventilée';
    const surligne = el.enfants.some(x => idsSurlignes.has(x.id));
    const fondG = fondCompte(o.compte);
    const verifG = el.enfants.some(x => x.a_verifier);
    html += '<div class="op groupe' + (verifG ? ' a-verifier' : '') + (el.enfants.some(x => (sortants.get(x.id) || 0) > Date.now()) ? ' sortante' : '') + (!toutPointe && o.date > jour ? ' prevue' : '') + (surligne ? ' surligne' : '') + '" data-groupe="' + esc(el.groupe) + '"' +
      ((fondG || liseret(o.compte)) ? ' style="' + esc((fondG ? 'background:' + fondG + ';' : '') + liseret(o.compte)) + '"' : '') + '>' +
      '<input type="checkbox" class="coche" ' + (toutPointe ? 'checked' : '') + styleCase(o.compte) + ' aria-label="Pointée">' +
      '<div class="lib"><div class="t"><span class="picto" title="Opération ventilée">' + (ouvert ? '▾' : '▸') + ' ' + el.enfants.length + '</span>' + esc(titre) + (el.enfants.every(x => x.serie_id) ? ' ↻' : '') + (o.commentaire ? ' <span class="bulle-com" data-com="' + esc(o.commentaire) + '">💬</span>' : '') + '</div>' +
      '<div class="s">Ventilée · ' + esc(o.compte) + (o.paiement ? ' · ' + esc(o.paiement) : '') + '</div></div>' +
      '<button type="button" class="drapeau' + (verifG ? ' actif' : '') + '" data-verif-groupe="' + esc(el.groupe) + '" title="' + (verifG ? 'À vérifier (toucher pour retirer)' : 'Marquer à vérifier') + '" aria-label="À vérifier">' + ICONE_DRAPEAU + '</button>' +
      '<div class="m ' + (total < 0 ? 'neg' : 'pos') + '">' + euros(total) + '</div></div>';
    if (ouvert) html += '<div class="sous-ops">' + el.enfants.map(x => ligneOp(x, true)).join('') +
      (String(el.groupe).startsWith('T-') ? '' : '<button type="button" class="btn-ticket" data-modif-ticket="' + esc(el.groupe) + '">✎ Modifier le ticket</button>') + '</div>';
  });
  $('#listeOps').innerHTML = html || '<p class="discret">Aucune opération.</p>';
  // Drapeau « à vérifier » : la ligne passe en jaune (sans ouvrir la modification)
  $$('#listeOps .drapeau').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const cibles = b.dataset.verifGroupe ? data.Operations.filter(o => o.groupe === b.dataset.verifGroupe) : data.Operations.filter(o => o.id === b.dataset.verif);
    const nouveau = !b.classList.contains('actif');
    modifier(cibles.map(o => ({ table: 'Operations', op: 'upsert', data: { id: o.id, a_verifier: nouveau } })));
  });
  // Info-bulle des commentaires : survol (PC) ou appui (mobile) sur 💬
  $$('#listeOps .bulle-com').forEach(b => {
    b.onmouseenter = () => afficherBulle(b);
    b.onmouseleave = () => masquerBulle();
    b.onclick = e => { e.stopPropagation(); afficherBulle(b); };   // fermeture : appui ailleurs ou défilement
  });
  $$('#listeOps [data-modif-ticket]').forEach(b => b.onclick = e => { e.stopPropagation(); ouvrirTicket(b.dataset.modifTicket); });
  $$('#listeOps .op.groupe').forEach(el => {
    const g = el.dataset.groupe;
    $('.coche', el).onchange = e => {
      const enfants = data.Operations.filter(o => o.groupe === g);
      garderUnInstant(enfants.map(o => o.id));
      modifier(enfants.map(o => ({ table: 'Operations', op: 'upsert', data: { id: o.id, pointe: e.target.checked } })));
    };
    $('.lib', el).onclick = $('.m', el).onclick = () => {
      if (groupesOuverts.has(g)) groupesOuverts.delete(g); else groupesOuverts.add(g);
      rendreJournal();
    };
  });
  $$('#listeOps .op:not(.groupe)').forEach(el => {
    const id = el.dataset.id;
    $$('.coche', el).forEach(cb => cb.onchange = e => {
      const o = data.Operations.find(x => x.id === id);
      let maj;
      if (cb.dataset.cote === 'arrivee') maj = { id, pointe_vers: e.target.checked };
      else if (cb.dataset.cote === 'depart') maj = { id, pointe: e.target.checked, pointe_vers: estPointeVers(o) };   // fige le côté arrivée
      else maj = { id, pointe: e.target.checked };
      garderUnInstant([id]);
      modifier([{ table: 'Operations', op: 'upsert', data: maj }]);
    });
    $('.lib', el).onclick = $('.m', el).onclick = () => ouvrirFormulaire({ op: data.Operations.find(o => o.id === id) });
  });
}


/* ================= Info-bulle ================= */

let bulleSur = null;
function afficherBulle(cible) {
  const b = $('#bulle');
  b.textContent = cible.dataset.com;
  b.hidden = false;
  const r = cible.getBoundingClientRect(), l = b.offsetWidth, h = b.offsetHeight;
  const x = Math.max(8, Math.min(r.left + r.width / 2 - l / 2, window.innerWidth - l - 8));
  const y = r.top - h - 10 > 60 ? r.top - h - 10 : r.bottom + 10;
  b.style.left = x + 'px'; b.style.top = y + 'px';
  bulleSur = cible;
}
function masquerBulle() { $('#bulle').hidden = true; bulleSur = null; }


/* ================= Formulaire de saisie ================= */

function remplirSelect(sel, valeurs, vide, valeur) {
  sel.innerHTML = '<option value="">' + esc(vide) + '</option>' + valeurs.map(v => '<option>' + esc(v) + '</option>').join('');
  if (valeur && valeurs.indexOf(valeur) === -1) sel.insertAdjacentHTML('beforeend', '<option>' + esc(valeur) + '</option>');
  sel.value = valeur || '';
}
function listeCategories() { return [...new Set(data.Categories.map(c => c.categorie))]; }
function listeSousCategories(cat) { return data.Categories.filter(c => c.categorie === cat).map(c => c.sous_categorie); }
function listeComptes() { return data.Comptes.filter(c => c.actif !== false).sort((a, b) => (a.ordre || 0) - (b.ordre || 0)).map(c => c.nom); }

function chargerSousCategories(valeur) {
  remplirSelect($('#sous_categorie'), listeSousCategories($('#categorie').value), $('#categorie').value ? '— choisir —' : '— catégorie d\'abord —', valeur);
}

/** Désignation automatique d'un retrait. */
function designationRetrait() { return 'Retrait ' + ($('#compte').value || '…') + ' → ' + ($('#vers').value || '…'); }
function majDesignationRetrait() { if (typeCourant === 'RETRAIT') $('#designation').value = designationRetrait(); }

/** Compte « Espèces » (pour les retraits). */
function compteEspeces() {
  return listeComptes().find(n => /^esp[eè]ces$/i.test(n.normalize('NFD').replace(/[\u0300-\u036f]/g, '')) || /^especes$/i.test(n.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) || '';
}

function definirType(type) {
  typeCourant = type;
  $$('#segType button').forEach(b => b.classList.toggle('actif', b.dataset.type === type));
  const vir = type === 'VIREMENT' || type === 'RETRAIT';
  if (type === 'RETRAIT') $('#vers').value = compteEspeces();     // retrait = mouvement vers Espèces
  // Retrait : désignation automatique « Retrait <compte> → <vers> », non modifiable
  const desi = $('#designation');
  const etaitAuto = desi.readOnly;
  desi.readOnly = type === 'RETRAIT';
  desi.classList.toggle('auto', type === 'RETRAIT');
  if (type === 'RETRAIT') majDesignationRetrait();
  else if (etaitAuto) desi.value = '';
  $('#champVers').hidden = !vir;
  $('#champPaiement').hidden = vir;
  $('#blocClassement').hidden = vir;
  $('#champVentiler').hidden = vir || !!edition;
  if (vir) { $('#ventiler').checked = false; basculerVentilation(); }
  $('#champDesignation').hidden = false;
}

function majEtoiles() {
  ['compte', 'paiement'].forEach(k => {
    const def = param(k + '_defaut'), sel = $('#' + k), btn = $('.etoile[data-defaut="' + k + '"]');
    const actif = !!sel.value && sel.value === def;
    btn.textContent = actif ? '★' : '☆'; btn.classList.toggle('actif', actif);
    sel.classList.toggle('defaut', actif);
  });
}

/** « 05 novembre 2026 » */
function dateEnLettres(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return pad(d) + ' ' + MOIS[m - 1] + ' ' + y;
}

/** Lit une date tapée : 5/11/26, 5/11, 5-11-2026, 5.11.26, 051126, 5 nov 26, 05 novembre 2026… → 'yyyy-mm-dd' (ou null). */
function lireDateTapee(texte) {
  const t = String(texte || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!t) return null;
  const anneeCourante = new Date().getFullYear();
  let j, m, a;
  let r = t.match(/^(\d{1,2})[\/\-. ](\d{1,2})(?:[\/\-. ](\d{2}|\d{4}))?$/);
  if (r) { j = +r[1]; m = +r[2]; a = r[3]; }
  if (!r && (r = t.match(/^(\d{2})(\d{2})(\d{2}|\d{4})?$/))) { j = +r[1]; m = +r[2]; a = r[3]; }
  if (!r && (r = t.match(/^(\d{1,2})\s*([a-z]+)\.?(?:\s+(\d{2}|\d{4}))?$/))) {
    const sansAccents = MOIS.map(x => x.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
    const i = sansAccents.findIndex(x => x.startsWith(r[2].slice(0, Math.max(3, Math.min(r[2].length, 4)))) || x === r[2]);
    if (i === -1) return null;
    j = +r[1]; m = i + 1; a = r[3];
  }
  if (!j || !m) return null;
  a = a === undefined ? anneeCourante : (String(a).length === 2 ? 2000 + Number(a) : Number(a));
  if (m < 1 || m > 12 || j < 1 || j > joursDansMois(a, m)) return null;
  return ymd(a, m, j);
}

function majDateTexte() {
  const champ = $('#dateTexte');
  if (champ && document.activeElement !== champ) champ.value = dateEnLettres($('#date').value);
  if (champ) champ.classList.remove('invalide');
}

function validerDateTexte() {
  const champ = $('#dateTexte');
  if (!champ.value.trim()) { majDateTexte(); return; }
  const iso = lireDateTapee(champ.value);
  if (!iso) { champ.classList.add('invalide'); return; }
  $('#date').value = iso;
  champ.value = dateEnLettres(iso);
  champ.classList.remove('invalide');
}

function changerJour(n) {
  $('#date').value = decalerJours($('#date').value || aujourdhui(), n);
  majDateTexte();
}

function dateParDefaut() {
  // Garde la dernière date saisie pendant 30 min (pratique pour une série de tickets), sinon aujourd'hui.
  if (local.derniereDate && Date.now() - local.derniereDateTs < 30 * 60 * 1000) return local.derniereDate;
  return aujourdhui();
}

function ouvrirFormulaire(opts) {
  opts = opts || {};
  edition = opts.op || null;
  ticketEdition = null;
  // Modification depuis le journal : on retient où l'on était pour y revenir
  positionJournal = edition && vueCourante === 'journal' ? { y: window.scrollY, mois: moisJournal ? moisJournal.join('-') : '' } : null;
  const f = $('#formulaire'); f.reset();
  $('#designation').readOnly = false; $('#designation').classList.remove('auto');
  $('#erreurForm').textContent = '';
  $$('.invalide', f).forEach(x => x.classList.remove('invalide'));

  remplirSelect($('#compte'), listeComptes(), '— choisir —', edition ? edition.compte : param('compte_defaut'));
  remplirSelect($('#vers'), listeComptes(), '— choisir —', edition ? edition.compte_vers : '');
  remplirSelect($('#paiement'), trierFr(data.Paiements.map(p => p.paiement)), '— choisir —', edition ? edition.paiement : param('paiement_defaut'));
  remplirSelect($('#enseigne'), trierFr(data.Enseignes.map(e => e.enseigne)), '—', edition ? edition.enseigne : '');
  remplirSelect($('#categorie'), listeCategories(), '— choisir —', edition ? edition.categorie : '');
  chargerSousCategories(edition ? edition.sous_categorie : '');

  const noms = {};
  data.Operations.slice().sort((a, b) => b.date.localeCompare(a.date)).forEach(o => { if (o.designation && !noms[o.designation]) noms[o.designation] = 1; });
  $('#listeDesignations').innerHTML = Object.keys(noms).slice(0, 400).map(n => '<option value="' + esc(n) + '">').join('');

  $('#zoneRaccourcis').hidden = !!edition;
  $('#champFrequence').hidden = false;
  $('#champPointe').hidden = !edition;
  $('#champPointeVers').hidden = true;
  $('#btnSupprimer').hidden = !edition;
  $('#btnFavori').hidden = false;
  $('#champSuivantes').hidden = !(edition && edition.serie_id);
  $('#lignesVentilation').innerHTML = '';
  $('#ventiler').disabled = false;
  $('#ventiler').checked = false; basculerVentilation();   // remet tout le formulaire hors ventilation
  $('#champFrequence').hidden = false;

  if (edition) {
    definirType(edition.type);
    $('#montant').value = String(Math.abs(Number(edition.montant))).replace('.', ',');
    $('#date').value = edition.date;
    $('#designation').value = edition.designation;
    $('#commentaire').value = edition.commentaire || '';
    $('#pointe').checked = !!edition.pointe;
    const virEd = edition.type === 'VIREMENT';
    $('#champPointeVers').hidden = !virEd;
    $('#libPointe').textContent = virEd ? 'Pointée sur ' + edition.compte : 'Pointée';
    $('#libPointeVers').textContent = virEd ? 'Pointée sur ' + edition.compte_vers : '';
    $('#pointeVers').checked = virEd && estPointeVers(edition);
    const serieActuelle = edition.serie_id && data.Series.find(x => x.id === edition.serie_id);
    $('#frequence').value = serieActuelle && (!serieActuelle.fin || serieActuelle.fin >= edition.date) ? serieActuelle.frequence : 'UNE_FOIS';
  } else {
    definirType('DEPENSE');
    $('#date').value = dateParDefaut();
    $('#modeVacances').checked = !!local.vacances;
    $('#lieuVacances').value = param('lieu_vacances');
    favorisOuverts = false;
    rendreRaccourcis();
  }
  majEtoiles();
  majDateTexte();
  afficherVue('saisie');
  if (!edition) setTimeout(() => {   // curseur dans le montant, sauf si un champ a déjà été touché
    const actif = document.activeElement;
    if (!actif || actif === document.body || !$('#formulaire').contains(actif)) $('#montant').focus();
  }, 50);
}

function rendreRaccourcis() {
  const vac = $('#modeVacances').checked;
  $('#lieuVacances').hidden = !vac;
  $('#btnFavoris').classList.toggle('actif', favorisOuverts);
  let html = '';
  if (vac) {
    const sc = listeSousCategories('Vacances');
    html += sc.map(x => '<button type="button" data-vac="' + esc(x) + '">' + esc(x) + '</button>').join('') ||
      '<span class="vide">Aucune sous-catégorie « Vacances ».</span>';
  }
  if (favorisOuverts) {
    const tries = data.Favoris.slice().sort((a, b) => String(a.nom || a.designation).localeCompare(String(b.nom || b.designation), 'fr', { sensitivity: 'base' }));
    html += tries.map(f => '<button type="button" data-fav="' + esc(f.id) + '">' + esc(f.nom || f.designation) + '</button>').join('') ||
      '<span class="vide">Aucun favori : remplis une saisie puis « ★ Enregistrer comme favori ».</span>';
  }
  $('#favoris').innerHTML = html;
  $('#favoris').hidden = !html;
  $$('#favoris [data-fav]').forEach(b => b.onclick = () => appliquerFavori(data.Favoris.find(f => f.id === b.dataset.fav)));
  $$('#favoris [data-vac]').forEach(b => b.onclick = () => appliquerVacances(b.dataset.vac));
}

function appliquerFavori(f) {
  if (!f) return;
  favorisOuverts = false;          // la liste se replie après le choix
  rendreRaccourcis();
  definirType(f.type === 'RECETTE' ? 'RECETTE' : 'DEPENSE');
  $('#designation').value = f.designation || '';
  remplirSelect($('#enseigne'), trierFr(data.Enseignes.map(e => e.enseigne)), '—', f.enseigne);
  $('#categorie').value = f.categorie || ''; chargerSousCategories(f.sous_categorie);
  if (f.compte) $('#compte').value = f.compte;
  if (f.paiement) $('#paiement').value = f.paiement;
  majEtoiles();
  modifier([{ table: 'Favoris', op: 'upsert', data: { id: f.id, utilisations: (Number(f.utilisations) || 0) + 1 } }]);
  $('#montant').focus();
}

/** Lieu de vacances d'une dépense : le ou les mots en MAJUSCULES au début de la désignation (« SARLAT Carburant » → « SARLAT »). */
function lieuVacances(o) {
  if (!o || o.categorie !== 'Vacances' || o.type === 'VIREMENT') return '';
  const m = String(o.designation || '').trim().match(/^([A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’-]+(?:\s+[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’-]+)*)(?=\s|$)/);
  return m ? m[1] : '';
}

function appliquerVacances(sc) {
  const lieu = $('#lieuVacances').value.trim().toUpperCase();
  definirType('DEPENSE');
  $('#designation').value = (lieu ? lieu + ' ' : '') + sc;
  $('#categorie').value = 'Vacances'; chargerSousCategories(sc);
  $('#montant').focus();
}

/** Saisie d'une désignation déjà connue : on reprend le classement de la dernière opération du même nom. */
function completerDepuisHistorique() {
  if (edition) return;
  const nom = $('#designation').value.trim().toLowerCase();
  if (!nom) return;
  const precedente = data.Operations.filter(o => o.designation.toLowerCase() === nom && o.type !== 'VIREMENT')
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!precedente) return;
  if (!$('#enseigne').value) remplirSelect($('#enseigne'), trierFr(data.Enseignes.map(e => e.enseigne)), '—', precedente.enseigne);
  if (!$('#categorie').value) { $('#categorie').value = precedente.categorie; chargerSousCategories(precedente.sous_categorie); }
  if (precedente.type !== typeCourant) definirType(precedente.type);
  if (precedente.compte && !$('#compte').value) $('#compte').value = precedente.compte;
  if (precedente.paiement && !$('#paiement').value) $('#paiement').value = precedente.paiement;
  majEtoiles();
}

function basculerVentilation() {
  const on = $('#ventiler').checked;
  $('#champIntitule').hidden = !on;
  $('.ligne-montant-date').classList.toggle('mode-ventilation', on);
  $('#ligneEnseigne').classList.toggle('avec-intitule', on);
  $('#blocVentilation').hidden = !on;
  $('#blocCategorie').hidden = on;
  $('#champMontant').hidden = on;
  $('#champDesignation').hidden = on;
  if (on && !$('#lignesVentilation').children.length) {
    const premiere = ajouterLigneVentilation(); ajouterLigneVentilation();
    $('.v-designation', premiere).focus();
  }
  majTotalVentilation();
}

function ajouterLigneVentilation(o) {
  const div = document.createElement('div');
  div.className = 'ligne-ventilation';
  div.innerHTML = '<input class="v-designation majuscules" autocapitalize="words" placeholder="Désignation">' +
    '<input class="v-montant" inputmode="decimal" placeholder="Montant">' +
    '<select class="v-categorie"></select><select class="v-sous"></select>' +
    '<button type="button" class="suppr" aria-label="Supprimer la ligne">×</button>';
  $('#lignesVentilation').appendChild(div);
  remplirSelect($('.v-categorie', div), listeCategories(), 'Catégorie', '');
  remplirSelect($('.v-sous', div), [], 'Sous-catégorie', '');
  $('.v-categorie', div).onchange = () => remplirSelect($('.v-sous', div), listeSousCategories($('.v-categorie', div).value), 'Sous-catégorie', '');
  $('.v-montant', div).oninput = majTotalVentilation;
  $('.suppr', div).onclick = () => { div.remove(); majTotalVentilation(); };
  if (o) {   // ligne existante d'un ticket modifié
    div.dataset.id = o.id;
    $('.v-designation', div).value = o.designation || '';
    $('.v-montant', div).value = String(Math.abs(Number(o.montant) || 0)).replace('.', ',');
    remplirSelect($('.v-categorie', div), listeCategories(), 'Catégorie', o.categorie || '');
    remplirSelect($('.v-sous', div), listeSousCategories(o.categorie || ''), 'Sous-catégorie', o.sous_categorie || '');
  }
  return div;
}

function lignesVentilation() {
  return $$('#lignesVentilation .ligne-ventilation').map(div => ({
    designation: $('.v-designation', div).value.trim(), categorie: $('.v-categorie', div).value,
    sous_categorie: $('.v-sous', div).value, montantTexte: $('.v-montant', div).value, div, id: div.dataset.id || ''
  })).filter(l => l.designation || l.categorie || l.montantTexte);
}

function majTotalVentilation() {
  let t = 0; lignesVentilation().forEach(l => { try { t += calculer(l.montantTexte) || 0; } catch (e) { /* ignoré */ } });
  $('#totalVentilation').textContent = 'Total : ' + euros(t);
}

function occurrencesSerie(serie, annee) {
  const intervalle = INTERVALLES[serie.frequence];
  if (!intervalle || !serie.debut) return [];
  const [dy, dm] = serie.debut.split('-').map(Number);
  const jour = Number(serie.jour) || Number(serie.debut.slice(8, 10));
  const res = [];
  for (let m = 1; m <= 12; m++) {
    const ecart = (annee - dy) * 12 + (m - dm);
    if (ecart < 0 || ecart % intervalle) continue;
    const d = ymd(annee, m, Math.min(jour, joursDansMois(annee, m)));
    if (serie.fin && d > serie.fin) continue;
    res.push(d);
  }
  return res;
}

/** Ticket commun : les échéances des séries de même « ticket », même compte et même date forment une ligne ventilée. */
function groupeSerie(serie, date) {
  const t = String((serie && serie.ticket) || '').trim();
  return t ? { groupe: 'T-' + t.toLowerCase() + '|' + serie.compte + '|' + date, groupe_libelle: t } : { groupe: '', groupe_libelle: '' };
}

/** Échéances d'une série strictement après une date, sur l'année de cette date (et l'année suivante si déjà préparée). */
function echeancesApres(serie, date, fiche) {
  const annee = Number(date.slice(0, 4));
  const annees = [annee];
  if (param('annee_generee_' + (annee + 1))) annees.push(annee + 1);
  const muts = [];
  annees.forEach(a => occurrencesSerie(serie, a).filter(d => d > date).forEach(d => {
    muts.push({ table: 'Operations', op: 'upsert', data: Object.assign({}, fiche, {
      id: nouvelId(), date: d, pointe: false, serie_id: serie.id, source: 'appli', commentaire: '' }, groupeSerie(serie, d)) });
  }));
  return muts;
}

/** Suppression des échéances non pointées d'une série après une date. */
function supprimerEcheancesApres(serieId, date) {
  return data.Operations.filter(o => o.serie_id === serieId && o.date > date && !o.pointe)
    .map(o => ({ table: 'Operations', op: 'delete', data: { id: o.id } }));
}

let manquants = [];
function marquer(el, ok, nom) { el.classList.toggle('invalide', !ok); if (!ok && nom) manquants.push(nom); return ok; }

/** Message qui cite les champs manquants, et défilement jusqu'au premier. */
function signalerManquants() {
  $('#erreurForm').textContent = 'Complète : ' + (manquants.join(', ') || 'les champs en rouge') + '.';
  const premier = $('#formulaire .invalide');
  if (premier) premier.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function enregistrer(ev) {
  ev.preventDefault();
  const err = $('#erreurForm'); err.textContent = '';
  $$('#formulaire .invalide').forEach(x => x.classList.remove('invalide'));
  manquants = [];
  if (document.activeElement === $('#dateTexte')) validerDateTexte();
  const type = typeCourant === 'RETRAIT' ? 'VIREMENT' : typeCourant;   // un retrait est enregistré comme un mouvement
  const date = $('#date').value;
  const compte = $('#compte').value;
  const commun = {
    type, date, compte, enseigne: type === 'VIREMENT' ? '' : $('#enseigne').value,
    paiement: type === 'VIREMENT' ? 'Virement' : $('#paiement').value,
    compte_vers: type === 'VIREMENT' ? $('#vers').value : '',
    commentaire: $('#commentaire').value.trim()
  };
  let ok = marquer($('#date'), !!date, 'date') & marquer($('#compte'), !!compte, 'compte');
  if (type === 'VIREMENT') ok &= marquer($('#vers'), !!commun.compte_vers && commun.compte_vers !== compte, commun.compte_vers ? 'compte « Vers » différent' : 'compte « Vers »');
  const signe = v => type === 'DEPENSE' ? -Math.abs(v) : Math.abs(v);

  // --- Ventilation : plusieurs lignes, même date / compte / paiement / enseigne ---
  if (!edition && $('#ventiler').checked) {
    const lignes = lignesVentilation();
    if (!lignes.length) { err.textContent = 'Ajoute au moins une ligne.'; return; }
    const ops = [];
    const groupe = ticketEdition ? ticketEdition.groupe : 'G-' + nouvelId();
    const intitule = $('#intitule').value.trim();
    const toutesLignes = $$('#lignesVentilation .ligne-ventilation');
    lignes.forEach(l => {
      let v = null; try { v = calculer(l.montantTexte); } catch (e) { /* invalide */ }
      const n = ' (ligne ' + (toutesLignes.indexOf(l.div) + 1) + ')';
      ok &= marquer($('.v-designation', l.div), !!l.designation, 'désignation' + n) & marquer($('.v-categorie', l.div), !!l.categorie, 'catégorie' + n) &
        marquer($('.v-sous', l.div), !!l.sous_categorie, 'sous-catégorie' + n) & marquer($('.v-montant', l.div), v > 0, 'montant' + n);
      const ligne = Object.assign({ id: l.id || nouvelId() }, commun, { designation: l.designation, categorie: l.categorie,
        sous_categorie: l.sous_categorie, montant: signe(v || 0), groupe, groupe_libelle: intitule });
      if (!l.id) Object.assign(ligne, { pointe: false, serie_id: '', source: 'appli' });   // une ligne existante garde son pointage
      ops.push(ligne);
    });
    if (!ok) { signalerManquants(); return; }
    if (ticketEdition) {                                    // ticket modifié : mise à jour, ajouts et lignes retirées
      const gardees = new Set(ops.map(o => o.id));
      const retirees = ticketEdition.ids.filter(id => !gardees.has(id));
      modifier(ops.map(o => ({ table: 'Operations', op: 'upsert', data: o }))
        .concat(retirees.map(id => ({ table: 'Operations', op: 'delete', data: { id } }))));
      ticketEdition = null;
      return terminerSaisie(date, 'Ticket modifié : ' + ops.length + ' ligne' + (ops.length > 1 ? 's' : '') + (retirees.length ? ', ' + retirees.length + ' retirée' + (retirees.length > 1 ? 's' : '') : ''), ops.map(o => o.id));
    }
    const frequenceV = $('#frequence').value;
    if (frequenceV !== 'UNE_FOIS') {                      // ticket ventilé récurrent : une série par ligne, même « ticket »
      const ticket = intitule || commun.enseigne || 'Ticket';
      const muts = [];
      ops.forEach(o => {
        const serie = { id: 'S-' + nouvelId(), type, designation: o.designation, enseigne: o.enseigne, categorie: o.categorie,
          sous_categorie: o.sous_categorie, compte: o.compte, compte_vers: o.compte_vers || '', paiement: o.paiement, montant: o.montant,
          frequence: frequenceV, jour: Number(date.slice(8, 10)), debut: date, fin: '', actif: true, ticket };
        Object.assign(o, { serie_id: serie.id }, groupeSerie(serie, date));
        const fiche = Object.assign({}, o); delete fiche.id; delete fiche.date; delete fiche.serie_id; delete fiche.groupe; delete fiche.groupe_libelle;
        muts.push({ table: 'Series', op: 'upsert', data: serie }, { table: 'Operations', op: 'upsert', data: o }, ...echeancesApres(serie, date, fiche));
      });
      modifier(muts);
      return terminerSaisie(date, ops.length + ' lignes récurrentes : ' + (muts.length - 2 * ops.length) + ' échéance(s) ajoutée(s)', ops.map(o => o.id));
    }
    modifier(ops.map(o => ({ table: 'Operations', op: 'upsert', data: o })));
    return terminerSaisie(date, ops.length + ' lignes enregistrées', ops.map(o => o.id));
  }

  let montant = null;
  try { montant = calculer($('#montant').value); } catch (e) { /* invalide */ }
  ok &= marquer($('#montant'), montant > 0, 'montant');
  const categorie = type === 'VIREMENT' ? '' : $('#categorie').value;
  const sous = type === 'VIREMENT' ? '' : $('#sous_categorie').value;
  if (type !== 'VIREMENT') ok &= marquer($('#categorie'), !!categorie, 'catégorie') & marquer($('#sous_categorie'), !!sous, 'sous-catégorie');
  if (!ok) { signalerManquants(); return; }
  let designation = typeCourant === 'RETRAIT' ? designationRetrait() : $('#designation').value.trim();
  if (!designation) designation = type === 'VIREMENT' ? 'Virement ' + compte + ' → ' + commun.compte_vers : (commun.enseigne || sous);
  const fiche = Object.assign({}, commun, { designation, categorie, sous_categorie: sous, montant: signe(montant) });

  // --- Modification avec changement de fréquence (s'applique à partir de cette date) ---
  if (edition) {
    const serieAvant = edition.serie_id && data.Series.find(x => x.id === edition.serie_id);
    const freqAvant = serieAvant && (!serieAvant.fin || serieAvant.fin >= edition.date) ? serieAvant.frequence : 'UNE_FOIS';
    const freqNouv = $('#frequence').value;
    if (freqNouv !== freqAvant) {
      const jour = Number(date.slice(8, 10));
      const champsSerie = { type, designation, enseigne: fiche.enseigne, categorie, sous_categorie: sous, compte,
        compte_vers: fiche.compte_vers, paiement: fiche.paiement, montant: fiche.montant };
      const muts = [];
      let message;
      if (freqAvant === 'UNE_FOIS') {                       // devient récurrente
        const serie = Object.assign({ id: 'S-' + nouvelId(), frequence: freqNouv, jour, debut: date, fin: '', actif: true }, champsSerie);
        muts.push({ table: 'Series', op: 'upsert', data: serie });
        muts.push({ table: 'Operations', op: 'upsert', data: Object.assign({ id: edition.id, pointe: $('#pointe').checked, serie_id: serie.id }, fiche) });
        const suivantes = echeancesApres(serie, date, fiche);
        muts.push(...suivantes);
        message = 'Opération rendue récurrente : ' + suivantes.length + ' échéance(s) ajoutée(s)';
      } else {
        const suppr = supprimerEcheancesApres(serieAvant.id, edition.date);
        muts.push(...suppr);
        muts.push({ table: 'Operations', op: 'upsert', data: Object.assign({ id: edition.id, pointe: $('#pointe').checked }, fiche) });
        if (freqNouv === 'UNE_FOIS') {                      // la série s'arrête à cette opération
          muts.push({ table: 'Series', op: 'upsert', data: { id: serieAvant.id, fin: date } });
          message = 'Récurrence arrêtée : ' + suppr.length + ' échéance(s) suivante(s) supprimée(s)';
        } else {                                            // nouvelle fréquence à partir de cette date
          const serie = Object.assign({}, serieAvant, champsSerie, { frequence: freqNouv, jour, debut: date, fin: '', actif: true });
          muts.push({ table: 'Series', op: 'upsert', data: serie });
          const suivantes = echeancesApres(serie, date, fiche);
          muts.push(...suivantes);
          message = 'Fréquence modifiée : ' + suivantes.length + ' échéance(s) recalculée(s)';
        }
      }
      modifier(muts);
      return terminerSaisie(date, message, [edition.id]);
    }

    // --- Modification simple ---
    const serieEd = edition.serie_id && data.Series.find(x => x.id === edition.serie_id);
    const muts = [{ table: 'Operations', op: 'upsert', data: Object.assign({ id: edition.id, pointe: $('#pointe').checked },
      type === 'VIREMENT' ? { pointe_vers: $('#pointeVers').checked } : {}, fiche,
      serieEd && serieEd.ticket && (!edition.groupe || edition.groupe.startsWith('T-')) ? groupeSerie(Object.assign({}, serieEd, { compte }), date) : {}) }];
    if (edition.serie_id && $('#suivantes').checked) {
      const jour = Number(date.slice(8, 10));
      data.Operations.filter(o => o.serie_id === edition.serie_id && o.date > edition.date && !o.pointe).forEach(o => {
        const [y, m] = o.date.split('-').map(Number);
        muts.push({ table: 'Operations', op: 'upsert', data: Object.assign({}, fiche, {
          id: o.id, date: ymd(y, m, Math.min(jour, joursDansMois(y, m))), commentaire: o.commentaire },
          o.groupe && !o.groupe.startsWith('T-') ? {} : groupeSerie(Object.assign({}, data.Series.find(x => x.id === edition.serie_id), { compte }), ymd(y, m, Math.min(jour, joursDansMois(y, m))))) });
      });
      muts.push({ table: 'Series', op: 'upsert', data: Object.assign({ id: edition.serie_id, jour },
        { type, designation, enseigne: fiche.enseigne, categorie, sous_categorie: sous, compte, compte_vers: fiche.compte_vers,
          paiement: fiche.paiement, montant: fiche.montant }) });
    }
    // Ticket ventilé : date, compte et paiement sont communs à toutes les lignes du ticket
    const communs = {};
    if (date !== edition.date) communs.date = date;
    if (fiche.compte !== edition.compte) communs.compte = fiche.compte;
    if ((fiche.paiement || '') !== (edition.paiement || '')) communs.paiement = fiche.paiement;
    const autresLignes = edition.groupe && Object.keys(communs).length
      ? data.Operations.filter(o => o.groupe === edition.groupe && o.id !== edition.id) : [];
    const nouveauGroupe = muts[0].data.groupe || edition.groupe;
    autresLignes.forEach(o => muts.push({ table: 'Operations', op: 'upsert', data: Object.assign({ id: o.id }, communs,
      edition.groupe.startsWith('T-') ? { groupe: nouveauGroupe } : {}) }));
    modifier(muts);
    const quoi = { date: 'Date', compte: 'Compte', paiement: 'Paiement' };
    const libCommuns = Object.keys(communs).map(k => quoi[k]).join(', ').replace(/, ([^,]*)$/, ' et $1');
    return terminerSaisie(date, autresLignes.length ? libCommuns + ' changé' + (Object.keys(communs).length > 1 ? 's' : '') + ' sur les ' + (autresLignes.length + 1) + ' lignes du ticket' : 'Opération modifiée', [edition.id]);
  }

  // --- Nouvelle opération, éventuellement récurrente ---
  const frequence = $('#frequence').value;
  if (frequence === 'UNE_FOIS') {
    const id = nouvelId();
    modifier([{ table: 'Operations', op: 'upsert', data: Object.assign({ id, pointe: false, serie_id: '', source: 'appli' },
      type === 'VIREMENT' ? { pointe_vers: false } : {}, fiche) }]);
    return terminerSaisie(date, 'Enregistré', [id]);
  }
  const serie = Object.assign({ id: 'S-' + nouvelId(), frequence, jour: Number(date.slice(8, 10)), debut: date, fin: '', actif: true }, fiche);
  delete serie.date; delete serie.commentaire;
  const premiere = { table: 'Operations', op: 'upsert', data: Object.assign({}, fiche, { id: nouvelId(), date, pointe: false, serie_id: serie.id, source: 'appli' }, groupeSerie(serie, date)) };
  const muts = [{ table: 'Series', op: 'upsert', data: serie }, premiere].concat(echeancesApres(serie, date, fiche));
  modifier(muts);
  terminerSaisie(date, (muts.length - 1) + ' échéance(s) créée(s)', muts.filter(m => m.table === 'Operations' && m.data.date === date).map(m => m.data.id));
}

function terminerSaisie(date, message, ids) {
  local.derniereDate = date; local.derniereDateTs = Date.now();
  local.vacances = $('#modeVacances').checked;
  ecrire(LS.local, local);
  const lieu = $('#lieuVacances').value.trim().toUpperCase();
  if (local.vacances && lieu !== param('lieu_vacances')) modifier([{ table: 'Parametres', op: 'upsert', data: { cle: 'lieu_vacances', valeur: lieu } }]);
  toast(message);
  edition = null;
  // Retour au journal, sur le mois de l'opération, ligne mise en évidence.
  idsSurlignes = new Set(ids || []);
  moisJournal = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  $('#recherche').value = '';
  const filtre = $('#filtreCompte').value;
  const ops = data.Operations.filter(o => idsSurlignes.has(o.id));
  if (filtre && !ops.some(o => o.compte === filtre || o.compte_vers === filtre)) $('#filtreCompte').value = '';
  revenirAuJournal('#listeOps .op.surligne');
}

/** Retour au journal à la position d'avant la modification (si on est resté sur le même mois). */
function revenirAuJournal(ligneCible) {
  const pos = positionJournal;
  positionJournal = null;
  afficherVue('journal');
  if (pos && moisJournal && pos.mois === moisJournal.join('-')) window.scrollTo(0, pos.y);
  else if (ligneCible) { const l = $(ligneCible); if (l) l.scrollIntoView({ block: 'center' }); }
}

/**
 * Fenêtre de dialogue aux couleurs de l'appli (remplace confirm/prompt du navigateur).
 * dialogue({ titre, message, champs: [{ label, valeur, placeholder }], ok, danger }) →
 *   confirmation : true / false ; avec champs : tableau des valeurs saisies, ou null si annulé.
 */
const ICONES_DLG = {
  danger: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  saisie: '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="26" height="26"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v5M12 8h.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>'
};
function dialogue(o) {
  return new Promise(resoudre => {
    const fen = $('#dialogue'), champs = o.champs || [];
    fen.classList.toggle('danger', !!o.danger);
    $('#dlgIcone').innerHTML = ICONES_DLG[o.danger ? 'danger' : champs.length ? 'saisie' : 'info'];
    $('#dlgTitre').textContent = o.titre || '';
    $('#dlgMessage').textContent = o.message || ''; $('#dlgMessage').hidden = !o.message;
    $('#dlgChamps').innerHTML = champs.map((c, i) => '<label class="champ">' + esc(c.label) +
      '<input class="majuscules" autocapitalize="words" autocomplete="off" data-dlg="' + i + '" placeholder="' + esc(c.placeholder || '') + '" value="' + esc(c.valeur || '') + '"></label>').join('');
    $('#dlgOk').textContent = o.ok || 'OK';
    fen.hidden = false;
    const premier = $('#dlgChamps input');
    setTimeout(() => (premier ? (premier.focus(), premier.select()) : $('#dlgOk').focus()), 30);
    const fermer = v => { fen.hidden = true; $('#dlgForm').onsubmit = $('#dlgAnnuler').onclick = fen.onclick = document.onkeydown = null; resoudre(v); };
    $('#dlgForm').onsubmit = e => {
      e.preventDefault();
      if (!champs.length) return fermer(true);
      const vals = $$('#dlgChamps input').map(i => majusculesMots(i.value.trim()));
      const vide = vals.findIndex(v => !v);
      if (vide >= 0) { const i = $$('#dlgChamps input')[vide]; i.classList.add('invalide'); i.focus(); return; }
      fermer(vals);
    };
    $('#dlgAnnuler').onclick = () => fermer(champs.length ? null : false);
    fen.onclick = e => { if (e.target === fen) fermer(champs.length ? null : false); };
    document.onkeydown = e => { if (e.key === 'Escape') fermer(champs.length ? null : false); };
  });
}

async function supprimerOperation() {
  if (ticketEdition) {
    const n = ticketEdition.ids.length;
    if (!await dialogue({ titre: 'Supprimer le ticket', message: 'Les ' + n + ' lignes de ce ticket seront supprimées.', ok: 'Supprimer', danger: true })) return;
    modifier(ticketEdition.ids.map(id => ({ table: 'Operations', op: 'delete', data: { id } })));
    ticketEdition = null; toast('Ticket supprimé'); revenirAuJournal(); return;
  }
  if (!edition) return;
  const serie = edition.serie_id && $('#suivantes').checked;
  if (!await dialogue(serie
    ? { titre: 'Supprimer les échéances', message: 'Cette échéance et toutes les suivantes non pointées seront supprimées. La récurrence s\'arrêtera la veille.', ok: 'Supprimer', danger: true }
    : { titre: 'Supprimer l\'opération', message: (edition.designation || 'Cette opération') + ' · ' + euros(edition.montant) + ' sera supprimée.', ok: 'Supprimer', danger: true })) return;
  const muts = [{ table: 'Operations', op: 'delete', data: { id: edition.id } }];
  if (serie) {
    data.Operations.filter(o => o.serie_id === edition.serie_id && o.date > edition.date && !o.pointe)
      .forEach(o => muts.push({ table: 'Operations', op: 'delete', data: { id: o.id } }));
    muts.push({ table: 'Series', op: 'upsert', data: { id: edition.serie_id, fin: decalerJours(edition.date, -1) } });
  }
  modifier(muts);
  edition = null;
  toast('Supprimé');
  revenirAuJournal();
}

async function enregistrerFavori() {
  const designation = $('#designation').value.trim();
  const categorie = $('#categorie').value, sous = $('#sous_categorie').value;
  if (typeCourant === 'VIREMENT' || typeCourant === 'RETRAIT' || !categorie || !sous) { toast('Choisis au moins une catégorie et une sous-catégorie.', true); return; }
  const r = await dialogue({ titre: 'Nouveau favori', champs: [{ label: 'Nom du favori', valeur: designation || sous }], ok: 'Ajouter' });
  if (!r) return; const nom = r[0];
  modifier([{ table: 'Favoris', op: 'upsert', data: { id: nouvelId(), nom: nom.trim(), type: typeCourant, designation: designation || sous,
    enseigne: $('#enseigne').value, categorie, sous_categorie: sous, compte: $('#compte').value, paiement: $('#paiement').value, utilisations: 0 } }]);
  rendreRaccourcis();
  toast('Favori ajouté');
}

async function ajouterReference(quoi) {
  if (quoi === 'enseigne') {
    const r = await dialogue({ titre: 'Nouvelle enseigne', champs: [{ label: 'Enseigne', placeholder: 'Ex : Carrefour' }], ok: 'Ajouter' }); if (!r) return;
    const nom = r[0];
    modifier([{ table: 'Enseignes', op: 'upsert', data: { enseigne: nom } }]);
    remplirSelect($('#enseigne'), trierFr(data.Enseignes.map(e => e.enseigne)), '—', nom);
  } else if (quoi === 'categorie') {
    const r = await dialogue({ titre: 'Nouvelle catégorie', champs: [{ label: 'Catégorie', placeholder: 'Ex : Loisirs' }, { label: 'Première sous-catégorie', placeholder: 'Ex : Cinéma' }], ok: 'Ajouter' }); if (!r) return;
    const [nom, sc] = r;
    modifier([{ table: 'Categories', op: 'upsert', data: { categorie: nom, sous_categorie: sc } }]);
    remplirSelect($('#categorie'), listeCategories(), '— choisir —', nom); chargerSousCategories(sc);
  } else {
    const cat = $('#categorie').value; if (!cat) { toast('Choisis d\'abord une catégorie.', true); return; }
    const r = await dialogue({ titre: 'Nouvelle sous-catégorie', message: 'Dans la catégorie « ' + cat + ' »', champs: [{ label: 'Sous-catégorie', placeholder: 'Ex : Cinéma' }], ok: 'Ajouter' }); if (!r) return;
    const sc = r[0];
    modifier([{ table: 'Categories', op: 'upsert', data: { categorie: cat, sous_categorie: sc } }]);
    chargerSousCategories(sc);
  }
}

function definirDefaut(k) {
  const v = $('#' + k).value; if (!v) { toast('Choisis d\'abord une valeur.', true); return; }
  modifier([{ table: 'Parametres', op: 'upsert', data: { cle: k + '_defaut', valeur: v } }]);
  majEtoiles();
  toast((k === 'compte' ? 'Compte' : 'Paiement') + ' par défaut : ' + v);
}


/* ================= Réglages ================= */

function rendreReglages(erreur) {
  rendreReglagesBudget();
  if (!config.url) $('#secConnexion').open = true;   // premier lancement : la connexion doit être visible
  $('#cfgUrl').value = config.url || '';
  $('#cfgToken').value = config.token || '';
  const info = [];
  if (local.derniereSync) info.push('Dernière synchro : ' + new Date(local.derniereSync).toLocaleString('fr-FR'));
  if (outbox.length) info.push(outbox.length + ' modification(s) en attente d\'envoi');
  if (erreur) info.push('⚠ ' + erreur);
  if (data.version && String(data.version) < VERSION_SCRIPT_ATTENDUE) info.push('⚠ Script Google en version ' + data.version + ' : à mettre à jour en ' + VERSION_SCRIPT_ATTENDUE);
  $('#infoSync').textContent = info.join(' · ') || 'Jamais synchronisé.';
  const suiv = new Date().getFullYear() + 1;
  $('#btnAnneeSuivante').textContent = param('annee_generee_' + suiv) ? 'Échéances ' + suiv + ' déjà préparées ✓' : 'Préparer les échéances ' + suiv;
  $('#btnAnneeSuivante').disabled = !!param('annee_generee_' + suiv);
  $('#version').textContent = 'Version ' + VERSION_APP;

  const jourR = aujourdhui();
  $('#listeComptesReglages').innerHTML = data.Comptes.slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0)).map(c =>
    '<div class="item item-compte' + (c.actif === false ? ' inactif' : '') + '" data-nom="' + esc(c.nom) + '"><span class="poignee" title="Glisser pour déplacer" aria-label="Déplacer">⠿</span><span class="corps-item">' +
    (couleurCompte(c.nom) ? '<span class="pastille" style="background:' + esc(couleurCompte(c.nom)) + '"></span>' : '') +
    esc(c.nom) + (c.actif === false ? ' (désactivé)' : '') +
    '<span class="sous">Départ ' + euros(c.solde_initial) + (c.date_solde ? ' au ' + c.date_solde.split('-').reverse().join('/') : '') +
    ' · aujourd\'hui ' + euros(soldesCompte(c, jourR).aujourdhui) + '</span></span>' +
    '<button type="button" data-fiche="' + esc(c.nom) + '">Modifier</button></div>').join('') || '<p class="discret">Aucun compte.</p>';
  $$('[data-fiche]').forEach(b => b.onclick = () => ouvrirFicheCompte(b.dataset.fiche));
  $$('#listeComptesReglages .poignee').forEach(activerGlisser);

  $('#listeFavoris').innerHTML = data.Favoris.slice().sort((a, b) => String(a.nom).localeCompare(String(b.nom), 'fr')).map(f =>
    '<div class="item"><span>' + esc(f.nom) + '<span class="sous">' + esc([f.categorie, f.sous_categorie, f.compte].filter(Boolean).join(' › ')) + '</span></span>' +
    '<span><button type="button" data-renommer="' + esc(f.id) + '">Renommer</button> <button type="button" data-suppr-fav="' + esc(f.id) + '">✕</button></span></div>'
  ).join('') || '<p class="discret">Aucun favori.</p>';
  $$('[data-renommer]').forEach(b => b.onclick = async () => {
    const f = data.Favoris.find(x => x.id === b.dataset.renommer);
    const r = await dialogue({ titre: 'Renommer le favori', champs: [{ label: 'Nom', valeur: f.nom }], ok: 'Renommer' }); if (!r) return;
    const nom = r[0];
    modifier([{ table: 'Favoris', op: 'upsert', data: { id: f.id, nom } }]);
  });
  $$('[data-suppr-fav]').forEach(b => b.onclick = async () => {
    const f = data.Favoris.find(x => x.id === b.dataset.supprFav);
    if (await dialogue({ titre: 'Supprimer le favori', message: '« ' + (f ? f.nom : '') + ' » sera retiré de tes favoris.', ok: 'Supprimer', danger: true })) modifier([{ table: 'Favoris', op: 'delete', data: { id: b.dataset.supprFav } }]);
  });

  const nomsFreq = { MENSUEL: 'mensuel', BIMESTRIEL: 'bimestriel', TRIMESTRIEL: 'trimestriel', QUADRIMESTRIEL: 'quadrimestriel', SEMESTRIEL: 'semestriel', ANNUEL: 'annuel' };
  $('#listeSeries').innerHTML = '<p class="discret">Désactive celles qui ne doivent pas se répéter l\'an prochain. Donne le même <b>ticket</b> à plusieurs récurrentes versées ensemble (ex. Caf) : elles formeront une seule ligne ventilée.</p>' +
    data.Series.slice().sort((a, b) => (b.actif === true) - (a.actif === true) || a.designation.localeCompare(b.designation, 'fr')).map(s =>
      '<div class="item' + (s.actif ? '' : ' inactif') + '"><span>' + esc(s.designation) + '<span class="sous">' + (nomsFreq[s.frequence] || s.frequence) +
      ' · le ' + s.jour + ' · ' + euros(s.montant) + (s.fin ? ' · jusqu\'au ' + s.fin.split('-').reverse().join('/') : '') + '</span></span>' +
      '<input class="ticket-serie" data-ticket="' + esc(s.id) + '" list="listeTickets" placeholder="Ticket" value="' + esc(s.ticket || '') + '" title="Même ticket = une seule ligne ventilée dans le journal" aria-label="Ticket commun">' +
      '<button type="button" data-serie="' + esc(s.id) + '">' + (s.actif ? 'Désactiver' : 'Activer') + '</button></div>'
    ).join('') +
    '<datalist id="listeTickets">' + [...new Set(data.Series.map(x => String(x.ticket || '').trim()).filter(Boolean))].sort().map(t => '<option value="' + esc(t) + '">').join('') + '</datalist>';
  $$('[data-ticket]').forEach(inp => inp.onchange = () => {
    const s = data.Series.find(x => x.id === inp.dataset.ticket);
    const ticket = majusculesMots(inp.value.trim());
    if (ticket === String(s.ticket || '')) return;
    const muts = [{ table: 'Series', op: 'upsert', data: { id: s.id, ticket } }];
    const serie = Object.assign({}, s, { ticket });
    data.Operations.filter(o => o.serie_id === s.id && (!o.groupe || o.groupe.startsWith('T-'))).forEach(o => {
      muts.push({ table: 'Operations', op: 'upsert', data: Object.assign({ id: o.id }, groupeSerie(Object.assign({}, serie, { compte: o.compte }), o.date)) });
    });
    modifier(muts);
    toast(ticket ? '« ' + s.designation + ' » rattachée au ticket ' + ticket : 'Ticket retiré de « ' + s.designation + ' »');
  });
  $$('[data-serie]').forEach(b => b.onclick = () => {
    const s = data.Series.find(x => x.id === b.dataset.serie);
    modifier([{ table: 'Series', op: 'upsert', data: { id: s.id, actif: !s.actif } }]);
  });
}


/* ================= Comptes : ordre par glisser-déposer ================= */

function activerGlisser(poignee) {
  poignee.addEventListener('pointerdown', e => {
    e.preventDefault();
    const item = poignee.closest('.item-compte'), liste = item.parentNode;
    item.classList.add('deplace');
    // Écoute sur toute la page : déplacer la ligne dans la liste ne doit pas interrompre le geste.
    const bouger = ev => {
      ev.preventDefault();
      const autres = $$('.item-compte', liste).filter(x => x !== item);
      const avant = autres.find(x => { const r = x.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
      if (avant) { if (item.nextSibling !== avant) liste.insertBefore(item, avant); }
      else if (liste.lastElementChild !== item) liste.appendChild(item);
      if (ev.clientY < 90) window.scrollBy(0, -12);                      // défilement près des bords
      else if (ev.clientY > window.innerHeight - 140) window.scrollBy(0, 12);
    };
    const finir = () => {
      document.removeEventListener('pointermove', bouger);
      document.removeEventListener('pointerup', finir);
      document.removeEventListener('pointercancel', finir);
      item.classList.remove('deplace');
      const noms = $$('.item-compte', liste).map(x => x.dataset.nom);
      const muts = [];
      noms.forEach((nom, i) => {
        const c = data.Comptes.find(x => x.nom === nom);
        if (c && Number(c.ordre) !== i + 1) muts.push({ table: 'Comptes', op: 'upsert', data: { nom, ordre: i + 1 } });
      });
      if (muts.length) { modifier(muts); toast('Ordre des comptes enregistré'); }
    };
    document.addEventListener('pointermove', bouger, { passive: false });
    document.addEventListener('pointerup', finir);
    document.addEventListener('pointercancel', finir);
  });
}


/* ================= Comptes (ajout, modification, désactivation, suppression) ================= */

let compteEdite = null;
let couleurChoisie = '';

function ouvrirFicheCompte(nom) {
  compteEdite = nom ? data.Comptes.find(c => c.nom === nom) : null;
  const c = compteEdite;
  $('#titreFicheCompte').textContent = c ? 'Modifier « ' + c.nom + ' »' : 'Nouveau compte';
  $('#fcNom').value = c ? c.nom : '';
  $('#fcNom').disabled = !!c;                        // renommer changerait toutes les opérations : non prévu
  $('#fcSolde').value = c ? String(Number(c.solde_initial) || 0).replace('.', ',') : '';
  $('#fcDate').value = c ? (c.date_solde || '') : decalerJours(aujourdhui(), -1);
  $('#fcActif').checked = c ? c.actif !== false : true;
  $('#fcPart').value = c ? String(Math.round(partCompte(c.nom) * 100)) : '100';
  couleurChoisie = c ? couleurCompte(c.nom) : '';
  $('#fcCouleur').value = couleurChoisie || '#ffffff';
  $('#fcSansCouleur').classList.toggle('actif', !couleurChoisie);
  $('#fcErreur').textContent = '';
  $('#fcSupprimer').hidden = !c;
  $('#ficheCompte').hidden = false;
  if (!c) setTimeout(() => $('#fcNom').focus(), 50);
}

function utilisationsCompte(nom) {
  return data.Operations.filter(o => o.compte === nom || o.compte_vers === nom).length +
    data.Series.filter(x => x.compte === nom || x.compte_vers === nom).length;
}

function enregistrerFicheCompte() {
  const err = $('#fcErreur');
  const nom = compteEdite ? compteEdite.nom : majusculesMots($('#fcNom').value.trim());
  if (!nom) { err.textContent = 'Donne un nom au compte.'; return; }
  if (!compteEdite && data.Comptes.some(c => c.nom.toLowerCase() === nom.toLowerCase())) { err.textContent = 'Ce compte existe déjà.'; return; }
  let solde;
  try { solde = calculer($('#fcSolde').value); } catch (e) { err.textContent = 'Solde invalide.'; return; }
  if (!$('#fcDate').value) { err.textContent = 'Indique la date du solde de départ.'; return; }
  const ordre = compteEdite ? compteEdite.ordre : Math.max(0, ...data.Comptes.map(c => Number(c.ordre) || 0)) + 1;
  const muts = [{ table: 'Comptes', op: 'upsert', data: { nom, solde_initial: solde || 0, date_solde: $('#fcDate').value, ordre, actif: $('#fcActif').checked } }];
  const part = Math.round(Number(String($('#fcPart').value).replace('%', '').replace(',', '.')));
  if (!(part >= 1 && part <= 100)) { err.textContent = 'Ta part doit être entre 1 et 100 %.'; return; }
  if (part !== Math.round(partCompte(nom) * 100)) muts.push({ table: 'Parametres', op: part === 100 ? 'delete' : 'upsert', data: { cle: 'part:' + nom, valeur: String(part) } });
  if (couleurChoisie !== couleurCompte(nom)) muts.push({ table: 'Parametres', op: 'upsert', data: { cle: 'couleur:' + nom, valeur: couleurChoisie } });
  modifier(muts);
  $('#ficheCompte').hidden = true;
  toast(compteEdite ? 'Compte modifié' : 'Compte ajouté');
}

async function supprimerFicheCompte() {
  const c = compteEdite; if (!c) return;
  const n = utilisationsCompte(c.nom);
  if (n) { $('#fcErreur').textContent = n + ' opération(s) utilisent ce compte : il ne peut pas être supprimé. Décoche « Compte actif » pour le masquer.'; return; }
  if (!await dialogue({ titre: 'Supprimer le compte', message: 'Le compte « ' + c.nom + ' » sera supprimé définitivement.', ok: 'Supprimer', danger: true })) return;
  const muts = [{ table: 'Comptes', op: 'delete', data: { nom: c.nom } }];
  if (couleurCompte(c.nom)) muts.push({ table: 'Parametres', op: 'delete', data: { cle: 'couleur:' + c.nom } });
  modifier(muts);
  $('#ficheCompte').hidden = true;
  toast('Compte supprimé');
}


/* ================= Démarrage ================= */

function brancher() {
  $$('.onglets button').forEach(b => b.onclick = () => {
    edition = null; idsSurlignes = new Set();
    if (b.dataset.vue === 'saisie') ouvrirFormulaire(); else afficherVue(b.dataset.vue);
  });
  $('#fermerChoix').onclick = () => { $('#choixCompte').hidden = true; };
  $('#btnAjoutCompte').onclick = () => ouvrirFicheCompte(null);
  $('#fcEnregistrer').onclick = enregistrerFicheCompte;
  $('#fcAnnuler').onclick = () => { $('#ficheCompte').hidden = true; };
  $('#fcSupprimer').onclick = supprimerFicheCompte;
  $('#fcCouleur').addEventListener('input', e => { couleurChoisie = e.target.value; $('#fcSansCouleur').classList.remove('actif'); });
  // Le clic qui ferme la palette de couleurs (Windows) retombait sur « Compte actif » juste en dessous : on l'ignore.
  let paletteOuverte = false, paletteFermeeA = 0;
  $('#fcCouleur').addEventListener('click', () => { paletteOuverte = true; });
  ['change', 'blur'].forEach(ev => $('#fcCouleur').addEventListener(ev, () => { paletteOuverte = false; paletteFermeeA = Date.now(); }));
  $('#fcActif').closest('label').addEventListener('click', e => {
    if (paletteOuverte || Date.now() - paletteFermeeA < 600) { e.preventDefault(); e.stopPropagation(); paletteOuverte = false; }
  }, true);
  $('#fcSansCouleur').onclick = () => { couleurChoisie = ''; $('#fcCouleur').value = '#ffffff'; $('#fcSansCouleur').classList.add('actif'); };
  $('#choixCompte').onclick = e => { if (e.target.id === 'choixCompte') $('#choixCompte').hidden = true; };
  $('#etatSync').onclick = () => synchroniser();
  $('#moisPrec').onclick = () => { let [y, m] = moisJournal; m--; if (!m) { m = 12; y--; } moisJournal = [y, m]; rendreJournal(); };
  $('#moisSuiv').onclick = () => { let [y, m] = moisJournal; m++; if (m > 12) { m = 1; y++; } moisJournal = [y, m]; rendreJournal(); };
  $('#filtreCompte').onchange = rendreJournal;
  $('#filtrePointage').onclick = () => {
    const ordre = ['toutes', 'apointer', 'pointees'];
    local.filtrePointage = ordre[(ordre.indexOf(local.filtrePointage || 'toutes') + 1) % 3];
    ecrire(LS.local, local);
    sortants.clear();
    rendreJournal();
    toast('Filtre : ' + FILTRES_POINTAGE[local.filtrePointage][0]);
  };
  $('#recherche').oninput = rendreJournal;

  $$('#segType button').forEach(b => b.onclick = () => definirType(b.dataset.type));
  $('#categorie').onchange = () => chargerSousCategories('');
  $('#compte').onchange = () => {
    if (/^esp[eè]ces$/i.test($('#compte').value.normalize('NFD').replace(/[̀-ͯ]/g, ''))) {
      const esp = data.Paiements.map(p => p.paiement).find(p => /^esp/i.test(p.normalize('NFD').replace(/[̀-ͯ]/g, '')));
      if (esp) $('#paiement').value = esp;
    }
    majEtoiles();
  };
  $('#paiement').onchange = majEtoiles;
  $('#vers').addEventListener('change', majDesignationRetrait);
  $('#compte').addEventListener('change', majDesignationRetrait);
  $('#designation').onchange = completerDepuisHistorique;
  $('#montant').onblur = () => { try { const v = calculer($('#montant').value); if (v !== null) $('#montant').value = v.toFixed(2).replace('.', ','); } catch (e) { $('#montant').classList.add('invalide'); } };
  $('#plus').onclick = () => { const m = $('#montant'); m.value += '+'; m.focus(); };
  $('#moins').onclick = () => { const m = $('#montant'); m.value += '-'; m.focus(); };
  ['#plus', '#moins'].forEach(id => $(id).addEventListener('pointerdown', e => e.preventDefault()));   // le montant garde le focus : pas de reformatage
  $('#btnAujourdhui').onclick = () => { $('#date').value = aujourdhui(); majDateTexte(); };
  $('#date').addEventListener('change', majDateTexte);
  $('#dateTexte').addEventListener('blur', validerDateTexte);
  $('#dateTexte').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); validerDateTexte(); $('#dateTexte').select(); } });
  $('#dateTexte').addEventListener('focus', () => $('#dateTexte').select());
  $('#btnCalendrier').onclick = () => { try { $('#date').showPicker(); } catch (e) { $('#date').focus(); } };
  $('#jourPlus').onclick = () => changerJour(1);
  $('#jourMoins').onclick = () => changerJour(-1);
  $$('.etoile').forEach(b => b.onclick = () => definirDefaut(b.dataset.defaut));
  $$('.ajout').forEach(b => b.onclick = () => ajouterReference(b.dataset.ajout));
  $('#modeVacances').onchange = rendreRaccourcis;
  $('#btnFavoris').onclick = () => { favorisOuverts = !favorisOuverts; rendreRaccourcis(); };
  $('#lieuVacances').oninput = e => { e.target.value = e.target.value.toUpperCase(); };
  $('#ventiler').onchange = basculerVentilation;
  $('#ajoutLigne').onclick = () => $('.v-designation', ajouterLigneVentilation()).focus();   // curseur dans la désignation de la nouvelle ligne
  $('#formulaire').onsubmit = enregistrer;
  $('#btnAnnuler').onclick = () => { const modif = !!edition; edition = null; if (modif) revenirAuJournal(); else { positionJournal = null; afficherVue('accueil'); } };
  $('#btnSupprimer').onclick = supprimerOperation;
  $('#btnFavori').onclick = enregistrerFavori;

  $('#btnConnexion').onclick = () => {
    config = { url: $('#cfgUrl').value.trim(), token: $('#cfgToken').value.trim() };
    ecrire(LS.config, config);
    toast('Connexion enregistrée, synchronisation…');
    synchroniser();
  };
  $('#btnAnneeSuivante').onclick = async () => {
    const an = new Date().getFullYear() + 1;
    try { await synchroniser(); const r = await api('genererAnnee', { annee: an }); toast(r.creees + ' échéance(s) ' + an + ' créée(s)'); await synchroniser(); }
    catch (e) { toast(e.message, true); }
  };
  $('#btnRecharger').onclick = async () => {
    if (outbox.length && !await dialogue({ titre: 'Recharger depuis Google', message: outbox.length + ' modification(s) pas encore envoyée(s). Elles seront conservées et renvoyées.', ok: 'Continuer' })) return;
    synchroniser();
  };

  document.addEventListener('input', e => { if (e.target.classList && e.target.classList.contains('majuscules')) majusculesChamp(e.target); });
  window.addEventListener('scroll', masquerBulle, { passive: true });
  document.addEventListener('click', e => { if (bulleSur && !e.target.closest('.bulle-com')) masquerBulle(); });
  window.addEventListener('online', synchroniser);
  setInterval(() => { if (outbox.length) synchroniser(); }, 60000);   // filet : réessaie tant qu'il reste des saisies à envoyer
  window.addEventListener('offline', () => majEtatSync());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') synchroniser(); });
}

brancher();
afficherVue(config.url ? 'accueil' : 'reglages');
synchroniser();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}

/* ===================== STATISTIQUES ===================== */

function statEtat() {
  const j = aujourdhui();
  if (!local.statPeriode) local.statPeriode = 'mois';
  if (!local.statMois) local.statMois = [Number(j.slice(0, 4)), Number(j.slice(5, 7))];
  return local;
}

/** Opérations prises en compte : dépenses et recettes (les mouvements entre comptes ne sont ni l'un ni l'autre). */
function opsStats(debut, fin, compte) {
  return data.Operations.filter(o => (o.type === 'DEPENSE' || o.type === 'RECETTE') && o.date >= debut && o.date <= fin && (!compte || o.compte === compte));
}
function sommeStats(ops, type) { return ops.filter(o => o.type === type).reduce((t, o) => t + (Number(o.montant) || 0) * partCompte(o.compte), 0) * (type === 'DEPENSE' ? -1 : 1); }

function rendreStats() {
  const st = statEtat();
  const [y, m] = st.statMois;
  const annee = st.statPeriode === 'annee';
  $$('#segPeriode button').forEach(b => b.classList.toggle('actif', b.dataset.p === st.statPeriode));
  $('#statLibelle').textContent = annee ? String(y) : MOIS[m - 1] + ' ' + y;
  const sel = $('#statCompte'), choix = sel.value;
  sel.innerHTML = '<option value="">Tous les comptes</option>' + data.Comptes.slice().sort((a, b) => (a.ordre || 0) - (b.ordre || 0))
    .map(c => '<option>' + esc(c.nom) + '</option>').join('');
  sel.value = choix; const compte = sel.value;
  const debut = annee ? ymd(y, 1, 1) : ymd(y, m, 1), fin = annee ? ymd(y, 12, 31) : ymd(y, m, joursDansMois(y, m));
  const ops = opsStats(debut, fin, compte);
  const recettes = sommeStats(ops, 'RECETTE'), depenses = sommeStats(ops, 'DEPENSE'), net = recettes - depenses;
  $('#statResume').innerHTML =
    '<div class="carte stat-chiffre"><span class="lib">Recettes</span><b class="pos">' + euros(recettes) + '</b></div>' +
    '<div class="carte stat-chiffre"><span class="lib">Dépenses</span><b class="neg">' + euros(depenses) + '</b></div>' +
    '<div class="carte stat-chiffre"><span class="lib">' + (net >= 0 ? 'Épargne' : 'Déficit') + '</span><b class="' + (net >= 0 ? 'pos' : 'neg') + '">' + euros(net) + '</b></div>';
  rendreBarresStats(y, annee ? 0 : m, compte);
  rendreCategoriesStats(ops);
  // Vacances par lieu : toujours l'année entière (un séjour peut chevaucher deux mois).
  rendreLieuxStats(annee ? ops : opsStats(ymd(y, 1, 1), ymd(y, 12, 31), compte), y);
}

let statLieuOuvert = '';
/** Dépenses Vacances regroupées par lieu (carte masquée s'il n'y en a pas sur la période). */
function rendreLieuxStats(ops, annee) {
  $('#titreLieux').textContent = 'Vacances par lieu · ' + annee;
  const parLieu = {};
  ops.filter(o => o.type === 'DEPENSE' && o.categorie === 'Vacances').forEach(o => {
    const l = lieuVacances(o) || 'Sans lieu', s = o.sous_categorie || '—', v = -(Number(o.montant) || 0) * partCompte(o.compte);
    parLieu[l] = parLieu[l] || { total: 0, n: 0, sous: {} };
    parLieu[l].total += v; parLieu[l].n++; parLieu[l].sous[s] = (parLieu[l].sous[s] || 0) + v;
  });
  const liste = Object.entries(parLieu).map(([nom, x]) => Object.assign({ nom }, x)).filter(x => x.total > 0.004)
    .sort((a, b) => (a.nom === 'Sans lieu') - (b.nom === 'Sans lieu') || b.total - a.total);
  const carte = $('#carteLieux');
  carte.hidden = !liste.length;
  if (!liste.length) return;
  const total = liste.reduce((t, x) => t + x.total, 0), max = Math.max(...liste.map(x => x.total));
  let i = 0;
  liste.forEach(x => { x.couleur = x.nom === 'Sans lieu' ? '#5b636d' : COULEURS_STATS[i++ % COULEURS_STATS.length]; });
  if (statLieuOuvert && !liste.some(x => x.nom === statLieuOuvert)) statLieuOuvert = '';
  const pc = v => { const p = v * 100; return (p < 10 ? p.toFixed(1) : p.toFixed(0)).replace('.', ',') + ' %'; };
  $('#statLieux').innerHTML = '<div class="lieux-total"><span>Total vacances</span><b>' + euros(total) + '</b></div><div class="liste-cats">' + liste.map(x => {
    const ouvert = statLieuOuvert === x.nom;
    const sous = ouvert ? '<div class="stat-sous">' + Object.entries(x.sous).filter(([, v]) => v > 0.004).sort((a, b) => b[1] - a[1]).map(([n, v]) =>
      '<div class="ligne-sous"><span class="n">' + esc(n) + '</span><span class="pc">' + pc(v / x.total) + '</span><b>' + euros(v) + '</b></div>').join('') + '</div>' : '';
    return '<div class="stat-cat' + (ouvert ? ' ouverte' : '') + '" data-lieu="' + esc(x.nom) + '" style="--c:' + x.couleur + '">' +
      '<div class="tete"><i class="pt"></i><span class="n">' + esc(x.nom) + ' <small class="nb-ops">' + x.n + ' op.</small></span><span class="pc">' + pc(x.total / total) + '</span><b>' + euros(x.total) + '</b><span class="chevron">›</span></div>' +
      '<div class="jauge"><span style="width:' + (x.total / max * 100).toFixed(2) + '%"></span></div>' + sous + '</div>';
  }).join('') + '</div>';
  $$('#statLieux [data-lieu]').forEach(el => el.onclick = e => {
    e.stopPropagation(); statLieuOuvert = statLieuOuvert === el.dataset.lieu ? '' : el.dataset.lieu; rendreLieuxStats(ops, annee);
  });
}

function rendreBarresStats(y, moisActif, compte) {
  const mois = [];
  for (let i = 1; i <= 12; i++) {
    const ops = opsStats(ymd(y, i, 1), ymd(y, i, joursDansMois(y, i)), compte);
    mois.push({ r: sommeStats(ops, 'RECETTE'), d: sommeStats(ops, 'DEPENSE') });
  }
  const max = Math.max(1, ...mois.map(x => Math.max(x.r, x.d)));
  const pas = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000].find(p => max / p <= 4) || 100000;
  const haut = Math.ceil(max / pas) * pas;
  // 1 unité du dessin = 1 pixel à l'écran : textes nets et lisibles sur mobile comme sur PC
  const W = Math.max(320, Math.round($('#statBarres').clientWidth || 700)), H = W < 500 ? 210 : 230, g = 38, bas = 24, col = (W - g - 2) / 12, b = Math.max(4, Math.min(18, col / 2 - 4)), hz = H - bas - 14;
  const yv = v => 12 + hz - (Math.max(0, v) / haut) * hz;
  const nomsCourts = W < 500 ? ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'] : ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="stat-svg" role="img" aria-label="Recettes et dépenses par mois">';
  for (let v = 0; v <= haut; v += pas) {
    svg += '<line x1="' + g + '" x2="' + W + '" y1="' + yv(v) + '" y2="' + yv(v) + '" class="grille"/>' +
      '<text x="' + (g - 8) + '" y="' + (yv(v) + 4) + '" class="axe" text-anchor="end">' + (v >= 1000 ? (v / 1000).toLocaleString('fr-FR') + 'k' : v) + '</text>';
  }
  mois.forEach((x, i) => {
    const x0 = g + 2 + i * col, cx = x0 + col / 2, actif = moisActif === i + 1, attenue = moisActif && !actif;
    svg += '<g class="mois-barre' + (actif ? ' actif' : '') + (attenue ? ' attenue' : '') + '" data-mois="' + (i + 1) + '">' +
      '<rect x="' + (x0 + 2) + '" y="4" width="' + (col - 4) + '" height="' + (H - 8) + '" rx="10" class="zone"/>' +
      '<rect x="' + (cx - b - 1.5) + '" y="' + yv(x.r) + '" width="' + b + '" height="' + Math.max(0, yv(0) - yv(x.r)) + '" rx="4" class="b-rec"/>' +
      '<rect x="' + (cx + 1.5) + '" y="' + yv(x.d) + '" width="' + b + '" height="' + Math.max(0, yv(0) - yv(x.d)) + '" rx="4" class="b-dep"/>' +
      '<text x="' + cx + '" y="' + (H - 9) + '" class="axe mois" text-anchor="middle">' + nomsCourts[i] + '</text>' +
      '<title>' + MOIS[i] + ' : recettes ' + euros(x.r) + ', dépenses ' + euros(x.d) + ', solde ' + euros(x.r - x.d) + '</title></g>';
  });
  $('#statBarres').innerHTML = svg + '</svg>' +
    '<div class="stat-legende"><span><i class="puce-leg rec"></i>Recettes</span><span><i class="puce-leg dep"></i>Dépenses</span><span class="aide">Appuie sur un mois pour le détailler</span></div>';
  $$('#statBarres .mois-barre').forEach(el => el.onclick = () => {
    local.statPeriode = 'mois'; local.statMois = [y, Number(el.dataset.mois)]; ecrire(LS.local, local); rendreStats();
  });
}

function rendreCategoriesStats(ops) {
  const parCat = {};
  ops.filter(o => o.type === 'DEPENSE').forEach(o => {
    const c = o.categorie || 'Sans catégorie', s = o.sous_categorie || '—', v = -(Number(o.montant) || 0) * partCompte(o.compte);
    parCat[c] = parCat[c] || { total: 0, sous: {} };
    parCat[c].total += v; parCat[c].sous[s] = (parCat[c].sous[s] || 0) + v;
  });
  const liste = Object.entries(parCat).map(([nom, x]) => ({ nom, total: x.total, sous: x.sous })).filter(x => x.total > 0.004).sort((a, b) => b.total - a.total);
  const total = liste.reduce((t, x) => t + x.total, 0);
  if (!total) { $('#statCategories').innerHTML = '<p class="vide-stats">Aucune dépense sur cette période.</p>'; return; }
  liste.forEach((x, i) => { x.couleur = i < COULEURS_STATS.length ? COULEURS_STATS[i] : '#5b636d'; });
  if (statCategorieOuverte && !liste.some(x => x.nom === statCategorieOuverte)) statCategorieOuverte = '';
  const R = 74, C = 2 * Math.PI * R; let decal = 0;
  let svg = '<svg viewBox="0 0 200 200" class="anneau" role="img" aria-label="Répartition des dépenses"><circle cx="100" cy="100" r="' + R + '" class="fond-anneau"/>';
  liste.forEach(x => {
    const l = x.total / total * C, ouvert = statCategorieOuverte === x.nom;
    svg += '<circle cx="100" cy="100" r="' + R + '" class="part' + (statCategorieOuverte && !ouvert ? ' attenue' : '') + (ouvert ? ' ouverte' : '') + '" data-cat="' + esc(x.nom) + '" stroke="' + x.couleur +
      '" stroke-dasharray="' + Math.max(0.5, l - (liste.length > 1 ? 2 : 0)).toFixed(2) + ' ' + C.toFixed(2) + '" stroke-dashoffset="' + (-decal).toFixed(2) + '" transform="rotate(-90 100 100)"><title>' +
      esc(x.nom) + ' : ' + euros(x.total) + '</title></circle>';
    decal += l;
  });
  const sel = liste.find(x => x.nom === statCategorieOuverte);
  svg += '<text x="100" y="92" text-anchor="middle" class="anneau-lib">' + esc(sel ? sel.nom : 'Total') + '</text>' +
    '<text x="100" y="118" text-anchor="middle" class="anneau-val">' + euros(sel ? sel.total : total) + '</text></svg>';
  const pc = v => { const p = v * 100; return (p < 10 ? p.toFixed(1) : p.toFixed(0)).replace('.', ',') + ' %'; };
  const lignes = liste.map(x => {
    const ouvert = statCategorieOuverte === x.nom;
    const sous = ouvert ? '<div class="stat-sous">' + Object.entries(x.sous).filter(([, v]) => v > 0.004).sort((a, b) => b[1] - a[1]).map(([n, v]) =>
      '<div class="ligne-sous"><span class="n">' + esc(n) + '</span><span class="pc">' + pc(v / x.total) + '</span><b>' + euros(v) + '</b></div>').join('') + '</div>' : '';
    return '<div class="stat-cat' + (ouvert ? ' ouverte' : '') + '" data-cat="' + esc(x.nom) + '" style="--c:' + x.couleur + '">' +
      '<div class="tete"><i class="pt"></i><span class="n">' + esc(x.nom) + '</span><span class="pc">' + pc(x.total / total) + '</span><b>' + euros(x.total) + '</b><span class="chevron">›</span></div>' +
      '<div class="jauge"><span style="width:' + (x.total / liste[0].total * 100).toFixed(2) + '%"></span></div>' + sous + '</div>';
  }).join('');
  $('#statCategories').innerHTML = '<div class="stat-cats">' + svg + '<div class="liste-cats">' + lignes + '</div></div>';
  $$('#statCategories [data-cat]').forEach(el => el.onclick = e => {
    e.stopPropagation(); statCategorieOuverte = statCategorieOuverte === el.dataset.cat ? '' : el.dataset.cat; rendreCategoriesStats(ops);
  });
}

(function brancherStats() {
  $$('#segPeriode button').forEach(b => b.onclick = () => { statEtat().statPeriode = b.dataset.p; ecrire(LS.local, local); rendreStats(); });
  const decaler = sens => {
    const st = statEtat(); let [y, m] = st.statMois;
    if (st.statPeriode === 'annee') y += sens; else { m += sens; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } }
    st.statMois = [y, m]; statCategorieOuverte = ''; ecrire(LS.local, local); rendreStats();
  };
  $('#statPrec').onclick = () => decaler(-1);
  $('#statSuiv').onclick = () => decaler(1);
  $('#statCompte').onchange = () => { statCategorieOuverte = ''; rendreStats(); };
})();


/* ===================== BUDGET ===================== */

const euros0 = v => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Math.round(Number(v) || 0));
function initialiserBudget() {
  if (!data.Comptes || !data.Comptes.length || !data.Parametres) return;   // données pas encore chargées
  if (data.Parametres.some(p => String(p.cle).startsWith('budget:'))) return;
  const muts = Object.entries(BUDGET_DEFAUT).map(([c, v]) => ({ table: 'Parametres', op: 'upsert', data: { cle: 'budget:' + c, valeur: String(v) } }));
  muts.push({ table: 'Parametres', op: 'upsert', data: { cle: 'budget_debut', valeur: '2026-11' } },
            { table: 'Parametres', op: 'upsert', data: { cle: 'budget_hors', valeur: BUDGET_HORS_DEFAUT } });
  modifier(muts);
}
function budgetsAnnuels() { return (data.Parametres || []).filter(p => String(p.cle).startsWith('budget:'))
  .map(p => ({ cat: String(p.cle).slice(7), annuel: Number(String(p.valeur).replace(',', '.')) || 0 })).filter(b => b.annuel > 0); }
function horsBudget(o) {
  const hors = String(param('budget_hors') || BUDGET_HORS_DEFAUT).split(';').map(x => x.trim()).filter(Boolean);
  return hors.includes(o.categorie) || hors.includes(o.categorie + '/' + o.sous_categorie);
}
/** Montant dépensé (dépenses moins remboursements) d'une catégorie entre deux dates, échéances prévues comprises. */
function depenseBudget(cat, debut, fin, seulementRecurrentes) {
  let t = 0;
  for (const o of data.Operations) {
    if (o.categorie !== cat || o.date < debut || o.date > fin || horsBudget(o)) continue;
    if (o.type !== 'DEPENSE' && o.type !== 'RECETTE') continue;
    if (seulementRecurrentes && !o.serie_id) continue;
    t -= (Number(o.montant) || 0) * partCompte(o.compte);
  }
  return t;
}
/** Budget lissé du mois : ce qui reste du budget de la période, réparti sur les mois restants (mois courant compris). */
function calculBudget(b, y, m) {
  const deb = String(param('budget_debut') || '2026-11');
  const [dy, dm] = deb.split('-').map(Number);
  const moisDebut = dy === y ? dm : dy > y ? 13 : 1;
  const dansPeriode = m >= moisDebut;
  const nbMois = 13 - moisDebut;
  const finMois = ymd(y, m, joursDansMois(y, m));
  const depAvant = dansPeriode && m > moisDebut ? depenseBudget(b.cat, ymd(y, moisDebut, 1), ymd(y, m - 1, joursDansMois(y, m - 1))) : 0;
  // Enveloppes annuelles (dépenses irrégulières, ex. Vacances) : lissage du reste de l'année.
  // Autres catégories : l'objectif suit tes progrès (moyenne réelle des 3 mois précédents si plus basse, sans jamais remonter).
  const alloue = estAnnuelle(b.cat)
    ? (dansPeriode ? Math.max(0, (b.annuel * nbMois / 12 - depAvant) / (13 - m)) : b.annuel / 12)
    : objectifSuivi(b, y, m);
  const depense = depenseBudget(b.cat, ymd(y, m, 1), finMois);
  const fixe = Math.max(0, depenseBudget(b.cat, ymd(y, m, 1), finMois, true));
  const anDepense = depenseBudget(b.cat, ymd(y, moisDebut > 12 ? 1 : moisDebut, 1), finMois);
  return { alloue, depense, fixe, reste: alloue - depense, anDepense, anBudget: b.annuel * (dansPeriode ? nbMois : 12) / 12 };
}
function estAnnuelle(cat) {
  return String(param('budget_annuelles') || 'Vacances;Voiture').split(';').map(x => x.trim()).includes(cat);
}
/** Dépense réelle d'une catégorie sur un mois (mise en cache pendant un affichage). */
let cacheDepMois = {};
function depenseMois(cat, ym) {
  const k = cat + '|' + ym;
  if (!(k in cacheDepMois)) { const [y, m] = ym.split('-').map(Number); cacheDepMois[k] = depenseBudget(cat, ymd(y, m, 1), ymd(y, m, joursDansMois(y, m))); }
  return cacheDepMois[k];
}
/**
 * Objectif qui suit tes progrès : chaque mois depuis le début du budget, l'objectif mensuel descend
 * à la moyenne réelle des 3 mois précédents si elle est plus basse, et ne remonte jamais.
 */
function objectifSuivi(b, y, m) {
  const base = b.annuel / 12, cible = y + '-' + String(m).padStart(2, '0');
  let ym = String(param('budget_debut') || '2026-11'), obj = base;
  if (cible < ym) return base;
  const moisCourant = aujourdhui().slice(0, 7);
  while (ym <= cible && ym <= moisCourant) {   // seuls des mois écoulés en entier servent de référence
    const moy = Math.max(0, (depenseMois(b.cat, ajoutMois(ym, -1)) + depenseMois(b.cat, ajoutMois(ym, -2)) + depenseMois(b.cat, ajoutMois(ym, -3))) / 3);
    obj = Math.min(obj, moy);
    ym = ajoutMois(ym, 1);
  }
  return obj;
}
function rythmeMois(y, m) {
  const j = aujourdhui(), ym = j.slice(0, 7), cible = ymd(y, m, 1).slice(0, 7);
  const nbJ = joursDansMois(y, m);
  if (cible < ym) return { avance: 1, joursRestants: 0, nbJ };
  if (cible > ym) return { avance: 0, joursRestants: nbJ, nbJ };
  const d = Number(j.slice(8, 10));
  return { avance: d / nbJ, joursRestants: nbJ - d + 1, nbJ };
}
function etatBudget(x, avance) {
  const attendu = x.fixe + Math.max(0, x.alloue - x.fixe) * avance;
  if (x.depense > x.alloue + 0.004) return 'depasse';
  if (x.depense > attendu + 0.004) return 'rapide';
  return 'ok';
}

function rendreBudget() {
  initialiserBudget();
  cacheDepMois = {};
  const j = aujourdhui();
  if (!moisBudget) moisBudget = [Number(j.slice(0, 4)), Number(j.slice(5, 7))];
  const [y, m] = moisBudget;
  $('#budLibelle').textContent = MOIS[m - 1] + ' ' + y;
  const r = rythmeMois(y, m);
  const lignes = budgetsAnnuels().map(b => Object.assign({ cat: b.cat }, calculBudget(b, y, m)));
  lignes.sort((a, b) => b.alloue - a.alloue);
  const tot = lignes.reduce((t, x) => ({ alloue: t.alloue + x.alloue, depense: t.depense + x.depense, fixe: t.fixe + x.fixe }), { alloue: 0, depense: 0, fixe: 0 });
  const reste = tot.alloue - tot.depense;
  const etatG = etatBudget(tot, r.avance);
  const parJour = r.joursRestants ? reste / r.joursRestants : 0;
  const pct = v => Math.max(0, Math.min(100, v * 100)).toFixed(1);
  const jauge = (x, etat) => '<div class="bud-jauge ' + etat + '"><span class="fixe" style="width:' + pct(x.alloue ? Math.min(x.fixe, x.depense) / x.alloue : 0) + '%"></span>' +
    '<span class="var" style="width:' + pct(x.alloue ? Math.max(0, x.depense - x.fixe) / x.alloue : 0) + '%"></span>' +
    (r.avance > 0 && r.avance < 1 ? '<i class="repere" style="left:' + pct((x.fixe + Math.max(0, x.alloue - x.fixe) * r.avance) / (x.alloue || 1)) + '%"></i>' : '') + '</div>';
  $('#budHero').className = 'carte bud-hero ' + etatG;
  $('#budHero').innerHTML =
    '<div class="bud-hero-haut"><span class="lib">Reste à dépenser</span><span class="montant ' + (reste < 0 ? 'neg' : '') + '">' + euros(reste) + '</span></div>' +
    '<div class="bud-hero-jour">' + (r.joursRestants ? (reste > 0 ? 'soit <b>' + euros(parJour) + '</b> par jour pendant ' + r.joursRestants + ' jour' + (r.joursRestants > 1 ? 's' : '') : 'budget du mois dépassé') : 'mois terminé') + '</div>' +
    jauge(tot, etatG) +
    '<div class="bud-hero-bas"><span>Budget <b>' + euros(tot.alloue) + '</b></span><span>Dépensé <b>' + euros(tot.depense) + '</b></span><span>dont prévu <b>' + euros(tot.fixe) + '</b></span></div>';
  $('#budTuiles').innerHTML = lignes.map((x, i) => {
    const etat = etatBudget(x, r.avance);
    const pj = r.joursRestants && x.reste > 0 ? euros0(x.reste / r.joursRestants) + '/j' : '';
    const large = lignes.length % 2 === 1 && i === lignes.length - 1 ? ' large' : '';
    return '<div class="carte bud-tuile ' + etat + large + '">' +
      '<div class="t1"><span class="cat">' + esc(x.cat) + '</span></div>' +
      '<div class="t2"><b class="reste ' + (x.reste < 0 ? 'neg' : '') + '">' + euros0(x.reste) + '</b><span class="sur">sur ' + euros0(x.alloue) + '</span></div>' +
      jauge(x, etat) +
      '<div class="t3"><span>Dépensé ' + euros0(x.depense) + '</span><span>' + pj + '</span></div>' +
      '<div class="t4">Année : ' + euros0(x.anDepense) + ' / ' + euros0(x.anBudget) + '</div></div>';
  }).join('') || '<p class="vide-stats">Aucun budget. Règle les montants dans Réglages &gt; Budget.</p>';
  const horsMois = data.Operations.filter(o => horsBudget(o) && o.date.slice(0, 7) === ymd(y, m, 1).slice(0, 7) && (o.type === 'DEPENSE' || o.type === 'RECETTE'))
    .reduce((t, o) => t - (Number(o.montant) || 0) * partCompte(o.compte), 0);
  $('#budHors').textContent = Math.abs(horsMois) > 0.004 ? 'Hors budget ce mois (divorce, ta mère) : ' + euros(horsMois) : '';
}

function rendreReglagesBudget() {
  if (!$('#listeBudget')) return;
  initialiserBudget();
  const budgets = budgetsAnnuels();
  const cats = trierFr([...new Set([...budgets.map(b => b.cat), ...(data.Categories || []).map(c => c.categorie || c.nom).filter(Boolean)])])
    .filter(c => c !== 'Ressource' && c !== 'Maman');
  $('#listeBudget').innerHTML = cats.map(c => {
    const b = budgets.find(x => x.cat === c);
    return '<div class="ligne-budget"><span>' + esc(c) + '</span>' +
      '<label class="annuelle" title="Enveloppe annuelle : répartie sur les mois restants, pour les dépenses irrégulières"><input type="checkbox" data-annuelle="' + esc(c) + '"' + (estAnnuelle(c) ? ' checked' : '') + '>Annuelle</label>' +
      '<input type="text" inputmode="decimal" data-budget="' + esc(c) + '" value="' + (b ? b.annuel : '') + '" placeholder="—" aria-label="Budget annuel ' + esc(c) + '"><em>€/an</em><i>' + (b ? euros(b.annuel / 12) + '/mois' : '') + '</i></div>';
  }).join('') + '<div class="ligne-budget total"><span>Total</span><b>' + euros(budgets.reduce((t, b) => t + b.annuel, 0)) + '/an</b><i>' + euros(budgets.reduce((t, b) => t + b.annuel, 0) / 12) + '/mois</i></div>';
  $$('[data-annuelle]').forEach(cb => cb.onchange = () => {
    const liste = new Set(String(param('budget_annuelles') || 'Vacances;Voiture').split(';').map(x => x.trim()).filter(Boolean));
    if (cb.checked) liste.add(cb.dataset.annuelle); else liste.delete(cb.dataset.annuelle);
    modifier([{ table: 'Parametres', op: 'upsert', data: { cle: 'budget_annuelles', valeur: [...liste].join(';') || '-' } }]);
    toast(cb.dataset.annuelle + (cb.checked ? ' : enveloppe annuelle' : ' : objectif qui suit tes progrès'));
  });
  $$('[data-budget]').forEach(inp => inp.onchange = () => {
    const v = Math.round((Number(inp.value.replace(/\s/g, '').replace(',', '.')) || 0) * 100) / 100;
    modifier([{ table: 'Parametres', op: v > 0 ? 'upsert' : 'delete', data: { cle: 'budget:' + inp.dataset.budget, valeur: String(v) } }]);
    toast('Budget ' + inp.dataset.budget + ' : ' + (v > 0 ? euros(v) + '/an' : 'supprimé'));
  });
  $('#budDebut').value = String(param('budget_debut') || '2026-11');
  $('#budDebut').onchange = () => { if ($('#budDebut').value) modifier([{ table: 'Parametres', op: 'upsert', data: { cle: 'budget_debut', valeur: $('#budDebut').value } }]); };
}

(function brancherBudget() {
  const dec = s2 => { let [y, m] = moisBudget; m += s2; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } moisBudget = [y, m]; rendreBudget(); };
  $('#budPrec').onclick = () => dec(-1);
  $('#budSuiv').onclick = () => dec(1);
})();


/* ===== Migration unique (18/11/2026) : abonnements de l'activité t-shirts → catégorie Printyshirt ===== */
function migrerPrintyshirt() {
  if (!data.Comptes || !data.Comptes.length || param('migration_printyshirt')) return;
  const regles = [
    { test: d => /adobe\s*creative\s*cloud/i.test(d), sous: 'Logiciels' },
    { test: d => /^claude\s*ai$/i.test(d.trim()), sous: 'IA' },
    { test: d => /nom de domaine printyshirt/i.test(d), sous: 'Hébergement' }
  ];
  const regle = x => regles.find(r => r.test(String(x.designation || '')));
  const muts = ['Logiciels', 'IA', 'Hébergement']
    .filter(sc => !data.Categories.some(c => c.categorie === 'Printyshirt' && c.sous_categorie === sc))
    .map(sc => ({ table: 'Categories', op: 'upsert', data: { categorie: 'Printyshirt', sous_categorie: sc } }));
  const series = data.Series.filter(regle);
  series.forEach(x => muts.push({ table: 'Series', op: 'upsert', data: { id: x.id, categorie: 'Printyshirt', sous_categorie: regle(x).sous } }));
  const ids = new Set(series.map(x => x.id));
  data.Operations.filter(o => o.type === 'DEPENSE' && (ids.has(o.serie_id) || regle(o)) && o.categorie !== 'Printyshirt').forEach(o => {
    const r = regle(o) || regle(series.find(x => x.id === o.serie_id));
    muts.push({ table: 'Operations', op: 'upsert', data: { id: o.id, categorie: 'Printyshirt', sous_categorie: r.sous } });
  });
  muts.push({ table: 'Parametres', op: 'upsert', data: { cle: 'migration_printyshirt', valeur: new Date().toISOString().slice(0, 10) } });
  modifier(muts);
  toast('Catégorie Printyshirt : ' + series.length + ' abonnement(s) et ' + (muts.length - series.length - 1) + ' ligne(s) reclassés');
}


/* ===================== PRÉVISION (onglet Budget > Prévision) ===================== */
// Hypothèses validées le 18/11/2026, modifiables (paramètres « prev:<clé> »).
const PREV_HYP = [
  { k: 'rsa', lib: 'RSA aujourd\'hui', v: 678, u: '€/mois' },
  { k: 'apl', lib: 'APL aujourd\'hui', v: 402, u: '€/mois' },
  { k: 'heritage', lib: 'Héritage (montant)', v: 50000, u: '€' },
  { k: 'heritage_mois', lib: 'Héritage (mois)', v: '2027-04', u: 'mois' },
  { k: 'prestation', lib: 'Prestation compensatoire (ex-femme)', v: 8000, u: '€' },
  { k: 'prestation_mois', lib: 'Prestation compensatoire (mois)', v: '2027-06', u: 'mois' },
  { k: 'rsa_apres', lib: 'RSA après l\'héritage (estimation)', v: 580, u: '€/mois' },
  { k: 'apl_apres', lib: 'APL après l\'héritage (estimation)', v: 300, u: '€/mois' },
  { k: 'part_sci', lib: 'Ta part dans la SCI après la vente', v: 225000, u: '€' },
  { k: 'flat', lib: 'Impôt sur les dividendes de la SCI', v: 33, u: '%' },
  { k: 'vosges_sci', lib: 'Vente de tes parts des Vosges à la SCI (0 = non)', v: 35000, u: '€' },
  { k: 'vosges_frais', lib: 'Frais de cette vente (payés par la SCI)', v: 2800, u: '€' },
  { k: 'maison', lib: 'Maison achetée par la SCI (frais et travaux)', v: 175000, u: '€' },
  { k: 'loyer', lib: 'Loyer actuel', v: 868, u: '€/mois' },
  { k: 'loyer_sci', lib: 'Loyer que tu verses à la SCI', v: 450, u: '€/mois' },
  { k: 'charges_proprio', lib: 'Taxe foncière + entretien (payés par la SCI)', v: 150, u: '€/mois' },
  { k: 'vosges', lib: 'Maison des Vosges (frais + 2 allers-retours)', v: 167, u: '€/mois' },
  { k: 'printy', lib: 'Printyshirt : coûts', v: 75, u: '€/mois' },
  { k: 'printy_rev', lib: 'Printyshirt : revenus', v: 0, u: '€/mois' },
  { k: 'emprunt', lib: 'Emprunt (fin nov. 2027)', v: 237, u: '€/mois' },
  { k: 'elec', lib: 'Voiture électrique : économie de carburant', v: 140, u: '€/mois' },
  { k: 'elec_cout', lib: 'Voiture électrique : coût net du changement', v: 0, u: '€' }
];
const COMPTE_RESERVE = 'Livret A Virgil';
let venteChoisie = '2027-12';

function hyp(k) {
  const h = PREV_HYP.find(x => x.k === k), p = param('prev:' + k);
  if (p === '' || p == null) return h.v;
  return h.u === 'mois' ? String(p) : Number(String(p).replace(',', '.')) || 0;
}
function ajoutMois(ym, n) { let [y, m] = ym.split('-').map(Number); m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return y + '-' + String(m).padStart(2, '0'); }

function capitalDepart() {
  const j = aujourdhui();
  let dispo = 0, reserve = 0;
  data.Comptes.forEach(c => {
    const v = soldesCompte(c, j).aujourdhui;
    if (c.nom === COMPTE_RESERVE) reserve += v; else dispo += v * partCompte(c.nom);
  });
  return { dispo, reserve };
}

/**
 * Argent dont tu peux disposer, fin de chaque mois de décembre 2026 à décembre 2031.
 * Deux poches : ton argent perso, et la trésorerie de la SCI (accessible en dividendes, après impôt).
 * Quand ta poche perso est vide, la prévision prend un dividende dans la SCI.
 */
function simuler(scenario, vente) {
  const budgetMensuel = budgetsAnnuels().reduce((t, b) => t + b.annuel, 0) / 12;   // train de vie : ton budget, loyer et emprunt compris
  const net = 1 - hyp('flat') / 100;
  let perso = capitalDepart().dispo, sci = 0;
  const debut = ajoutMois(aujourdhui().slice(0, 7), 1), points = [];
  const hMois = String(hyp('heritage_mois')), pMois = String(hyp('prestation_mois'));
  const maison = scenario !== 'tel';
  for (let i = 0; i < 61; i++) {
    const ym = ajoutMois(debut, i);
    const apresHeritage = ym >= hMois, apresVente = vente && ym > vente;
    let entrees = hyp('printy_rev');
    if (apresVente) { /* capital important dans la SCI : plus de RSA ni d'APL (hypothèse prudente) */ }
    else if (apresHeritage && ym < ajoutMois(hMois, 3)) { /* trimestre de l'héritage : RSA et APL suspendus */ }
    else if (apresHeritage) entrees += hyp('rsa_apres') + hyp('apl_apres');
    else entrees += hyp('rsa') + hyp('apl');
    let sorties = budgetMensuel + hyp('printy');
    if (ym > '2027-11') sorties -= hyp('emprunt');
    if (apresHeritage) sorties += hyp('vosges');
    if (maison && apresVente) { sorties += hyp('loyer_sci') - hyp('loyer'); sci += hyp('loyer_sci') - hyp('charges_proprio'); }
    if (scenario === 'elec' && apresVente) sorties -= hyp('elec');
    perso += entrees - sorties;
    if (ym === hMois) perso += hyp('heritage');
    if (ym === pMois) perso += hyp('prestation');
    if (vente && ym === ajoutMois(vente, 1)) {
      sci += hyp('part_sci');
      if (hyp('vosges_sci') > 0) { sci -= hyp('vosges_sci') + hyp('vosges_frais'); perso += hyp('vosges_sci'); }
      if (maison) sci -= hyp('maison');
      if (scenario === 'elec') perso -= hyp('elec_cout');
    }
    if (perso < 0 && sci > 0) { const pris = Math.min(sci, -perso / net); sci -= pris; perso += pris * net; }   // dividende pour combler
    points.push({ ym, cap: perso + Math.max(0, sci) * net, perso, sci });
  }
  return points;
}

function rendrePrevision() {
  $$('#segVente button').forEach(b => b.classList.toggle('actif', b.dataset.vente === venteChoisie));
  const sc = [
    { id: 'tel', nom: 'Tel quel', desc: 'Tu restes dans ta location', coul: '#b26bff' },
    { id: 'maison', nom: 'Maison via la SCI', desc: 'Tu paies ton loyer à la SCI', coul: '#00b4ff' },
    { id: 'elec', nom: 'Maison + électrique', desc: 'Et voiture électrique', coul: '#00ff7f' }
  ].map(x => Object.assign(x, { pts: simuler(x.id, venteChoisie) }));
  const tous = sc.flatMap(x => x.pts.map(p => p.cap));
  const max = Math.max(1, ...tous), min = Math.min(0, ...tous);
  const W = Math.max(320, Math.round($('#prevGraphe').clientWidth || 700)), H = W < 500 ? 220 : 260, g = 46, bas = 22, haut = 10;
  const X = i => g + (W - g - 6) * i / 60, Y = v => haut + (H - bas - haut) * (max - v) / (max - min || 1);
  const pas = [10000, 20000, 25000, 50000, 100000].find(p => (max - min) / p <= 5) || 200000;
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="stat-svg prev-svg" role="img" aria-label="Capital disponible par scénario">';
  for (let v = Math.ceil(min / pas) * pas; v <= max; v += pas)
    svg += '<line x1="' + g + '" x2="' + W + '" y1="' + Y(v) + '" y2="' + Y(v) + '" class="grille' + (v === 0 ? ' zero' : '') + '"/><text x="' + (g - 6) + '" y="' + (Y(v) + 4) + '" class="axe" text-anchor="end">' + Math.round(v / 1000) + 'k</text>';
  for (let a = 0; a <= 5; a++) { const i = sc[0].pts.findIndex(p => p.ym === (2027 + a) + '-01'); if (i >= 0) svg += '<line x1="' + X(i) + '" x2="' + X(i) + '" y1="' + haut + '" y2="' + (H - bas) + '" class="grille"/><text x="' + X(i) + '" y="' + (H - 6) + '" class="axe" text-anchor="middle">' + (2027 + a) + '</text>'; }
  sc.slice().reverse().forEach(x => {
    svg += '<polyline fill="none" stroke="' + x.coul + '" stroke-width="2.5" stroke-linejoin="round" style="filter:drop-shadow(0 0 4px ' + x.coul + '88)" points="' + x.pts.map((p, i) => X(i).toFixed(1) + ',' + Y(p.cap).toFixed(1)).join(' ') + '"/>';
  });
  $('#prevGraphe').innerHTML = svg + '</svg><div class="stat-legende">' + sc.map(x => '<span><i class="puce-leg" style="background:' + x.coul + ';box-shadow:0 0 6px ' + x.coul + '"></i>' + x.nom + '</span>').join('') + '</div>';
  const nomMois = ym => MOIS[Number(ym.slice(5)) - 1] + ' ' + ym.slice(0, 4);
  $('#prevScenarios').innerHTML = sc.map(x => {
    const fin = x.pts.find(p => p.cap < 0), dernier = x.pts[x.pts.length - 1];
    return '<div class="carte prev-sc" style="--c:' + x.coul + '"><div class="nom">' + x.nom + '</div><div class="desc">' + x.desc + '</div>' +
      (fin ? '<div class="res neg">Argent disponible épuisé en <b>' + nomMois(fin.ym) + '</b></div>' : '<div class="res">Disponible fin 2031 : <b>' + euros0(dernier.cap) + '</b></div>') +
      (x.id !== 'tel' && venteChoisie ? '<div class="patri">+ la maison dans la SCI (' + euros0(hyp('maison')) + ')</div>' : '') + '</div>';
  }).join('');
  const cd = capitalDepart();
  if (!venteChoisie) $('#prevScenarios').innerHTML = '<p class="bud-hors">Sans vente du bâtiment, les trois scénarios sont identiques : pas d\'achat de maison ni de changement de voiture.</p>' + $('#prevScenarios').innerHTML;
  $('#prevReserve').textContent = 'Courbe : ton argent perso + ce que tu pourrais sortir de la SCI en dividendes, après ' + hyp('flat') + ' % d\'impôt. Point de départ : ' + euros0(cd.dispo) + ' disponibles aujourd\'hui (compte commun pour ta moitié). Réserve de dernier recours non comptée : ' + euros0(cd.reserve) + '. Train de vie = ton budget (' + euros0(budgetsAnnuels().reduce((t, b) => t + b.annuel, 0)) + '/an).';
  $('#prevHypotheses').innerHTML = PREV_HYP.map(h => '<label class="ligne-budget"><span>' + esc(h.lib) + '</span><input type="' + (h.u === 'mois' ? 'month' : 'text') + '" inputmode="decimal" data-hyp="' + h.k + '" value="' + esc(hyp(h.k)) + '"><em>' + (h.u === 'mois' ? '' : h.u) + '</em></label>').join('') +
    '<p class="discret">Estimations à vérifier : RSA et APL après l\'héritage (simulateur caf.fr), et la suppression du RSA et de l\'APL après la vente du bâtiment. Ne sont pas comptés : les intérêts de ton épargne, l\'impôt sur les loyers reçus par la SCI.</p>';
  $$('[data-hyp]').forEach(inp => inp.onchange = () => {
    const h = PREV_HYP.find(x => x.k === inp.dataset.hyp);
    modifier([{ table: 'Parametres', op: 'upsert', data: { cle: 'prev:' + h.k, valeur: h.u === 'mois' ? inp.value : String(Number(inp.value.replace(/\s/g, '').replace(',', '.')) || 0) } }]);
  });
}

(function brancherPrevision() {
  $$('#segBudget button').forEach(b => b.onclick = () => {
    sousVueBudget = b.dataset.sv;
    $$('#segBudget button').forEach(x => x.classList.toggle('actif', x === b));
    $('#budMois').hidden = sousVueBudget !== 'mois'; $('#budPrevision').hidden = sousVueBudget !== 'prevision';
    if (sousVueBudget === 'prevision') rendrePrevision(); else rendreBudget();
  });
  $$('#segVente button').forEach(b => b.onclick = () => { venteChoisie = b.dataset.vente; rendrePrevision(); });
})();


/* ===== Modifier un ticket ventilé en entier (lignes, intitulé, date, compte, paiement, enseigne) ===== */
function ouvrirTicket(groupe) {
  const enfants = data.Operations.filter(o => o.groupe === groupe).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!enfants.length) return;
  const o = enfants[0];
  const pos = vueCourante === 'journal' ? { y: window.scrollY, mois: moisJournal ? moisJournal.join('-') : '' } : null;
  ouvrirFormulaire();
  ticketEdition = { groupe, ids: enfants.map(x => x.id) };
  positionJournal = pos;
  definirType(o.type);
  $('#zoneRaccourcis').hidden = true;
  $('#champFrequence').hidden = true;
  $('#btnSupprimer').hidden = false;
  $('#btnFavori').hidden = true;
  $('#date').value = o.date;
  remplirSelect($('#compte'), listeComptes(), '— choisir —', o.compte);
  remplirSelect($('#paiement'), trierFr(data.Paiements.map(p => p.paiement)), '— choisir —', o.paiement);
  remplirSelect($('#enseigne'), trierFr(data.Enseignes.map(e => e.enseigne)), '—', o.enseigne);
  $('#commentaire').value = o.commentaire || '';
  $('#lignesVentilation').innerHTML = '';
  enfants.forEach(x => ajouterLigneVentilation(x));
  $('#ventiler').checked = true; basculerVentilation();
  $('#ventiler').disabled = true;   // un ticket reste ventilé
  $('#champFrequence').hidden = true;
  $('#intitule').value = o.groupe_libelle || '';
  majEtoiles(); majDateTexte(); majTotalVentilation();
  $('#titre').textContent = 'Modifier le ticket';
}


/* ===== Soldes masqués : floutés à chaque ouverture sur mobile, œil pour les afficher ===== */
const ICONE_OEIL = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const ICONE_OEIL_BARRE = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M2 12s3.6-7 10-7c2 0 3.7.7 5.1 1.6M22 12s-3.6 7-10 7c-2 0-3.7-.7-5.1-1.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M9.9 14.1a3 3 0 0 1 4.2-4.2M4 20 20 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
function majOeilSoldes() {
  const masques = document.body.classList.contains('soldes-masques');
  const b = $('#oeilSoldes');
  b.innerHTML = masques ? ICONE_OEIL_BARRE : ICONE_OEIL;
  b.classList.toggle('visible', !masques);
  b.setAttribute('aria-pressed', String(!masques));
  b.title = masques ? 'Afficher les soldes' : 'Masquer les soldes';
}
(function brancherOeilSoldes() {
  document.body.classList.toggle('soldes-masques', window.matchMedia('(max-width: 699px)').matches);
  $('#oeilSoldes').onclick = () => { document.body.classList.toggle('soldes-masques'); majOeilSoldes(); };
  majOeilSoldes();
  $('#oeilSoldes').hidden = vueCourante !== 'accueil';
})();
