/* Budget — appli web hors connexion (v1)
 * Données : copie locale (localStorage) + file d'attente des modifications,
 * synchronisée avec le script Apps Script du classeur « Budget – Base ».
 */
'use strict';

const VERSION_APP = '1.18.0';
const VERSION_SCRIPT_ATTENDUE = '2.2.0';
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
let groupesOuverts = new Set();   // dépenses ventilées dépliées dans le journal   // lignes à mettre en évidence dans le journal après un enregistrement

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
  $('#total').innerHTML = '<span class="discret lib-total">Total aujourd\'hui</span>' +
    '<span class="montant-grand ' + (total < 0 ? 'neg' : '') + '">' + euros(total) + '</span>' +
    '<span class="discret date-total"><span class="date-longue">' + new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) +
    '</span><span class="date-courte">' + new Date().toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) + '</span></span>';
  $('#total').onclick = ouvrirChoixTotal;

  const nomMoisSuiv = MOIS[new Date().getMonth() === 11 ? 0 : new Date().getMonth() + 1];
  const carte = ({ c, s }) =>
    '<div class="carte compte-carte" data-compte="' + esc(c.nom) + '">' +
      '<div class="entete"><span class="nom">' + esc(c.nom) + '</span>' +
      '<span class="montant-grand ' + (s.aujourdhui < 0 ? 'neg' : '') + '">' + euros(s.aujourdhui) + '</span></div>' +
      '<div class="details-solde">' +
        '<div>Fin de mois<b class="' + (s.finMois < 0 ? 'neg' : '') + '">' + euros(s.finMois) + '</b></div>' +
        '<div>Engagé ' + nomMoisSuiv + '<b>' + euros(s.engage) + '</b></div>' +
        '<div>Différence<b class="' + (s.difference < 0 ? 'neg' : '') + '">' + euros(s.difference) + '</b></div>' +
        '<div>Pointé<b>' + euros(s.pointe) + '</b></div>' +
      '</div></div>';

  // 4 cartes choisies par l'utilisateur (par défaut : les plus utilisées) ; les autres comptes en dessous.
  const nomsCartes = comptesTuiles('tuilesAccueil', 4);
  const principaux = nomsCartes.map(n => calcules.find(x => x.c.nom === n)).filter(Boolean);
  const autres = calcules.filter(x => principaux.indexOf(x) === -1 && (x.s.utilise || Math.abs(x.s.aujourdhui) > 0.004));
  $('#comptes').innerHTML = principaux.map(carte).join('');
  $('#autresComptes').hidden = !autres.length;
  $('#autresComptes > div').innerHTML = autres.map(carte).join('');
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
function rendreTuiles() {
  const jour = aujourdhui();
  const noms = comptesTuiles();
  $('#tuilesPointage').innerHTML = noms.map((nom, i) => {
    const c = data.Comptes.find(x => x.nom === nom);
    const v = c ? soldesCompte(c, jour).pointeTotal : 0;
    const change = dernieresValeursTuiles[i] !== undefined && dernieresValeursTuiles[nom + i] !== v;
    dernieresValeursTuiles[i] = true; dernieresValeursTuiles[nom + i] = v;
    return '<button type="button" class="tuile' + (change ? ' maj' : '') + '" data-index="' + i + '">' +
      '<span class="n">' + esc(nom) + '</span><span class="v' + (v < 0 ? ' neg' : '') + '">' + euros(v) + '</span><span class="p">pointé</span></button>';
  }).join('');
  $$('#tuilesPointage .tuile').forEach(t => t.onclick = () => ouvrirChoixCompte(Number(t.dataset.index)));
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

function rendreJournal() {
  rendreTuiles();
  if (!moisJournal) { const j = aujourdhui(); moisJournal = [Number(j.slice(0, 4)), Number(j.slice(5, 7))]; }
  const [y, m] = moisJournal;
  $('#moisLibelle').textContent = libelleMois(y, m);

  const sel = $('#filtreCompte'), choix = sel.value;
  sel.innerHTML = '<option value="">Tous les comptes</option>' +
    data.Comptes.map(c => '<option>' + esc(c.nom) + '</option>').join('');
  sel.value = choix;
  const compte = sel.value;
  const q = $('#recherche').value.trim().toLowerCase();
  const prefixe = ymd(y, m, 1).slice(0, 7);

  let ops = data.Operations.filter(o =>
    (q ? true : o.date.slice(0, 7) === prefixe) &&
    (!compte || o.compte === compte || o.compte_vers === compte) &&
    (!q || [o.designation, o.enseigne, o.categorie, o.sous_categorie, o.commentaire, o.compte, String(o.montant)].join(' ').toLowerCase().includes(q)));
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
    let fond = fondCompte(o.compte);
    if (vir && (fond || fondCompte(o.compte_vers))) fond = 'linear-gradient(90deg,' + (fond || 'var(--carte)') + ',' + (fondCompte(o.compte_vers) || 'var(--carte)') + ')';
    const cases = vir
      ? '<span class="coches"><input type="checkbox" class="coche" data-cote="depart" ' + (o.pointe ? 'checked' : '') + styleCase(o.compte) + ' title="Pointé sur ' + esc(o.compte) + '" aria-label="Pointé sur ' + esc(o.compte) + '">' +
        '<input type="checkbox" class="coche" data-cote="arrivee" ' + (estPointeVers(o) ? 'checked' : '') + styleCase(o.compte_vers) + ' title="Pointé sur ' + esc(o.compte_vers) + '" aria-label="Pointé sur ' + esc(o.compte_vers) + '"></span>'
      : '<input type="checkbox" class="coche" ' + (o.pointe ? 'checked' : '') + styleCase(o.compte) + ' aria-label="Pointée">';
    const prevue = vir ? (!o.pointe || !estPointeVers(o)) : !o.pointe;
    const style = (fond ? 'background:' + fond + ';' : '') + liseret(o.compte);
    return '<div class="op' + (prevue && o.date > jour ? ' prevue' : '') + (idsSurlignes.has(o.id) ? ' surligne' : '') + '" data-id="' + esc(o.id) + '"' +
      (style ? ' style="' + esc(style) + '"' : '') + '>' + cases +
      '<div class="lib"><div class="t">' + esc(o.designation || o.enseigne || o.sous_categorie) + (o.serie_id ? ' ↻' : '') + (o.commentaire ? ' 💬' : '') + '</div>' +
      '<div class="s">' + sous + '</div></div>' +
      '<div class="m ' + classe + '">' + euros(montantAffiche) + '</div></div>';
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
    html += '<div class="op groupe' + (!toutPointe && o.date > jour ? ' prevue' : '') + (surligne ? ' surligne' : '') + '" data-groupe="' + esc(el.groupe) + '"' +
      ((fondG || liseret(o.compte)) ? ' style="' + esc((fondG ? 'background:' + fondG + ';' : '') + liseret(o.compte)) + '"' : '') + '>' +
      '<input type="checkbox" class="coche" ' + (toutPointe ? 'checked' : '') + styleCase(o.compte) + ' aria-label="Pointée">' +
      '<div class="lib"><div class="t"><span class="picto" title="Dépense ventilée">' + (ouvert ? '▾' : '▸') + ' ' + el.enfants.length + '</span>' + esc(titre) + (o.commentaire ? ' 💬' : '') + '</div>' +
      '<div class="s">Ventilée · ' + esc(o.compte) + (o.paiement ? ' · ' + esc(o.paiement) : '') + '</div></div>' +
      '<div class="m ' + (total < 0 ? 'neg' : 'pos') + '">' + euros(total) + '</div></div>';
    if (ouvert) html += '<div class="sous-ops">' + el.enfants.map(x => ligneOp(x, true)).join('') + '</div>';
  });
  $('#listeOps').innerHTML = html || '<p class="discret">Aucune opération.</p>';
  $$('#listeOps .op.groupe').forEach(el => {
    const g = el.dataset.groupe;
    $('.coche', el).onchange = e => modifier(data.Operations.filter(o => o.groupe === g)
      .map(o => ({ table: 'Operations', op: 'upsert', data: { id: o.id, pointe: e.target.checked } })));
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
      modifier([{ table: 'Operations', op: 'upsert', data: maj }]);
    });
    $('.lib', el).onclick = $('.m', el).onclick = () => ouvrirFormulaire({ op: data.Operations.find(o => o.id === id) });
  });
}


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

/** Compte « Espèces » (pour les retraits). */
function compteEspeces() {
  return listeComptes().find(n => /^esp[eè]ces$/i.test(n.normalize('NFD').replace(/[\u0300-\u036f]/g, '')) || /^especes$/i.test(n.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) || '';
}

function definirType(type) {
  typeCourant = type;
  $$('#segType button').forEach(b => b.classList.toggle('actif', b.dataset.type === type));
  const vir = type === 'VIREMENT' || type === 'RETRAIT';
  if (type === 'RETRAIT') $('#vers').value = compteEspeces();     // retrait = mouvement vers Espèces
  // Désignation par défaut d'un retrait : « Retrait » (retirée si on change de type sans l'avoir modifiée)
  const desi = $('#designation');
  if (type === 'RETRAIT' && !desi.value.trim()) desi.value = 'Retrait';
  else if (type !== 'RETRAIT' && desi.value === 'Retrait') desi.value = '';
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
  const f = $('#formulaire'); f.reset();
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
  let designation = $('#designation').value.trim();
  if (!designation) designation = typeCourant === 'RETRAIT' ? 'Retrait' : type === 'VIREMENT' ? 'Virement ' + compte + ' → ' + commun.compte_vers : (commun.enseigne || sous);
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
  afficherVue('journal');
  const ligne = $('#listeOps .op.surligne');
  if (ligne) ligne.scrollIntoView({ block: 'center' });
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
  afficherVue('journal');
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
    '<div class="item' + (c.actif === false ? ' inactif' : '') + '"><span>' +
    (couleurCompte(c.nom) ? '<span class="pastille" style="background:' + esc(couleurCompte(c.nom)) + '"></span>' : '') +
    esc(c.nom) + (c.actif === false ? ' (désactivé)' : '') +
    '<span class="sous">Départ ' + euros(c.solde_initial) + (c.date_solde ? ' au ' + c.date_solde.split('-').reverse().join('/') : '') +
    ' · aujourd\'hui ' + euros(soldesCompte(c, jourR).aujourdhui) + '</span></span>' +
    '<button type="button" data-fiche="' + esc(c.nom) + '">Modifier</button></div>').join('') || '<p class="discret">Aucun compte.</p>';
  $$('[data-fiche]').forEach(b => b.onclick = () => ouvrirFicheCompte(b.dataset.fiche));

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
  $('#btnAnnuler').onclick = () => { const r = edition ? 'journal' : 'accueil'; edition = null; afficherVue(r); };
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
