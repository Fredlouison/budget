/* Budget — appli web hors connexion (v1)
 * Données : copie locale (localStorage) + file d'attente des modifications,
 * synchronisée avec le script Apps Script du classeur « Budget – Base ».
 */
'use strict';

const VERSION_APP = '1.28.1';
const VERSION_SCRIPT_ATTENDUE = '2.4.0';
const LS = { config: 'budget.config', data: 'budget.data', outbox: 'budget.outbox', local: 'budget.local' };
const CLES = {
  Operations: ['id'], Series: ['id'], Comptes: ['nom'], Arretes: ['compte', 'annee', 'mois'],
  Categories: ['categorie', 'sous_categorie'], Enseignes: ['enseigne'], Paiements: ['paiement'],
  Favoris: ['id'], Parametres: ['cle']
};
const INTERVALLES = { MENSUEL: 1, BIMESTRIEL: 2, TRIMESTRIEL: 3, QUADRIMESTRIEL: 4, SEMESTRIEL: 6, ANNUEL: 12 };
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
function param(cle) { const p = data.Parametres.find(x => x.cle === cle); return p ? p.valeur : ''; }

/** Couleur d'un compte (paramètre « couleur:<nom> »), et sa version très claire pour le fond des lignes. */
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
    majEtatSync();
    rendre();
  } catch (e) {
    derniereErreur = (e instanceof TypeError || e.name === 'AbortError') ? 'Pas de réseau' : e.message;
    majEtatSync(derniereErreur);
    if (vueCourante === 'reglages') rendreReglages(e.message);
  } finally {
    syncEnCours = false; majEtatSync(derniereErreur);
    if (outbox.length && navigator.onLine) setTimeout(synchroniser, 30000);
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
  majEtatSync();
}

function afficherVue(vue) {
  vueCourante = vue;
  $$('.vue').forEach(s => { s.hidden = s.id !== 'vue-' + vue; });
  $$('.onglets button').forEach(b => b.classList.toggle('actif', b.dataset.vue === vue));
  document.body.classList.toggle('saisie', vue === 'saisie');
  $('#titre').textContent = { accueil: 'Soldes', journal: 'Journal', saisie: edition ? 'Modifier' : 'Nouvelle opération', reglages: 'Réglages' }[vue];
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

function rendreTuiles() {
  const jour = aujourdhui();
  const noms = comptesTuiles();
  const filtre = $('#filtreCompte').value;
  const [y, m] = moisJournal || [Number(jour.slice(0, 4)), Number(jour.slice(5, 7))];
  const finMois = ymd(y, m, joursDansMois(y, m));
  const libFin = '<span class="long">pointé au ' + joursDansMois(y, m) + ' ' + MOIS[m - 1] + '</span><span class="court">pointé ' + joursDansMois(y, m) + '/' + String(m).padStart(2, '0') + '</span>';
  $('#tuilesPointage').innerHTML = noms.map((nom, i) => {
    const c = data.Comptes.find(x => x.nom === nom);
    const actif = filtre === nom;
    const v = c ? (actif ? pointeAu(c, finMois) : soldesCompte(c, jour).pointeTotal) : 0;
    const change = dernieresValeursTuiles[i] !== undefined && dernieresValeursTuiles[nom + i] !== v;
    dernieresValeursTuiles[i] = true; dernieresValeursTuiles[nom + i] = v;
    const coul = couleurCompte(nom);
    const classes = 'tuile' + (change ? ' maj' : '') + (actif ? ' filtree' : '') + (filtre && !actif ? ' estompee' : '');
    return '<button type="button" class="' + classes + '" data-index="' + i + '" data-nom="' + esc(nom) + '"' + (coul ? ' style="--c:' + esc(coul) + '"' : '') +
      ' aria-pressed="' + actif + '" title="' + (actif ? 'Afficher tous les comptes' : 'N\'afficher que ' + esc(nom)) + '">' +
      (actif ? '<span class="marque-filtre">' + ICONE_FILTRE_TUILE + '</span>' : '') +
      '<span class="n"><i class="pastille-compte"></i><span class="nom-tuile">' + esc(nom) + '</span>' +
      '<span class="changer-compte" role="button" tabindex="0" aria-label="Changer de compte" title="Changer de compte">' + ICONE_CHEVRON + '</span></span>' +
      '<span class="v' + (v < 0 ? ' neg' : '') + '">' + euros(v) + '</span><span class="p">' + (actif ? libFin : 'pointé') + '</span></button>';
  }).join('');
  $$('#tuilesPointage .tuile').forEach(t => t.onclick = () => {
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
      '<div class="lib"><div class="t">' + esc(o.designation || o.enseigne || o.sous_categorie) + (o.serie_id ? ' ↻' : '') + (o.commentaire ? ' <span class="bulle-com" data-com="' + esc(o.commentaire) + '">💬</span>' : '') + '</div>' +
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
    const titre = [o.enseigne, o.groupe_libelle].filter(Boolean).join(' — ') || 'Dépense ventilée';
    const surligne = el.enfants.some(x => idsSurlignes.has(x.id));
    const fondG = fondCompte(o.compte);
    const verifG = el.enfants.some(x => x.a_verifier);
    html += '<div class="op groupe' + (verifG ? ' a-verifier' : '') + (el.enfants.some(x => (sortants.get(x.id) || 0) > Date.now()) ? ' sortante' : '') + (!toutPointe && o.date > jour ? ' prevue' : '') + (surligne ? ' surligne' : '') + '" data-groupe="' + esc(el.groupe) + '"' +
      ((fondG || liseret(o.compte)) ? ' style="' + esc((fondG ? 'background:' + fondG + ';' : '') + liseret(o.compte)) + '"' : '') + '>' +
      '<input type="checkbox" class="coche" ' + (toutPointe ? 'checked' : '') + styleCase(o.compte) + ' aria-label="Pointée">' +
      '<div class="lib"><div class="t"><span class="picto" title="Dépense ventilée">' + (ouvert ? '▾' : '▸') + ' ' + el.enfants.length + '</span>' + esc(titre) + (o.commentaire ? ' <span class="bulle-com" data-com="' + esc(o.commentaire) + '">💬</span>' : '') + '</div>' +
      '<div class="s">Ventilée · ' + esc(o.compte) + (o.paiement ? ' · ' + esc(o.paiement) : '') + '</div></div>' +
      '<button type="button" class="drapeau' + (verifG ? ' actif' : '') + '" data-verif-groupe="' + esc(el.groupe) + '" title="' + (verifG ? 'À vérifier (toucher pour retirer)' : 'Marquer à vérifier') + '" aria-label="À vérifier">' + ICONE_DRAPEAU + '</button>' +
      '<div class="m ' + (total < 0 ? 'neg' : 'pos') + '">' + euros(total) + '</div></div>';
    if (ouvert) html += '<div class="sous-ops">' + el.enfants.map(x => ligneOp(x, true)).join('') + '</div>';
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
  $('#champSuivantes').hidden = !(edition && edition.serie_id);
  $('#blocVentilation').hidden = true;
  $('#lignesVentilation').innerHTML = '';

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
  $('#ligneEnseigne').classList.toggle('avec-intitule', on);
  $('#blocVentilation').hidden = !on;
  $('#blocCategorie').hidden = on;
  $('#champMontant').hidden = on;
  $('#champDesignation').hidden = on;
  $('#champFrequence').hidden = on;
  if (on && !$('#lignesVentilation').children.length) {
    const premiere = ajouterLigneVentilation(); ajouterLigneVentilation();
    $('.v-designation', premiere).focus();
  }
  majTotalVentilation();
}

function ajouterLigneVentilation() {
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
  return div;
}

function lignesVentilation() {
  return $$('#lignesVentilation .ligne-ventilation').map(div => ({
    designation: $('.v-designation', div).value.trim(), categorie: $('.v-categorie', div).value,
    sous_categorie: $('.v-sous', div).value, montantTexte: $('.v-montant', div).value, div
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

/** Échéances d'une série strictement après une date, sur l'année de cette date (et l'année suivante si déjà préparée). */
function echeancesApres(serie, date, fiche) {
  const annee = Number(date.slice(0, 4));
  const annees = [annee];
  if (param('annee_generee_' + (annee + 1))) annees.push(annee + 1);
  const muts = [];
  annees.forEach(a => occurrencesSerie(serie, a).filter(d => d > date).forEach(d => {
    muts.push({ table: 'Operations', op: 'upsert', data: Object.assign({}, fiche, {
      id: nouvelId(), date: d, pointe: false, serie_id: serie.id, source: 'appli', commentaire: '' }) });
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
    const groupe = 'G-' + nouvelId();
    const intitule = $('#intitule').value.trim();
    const toutesLignes = $$('#lignesVentilation .ligne-ventilation');
    lignes.forEach(l => {
      let v = null; try { v = calculer(l.montantTexte); } catch (e) { /* invalide */ }
      const n = ' (ligne ' + (toutesLignes.indexOf(l.div) + 1) + ')';
      ok &= marquer($('.v-designation', l.div), !!l.designation, 'désignation' + n) & marquer($('.v-categorie', l.div), !!l.categorie, 'catégorie' + n) &
        marquer($('.v-sous', l.div), !!l.sous_categorie, 'sous-catégorie' + n) & marquer($('.v-montant', l.div), v > 0, 'montant' + n);
      ops.push(Object.assign({ id: nouvelId() }, commun, { designation: l.designation, categorie: l.categorie,
        sous_categorie: l.sous_categorie, montant: signe(v || 0), pointe: false, serie_id: '', source: 'appli',
        groupe, groupe_libelle: intitule }));
    });
    if (!ok) { signalerManquants(); return; }
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
    const muts = [{ table: 'Operations', op: 'upsert', data: Object.assign({ id: edition.id, pointe: $('#pointe').checked },
      type === 'VIREMENT' ? { pointe_vers: $('#pointeVers').checked } : {}, fiche) }];
    if (edition.serie_id && $('#suivantes').checked) {
      const jour = Number(date.slice(8, 10));
      data.Operations.filter(o => o.serie_id === edition.serie_id && o.date > edition.date && !o.pointe).forEach(o => {
        const [y, m] = o.date.split('-').map(Number);
        muts.push({ table: 'Operations', op: 'upsert', data: Object.assign({}, fiche, {
          id: o.id, date: ymd(y, m, Math.min(jour, joursDansMois(y, m))), commentaire: o.commentaire }) });
      });
      muts.push({ table: 'Series', op: 'upsert', data: Object.assign({ id: edition.serie_id, jour },
        { type, designation, enseigne: fiche.enseigne, categorie, sous_categorie: sous, compte, compte_vers: fiche.compte_vers,
          paiement: fiche.paiement, montant: fiche.montant }) });
    }
    modifier(muts);
    return terminerSaisie(date, 'Opération modifiée', [edition.id]);
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
  const premiere = { table: 'Operations', op: 'upsert', data: Object.assign({}, fiche, { id: nouvelId(), date, pointe: false, serie_id: serie.id, source: 'appli' }) };
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

function supprimerOperation() {
  if (!edition) return;
  const serie = edition.serie_id && $('#suivantes').checked;
  if (!confirm(serie ? 'Supprimer cette échéance et toutes les suivantes non pointées ?' : 'Supprimer cette opération ?')) return;
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

function enregistrerFavori() {
  const designation = $('#designation').value.trim();
  const categorie = $('#categorie').value, sous = $('#sous_categorie').value;
  if (typeCourant === 'VIREMENT' || typeCourant === 'RETRAIT' || !categorie || !sous) { toast('Choisis au moins une catégorie et une sous-catégorie.', true); return; }
  const nom = majusculesMots(prompt('Nom du favori :', designation || sous) || '');
  if (!nom) return;
  modifier([{ table: 'Favoris', op: 'upsert', data: { id: nouvelId(), nom: nom.trim(), type: typeCourant, designation: designation || sous,
    enseigne: $('#enseigne').value, categorie, sous_categorie: sous, compte: $('#compte').value, paiement: $('#paiement').value, utilisations: 0 } }]);
  rendreRaccourcis();
  toast('Favori ajouté');
}

function ajouterReference(quoi) {
  if (quoi === 'enseigne') {
    const nom = majusculesMots((prompt('Nouvelle enseigne :') || '').trim()); if (!nom) return;
    modifier([{ table: 'Enseignes', op: 'upsert', data: { enseigne: nom } }]);
    remplirSelect($('#enseigne'), trierFr(data.Enseignes.map(e => e.enseigne)), '—', nom);
  } else if (quoi === 'categorie') {
    const nom = majusculesMots((prompt('Nouvelle catégorie :') || '').trim()); if (!nom) return;
    const sc = majusculesMots((prompt('Première sous-catégorie de « ' + nom + ' » :') || '').trim()); if (!sc) return;
    modifier([{ table: 'Categories', op: 'upsert', data: { categorie: nom, sous_categorie: sc } }]);
    remplirSelect($('#categorie'), listeCategories(), '— choisir —', nom); chargerSousCategories(sc);
  } else {
    const cat = $('#categorie').value; if (!cat) { toast('Choisis d\'abord une catégorie.', true); return; }
    const sc = majusculesMots((prompt('Nouvelle sous-catégorie de « ' + cat + ' » :') || '').trim()); if (!sc) return;
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
  $$('[data-renommer]').forEach(b => b.onclick = () => {
    const f = data.Favoris.find(x => x.id === b.dataset.renommer); const nom = majusculesMots((prompt('Nouveau nom :', f.nom) || '').trim());
    if (nom) modifier([{ table: 'Favoris', op: 'upsert', data: { id: f.id, nom } }]);
  });
  $$('[data-suppr-fav]').forEach(b => b.onclick = () => {
    if (confirm('Supprimer ce favori ?')) modifier([{ table: 'Favoris', op: 'delete', data: { id: b.dataset.supprFav } }]);
  });

  const nomsFreq = { MENSUEL: 'mensuel', BIMESTRIEL: 'bimestriel', TRIMESTRIEL: 'trimestriel', QUADRIMESTRIEL: 'quadrimestriel', SEMESTRIEL: 'semestriel', ANNUEL: 'annuel' };
  $('#listeSeries').innerHTML = '<p class="discret">Désactive celles qui ne doivent pas se répéter l\'an prochain.</p>' +
    data.Series.slice().sort((a, b) => (b.actif === true) - (a.actif === true) || a.designation.localeCompare(b.designation, 'fr')).map(s =>
      '<div class="item' + (s.actif ? '' : ' inactif') + '"><span>' + esc(s.designation) + '<span class="sous">' + (nomsFreq[s.frequence] || s.frequence) +
      ' · le ' + s.jour + ' · ' + euros(s.montant) + (s.fin ? ' · jusqu\'au ' + s.fin.split('-').reverse().join('/') : '') + '</span></span>' +
      '<button type="button" data-serie="' + esc(s.id) + '">' + (s.actif ? 'Désactiver' : 'Activer') + '</button></div>'
    ).join('');
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
  if (couleurChoisie !== couleurCompte(nom)) muts.push({ table: 'Parametres', op: 'upsert', data: { cle: 'couleur:' + nom, valeur: couleurChoisie } });
  modifier(muts);
  $('#ficheCompte').hidden = true;
  toast(compteEdite ? 'Compte modifié' : 'Compte ajouté');
}

function supprimerFicheCompte() {
  const c = compteEdite; if (!c) return;
  const n = utilisationsCompte(c.nom);
  if (n) { $('#fcErreur').textContent = n + ' opération(s) utilisent ce compte : il ne peut pas être supprimé. Décoche « Compte actif » pour le masquer.'; return; }
  if (!confirm('Supprimer définitivement le compte « ' + c.nom + ' » ?')) return;
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
  $('#btnRecharger').onclick = () => {
    if (outbox.length && !confirm(outbox.length + ' modification(s) pas encore envoyée(s). Elles seront conservées et renvoyées. Continuer ?')) return;
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
