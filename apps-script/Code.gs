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

const VERSION_API = '2.1.0';
const CLE_TOKEN = 'BUDGET_TOKEN';

const TABLES = {
  Operations: {
    cle: ['id'],
    colonnes: ['id', 'date', 'type', 'designation', 'enseigne', 'categorie', 'sous_categorie',
      'compte', 'compte_vers', 'paiement', 'montant', 'pointe', 'commentaire', 'serie_id', 'source',
      'groupe', 'groupe_libelle'],
    dates: ['date'], booleens: ['pointe'], nombres: ['montant']
  },
  Series: {
    cle: ['id'],
    colonnes: ['id', 'type', 'designation', 'enseigne', 'categorie', 'sous_categorie', 'compte',
      'compte_vers', 'paiement', 'frequence', 'jour', 'montant', 'debut', 'fin', 'actif'],
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
            pointe: false, commentaire: '', serie_id: s.id, source: 'serie ' + annee
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
    const nonPointees = aArchiver.filter(o => o.pointe !== true);
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

  if (lignes.length) f.getRange(2, 1, lignes.length, largeur).setValues(lignes);
  if (nbAvant > lignes.length) f.getRange(2 + lignes.length, 1, nbAvant - lignes.length, largeur).clearContent();
  return { ajouts: ajouts, maj: maj, suppressions: suppr, total: lignes.length };
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
