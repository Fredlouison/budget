/**
 * BUDGET — Apps Script v2
 * À coller dans le classeur « Budget – Base » (Extensions > Apps Script).
 *
 * Rôle : stockage et API. Aucun calcul de solde dans le classeur,
 * aucune formule, aucune dépendance à l'onglet actif.
 *
 * Onglets attendus : Operations, Series, Comptes, Arretes, Categories,
 * Enseignes, Paiements, Favoris, Parametres.
 */

const VERSION_API = '2.5.0';
const CLE_TOKEN = 'BUDGET_TOKEN';

const TABLES = {
  Operations: {
    cle: ['id'],
    colonnes: ['id', 'date', 'type', 'designation', 'enseigne', 'categorie', 'sous_categorie',
      'compte', 'compte_vers', 'paiement', 'montant', 'pointe', 'commentaire', 'serie_id', 'source',
      'groupe', 'groupe_libelle', 'pointe_vers', 'a_verifier'],
    dates: ['date'], booleens: ['pointe', 'a_verifier'], nombres: ['montant']
  },
  Series: {
    cle: ['id'],
    colonnes: ['id', 'type', 'designation', 'enseigne', 'categorie', 'sous_categorie', 'compte',
      'compte_vers', 'paiement', 'frequence', 'jour', 'montant', 'debut', 'fin', 'actif', 'ticket'],
    dates: ['debut', 'fin'], booleens: ['actif'], nombres: ['jour', 'montant']
  },
  Comptes: {
    cle: ['nom'],
    colonnes: ['nom', 'solde_initial', 'date_solde', 'ordre', 'actif'],
    dates: ['date_solde'], booleens: ['actif'], nombres: ['solde_initial', 'ordre']
  },
  Arretes: {
    cle: ['compte', 'annee', 'mois'],
    colonnes: ['compte', 'annee', 'mois', 'jour'],
    dates: [], booleens: [], nombres: ['annee', 'mois', 'jour']
  },
  Categories: { cle: ['categorie', 'sous_categorie'], colonnes: ['categorie', 'sous_categorie'], dates: [], booleens: [], nombres: [] },
  Enseignes: { cle: ['enseigne'], colonnes: ['enseigne'], dates: [], booleens: [], nombres: [] },
  Paiements: { cle: ['paiement'], colonnes: ['paiement'], dates: [], booleens: [], nombres: [] },
  Favoris: {
    cle: ['id'],
    colonnes: ['id', 'nom', 'type', 'designation', 'enseigne', 'categorie', 'sous_categorie',
      'compte', 'paiement', 'utilisations'],
    dates: [], booleens: [], nombres: ['utilisations']
  },
  Parametres: { cle: ['cle'], colonnes: ['cle', 'valeur'], dates: [], booleens: [], nombres: [] }
};

const INTERVALLES = { MENSUEL: 1, BIMESTRIEL: 2, TRIMESTRIEL: 3, QUADRIMESTRIEL: 4, SEMESTRIEL: 6, ANNUEL: 12 };


/* ============================================================
   MENU DU CLASSEUR
   ============================================================ */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Budget')
    .addItem("Installer / afficher le token de l'appli", 'menuInstaller')
    .addSeparator()
    .addItem("Générer les échéances de l'année suivante", 'menuGenererAnneeSuivante')
    .addItem('Archiver une année…', 'menuArchiverAnnee')
    .addToUi();
}

function menuInstaller() {
  const ui = SpreadsheetApp.getUi();
  const token = installer();
  ui.alert('Appli Budget',
    "Token de l'appli (à saisir une seule fois sur chaque appareil) :\n\n" + token +
    '\n\nLe déclencheur de décembre est installé : les échéances de l\'année suivante ' +
    'seront générées automatiquement à partir du 1er décembre.', ui.ButtonSet.OK);
}

function menuGenererAnneeSuivante() {
  const annee = new Date().getFullYear() + 1;
  const res = genererAnnee(annee);
  SpreadsheetApp.getUi().alert('Année ' + annee,
    res.creees + ' échéance(s) créée(s), ' + res.deja + ' déjà présente(s), ' +
    res.arretes + " jour(s) d'arrêté recopié(s).", SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuArchiverAnnee() {
  const ui = SpreadsheetApp.getUi();
  const rep = ui.prompt('Archiver une année',
    "Année à archiver (les opérations seront déplacées dans un fichier d'archive, " +
    'les soldes de départ des comptes seront mis à jour) :', ui.ButtonSet.OK_CANCEL);
  if (rep.getSelectedButton() !== ui.Button.OK) return;
  const res = archiverAnnee(Number(rep.getResponseText()));
  ui.alert('Archivage terminé', res.operations + ' opération(s) archivée(s) dans « ' + res.fichier + ' ».',
    ui.ButtonSet.OK);
}


/* ============================================================
   INSTALLATION
   ============================================================ */

function installer() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty(CLE_TOKEN);
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty(CLE_TOKEN, token);
  }
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'declencheurQuotidien')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('declencheurQuotidien').timeBased().everyDays(1).atHour(4).create();
  return token;
}

/** Tous les jours à 4 h : en décembre, prépare l'année suivante (une seule fois). */
function declencheurQuotidien() {
  const maintenant = new Date();
  if (maintenant.getMonth() === 11) genererAnneeSiAbsente_(maintenant.getFullYear() + 1);
  // Filet de sécurité si le classeur n'a pas tourné en décembre.
  if (maintenant.getMonth() === 0) genererAnneeSiAbsente_(maintenant.getFullYear());
}

function genererAnneeSiAbsente_(annee) {
  if (lireParametre_('annee_generee_' + annee)) return;
  genererAnnee(annee);
}


/* ============================================================
   API WEB (appli mobile / ordinateur)
   L'appli envoie toujours un POST en text/plain (pas de pré-vol CORS).
   ============================================================ */

function doGet() {
  return json_({ ok: true, version: VERSION_API });
}

function doPost(e) {
  try {
    const corps = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    verifierToken_(corps.token);

    switch (String(corps.action || '')) {
      case 'bootstrap':
        return json_({ ok: true, data: bootstrap(corps.annees) });
      case 'push':
        return json_({ ok: true, data: appliquerMutations(corps.mutations) });
      case 'genererAnnee':
        return json_({ ok: true, data: genererAnnee(Number(corps.annee)) });
      default:
        throw new Error('Action inconnue : ' + corps.action);
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json_(objet) {
  return ContentService.createTextOutput(JSON.stringify(objet))
    .setMimeType(ContentService.MimeType.JSON);
}

function verifierToken_(token) {
  const attendu = PropertiesService.getScriptProperties().getProperty(CLE_TOKEN);
  if (!attendu) throw new Error("API non installée : menu Budget > Installer.");
  if (!token || String(token) !== attendu) throw new Error('Token invalide.');
}


/**
 * Données complètes pour l'appli.
 * annees : liste d'années d'opérations à renvoyer (défaut : année précédente, courante, suivante).
 */
function bootstrap(annees) {
  if (!lireParametre_('reparation_textes_2_3')) reparerTextesImport_();
  const an = new Date().getFullYear();
  const filtre = (Array.isArray(annees) && annees.length ? annees : [an - 1, an, an + 1]).map(Number);
  const data = {};
  Object.keys(TABLES).forEach(function (nom) {
    data[nom] = lireTable_(nom);
  });
  data.Operations = data.Operations.filter(o => filtre.indexOf(Number(String(o.date).slice(0, 4))) !== -1);
  data.version = VERSION_API;
  data.serveur = new Date().toISOString();
  return data;
}


/**
 * Applique une liste de mutations envoyées par l'appli.
 * mutation = { table, op: 'upsert' | 'delete', data: {...} }
 * Idempotent : rejouer la même mutation donne le même résultat
 * (un upsert sur un id existant le remplace, un delete d'un id absent ne fait rien).
 */
function appliquerMutations(mutations) {
  if (!Array.isArray(mutations)) throw new Error('mutations doit être une liste.');
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const parTable = {};
    mutations.forEach(function (m) {
      if (!TABLES[m.table]) throw new Error('Table inconnue : ' + m.table);
      if (m.op !== 'upsert' && m.op !== 'delete') throw new Error('Opération inconnue : ' + m.op);
      (parTable[m.table] = parTable[m.table] || []).push(m);
    });
    const bilan = {};
    Object.keys(parTable).forEach(function (nom) {
      bilan[nom] = ecrireMutations_(nom, parTable[nom]);
    });
    return bilan;
  } finally {
    lock.releaseLock();
  }
}


/* ============================================================
   ÉCHÉANCES ET ANNÉES
   ============================================================ */

/**
 * Crée les échéances (non pointées) de l'année pour toutes les séries actives
 * et recopie les jours d'arrêté de l'année précédente. Sans risque de doublon.
 */
function genererAnnee(annee) {
  if (!annee || annee < 2000 || annee > 2100) throw new Error('Année invalide.');
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const series = lireTable_('Series').filter(s => s.actif === true);
    const operations = lireTable_('Operations');

    const existantes = {};
    operations.forEach(function (o) {
      if (o.serie_id) existantes[o.serie_id + '|' + String(o.date).slice(0, 7)] = true;
    });

    const nouvelles = [];
    let deja = 0;
    series.forEach(function (s) {
      occurrencesSerie(s, annee).forEach(function (date) {
        if (existantes[s.id + '|' + date.slice(0, 7)]) { deja++; return; }
        nouvelles.push({
          table: 'Operations', op: 'upsert', data: {
            id: Utilities.getUuid().replace(/-/g, '').slice(0, 12),
            date: date, type: s.type, designation: s.designation, enseigne: s.enseigne,
            categorie: s.categorie, sous_categorie: s.sous_categorie, compte: s.compte,
            compte_vers: s.compte_vers, paiement: s.paiement, montant: s.montant,
            pointe: false, commentaire: '', serie_id: s.id, source: 'serie ' + annee,
            groupe: groupeSerie_(s, date), groupe_libelle: s.ticket ? String(s.ticket) : ''
          }
        });
      });
    });

    // Jours d'arrêté : on reprend ceux de l'année précédente s'ils manquent.
    const arretes = lireTable_('Arretes');
    const presents = {};
    arretes.forEach(a => { presents[a.compte + '|' + a.annee + '|' + a.mois] = true; });
    const copies = arretes
      .filter(a => Number(a.annee) === annee - 1 && !presents[a.compte + '|' + annee + '|' + a.mois])
      .map(a => ({ table: 'Arretes', op: 'upsert', data: { compte: a.compte, annee: annee, mois: a.mois, jour: a.jour } }));

    if (nouvelles.length) ecrireMutations_('Operations', nouvelles);
    if (copies.length) ecrireMutations_('Arretes', copies);
    ecrireMutations_('Parametres', [{ table: 'Parametres', op: 'upsert',
      data: { cle: 'annee_generee_' + annee, valeur: formaterDate_(new Date()) } }]);

    return { annee: annee, creees: nouvelles.length, deja: deja, arretes: copies.length };
  } finally {
    lock.releaseLock();
  }
}

/** Ticket commun : les échéances des séries qui partagent le même « ticket », même compte et même date forment une ligne ventilée. */
function groupeSerie_(s, date) {
  const t = String(s.ticket || '').trim();
  return t ? 'T-' + t.toLowerCase() + '|' + s.compte + '|' + date : '';
}

/** Dates 'yyyy-MM-dd' des échéances d'une série tombant dans l'année donnée. */
function occurrencesSerie(serie, annee) {
  const intervalle = INTERVALLES[String(serie.frequence || '').toUpperCase()];
  if (!intervalle || !serie.debut) return [];
  const debut = lireDateIso_(serie.debut);
  const fin = serie.fin ? lireDateIso_(serie.fin) : null;
  const jour = Number(serie.jour) || debut.getDate();
  const dates = [];
  for (let mois = 0; mois < 12; mois++) {
    const ecart = (annee - debut.getFullYear()) * 12 + (mois - debut.getMonth());
    if (ecart < 0 || ecart % intervalle !== 0) continue;
    const d = new Date(annee, mois, Math.min(jour, new Date(annee, mois + 1, 0).getDate()));
    if (d < new Date(debut.getFullYear(), debut.getMonth(), 1)) continue;
    if (fin && d > fin) continue;
    dates.push(formaterDate_(d));
  }
  return dates;
}

/**
 * Déplace toutes les opérations d'une année dans un classeur d'archive
 * (sous-dossier « Archives » du dossier de la base) et reporte les soldes
 * de départ des comptes au 31/12 de cette année.
 * Refuse si l'année contient encore des opérations non pointées.
 */
function archiverAnnee(annee) {
  const anneeCourante = new Date().getFullYear();
  if (!annee || annee >= anneeCourante) throw new Error("On ne peut archiver qu'une année terminée.");
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const operations = lireTable_('Operations');
    const limite = annee + '-12-31';
    const aArchiver = operations.filter(o => String(o.date) <= limite);
    if (!aArchiver.length) throw new Error("Aucune opération jusqu'à fin " + annee + '.');
    // Un virement doit être pointé des deux côtés (pointe_vers vide = même état que pointe).
    const nonPointees = aArchiver.filter(o => o.pointe !== true ||
      (o.type === 'VIREMENT' && String(o.pointe_vers).toLowerCase() === 'false'));
    if (nonPointees.length) {
      throw new Error(nonPointees.length + ' opération(s) non pointée(s) jusqu\'à fin ' + annee +
        ' : pointe-les ou supprime-les avant d\'archiver.');
    }

    // 1. Fichier d'archive
    const ss = SpreadsheetApp.getActive();
    const fichierBase = DriveApp.getFileById(ss.getId());
    const parents = fichierBase.getParents();
    const dossierBase = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
    const sousDossiers = dossierBase.getFoldersByName('Archives');
    const dossierArchives = sousDossiers.hasNext() ? sousDossiers.next() : dossierBase.createFolder('Archives');
    const nomArchive = 'Budget ' + annee + ' – Archive';
    const archive = SpreadsheetApp.create(nomArchive);
    DriveApp.getFileById(archive.getId()).moveTo(dossierArchives);
    const def = TABLES.Operations;
    const feuille = archive.getSheets()[0].setName('Operations');
    const lignes = [def.colonnes].concat(aArchiver.map(o => versLigne_('Operations', o)));
    feuille.getRange(1, 1, lignes.length, def.colonnes.length).setValues(lignes);
    feuille.setFrozenRows(1);

    // 2. Nouveaux soldes de départ
    const comptes = lireTable_('Comptes');
    const majComptes = comptes.map(function (c) {
      const solde = Number(c.solde_initial || 0) + mouvementsCompte_(c.nom, aArchiver);
      return { table: 'Comptes', op: 'upsert',
        data: Object.assign({}, c, { solde_initial: Math.round(solde * 100) / 100, date_solde: limite }) };
    });
    ecrireMutations_('Comptes', majComptes);

    // 3. Retrait de la base
    ecrireMutations_('Operations', aArchiver.map(o => ({ table: 'Operations', op: 'delete', data: { id: o.id } })));

    return { operations: aArchiver.length, fichier: nomArchive };
  } finally {
    lock.releaseLock();
  }
}

/** Somme des mouvements d'un compte (dépenses/recettes signées, virements entrants et sortants). */
function mouvementsCompte_(compte, operations) {
  return operations.reduce(function (total, o) {
    const m = Number(o.montant) || 0;
    if (o.type === 'VIREMENT') {
      if (o.compte === compte) total -= Math.abs(m);
      if (o.compte_vers === compte) total += Math.abs(m);
    } else if (o.compte === compte) {
      total += m;
    }
    return total;
  }, 0);
}


/* ============================================================
   RÉPARATION (une fois) : textes transformés par Google Sheets
   lors des réécritures de l'onglet Operations (commentaires « 18.07 »
   devenus des dates, identifiants « 0983… » devenus des nombres).
   [id, date, désignation, montant, commentaire] d'origine, tirés de Budget v2.xlsx.
   ============================================================ */

const ORIGINAUX_IMPORT = [["b75a35523b2c","2026-01-02","beurre",-4.78,"10.28"],["2a7a1c6ed8d9","2026-01-02","champignons, purée",-13.48,"16.97"],["ff76dca1e448","2026-01-02","chips + raviolis",-4.16,"10.28"],["ebe3aaad10d1","2026-01-02","jus de fruits",-1.34,"10.28"],["53fad668bc8d","2026-01-02","tagliatelles",-3.49,"16.97"],["1758c251a81e","2026-01-05","bananes",-0.89,"26.18"],["292c2c0818ad","2026-01-05","déo",-3.72,"26.18"],["95fff84aa5e2","2026-01-05","jus de fruits, bière, eau",-6.04,"26.18"],["a9f2b3df8b29","2026-01-05","lardon, jambon",-2.99,"26.18"],["77c2558ab48c","2026-01-05","purée de tomates, pâtes",-1.9,"26.18"],["b894902e0824","2026-01-05","sandwich",-1.49,"26.18"],["8223199dbb85","2026-01-05","soja cuisine, yaourts",-9.15,"26.18"],["f971c5d75887","2026-01-10","fruits et légumes",-4.52,"25.78"],["b95e1ce4982f","2026-01-10","lait",-2.66,"25.78"],["be7f6f8693ff","2026-01-10","mouchoirs",-2.08,"25.78"],["41488d1e351d","2026-01-10","pain + brioche + galette des rois",-9.53,"25.78"],["aee1561ec5d6","2026-01-10","pate à tarte",-3.09,"25.78"],["6e6f34168e45","2026-01-10","remise cagnotte",7.03,"25.78"],["87a41d806b34","2026-01-10","sandwich",-1.68,"25.78"],["6e9acbf5ef17","2026-01-10","œufs + jambon + paté + boudin",-9.25,"25.78"],["bb1ab695d9ce","2026-01-13","bechamel + chips",-2.99,"11.23"],["8fff200dd1d8","2026-01-13","compotes",-3.99,"7.73"],["30412e818c4d","2026-01-13","flans",-1.49,"11.23"],["7abe18873e03","2026-01-13","fromage",-5.27,"11.23"],["a2c7c1391001","2026-01-13","jus de fruits",-1.79,"7.73"],["d024ec73954d","2026-01-13","pain",-1.95,"7.73"],["eaa5eac8f928","2026-01-13","pain",-1.48,"11.23"],["6e44ab9e49c2","2026-01-14","bière",-6.35,"8.34"],["bd1ae62f7108","2026-01-14","petite voiture",-1.99,"8.34"],["f5d429c8f7ae","2026-01-19","bière répèt",-1.99,"3.26"],["8ea272beac2e","2026-01-19","pain",-0.28,"3.26"],["a3642eef46ed","2026-01-19","sandwich",-0.99,"3.26"],["25c7b9bd7924","2026-01-20","Télépéage",-8.9,"63"],["c1043f96bd04","2026-01-20","Télépéage (Vacances)",-54.1,"63"],["765da680c45c","2026-01-22","chocolat",-4.3,"36.31"],["c2ed45298db0","2026-01-22","cremes caramel",-4.76,"36.31"],["8c4b5122d7d0","2026-01-22","fruits et légumes",-11.61,"36.31"],["693988d11456","2026-01-22","infusion",-0.99,"7.63"],["51e0f00aa859","2026-01-22","jus de fruits",-2.68,"36.31"],["18b6fc29ce1e","2026-01-22","oeufs",-2.87,"36.31"],["41e3feeda222","2026-01-22","pain",-0.99,"36.31"],["f7a01c1b64f7","2026-01-22","pates",-1.48,"36.31"],["59ac4bcdba50","2026-01-22","petite voiture",-1.99,"7.63"],["ed8501e4a799","2026-01-22","saumon fumé",-4.65,"7.63"],["5e0c0ba86084","2026-01-22","yaourts, fromage",-7.62,"36.31"],["514410d9269a","2026-01-24","jus de fruits anniversaire Virgil",-4.64,"25.25"],["de09232729d3","2026-01-24","osso bucco",-4.69,"25.25"],["c08d0397cafa","2026-01-24","petite voiture",-13.93,"25.25"],["098310756544","2026-01-24","petite voiture",-1,""],["782f93dbbf7c","2026-01-24","potimarron",-1.99,"25.25"],["f8bdda7f0783","2026-01-25","bières",-6.35,"14.24"],["224b68cdf5cd","2026-01-25","fruits et légumes",-3.91,"14.24"],["84fc1a8674bf","2026-01-25","petites voitures",-3.98,"14.24"],["f9e221b29889","2026-01-26","buche de chèvre",-2.03,"5.84"],["6eb2abce62bf","2026-01-26","chips",-1.05,"5.84"],["a039ad66349c","2026-01-26","pain",-0.89,"5.84"],["79120fa53f12","2026-01-26","pate à tartiner",-1.87,"5.84"],["fbfe7285747b","2026-01-27","repas Fred",-11.55,"15.55"],["52b5252548e4","2026-01-27","repas Virgil",-4,"15.55"],["8da9b8fe4dc3","2026-01-30","crème + beurre",-6.24,"15.30"],["eb9c4bdf94d7","2026-01-30","de quoi faire le gateau d'anniversaire de Virgil",-7.11,"15.30"],["8bad3e401699","2026-01-30","Pain",-1.95,"15.30"],["7a52d8c3bd88","2026-02-02","buche de chèvre",-1.79,"6.62"],["d3d8bed37cca","2026-02-02","grignot de poulet",-1.69,"6.62"],["700a5d0b3a24","2026-02-02","jus de fruit",-3.14,"6.62"],["019bf96228c8","2026-02-04","attaches cables",-1.66,"24.39"],["1d4e5d732175","2026-02-04","lampe galaxy",-7.34,"24.39"],["9d3cacc3cf75","2026-02-04","porte de souris",-0.9,"24.39"],["5bb0d9d41ddb","2026-02-04","pull",-9.98,"24.39"],["c6d9eccdf675","2026-02-04","sacs d'expédition",-4.51,"24.39"],["f007cf3e417c","2026-02-05","bière",-7.49,"12.56"],["958529780963","2026-02-05","Fruits et légumes",-4,""],["6f6abf10ba71","2026-02-05","poulet",-5.07,"12.56"],["cb65f8b78ef9","2026-02-06","cagnotte",2.89,"25.44"],["f3a68d69670f","2026-02-06","cassoulet + œufs",-6.07,"25.44"],["45c59bcfab1e","2026-02-06","chips + pate à tarte",-2.17,"25.44"],["36b65dcc1127","2026-02-06","essuie tout + éponges magiques",-3.18,"25.44"],["9b7c68e74014","2026-02-06","jus de fruits",-1.34,"25.44"],["2ae33250b485","2026-02-06","nutella + liegeois + chocolat",-12.21,"25.44"],["0812464af622","2026-02-06","sandwich",-1.08,"25.44"],["e059fdcab874","2026-02-06","yaourts",-2.28,"25.44"],["fd1a8d61e129","2026-02-07","apéro chez Matthieu",-7.18,"10.96"],["c26fadac29a1","2026-02-07","mini saucissons + jus de fruits",-3.78,"10.96"],["f358f23445f5","2026-02-07","repas Fred",-5.95,"11.45"],["f441aca473ea","2026-02-07","repas Virgil",-5.5,"11.45"],["312aa1e88da9","2026-02-11","fromage rapé",-3.99,"9.15"],["e89af5c2c7f8","2026-02-11","jus de fruits",-1.79,"9.15"],["44dd13d70cab","2026-02-11","kinder surprise",-1.19,"9.15"],["3848a1380351","2026-02-11","salade",-1.29,"9.15"],["b9b382859b62","2026-02-11","vinaigrette",-0.89,"9.15"],["f4f1336a2114","2026-02-17","petites voitures",-9.95,"13.33"],["083684c47c9a","2026-02-17","Repas Fred",-20.7,"36.50"],["af336cf8c7f0","2026-02-17","Repas Lily",-15.8,"36.50"],["8646cded52dc","2026-02-17","salade",-3.38,"13.33"],["efe167003224","2026-02-18","fromage blanc",-0.97,"6.40"],["6f14694290c8","2026-02-18","jambon",-2.99,"6.40"],["aacdea978d77","2026-02-18","kiwis",-1.05,"6.40"],["88ba015d8e6a","2026-02-18","mouchoirs",-1.39,"6.40"],["d1eeec4991e8","2026-02-19","PQ",-8.26,"20.33"],["59f9915af888","2026-02-19","rouelle de porc",-6.47,"20.33"],["fa2eeab202d0","2026-02-19","salade",-2.92,"20.33"],["b102ddb30efb","2026-02-19","thon",-2.68,"20.33"],["b400cb97277f","2026-02-20","cidre + jus de pommes",-2.74,"21.22"],["ebcf0118722f","2026-02-20","kiris",-1.85,"21.22"],["52d930bea9dc","2026-02-20","petites voitures + livre",-10.95,"21.22"],["3919469d0b25","2026-02-20","œufs + pilons de poulet",-5.68,"21.22"],["b3e237940158","2026-02-21","bière",-0.89,"17.70"],["8383f8c7e809","2026-02-21","brioche + chocolatines + pain",-3.92,"17.70"],["ee1d04afc240","2026-02-21","chocolat",-2.59,"17.70"],["332e6e89b7be","2026-02-21","courgettes",-0.93,"17.70"],["a25ee273b172","2026-02-21","le garage avec parteno",-4.5,"16.90"],["78ec58f709e8","2026-02-21","le garage avec parteno",-12.4,"16.90"],["cf6501218c5b","2026-02-21","liegeois",-0.99,"17.70"],["9043f7d58cc6","2026-02-21","mouchoirs",-1.39,"17.70"],["89eac00a4013","2026-02-21","skyr + yaourts + lait + mozza",-6.99,"17.70"],["f40ee513f9b9","2026-02-24","gnocchi",-2.39,"10.18"],["29bf76053316","2026-02-24","jus de fruits",-1.43,"10.18"],["3d368fade0fc","2026-02-24","kinder + pain au chocolat + flans",-3.24,"10.18"],["67a2ee07927d","2026-02-24","pain + pain de mie + cookie",-3.12,"10.18"],["bacfe6bb3d7b","2026-02-25","bière + donuts",-6.24,"12.21"],["6ef9c7b0f54c","2026-02-25","petites voitures",-5.97,"12.21"],["93e200409284","2026-02-28","Ecole Virgil",-126.13,""],["924a896cb94c","2026-03-02","bière + jus de fruits + eau",-6.74,"28.86"],["f6ab2fe0552f","2026-03-02","emmental rapé",-1.88,"28.86"],["50439cc184b9","2026-03-02","nutella + muesli + chocolat + cookies",-10.52,"28.86"],["940737fff0b3","2026-03-02","pates",-2.17,"28.86"],["b644da02e21b","2026-03-02","salades + sandwich",-7.55,"28.86"],["5cbe6611c7fd","2026-03-04","café",-3.75,"11.81"],["cf847e9a7b54","2026-03-04","gateaux",-1.92,"11.81"],["6cb025e35397","2026-03-04","quenelles",-6.14,"11.81"],["800c2f7f51e1","2026-03-06","brosse à dents",-3.07,"40.11"],["beea65b80a9a","2026-03-06","crème de coco",-1.65,"40.11"],["5cc44ee3e44c","2026-03-06","fruits et légumes",-20.84,"40.11"],["fd2eeb013643","2026-03-06","mayo",-1.66,"40.11"],["fa4d2fb8c6e0","2026-03-06","pain",-0.99,"40.11"],["7b1b459abb55","2026-03-06","poulet",-11.9,"40.11"],["e019a5c40938","2026-03-07","fromage",-3.01,"6.34"],["96567f5be369","2026-03-07","jambon",-1.84,"6.34"],["e553302fbd60","2026-03-07","mousses au chocolat",-1.49,"6.34"],["bcaecd1e653e","2026-03-07","sabre pirate",-4.49,"12.47"],["b1d567cc85b7","2026-03-07","ustensiles de cuisine",-7.98,"12.47"],["416d27e88441","2026-03-09","flans",-1.49,"12.20"],["4435904ecde2","2026-03-09","petites voitures",-5.97,"12.20"],["8201b66ad592","2026-03-09","raviolis",-1.49,"12.20"],["dc9e792c5dde","2026-03-09","yaourts + lait",-3.25,"12.20"],["e1617f72cb23","2026-03-11","fromage rapé",-4.45,"7.96"],["096ac47757de","2026-03-11","olives + oignons",-2.02,"7.96"],["3926af3577af","2026-03-11","pain",-1.49,"7.96"],["66e067965b56","2026-03-11","repas Fred",-7.55,"11.55"],["0404101525a6","2026-03-11","repas Virgil",-4,"11.55"],["03dc7ea36291","2026-03-13","buche de chèvre",-2.99,"10.65"],["ae008fb5c10c","2026-03-13","fruits et légumes",-9.22,"13.18"],["5cd7a5166630","2026-03-13","herbes aromatiques",-3.5,"10.65"],["521a45986b75","2026-03-13","loup de mer",-2.97,"10.65"],["84428adad46e","2026-03-13","pate brisée",-1.19,"10.65"],["e427719706db","2026-03-13","Tomme",-3.96,"13.18"],["2a50afcc7c44","2026-03-14","film alimentaire",-2.55,"3.86"],["dc63fa4ecdc3","2026-03-14","fruits et légumes",-1.31,"3.86"],["c34a903678c7","2026-03-17","bière + jus de fruits + eau",-7.79,"14.18"],["d803923407bc","2026-03-17","fruits secs",-2.29,"14.18"],["d83e119425e5","2026-03-17","gateaux + chocolat",-4.1,"14.18"],["911f984f5a58","2026-03-20","cordons bleus",-1.55,"11.98"],["e0a53cd3d959","2026-03-20","emmental rapé",-3.99,"11.98"],["25c345ce2320","2026-03-20","jus de fruits",-2.54,"22.35"],["5ceaa8ceba4c","2026-03-20","pain",-1.95,"11.98"],["f8ba0817ff11","2026-03-20","repas Fred",-9.05,"13.05"],["1f44fd22b831","2026-03-20","repas Virgil",-4,"13.05"],["45c9b20c599c","2026-03-20","ships + flans + saucisson + kiri + kinders",-10.52,"22.35"],["8522b727fcac","2026-03-20","sopalin",-4.49,"11.98"],["d358ce57517d","2026-03-20","sucre + chocolat + arome vanille",-7.01,"22.35"],["4f47861f716f","2026-03-20","Yaourts",-2.28,"22.35"],["e46b9f72bc3a","2026-03-23","café",-11.99,"14.33"],["92d8a1f2edbc","2026-03-23","croissant",-0.45,"14.33"],["7642e74540f9","2026-03-23","haricots",-1.89,"14.33"],["3b5c8d40bf52","2026-03-23","Muffins",-3.4,"7.38"],["2fb655168515","2026-03-23","petite voiture",-3.98,"7.38"],["04e019fb0c2d","2026-03-25","fruits et légumes",-3.47,"13.82"],["d68a06a9f6fb","2026-03-25","jus de pomme",-1.39,"13.82"],["4d5496cb6752","2026-03-25","lait",-1.92,"13.82"],["ab20b13deb94","2026-03-25","maquereaux",-0.99,"13.82"],["639554ad5da2","2026-03-25","mouchoirs",-1.39,"13.82"],["9a2f0f25e4d3","2026-03-25","pain + chocos",-2.67,"13.82"],["2f414bafdd4a","2026-03-25","petite voiture",-1.99,"13.82"],["cdb7c22f42a8","2026-04-03","bière + jus de fruits",-10.25,"35.86"],["9c23d3745d2b","2026-04-03","chocolat",-4.32,"35.86"],["a72bf685d1e6","2026-04-03","chocolats de paques",-16.8,"35.86"],["3855a1b93cdd","2026-04-03","So Good Tacos repas Fred",-11,"19"],["f3c40c11f7ba","2026-04-03","So Good Tacos repas Virgil",-8,"19"],["098bf2f7a64f","2026-04-03","yaourts",-4.49,"35.86"],["ba7d3329fde2","2026-04-05","cannelonis",-4.99,"11.52"],["be1f3e50389b","2026-04-05","jus de fruits",-1.35,"11.52"],["28332d6a97da","2026-04-05","pain + gateau",-5.18,"11.52"],["0e546d96fec1","2026-04-07","pain",-1.49,"6.67"],["23e953014943","2026-04-07","repas Fred",-10.5,"15.50"],["a60650990826","2026-04-07","repas Virgil",-5,"15.50"],["7ed654cc9298","2026-04-07","salade",-2.19,"6.67"],["304290353cf2","2026-04-07","skyr",-2.99,"6.67"],["1b654a319c8b","2026-04-14","Adidas Hoops 3.0",-13.45,"21,45"],["a814049af0e0","2026-04-14","Adidas Hoops 3.0",-8,"21,45"],["0f5ac8d9fee6","2026-04-14","rajpoot avec Lily - repas Fred",-16.5,"35"],["6577cd1dacfc","2026-04-14","rajpoot avec Lily - repas Lily",-18.5,"35"],["70ddd96c14cc","2026-04-15","ciboulette + tomate",-3.33,"52,18"],["0e0cd061e911","2026-04-15","jus de pomme",-1.79,"52,18"],["1b4e59ec3798","2026-04-15","lait+buche de chèvre+beurre+ricotta",-12.24,"52,18"],["a4604f19c419","2026-04-15","livre hotweels",-4.99,"52,18"],["53959f96d552","2026-04-15","mouchoirs",-2.99,"52,18"],["25ccc8adde54","2026-04-15","pain",-1.49,"52,18"],["f1182f7d57b5","2026-04-15","pate brisee",-1.19,"52,18"],["97949be81160","2026-04-15","skip",-19.17,"52,18"],["f3e0510b7589","2026-04-15","thon",-4.99,"52,18"],["2d7d9414e93d","2026-04-17","chocolat + nappage caramel",-5.51,"9,77"],["6194139d025d","2026-04-17","jambon",-1.88,"9,77"],["2ae8017125c1","2026-04-17","lait",-1.33,"9,77"],["6c9e726f942f","2026-04-17","pain de mie",-1.05,"9,77"],["c6c9053e3bc0","2026-04-19","jus de pomme",-1.49,"2,67"],["47791fcc309e","2026-04-19","repas Fred",-10,"14,10"],["b475d9394c7a","2026-04-19","repas Virgil",-4.1,"14,10"],["5b4c2b045f93","2026-04-19","viennoiseries",-1.18,"2,67"],["aa5dadd71b06","2026-04-21","biere",-6.49,"11,97"],["8a71d6164762","2026-04-21","glaces",-3.99,"11,97"],["0cca1cf1a688","2026-04-21","pain",-1.49,"11,97"],["d538803dab43","2026-04-23","repas Fred",-11.2,"16.20"],["cba96f85d3c4","2026-04-23","repas Virgil",-5,"16.20"],["cdabf0eeac63","2026-04-25","safari Sigean Fred et Virgil",-58,"126,00"],["88cb3e03406f","2026-04-25","safari Sigean Steph et Fanny",-68,"126,00"],["e855b11fd07b","2026-04-27","bière + jus de fruit",-3.7,"5,19"],["3d4f5c1237f4","2026-04-27","pain",-1.49,"5,19"],["162c1875839f","2026-05-01","brioche",-1.89,"33,62"],["2c95de24f22f","2026-05-01","muguet",-4.98,"33,62"],["3d9748864a25","2026-05-01","petite voiture",-3.99,"33,62"],["67b9e7aaf001","2026-05-01","repas avec steph et fanny",-22.76,"33,62"],["dfcf18e63587","2026-05-04","bière",-10.46,"19,53"],["9be812af333d","2026-05-04","chocolat",-2.59,"19,53"],["b655113de961","2026-05-04","pain",-1.49,"19,53"],["f48653c4dc97","2026-05-04","thon",-4.99,"19,53"],["27e583b62efb","2026-05-05","coquelets + jambon",-8.47,"26,64"],["6016d73c0d9b","2026-05-05","fruits et légumes",-2.61,"26,64"],["eff04cc9f22a","2026-05-05","jus de fruits + eau",-2.86,"26,64"],["9b2ca526284c","2026-05-05","liegeois + cookies",-2.54,"26,64"],["0cc85ffb4336","2026-05-05","moussaka",-2.74,"26,64"],["b74912a803e2","2026-05-05","pate brisée",-1.18,"26,64"],["e7a1e7bec211","2026-05-05","yaourts + lait",-6.24,"26,64"],["7aa6048271d0","2026-05-06","repas Fred",-8.85,"13,35"],["b9be1a12a034","2026-05-06","repas Virgil",-4.5,"13,35"],["5c646feb1884","2026-05-13","apéricubes, parmesan, burrata",-8.9,"15,88"],["f3548cf753bc","2026-05-13","pain",-1.49,"6,36"],["5a52734030a2","2026-05-13","pate brisée",-1.19,"6,36"],["3ef75a7361d1","2026-05-13","paves de saumon",-5.99,"15,88"],["2f7b2c3d4e5c","2026-05-13","pommes",-1.83,"6,36"],["85e11b7e028a","2026-05-13","salade",-0.99,"15,88"],["e521bf60a4da","2026-05-13","sandwich",-1.85,"6,36"],["637200328960","2026-05-16","pate brisée",-1.18,""],["b68140fe80f1","2026-05-28","bananes + salade",-4.49,"8,68"],["711fbaabb2ad","2026-05-28","jus de fruit",-2.7,"8,68"],["40ff844768c1","2026-05-28","pain",-1.49,"8,68"],["02101b2ccb43","2026-05-29","bechamel",-1.23,"24,35"],["e61397ea5ba6","2026-05-29","Bière",-13.11,"24,35"],["180a01b12256","2026-05-29","pains au lait",-1.05,"24,35"],["2764e87e2c03","2026-05-29","petite voiture",-1.99,"24,35"],["ecb2b5d2338a","2026-05-29","salade",-2.99,"24,35"],["c61dc6a1089c","2026-05-29","tiramisu",-3.98,"24,35"],["72ff31a238ee","2026-06-01","boissons",-6.39,"8,24"],["7ffa95129c7e","2026-06-01","glaces",-1.85,"8,24"],["c20eef2ff433","2026-06-02","salade",-2.99,"19,18"],["da49b3c7c0d4","2026-06-02","saumon",-16.19,"19,18"],["ac5a50849892","2026-06-03","repas Fred",-9.05,"13,05"],["d2e1c8c6f11c","2026-06-03","repas Virgil",-4,"13,05"],["7122099ac2ea","2026-06-04","coca, ice tea",-3.11,"8,86"],["3e6c4a32db7d","2026-06-04","croissants",-0.69,"8,86"],["0aef0031b2de","2026-06-04","jambon",-2.26,"8,86"],["90aa29fcfaee","2026-06-04","Repas Fred",-5.09,"9,09"],["b51e0d26784f","2026-06-04","Repas Virgil",-4,"9,09"],["e1d074f2f29e","2026-06-04","salade",-2.8,"8,86"],["65964b4f6e28","2026-06-05","jus de fruits",-1.35,"4,13"],["f52cca3a5e74","2026-06-05","viennoiseries",-2.78,"4,13"],["e247b33d8bc7","2026-06-08","chocolat",-2.53,"7,01"],["3f467a439ed2","2026-06-08","pain",-1.49,"7,01"],["764c2e8b6370","2026-06-08","salade",-2.99,"7,01"],["99d061a55a55","2026-06-10","bière",-1.99,"16,32"],["018071406ee2","2026-06-10","filet mignon + poulet",-14.95,"19,40"],["5a711a5b511c","2026-06-10","fromage + lait concentré",-3.71,"19,40"],["3578a5ad9e09","2026-06-10","pizza",-6.89,"16,32"],["1b51fb6a07ef","2026-06-10","sucre + chocolat",-7.44,"16,32"],["9371c4d42d26","2026-06-10","éponges",-0.74,"19,40"],["2c042617c010","2026-06-12","médicaments Fred",-8.9,"30,53"],["124eb171c795","2026-06-12","produits verrue",-21.63,"30,53"],["8e6796733bf2","2026-06-13","brioche",-2.35,"12,56"],["b7fba45b9ced","2026-06-13","chips",-1.99,"31,12"],["0e5313f67d82","2026-06-13","chips",-0.99,"12,56"],["d3e71572b0b9","2026-06-13","flans + cornets glace",-3.7,"12,56"],["1ad769875fd8","2026-06-13","fromage",-6.77,"18,38"],["a89d6f38a0cb","2026-06-13","gants exfolliants",-9.99,"25,96"],["e2b4aba6ca84","2026-06-13","gel douche Sanex",-5.98,"25,96"],["434f3f9137cd","2026-06-13","jambon",-1.21,"18,38"],["74d4c5ad18e0","2026-06-13","jouets",-24.89,"31,12"],["5401061293cb","2026-06-13","jus de fruits",-1.35,"18,38"],["59f1cccb2672","2026-06-13","jus de fruits",-1.79,"12,56"],["0acc64b0c232","2026-06-13","lait + crème",-3.73,"12,56"],["9283f43ee1df","2026-06-13","mousquetons porte clés",-9.99,"25,96"],["4329cb92747b","2026-06-13","pain de mie",-1.6,"18,38"],["82c7c1c9510b","2026-06-13","petite voiture",-5.96,"18,38"],["0e1739aac92e","2026-06-13","ricola",-1.49,"18,38"],["cf9a59444064","2026-06-13","vanish",-4.24,"31,12"],["ac57ab88f01b","2026-06-15","bière",-1.99,"6,23"],["c862ac7d67ae","2026-06-15","cakes",-5.58,"12,15"],["0db17bbca5e3","2026-06-15","cornets de glace",-2.95,"6,23"],["b127437bbc55","2026-06-15","fromage",-1.69,"12,15"],["d70e430d2661","2026-06-15","jus de pomme",-1.9,"12,15"],["992422620c4e","2026-06-15","oignons",-1.03,"12,15"],["f2f71fa9f850","2026-06-15","pate brisée",-1.29,"6,23"],["4c3d4859dc2e","2026-06-15","saucisson",-1.95,"12,15"],["5e77903c4a7f","2026-06-17","repas Fred",-8.45,"13,45"],["12b00d1de474","2026-06-17","repas Virgil",-5,"13,45"],["0246d894d289","2026-06-18","vente 3 intel",284.27,"339,51"],["f157b6d117c0","2026-06-18","vente 3 intel",55.24,"339,51"],["b4770bb1314d","2026-06-19","cables sono école",-23,"34,80"],["a67b83198dbb","2026-06-19","cables sono école",-11.8,"34,80"],["87298fb67d05","2026-06-19","jus de fruits",-1.25,"2,54"],["26b461e60b6a","2026-06-19","pain",-1.49,"7,67"],["01e241ad89c7","2026-06-19","salade",-2.19,"7,67"],["d24a821158f3","2026-06-19","salade",-1.29,"2,54"],["ca509e3df380","2026-06-19","vin",-3.99,"7,67"],["eee866f95a35","2026-06-22","chips + vinaigrette + riz",-3.54,"11,69"],["34d91ede3ed5","2026-06-22","lentilles + salade + tomates",-4.07,"11,69"],["fc23e66ac419","2026-06-22","pain",-1.49,"11,69"],["7050bb4cccd5","2026-06-22","salade",-2.59,"11,69"],["63312a0e1814","2026-06-23","repas Fred",-45.45,"90,90"],["e8459310778b","2026-06-23","repas Lily",-45.45,"90,90"],["f572789666ef","2026-06-25","chocolat",-2.53,"14,44"],["cd8f1fbd6c6a","2026-06-25","fromage",-9.32,"14,44"],["400feb2ba3d2","2026-06-25","salade de pates",-2.59,"14,44"],["58fc8676dc60","2026-06-26","biere",-13.11,"29,90"],["a046a5b32f27","2026-06-26","flanby",-1.95,"29,90"],["7abaeddad112","2026-06-26","fromate, lait",-8.07,"29,90"],["00f62e5262d8","2026-06-26","glace",-6.29,"10,28"],["5110e3ec639b","2026-06-26","patates",-1.99,"29,90"],["7b596e5b42f1","2026-06-26","pates",-1.99,"29,90"],["514bac3318ba","2026-06-26","plats cuisinés",-3.99,"10,28"],["b67affec242b","2026-06-26","thon",-2.79,"29,90"],["6f3905a8e4bf","2026-06-28","pommes",-5.75,"19,75"],["59d5716e898c","2026-06-28","serviettes de plage grand schtroumph",-14,"19,75"],["01e78d1fcb52","2026-07-01","chocolat",-2.53,"7,61"],["7874aa14c373","2026-07-01","jus de fruits",-1.79,"7,61"],["e8ccd90aa298","2026-07-01","pain",-1.49,"7,61"],["07c43c1e2589","2026-07-01","pates",-1.8,"7,61"],["3f3251d67e1e","2026-07-01","Repas Fred",-8.55,"13,05"],["c6f57b0f100c","2026-07-01","Repas Virgil",-4.5,"13,05"],["588c5e63b75b","2026-07-03","cadre bois",-2.19,"17,18"],["2f1c04807431","2026-07-03","chargeur aspirateur",-16.14,"24,13"],["34eddc61ec48","2026-07-03","chargeur dyson",-14.99,"17,18"],["219b5b9afd72","2026-07-03","rouleaux anti poils",-7.99,"24,13"],["9e90af40c41b","2026-07-04","jus de fruits",-1.49,"4.08"],["addfaad74266","2026-07-04","nectarines",-2.59,"4.08"],["814cc1061438","2026-07-12","eponges",-4,"6,44"],["317fcb92b131","2026-07-12","pain",-2.44,"6,44"],["5b89345c51c9","2026-07-15","3 monts triple",-5.99,"10,97"],["2f1782a2af5a","2026-07-15","biere",-7.38,"9,08"],["b2fee3ebc91d","2026-07-15","chips",-2.49,"10,97"],["ea79178c30c9","2026-07-15","fruits secs",-2.49,"10,97"],["f32d945ac665","2026-07-15","pain",-1.7,"9,08"],["84b05bdb5ee8","2026-07-29","desodorisant wc + tablettes lave vaisselle",-12.74,"19,72"],["6bd3afced54e","2026-07-29","glaces",-1.59,"19,72"],["c55bc08abdbb","2026-07-29","mais",-1.45,"19,72"],["6a383e0a3698","2026-07-29","pain",-1.49,"19,72"],["b6c0049d09b3","2026-07-29","poulet",-2.45,"19,72"],["a3b6cff9e742","2026-07-31","Ecole Virgil",-143.62,"juin 2026"],["2347bafbfc6b","2026-08-03","Ecole Virgil",-8.66,"juillet 2026"],["c9b94351dbb8","2026-08-04","creme de soja",-2.85,"5,26"],["6d4898a8d141","2026-08-04","fruits et légumes",-2.41,"5,26"],["01d1fc2cc691","2026-08-04","fruits et légumes",-4.4,"6,69"],["e4c5bbe4a80f","2026-08-04","oeufs",-2.29,"6,69"],["05e350b54e92","2026-08-07","chocolat",-6.4,"29,06"],["2f1e0d56b5d6","2026-08-07","echalottes, poivrons",-1.58,"29,06"],["0db49645fecf","2026-08-07","fromage, yaourts",-14.26,"29,06"],["7b782c4525cc","2026-08-07","jus de fruit",-1.34,"29,06"],["a34cc251a1ab","2026-08-07","pain",-1.59,"29,06"],["830bc8f6e048","2026-08-07","poisson",-3.89,"29,06"],["494483967963","2026-08-07","rose éternelle Mag",-18,""],["41a20c8e11a3","2026-08-09","repas Fred",-19.5,"39,00"],["67d09428884d","2026-08-09","repas Mag",-19.5,"39,00"],["197a2d5910b4","2026-08-09","rhum, eau",-26.2,"37,55"],["2ba958abc38d","2026-08-09","sauce tomate",-11.35,"37,55"],["82ac5c8a959f","2026-08-10","jus de pomme",-0.89,"3,08"],["bd02582e9ea0","2026-08-10","pansements",-3.99,"13,44"],["8c07a23d6a4a","2026-08-10","préservatifs",-9.45,"13,44"],["1a13bfd5a11b","2026-08-10","salade",-2.19,"3,08"],["fe7ba19bfc12","2026-08-14","kama sutra",-12.65,"23.75"],["5aaee8556957","2026-08-14","livraison",-3,"23.75"],["fc623bc6a967","2026-08-14","un homme debout",-8.1,"23.75"],["445672e42999","2026-08-17","entretien maison Godoncourt",-11.47,""],["b663dd016927","2026-08-19","divers pour maison Godoncourt",-6.98,"36,71"],["c47f12eb1d52","2026-08-19","petites voitures",-2.39,"36,71"],["a91cc778409f","2026-08-19","petites voitures Lenny",-2.39,"36,71"],["d8af7e1c753d","2026-08-19","rasoir",-24.95,"36,71"],["16d9dc2cf725","2026-08-20","Télépéage",-17.7,"137.70"],["9b06eb10d629","2026-08-20","Télépéage (Vacances)",-120,"137.70"],["7212f818696a","2026-08-31","jus de pomme",-0.89,"2,46"],["86bc163f5a8e","2026-08-31","lait",-1.08,"2,46"],["c5006282ae58","2026-08-31","pain au chocolat",-0.49,"2,46"],["75328272aced","2026-09-01","biere",-8.47,"12,46"],["1e15f84e58b3","2026-09-01","capres",-1.19,"6.56"],["48bb2fa69f15","2026-09-01","pain",-1.49,"6.56"],["f939ab35a3f9","2026-09-01","poisson",-3.49,"6.56"],["de788fbdabb3","2026-09-01","thon",-3.99,"12,46"],["6c21174fad2c","2026-09-01","vinaigre",-0.39,"6.56"],["1569326af096","2026-09-03","biere, café",-3.6,"9,97"],["9910a0ba5e48","2026-09-03","roses",-2.79,"9,97"],["1a055d472cf6","2026-09-03","salade",-2.99,"9,97"],["0b4d49317770","2026-09-03","suisse",-0.59,"9,97"],["7f0de9589872","2026-09-04","brioche, croissants",-1.59,"40,41"],["2f3e2bc24487","2026-09-04","flans",-1.55,"40,41"],["ecef50959379","2026-09-04","gateaux, chocolat",-5.38,"40,41"],["f9706a1a5aa0","2026-09-04","jambon",-1.95,"40,41"],["7620be92461a","2026-09-04","jus de fruits",-1.49,"40,41"],["06a543d19c8d","2026-09-04","lait, yaourts, chevre, creme de soja",-9.17,"40,41"],["9c53788385b6","2026-09-04","repas Fred",-12.5,"16,50"],["4a1129966385","2026-09-04","repas Virgil",-4,"16,50"],["2a1c65fa9a57","2026-09-04","salade",-1.29,"40,41"],["261eddc45939","2026-09-04","saumon",-17.99,"40,41"],["a0a49d87c813","2026-09-06","biere",-11.25,"16,95"],["8383b7c64e3d","2026-09-06","carafe",-1.9,"16,95"],["bedf4b48c8d4","2026-09-06","pates",-3.8,"16,95"],["a6c5909d17ae","2026-09-09","beurre",-1.99,"9,02"],["c76d4a8aef44","2026-09-09","compote",-3.89,"9,02"],["f8c635aa9ae7","2026-09-09","pate",-1.15,"9,02"],["44060795c598","2026-09-09","petites voitures",-1.99,"9,02"],["dd81a691b94d","2026-09-09","Repas Fred",-11.45,"15,95"],["80af578a3f61","2026-09-09","repas Virgil",-4.5,"15,95"],["70aa7d515451","2026-09-10","gateaux",-1.49,"2,57"],["b34da54ae5f9","2026-09-10","lait",-1.08,"2,57"],["8cc86a756bd8","2026-09-18","jambon",-1.95,"6,37"],["528cb8225e1f","2026-09-18","jus de fruits",-0.89,"6,37"],["811d7d24b337","2026-09-18","lait",-1.08,"6,37"],["5e43d6c075b0","2026-09-18","petite voiture",-3.98,"13,97"],["814996fdfbb0","2026-09-18","rhum",-9.99,"13,97"],["ef0eb536bfdb","2026-09-18","wrap",-2.45,"6,37"],["b3e38d86bd8e","2026-09-19","compote, petits suisses, gauffres, flans, saucissons",-10.05,"29,78"],["5233e32709f6","2026-09-19","pignons, epinards, potimarron, panier anti gaspi, salade",-15.13,"29,78"],["51420147eabd","2026-09-19","repas Fred + Virgil",-34.75,"69,50"],["70a010954f04","2026-09-19","repas Mag + Lenny",-34.75,"69,50"],["ec3b7082d2db","2026-09-19","saucisse",-4.6,"29,78"],["d2969454419a","2026-09-20","Télépéage",-12.5,"171.10"],["55b88c14422f","2026-09-20","Télépéage (Vacances)",-158.6,"171.10"],["3ec5dd4ef504","2026-09-22","Repas Fred",-13.45,"17,45"],["15690735303c","2026-09-22","Repas Virgil",-4,"17,45"],["7c451687df05","2026-09-23","gateaux",-3.99,"11,02"],["b217f829c4d7","2026-09-23","jus de pomme",-5.34,"11,02"],["792902422cd1","2026-09-23","menu Fred",-8.45,"13,40"],["15f7c5e7e1dd","2026-09-23","menu Virgil",-4.95,"13,40"],["e93f55ebc70f","2026-09-23","mouchoirs",-1.69,"11,02"],["3ffe1263b459","2026-09-23","Normal - chocolat",-5,"9,20"],["f44ad98f5106","2026-09-23","Normal - laque",-3.7,"9,20"],["c8548486981b","2026-09-23","Normal - poche",-0.5,"9,20"],["de86ceb2ef11","2026-09-24","croques monsieurs",-2.39,"8,28"],["eaee3d9619a6","2026-09-24","mars glacés",-5.89,"8,28"],["ded04c8f6d99","2026-09-25","biere",-6.42,"18,63"],["f2a38a0fad82","2026-09-25","caleçons",-11.37,"18,63"],["a0286f7a0132","2026-09-25","croissant",-0.84,"18,63"],["d8c5fc3f45bc","2026-09-26","cookies",-1.49,"4.14"],["5d13c0c7feae","2026-09-26","croissants, pain de mie",-2.65,"4.14"],["ac37d5526182","2026-10-02","biere",-4.49,"14,17"],["e2a534dc0e99","2026-10-02","deo",-3.3,"14,17"],["2fc10273f529","2026-10-02","gateaux",-2.93,"14,17"],["de27a1568c52","2026-10-02","legumes",-3.45,"14,17"],["1f7d1c1664a8","2026-10-03","biere",-4.32,"32,50"],["b57e7b59bcda","2026-10-03","fruits et légumes",-2.87,"32,50"],["2cb66ba296c3","2026-10-03","pates à tartes, chips",-4.11,"32,50"],["d83f14ef8fcc","2026-10-03","petits suisses, ricotta, cabecou",-6.82,"32,50"],["c502f2943491","2026-10-03","poulet",-12.6,"32,50"],["c4255e0635d8","2026-10-03","sucre vanillé",-1.78,"32,50"],["1c50328ef7de","2026-10-07","circuit hot wheels",-54.4,"313,44"],["0edd716b372c","2026-10-07","double écran portable",-139.98,"313,44"],["bc7a9da8e56e","2026-10-07","onduleur",-88.34,"313,44"],["e50f49145c8a","2026-10-07","pied de guitare",-14.59,"313,44"],["098968aa1325","2026-10-07","pommeau de douche",-16.13,"313,44"],["4a22bb0ae940","2026-10-08","aiguillettes de canard",-5.99,"13,36"],["36d6a1cfb813","2026-10-08","biere",-3.99,"13,36"],["61d1b1cc05d8","2026-10-08","Ecole Virgil",-113.88,"septembre 2026"],["3251045c799b","2026-10-08","lait d'avoine",-1.39,"13,36"],["406404d947b7","2026-10-08","poireaux",-1.99,"13,36"],["aae48c424fe1","2026-10-08","Repas Fred",-8.05,"12,55"],["9c605f781b55","2026-10-08","Repas Virgil",-4.5,"12,55"],["e48b3c8bfbf1","2026-10-17","Boucherie",-37.47,"44.41"],["07b99847f2d9","2026-10-17","Boucherie",-6.94,"44.41"],["4e3f4155084b","2026-10-17","brioche",-1.79,"6,51"],["88e50af19897","2026-10-17","dessert",-1.58,"6,51"],["68de3ce5ba1b","2026-10-17","jus de fruits",-0.89,"6,51"],["18054c6df6f1","2026-10-17","lait",-0.96,"6,51"],["9ddaa8b4084a","2026-10-17","pates",-1.29,"6,51"],["13c717caf896","2026-10-19","spatule, bocaux, sac",-34.43,"40,41"],["e44e8c90bb3e","2026-10-19","voiture drone",-4.99,"40,41"],["503b02bd6ea6","2026-10-19","éponges",-0.99,"40,41"],["74428763df6d","2026-10-22","Biere",-2.5,"14"],["4e1a26ae9563","2026-10-22","Crème d’avoine",-1.25,"6,26"],["0880dc18dc99","2026-10-22","Legumes",-5.01,"6,26"],["35af75646cf6","2026-10-22","Tabac",-11.5,"14"],["215e36487f93","2026-10-23","Repas Fred",-8.05,"13,05"],["391eefc4c238","2026-10-23","Repas virgil",-5,"13,05"],["bd11d0f7c32b","2026-10-25","La halle Fred",-41.5,"81,50"],["fca5671641f9","2026-10-25","La halle Mag",-40,"81,50"],["95d05954dd3b","2026-10-29","costume halloween",-17.97,"19,46"],["968175016875","2026-10-29","savon liquide",-1.49,"19,46"],["6076c8754754","2026-10-30","bandes de classement",-9.71,"27,00"],["c570dafec5c1","2026-10-30","vipouxit",-17.29,"27,00"],["24570c06d730","2026-10-31","brioche, pain,",-3.54,"35,79"],["c0e44deb3417","2026-10-31","chocolat",-1.69,"35,79"],["63fb6b08396e","2026-10-31","compotes, gateaux, petits suisses, flans",-9.64,"35,79"],["0f8d5abbe3b3","2026-10-31","jambon",-1.95,"35,79"],["1101f61156d6","2026-10-31","jeu en bois",-2.99,"35,79"],["f4ff0ade8c83","2026-10-31","jus de fruits, biere",-9.33,"35,79"],["6e2674f71f66","2026-10-31","pate à tarte, bouquet garni",-2.5,"35,79"],["8ec01ca33d2d","2026-10-31","skyr, lait",-4.15,"35,79"],["a4025c805194","2026-11-04","Repas Fred",-8.05,"13,05"],["071a73dfbb83","2026-11-04","Repas Virgil",-5,"13,05"],["20d764f6c6d1","2026-11-07","Burger King",-9.1,"18.20"],["71ae31041de3","2026-11-07","Burger King",-9.1,"18.20"],["b985bbdf25a2","2026-11-09","Ecole Virgil",-87.9,"octobre 2026"],["7fd3154e9bdc","2026-11-11","pain",-1.49,"3,38"],["b77977ce7135","2026-11-11","yaourts",-1.89,"3,38"],["c9cdfd9a9855","2026-11-20","Télépéage",-14.1,"18.7"],["ba4c6ba1c5f7","2026-11-20","Télépéage (Vacances)",-4.6,"18.7"]];

function reparerTextesImport_() {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    if (lireParametre_('reparation_textes_2_3')) return;
    const def = TABLES.Operations, f = feuille_('Operations');
    const n = f.getLastRow() - 1;
    if (n > 0) {
      const largeur = def.colonnes.length;
      const iId = def.colonnes.indexOf('id'), iCom = def.colonnes.indexOf('commentaire');
      const iDate = def.colonnes.indexOf('date'), iDes = def.colonnes.indexOf('designation'), iMt = def.colonnes.indexOf('montant');
      const valeurs = f.getRange(2, 1, n, largeur).getValues();
      const parId = {}, parCle = {};
      ORIGINAUX_IMPORT.forEach(o => { parId[o[0]] = o; parCle[o[1] + '|' + o[2] + '|' + Number(o[3]).toFixed(2)] = o; });
      const vus = {};
      let reparees = 0;
      valeurs.forEach(l => {
        const dateTxt = estDate_(l[iDate]) ? formaterDate_(l[iDate]) : String(l[iDate]);
        const cle = dateTxt + '|' + l[iDes] + '|' + Number(l[iMt]).toFixed(2);
        let id = l[iId];
        // identifiant : zéros perdus, notation scientifique, doublon
        if (typeof id === 'number' && isFinite(id) && Math.floor(id) === id) id = String(id).padStart(12, '0');
        id = String(id);
        // identifiant abîmé (notation scientifique, etc.) : on le retrouve par date + désignation + montant
        if (!parId[id] && parCle[cle] && !/^[0-9a-f]{12}$/i.test(id) && !/^[SG]-/.test(id)) id = parCle[cle][0];
        if (!id || vus[id] || !/^[0-9a-zA-Z\-]+$/.test(id)) id = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
        vus[id] = true;
        if (String(l[iId]) !== id) { l[iId] = id; reparees++; }
        // commentaire d'origine
        const o2 = parId[id];
        if (o2) { if (String(l[iCom]) !== String(o2[4]) || estDate_(l[iCom])) { l[iCom] = o2[4]; reparees++; } }
        else if (estDate_(l[iCom])) { l[iCom] = Utilities.formatDate(l[iCom], Session.getScriptTimeZone(), 'dd/MM/yyyy'); reparees++; }
      });
      formaterColonnesTexte_(f, def, n);
      f.getRange(2, 1, n, largeur).setValues(valeurs);
      console.log('Réparation des textes : ' + reparees + ' valeur(s) corrigée(s)');
    }
    ecrireMutations_('Parametres', [{ table: 'Parametres', op: 'upsert', data: { cle: 'reparation_textes_2_3', valeur: formaterDate_(new Date()) } }]);
  } finally {
    lock.releaseLock();
  }
}


/* ============================================================
   ACCÈS AUX TABLES
   ============================================================ */

function feuille_(nom) {
  const f = SpreadsheetApp.getActive().getSheetByName(nom);
  if (!f) throw new Error("Onglet « " + nom + " » introuvable.");
  return f;
}

/** Lit un onglet et renvoie une liste d'objets typés (dates en 'yyyy-MM-dd'). */
function lireTable_(nom) {
  const def = TABLES[nom];
  const f = feuille_(nom);
  const nbLignes = f.getLastRow() - 1;
  if (nbLignes < 1) return [];
  const valeurs = f.getRange(2, 1, nbLignes, def.colonnes.length).getValues();
  return valeurs
    .filter(l => l.some(v => v !== '' && v !== null))
    .map(function (l) {
      const o = {};
      def.colonnes.forEach(function (col, i) { o[col] = versValeurJson_(def, col, l[i]); });
      return o;
    });
}

function versValeurJson_(def, col, v) {
  if (def.dates.indexOf(col) !== -1) {
    if (estDate_(v)) return formaterDate_(v);
    return v ? String(v) : '';
  }
  if (def.booleens.indexOf(col) !== -1) return v === true || String(v).toUpperCase() === 'TRUE';
  if (def.nombres.indexOf(col) !== -1) return v === '' || v === null ? null : Number(v);
  if (estDate_(v)) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy');   // texte converti en date par Sheets
  return v === null ? '' : String(v);
}

function versLigne_(nom, objet) {
  const def = TABLES[nom];
  return def.colonnes.map(function (col) {
    const v = objet[col];
    if (v === undefined || v === null) return '';
    if (def.dates.indexOf(col) !== -1) return v ? lireDateIso_(v) : '';
    if (def.booleens.indexOf(col) !== -1) return v === true || String(v).toUpperCase() === 'TRUE';
    if (def.nombres.indexOf(col) !== -1) return v === '' ? '' : Number(v);
    return String(v);
  });
}

function cleObjet_(def, o) {
  return def.cle.map(k => String(o[k] === undefined || o[k] === null ? '' : o[k]).trim().toLowerCase()).join('|');
}

/** Applique upserts/deletes sur un onglet en une lecture et une écriture. */
function ecrireMutations_(nom, mutations) {
  const def = TABLES[nom];
  const f = feuille_(nom);
  const largeur = def.colonnes.length;
  f.getRange(1, 1, 1, largeur).setValues([def.colonnes]);   // en-têtes (ajoute les colonnes manquantes)
  const nbAvant = Math.max(f.getLastRow() - 1, 0);
  let lignes = nbAvant ? f.getRange(2, 1, nbAvant, largeur).getValues() : [];

  const index = {};
  lignes.forEach(function (l, i) {
    const o = {};
    def.colonnes.forEach((c, j) => { o[c] = versValeurJson_(def, c, l[j]); });
    index[cleObjet_(def, o)] = i;
  });

  const supprimees = {};
  let ajouts = 0, maj = 0, suppr = 0;
  mutations.forEach(function (m) {
    const k = cleObjet_(def, m.data || {});
    if (!k.replace(/\|/g, '')) throw new Error('Clé manquante pour ' + nom + '.');
    if (m.op === 'delete') {
      if (index[k] !== undefined && !supprimees[index[k]]) { supprimees[index[k]] = true; suppr++; }
      return;
    }
    if (index[k] !== undefined && !supprimees[index[k]]) {
      // On fusionne : un champ absent de la mutation garde sa valeur actuelle.
      const actuel = {};
      def.colonnes.forEach((c, j) => { actuel[c] = versValeurJson_(def, c, lignes[index[k]][j]); });
      lignes[index[k]] = versLigne_(nom, Object.assign(actuel, m.data));
      maj++;
    } else {
      lignes.push(versLigne_(nom, m.data));
      index[k] = lignes.length - 1;
      delete supprimees[index[k]];
      ajouts++;
    }
  });

  lignes = lignes.filter((l, i) => !supprimees[i]);
  if (nom === 'Operations') {
    lignes.sort(function (a, b) {
      const da = estDate_(a[1]) ? a[1].getTime() : 0, db = estDate_(b[1]) ? b[1].getTime() : 0;
      return da - db || String(a[3]).localeCompare(String(b[3]), 'fr', { sensitivity: 'base' });
    });
  }

  if (lignes.length) {
    formaterColonnesTexte_(f, def, lignes.length);
    f.getRange(2, 1, lignes.length, largeur).setValues(lignes);
  }
  if (nbAvant > lignes.length) f.getRange(2 + lignes.length, 1, nbAvant - lignes.length, largeur).clearContent();
  return { ajouts: ajouts, maj: maj, suppressions: suppr, total: lignes.length };
}

/** Colonnes de texte en format « texte brut » : Sheets ne transforme plus « 18.07 » en date ni « 0983… » en nombre. */
function colonnesTexte_(def) {
  return def.colonnes.map((c, i) => ({ c, i })).filter(x => def.dates.indexOf(x.c) === -1 && def.booleens.indexOf(x.c) === -1 && def.nombres.indexOf(x.c) === -1);
}
function lettreColonne_(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function formaterColonnesTexte_(f, def, nbLignes) {
  const plages = colonnesTexte_(def).map(x => lettreColonne_(x.i + 1) + '2:' + lettreColonne_(x.i + 1) + (nbLignes + 1));
  if (plages.length) f.getRangeList(plages).setNumberFormat('@');
}

function lireParametre_(cle) {
  const p = lireTable_('Parametres').filter(x => x.cle === cle)[0];
  return p ? p.valeur : '';
}


/* ============================================================
   DATES (fuseau du script : Europe/Paris)
   ============================================================ */

function estDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function formaterDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function lireDateIso_(v) {
  if (estDate_(v)) return v;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error('Date invalide : ' + v);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
