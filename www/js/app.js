/* SH Presta Terrain : application du prestataire (écrans et événements).
   La logique (règles, file d'envoi, vue hors connexion, TS4300) est dans des modules purs testés. */
import { esc, jourDe, heureDe, jourLisible, horodatage, ilya, aujourdhui, ecartJours, pluriel } from "./format.js";
import { STATUTS, STATUT_TON, ETAPES, VOYANTS, PRIORITES, STATUTS_ANOMALIE, etapes, etapeValidee, bloquants, sousEtapesRequises, figee, departApplicable, retourApplicable, avancement } from "./regles.js";
import { creer, idLocal, estLocal } from "./actions.js";
import { appliquer } from "./optimiste.js";
import { synchroniser, annulerCreation, delaiNouvelEssai, ARRET } from "./file.js";
import { normaliserAdresse } from "./adresse.js";
import { comparer } from "./veille.js";
import * as ts from "./ts4300.js";
import * as st from "./stockage.js";
import * as native from "./native.js";
import { creerApi, lireSession } from "./api.js";
import { createUpdater } from "@orfeo/updater";
import { banniere, carteEtat, sectionReglages, feuille, titreFeuille } from "@orfeo/updater/ui";

const $ = s => document.querySelector(s);
const REGLAGES_DEFAUT = { adresse: "", verrou: false, notifications: true, email: "" };

const etat = {
  ecran: "accueil",              /* accueil | intervention | reglages | adresse | connexion */
  interventionId: null,
  reglages: lireReglages(),
  session: lireSession(),
  liste: null,                   /* interventions de l'entreprise (dernière liste reçue) */
  listeLe: null,
  dossiers: {},                  /* id → dossier terrain enregistré sur le téléphone */
  actions: [],                   /* file d'envoi */
  brouillons: {},                /* id → brouillon TS4300 */
  joignable: null,               /* le serveur a-t-il répondu à la dernière requête ? */
  reseau: true,
  sync: { enCours: false, echecs: 0, prochain: null, dernier: null, arret: null },
  chargement: {},                /* id → téléchargement du dossier en cours */
  ouvert: {},                    /* étapes et blocs dépliés */
  selection: null,               /* TS4300 : { cartoucheId } ou { emplacementId, mode: "deplacer" } */
  photosAnomalie: [],            /* photos prises pour l'anomalie en cours de saisie : [{ id, url }] */
  verrouille: false,
  scanner: null
};

const api = creerApi({
  adresse: () => etat.reglages.adresse,
  surSession: s => { etat.session = s; partagerSession(); },
  surJoignable: j => { if (etat.joignable !== j) { etat.joignable = j; render(); } }
});

const maj = createUpdater({ name: "SH Presta", repo: "orfeo971/sh-presta-android", prefix: "shpresta-v", private: false, storage: "shpresta" }, { capacitor: native.isNative ? native.capacitor : null });
maj.onChange(() => { render(); if (!$("#sheet").hidden && $("#sheetTitle").textContent.startsWith("Mise à jour")) $("#sheetBody").innerHTML = feuille(maj); });

/* ---------- réglages ---------- */
function lireReglages() { try { return { ...REGLAGES_DEFAUT, ...JSON.parse(localStorage.getItem("shp.reglages") || "{}") }; } catch (e) { return { ...REGLAGES_DEFAUT }; } }
function sauverReglages() { try { localStorage.setItem("shp.reglages", JSON.stringify(etat.reglages)); } catch (e) { /* ignoré */ } }

/* session et adresse partagées avec la vérification en arrière-plan (VeilleService.java) */
async function partagerSession() {
  const s = etat.session;
  await native.prefEcrire("veille.serveur", etat.reglages.adresse || null);
  await native.prefEcrire("veille.jeton", s && s.token ? s.token : null);
  await native.prefEcrire("veille.actif", s && s.token && etat.reglages.notifications ? "1" : null);
}

/* ---------- petits éléments d'interface ---------- */
function toast(msg, ton = "") {
  const t = $("#toast"); t.textContent = msg; t.className = "toast " + ton; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 3800);
}
function feuilleOuvrir(titre, html) { $("#sheetTitle").textContent = titre; $("#sheetBody").innerHTML = html; $("#sheet").hidden = false; }
function feuilleFermer() { $("#sheet").hidden = true; etat.selection = etat.selection && etat.selection.mode === "deplacer" ? etat.selection : null; }
const puce = (texte, ton = "neutre") => `<span class="puce ${ton}">${esc(texte)}</span>`;
const attente = o => (o && o._attente ? `<span class="attente" title="En attente d'envoi">⏳</span>` : "");
const coche = (fait, act, data, libelle, sous = "", desactive = false, enAttente = false) =>
  `<button class="ligne-coche${fait ? " fait" : ""}" data-act="${act}" ${data} ${desactive ? "disabled" : ""} aria-pressed="${fait}">`
  + `<span class="case" aria-hidden="true">${fait ? "✓" : ""}</span><span class="txt"><b>${libelle}</b>${sous ? `<small>${sous}</small>` : ""}</span>${enAttente ? `<span class="attente" title="En attente d'envoi">⏳</span>` : ""}</button>`;

/* ---------- données ---------- */
const actionsDe = id => etat.actions.filter(a => Number(a.interventionId) === Number(id));
const refusees = () => etat.actions.filter(a => a.etat === "rejetee");
const enAttente = () => etat.actions.filter(a => a.etat !== "rejetee");
function vueDe(id) {
  const d = etat.dossiers[id];
  return d ? appliquer(d, actionsDe(id)) : null;
}
const enLigne = () => etat.reseau && etat.joignable !== false;

async function chargerLocal() {
  etat.actions = await st.listerActions();
  etat.liste = (await st.lire("liste")) || null;
  etat.listeLe = (await st.lire("listeLe")) || null;
  etat.dossiers = (await st.lire("dossiers")) || {};
  etat.brouillons = (await st.lire("brouillons")) || {};
}
const sauverDossiers = () => st.ecrire("dossiers", etat.dossiers);
const sauverBrouillons = () => st.ecrire("brouillons", etat.brouillons);

/** Ajoute un geste de l'opérateur à la file, l'affiche aussitôt, et l'envoie si le réseau est là. */
async function agir(type, params) {
  const a = { ...creer(type, params), userId: etat.session && etat.session.user ? etat.session.user.id : null };
  await st.ajouterAction(a);
  etat.actions = await st.listerActions();
  render();
  planifierSync(0);
  return a;
}

async function rafraichirListe({ silencieux = true } = {}) {
  if (!etat.session || !etat.session.token) return;
  try {
    const r = await api.appel("GET", "/interventions");
    if (r.status === 200) {
      etat.liste = r.data; etat.listeLe = new Date().toISOString();
      await st.ecrire("liste", etat.liste); await st.ecrire("listeLe", etat.listeLe);
      await verifierNouveautes(r.data);
      preparerDossiers();
    } else if (r.status === 401) sessionPerdue();
    else if (!silencieux) toast((r.data && r.data.error) || "Liste indisponible", "alerte");
  } catch (e) { if (!silencieux) toast("Hors connexion : liste enregistrée affichée", "alerte"); }
  render();
}

/** Préparation hors connexion : le dossier complet de l'intervention est enregistré sur le téléphone. */
async function telechargerDossier(id, { silencieux = true } = {}) {
  if (etat.chargement[id]) return etat.chargement[id];
  const p = (async () => {
    try {
      const r = await api.appel("GET", `/interventions/${id}/terrain`);
      if (r.status === 200) {
        /* tant que des actions de cette intervention attendent, la vue reste fondée sur le dossier reçu
           (les actions y sont rejouées) : un dossier plus récent les intègre peut-être déjà, ce qui est
           sans conséquence, le serveur ignorant les actions déjà appliquées. */
        etat.dossiers[id] = { ...r.data, telechargeLe: new Date().toISOString() };
        await sauverDossiers();
        if (etat.brouillons[id]) { etat.brouillons[id] = ts.nettoyer(vueDe(id), etat.brouillons[id]); await sauverBrouillons(); }
        return true;
      }
      if (r.status === 401) sessionPerdue();
      else if (!silencieux) toast((r.data && r.data.error) || "Dossier indisponible", "alerte");
    } catch (e) { if (!silencieux) toast("Hors connexion : dossier enregistré affiché", "alerte"); }
    return false;
  })().finally(() => { delete etat.chargement[id]; render(); });
  etat.chargement[id] = p;
  render();
  return p;
}

/** Télécharge d'avance les dossiers des interventions du jour et à venir (prêtes pour le datacenter). */
async function preparerDossiers() {
  if (!etat.liste) return;
  const auj = aujourdhui();
  const ouvertes = etat.liste.filter(i => ["planifiee", "en_cours", "creee"].includes(i.statut) && ecartJours(auj, jourDe(i.date)) <= 7);
  for (const i of ouvertes) await telechargerDossier(i.id);
  /* les dossiers d'interventions terminées depuis longtemps sont oubliés (sauf actions en attente) */
  const gardes = new Set(etat.liste.filter(i => ecartJours(jourDe(i.date), auj) <= 14).map(i => String(i.id)));
  let change = false;
  for (const id of Object.keys(etat.dossiers)) if (!gardes.has(id) && !actionsDe(id).length) { delete etat.dossiers[id]; change = true; }
  if (change) await sauverDossiers();
}

/* ---------- synchronisation ---------- */
let minuterieSync = null;
function planifierSync(delai) {
  clearTimeout(minuterieSync);
  if (!enAttente().length) { etat.sync.prochain = null; return; }
  etat.sync.prochain = Date.now() + delai;
  minuterieSync = setTimeout(lancerSync, delai);
}

async function lancerSync() {
  if (etat.sync.enCours || !etat.session || !etat.session.refreshToken) return;
  if (!etat.reseau) { planifierSync(delaiNouvelEssai(++etat.sync.echecs)); render(); return; }
  etat.sync.enCours = true; render();
  let bilan;
  try {
    bilan = await synchroniser({
      depot: st.depot,
      envoyer: req => api.envoyer(req, st.lirePhoto),
      renouveler: () => api.renouveler(),
      surProgression: async () => { etat.actions = await st.listerActions(); render(); }
    });
  } catch (e) {
    bilan = { envoyees: 0, refusees: 0, arret: ARRET.RESEAU, interventions: new Set() };
  }
  etat.sync.enCours = false;
  etat.sync.arret = bilan.arret;
  etat.actions = await st.listerActions();
  if (bilan.envoyees || bilan.refusees) etat.sync.dernier = new Date().toISOString();
  if (bilan.refusees) toast(pluriel(bilan.refusees, "action refusée", "actions refusées") + " par le serveur : voir Réglages", "alerte");
  /* la vérité du serveur remplace la vue locale dès qu'une intervention n'a plus rien en attente */
  for (const id of bilan.interventions) if (!actionsDe(id).some(a => a.etat !== "rejetee")) telechargerDossier(id);
  if (bilan.arret === ARRET.SESSION) sessionPerdue();
  else if (bilan.arret) planifierSync(delaiNouvelEssai(++etat.sync.echecs));
  else { etat.sync.echecs = 0; if (bilan.envoyees) rafraichirListe(); }
  render();
}

function sessionPerdue() {
  if (etat.session && etat.session.token) etat.session = { ...etat.session, token: null, refreshToken: null, perdue: true };
  etat.session = lireSession();
  partagerSession();
  render();
}

/* ---------- notifications (application ouverte) ---------- */
async function verifierNouveautes(liste) {
  const brut = await native.prefLire("veille.connues");
  const { connues, notifications } = comparer(liste, brut ? JSON.parse(brut) : null);
  await native.prefEcrire("veille.connues", JSON.stringify(connues));
  if (etat.reglages.notifications && notifications.length) native.notifier(notifications);
}

/* ---------- écrans ---------- */
function bandeau() {
  const n = enAttente().length, r = refusees().length;
  let cls, txt;
  if (etat.sync.enCours) { cls = "sync"; txt = `Envoi en cours… ${n ? pluriel(n, "action", "actions") + " en attente" : ""}`; }
  else if (!enLigne()) { cls = "horsligne"; txt = "Hors connexion" + (n ? ` · ${pluriel(n, "action", "actions")} en attente, envoyée${n > 1 ? "s" : ""} au retour du réseau` : " · travail possible sur les dossiers enregistrés"); }
  else if (n) { cls = "attente"; txt = `${pluriel(n, "action", "actions")} en attente d'envoi`; }
  else cls = "";
  const session = etat.session && etat.session.perdue ? `<button class="bandeau alerte" data-act="reconnecter">Session expirée : reconnectez-vous pour envoyer vos actions (elles sont conservées)</button>` : "";
  const ref = r ? `<button class="bandeau alerte" data-act="voir-refus">${pluriel(r, "action refusée", "actions refusées")} par le serveur : à examiner</button>` : "";
  return session + ref + (cls ? `<button class="bandeau ${cls}" data-act="sync-maintenant">${esc(txt)}${n && !etat.sync.enCours && enLigne() ? " · Envoyer" : ""}</button>` : "");
}

function ecranAccueil() {
  const auj = aujourdhui();
  let html = banniere(maj) + bandeau();
  if (!etat.liste) {
    return html + `<section class="vide"><p>${enLigne() ? "Chargement des interventions…" : "Aucune intervention enregistrée sur ce téléphone. Connectez-vous au réseau de l'entreprise pour les télécharger."}</p><button class="btn" data-act="actualiser">Actualiser</button></section>`;
  }
  const groupes = [
    ["En cours", i => i.statut === "en_cours"],
    ["Aujourd'hui", i => ["creee", "planifiee"].includes(i.statut) && jourDe(i.date) <= auj],
    ["À venir", i => ["creee", "planifiee"].includes(i.statut) && jourDe(i.date) > auj],
    ["Terminées récemment", i => ["terminee", "validee", "annulee"].includes(i.statut) && ecartJours(jourDe(i.date), auj) <= 14]
  ];
  const tri = (a, b) => (jourDe(a.date) + heureDe(a.heure_prevue)).localeCompare(jourDe(b.date) + heureDe(b.heure_prevue));
  for (const [titre, f] of groupes) {
    const l = etat.liste.filter(f).sort(titre.startsWith("Terminées") ? (a, b) => tri(b, a) : tri);
    if (!l.length) continue;
    html += `<h2>${titre}</h2>` + l.map(carteIntervention).join("");
  }
  if (!etat.liste.some(i => groupes.some(([, f]) => f(i)))) html += `<section class="vide"><p>Aucune intervention prévue pour votre entreprise.</p></section>`;
  html += `<p class="note centre">Liste ${etat.listeLe ? "mise à jour " + ilya(etat.listeLe) : "jamais mise à jour"} · <button class="linkbtn" data-act="actualiser">Actualiser</button></p>`;
  return html;
}

function carteIntervention(i) {
  const v = vueDe(i.id);
  const statut = v ? v.intervention.statut : i.statut;
  const n = actionsDe(i.id).filter(a => a.etat !== "rejetee").length;
  const pret = !!etat.dossiers[i.id];
  const pc = v ? avancement(v) : null;
  return `<button class="carte-inter" data-act="ouvrir" data-id="${i.id}">`
    + `<span class="ci-tete"><b>${esc(jourLisible(jourDe(i.date)))} · ${esc(heureDe(i.heure_prevue))}</b>${puce(STATUTS[statut] || statut, STATUT_TON[statut])}</span>`
    + `<span class="ci-dc">${esc(i.datacenter || "Datacenter à préciser")}</span>`
    + `<span class="ci-pied">${i.ticket_hebergeur ? `<span>🎫 ${esc(i.ticket_hebergeur)}</span>` : `<span class="muet">Pas encore de ticket</span>`}`
    + `${i.en_retard && !["terminee", "validee", "annulee"].includes(statut) ? `<span class="rouge">En retard</span>` : ""}`
    + `${n ? `<span class="orange">⏳ ${n} en attente</span>` : ""}<span class="${pret ? "vert" : "muet"}">${pret ? "✓ Prête hors connexion" : "Non téléchargée"}</span></span>`
    + (pc != null && pc > 0 && pc < 100 ? `<span class="progres"><i style="width:${pc}%"></i></span>` : "")
    + `</button>`;
}

function ecranIntervention() {
  const id = etat.interventionId;
  const v = vueDe(id);
  const resume = (etat.liste || []).find(i => i.id === id);
  let html = bandeau();
  if (!v) {
    return html + `<section class="vide"><p>${etat.chargement[id] ? "Téléchargement du dossier…" : "Ce dossier n'a pas été téléchargé sur le téléphone. Connectez-vous au réseau de l'entreprise puis réessayez."}</p>`
      + (etat.chargement[id] ? "" : `<button class="btn primary" data-act="telecharger" data-id="${id}">Télécharger le dossier</button>`) + `</section>`;
  }
  const i = v.intervention;
  const acces = v.acces[v.acces.length - 1];
  html += `<section class="card entete">`
    + `<div class="ci-tete"><h2>${esc(i.datacenter || "Datacenter à préciser")}</h2>${puce(STATUTS[i.statut], STATUT_TON[i.statut])}</div>`
    + `<p class="grand">${esc(jourLisible(jourDe(i.date)))} à ${esc(heureDe(i.heure_prevue))}${resume && resume.en_retard && !["terminee", "validee", "annulee"].includes(i.statut) ? ` ${puce("En retard", "alerte")}` : ""}</p>`
    + `<dl>`
    + `<dt>Ticket hébergeur</dt><dd>${i.ticket_hebergeur ? `<b class="mono">${esc(i.ticket_hebergeur)}</b>` : `<span class="orange">Pas encore communiqué</span>`}</dd>`
    + (acces ? `<dt>Accès</dt><dd>${esc([acces.intervenant, acces.heure ? "à " + heureDe(acces.heure) : ""].filter(Boolean).join(" ")) || "—"}</dd>` : "")
    + (i.inclut_anomalies_ponctuelles && i.operation_ponctuelle_intitule ? `<dt>Opération</dt><dd>${esc(i.operation_ponctuelle_intitule)}</dd>` : "")
    + (i.commentaires ? `<dt>Consignes</dt><dd>${esc(i.commentaires)}</dd>` : "")
    + `</dl>`
    + `<p class="note">${etat.chargement[id] ? "Mise à jour du dossier…" : `✓ Dossier enregistré sur le téléphone ${ilya(etat.dossiers[id].telechargeLe)}`} · <button class="linkbtn" data-act="telecharger" data-id="${id}">Mettre à jour</button></p>`
    + `</section>`;
  if (figee(v)) html += `<div class="priority lv-vert"><b>Intervention ${i.statut === "annulee" ? "annulée" : "clôturée"}</b>Consultation seule.</div>`;
  else if (i.statut === "terminee") html += `<div class="priority lv-vert"><b>Travail terminé sur le terrain</b>L'administrateur va vérifier puis clôturer l'intervention.</div>`;

  for (const e of etapes(v)) html += blocEtape(v, e);
  return html;
}

function enteteEtape(e, ouvert, cle) {
  const etatTxt = !e.applicable ? "Sans objet" : e.validee ? (e.enAttente ? "Validée · en attente d'envoi" : "Validée " + horodatage(e.valideLe)) : !e.accessible ? "À venir" : "À faire";
  const ton = !e.applicable ? "neutre" : e.validee ? "ok" : !e.accessible ? "neutre" : "actif";
  return `<button class="etape-tete" data-act="plier" data-cle="${cle}" aria-expanded="${ouvert}">`
    + `<span class="num ${ton}">${e.validee ? "✓" : e.numero}</span><span class="txt"><b>${esc(e.titre)}</b><small>${esc(etatTxt)}</small></span><span class="chevron" aria-hidden="true">${ouvert ? "▾" : "▸"}</span></button>`;
}

function blocEtape(v, e) {
  const cle = "e" + v.intervention.id + e.cle;
  const ouvert = etat.ouvert[cle] ?? (e.applicable && e.accessible && !e.validee);
  let corps = "";
  if (ouvert) {
    if (!e.applicable) corps = `<p class="note">${e.cle === "depart_siege" ? "Rien à récupérer au siège pour cette intervention." : "Rien à ramener au siège pour cette intervention."}</p>`;
    else if (e.cle === "depart_siege") corps = corpsDepart(v, e);
    else if (e.cle === "intervention") corps = corpsDatacenter(v, e);
    else corps = corpsRetour(v, e);
  }
  return `<section class="card etape${e.validee ? " validee" : ""}">${enteteEtape(e, ouvert, cle)}${ouvert ? `<div class="etape-corps">${corps}</div>` : ""}</section>`;
}

const lecture = (v, e) => figee(v) || e.validee;

function boutonValider(v, cle, libelle) {
  const b = bloquants(v, cle);
  return (b.length ? `<ul class="bloquants">${b.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "")
    + `<div class="actions"><button class="btn primary large" data-act="valider-etape" data-etape="${cle}" ${b.length ? "disabled" : ""}>${esc(libelle)}</button></div>`;
}

function zoneScan(contexte) {
  return `<div class="scan"><button class="btn scan-btn" data-act="scanner" data-contexte="${contexte}"><span aria-hidden="true">▦</span> Scanner</button>`
    + `<input class="saisie-scan" data-contexte="${contexte}" placeholder="ou saisir / douchette" autocomplete="off" autocapitalize="characters" enterkeyhint="done"></div>`;
}

function corpsDepart(v, e) {
  const i = v.intervention, ro = lecture(v, e);
  if (i.statut === "creee" && !e.validee) return `<p class="note">L'administrateur n'a pas encore mis le matériel à disposition au siège. Vous serez prévenu dès qu'il le sera.</p>`;
  let h = "";
  if (v.materielPrevu.length) {
    const n = v.materielPrevu.filter(m => m.recupere_le).length;
    h += `<h3>Cartouches à récupérer <small>${n}/${v.materielPrevu.length}</small></h3>` + (ro ? "" : zoneScan("recuperer"));
    h += v.materielPrevu.map(m => coche(!!m.recupere_le, "recuperer", `data-cid="${m.cartouche_id}"`, `<span class="mono">${esc(m.cartouche_reference)}</span>`,
      m.emplacement_prevu_code ? `→ ${esc(m.emplacement_prevu_code)} ${m.emplacement_prevu_type === "ts4300_magasin2" ? "droite" : "gauche"}` : "", ro, m._attente)).join("");
  }
  const p = v.materielPonctuel.filter(m => m.a_recuperer);
  if (p.length) {
    h += `<h3>Matériel à récupérer</h3>` + p.map(m => coche(!!m.recupere_le, "ponctuel", `data-item="${m.id}" data-quoi="recuperer"`, esc(m.intitule), "Quantité : " + m.quantite, ro, m._attente)).join("");
  }
  if (!ro) h += boutonValider(v, "depart_siege", "Valider la récupération");
  return h;
}

function corpsDatacenter(v, e) {
  const i = v.intervention;
  if (!e.accessible && !e.validee) return `<p class="note">Disponible une fois la récupération au siège validée.</p>`;
  let h = "";
  for (const s of sousEtapesRequises(i)) {
    const cle = "s" + i.id + s;
    const fait = etapeValidee(v, s);
    const et = v.etapes.find(x => x.etape === s);
    const ouvert = etat.ouvert[cle] ?? !fait;
    h += `<div class="sous${fait ? " validee" : ""}"><button class="sous-tete" data-act="plier" data-cle="${cle}" aria-expanded="${ouvert}"><span class="num ${fait ? "ok" : "actif"}">${fait ? "✓" : "•"}</span><span class="txt"><b>${ETAPES[s]}</b><small>${fait ? (et._attente ? "Validée · en attente d'envoi" : "Validée " + horodatage(et.valide_le)) : "À faire"}</small></span><span class="chevron">${ouvert ? "▾" : "▸"}</span></button>`;
    if (ouvert) h += `<div class="sous-corps">${s === "chargement_ts4300" ? corpsTs4300(v, fait) : s === "verification_visuelle" ? corpsControles(v, fait) : corpsOperation(v, fait)}</div>`;
    h += `</div>`;
  }
  if (!sousEtapesRequises(i).length) h += `<p class="note">Aucune tâche détaillée pour cette intervention.</p>`;
  if (!lecture(v, e)) h += boutonValider(v, "intervention", "Valider le passage au datacenter");
  return h;
}

/* ----- TS4300 ----- */
function corpsTs4300(v, fait) {
  const id = v.intervention.id;
  const ro = fait || figee(v);
  const b = ro ? ts.brouillonVide() : ts.nettoyer(v, etat.brouillons[id]);
  let h = "";
  if (!ro) {
    const pl = ts.plateau(v, b);
    const sel = etat.selection;
    h += `<h3>Cartouches à installer <small>${pl.length}</small></h3>`;
    h += pl.length ? `<div class="plateau">${pl.map(c => `<button class="cartouche${sel && sel.cartoucheId === c.id ? " choisie" : ""}${c.retiree ? " retiree" : ""}" data-act="choisir-cartouche" data-cid="${c.id}"><span class="mono">${esc(c.reference)}</span>${c.cibleCode ? `<small>→ ${esc(c.cibleCode)} ${c.cibleMagasin === "ts4300_magasin2" ? "D" : "G"}</small>` : c.retiree ? "<small>retirée</small>" : ""}</button>`).join("")}</div>`
      : `<p class="note">${etapeValidee(v, "depart_siege") ? "Tout est placé." : "En attente de la validation de la récupération au siège."}</p>`;
    h += zoneScan("ts4300");
    if (pl.some(c => c.cibleId)) h += `<div class="actions"><button class="btn" data-act="placer-plan">Placer selon le plan</button></div>`;
    h += `<p class="aide">${sel && sel.cartoucheId ? `Touchez l'emplacement où installer <b class="mono">${esc(ts.referenceDe(v, sel.cartoucheId))}</b>.` : sel && sel.mode === "deplacer" ? "Touchez l'emplacement de destination." : "Touchez une cartouche puis un emplacement libre. Touchez une cartouche en place pour la retirer ou la déplacer."}</p>`;
  }
  h += `<div class="magasins">${Object.keys(ts.MAGASINS).map(m => grilleMagasin(v, b, m, ro)).join("")}</div>`;
  h += `<p class="legende"><span class="l-cible"></span>emplacement planifié <span class="l-retrait"></span>retrait planifié</p>`;
  if (!ro) {
    const rets = b.retraits.map(e => v.emplacements.find(x => x.id === e)).filter(Boolean);
    if (rets.length) h += `<h3>À retirer <small>${rets.length}</small></h3><div class="plateau">${rets.map(e => `<button class="cartouche retrait" data-act="annuler-emplacement" data-emp="${e.id}"><span class="mono">${esc(e.cartouche_reference)}</span><small>annuler</small></button>`).join("")}</div>`;
    const nb = b.installs.length + b.retraits.length;
    h += `<div class="actions"><button class="btn primary large" data-act="valider-chargement">${nb ? `Valider le chargement (${pluriel(b.installs.length, "installation", "installations")}, ${pluriel(b.retraits.length, "retrait", "retraits")})` : "Valider le chargement sans mouvement"}</button></div>`;
    if (nb) h += `<div class="actions"><button class="linkbtn" data-act="vider-brouillon">Tout annuler</button></div>`;
  } else {
    const r = v.aRestituer.filter(c => c.cartouche_etat === "transit");
    if (r.length) h += `<p class="note">À ramener au siège : ${r.map(c => `<span class="mono">${esc(c.cartouche_reference)}</span>`).join(", ")}</p>`;
  }
  return h;
}

function grilleMagasin(v, b, magasin, ro) {
  const cs = ts.cases(v, b, magasin);
  if (!cs.length) return `<div class="magasin"><h4>${ts.MAGASINS[magasin]}</h4><p class="note">Aucun emplacement défini.</p></div>`;
  const cellules = ts.colonnesBasEnHaut(cs).map(c => {
    if (!c) return `<span class="slot vide-pad"></span>`;
    const cls = ["slot", c.pose ? "pose" : c.retrait ? "retrait" : c.occupant ? "occupe" : "libre", c.cible && !c.pose ? "cible" : "", c.retraitPrevu ? "retrait-prevu" : "", c.attente ? "attente-envoi" : ""].join(" ");
    const ref = c.pose || c.occupant;
    return `<button class="${cls}" data-act="emplacement" data-emp="${c.id}" ${ro ? "disabled" : ""} title="${esc(c.code)}"><small>${esc(c.code.replace("SLOT-", ""))}</small><span class="mono">${ref ? esc(ref.replace(/L\d$/, "")) : ""}</span></button>`;
  }).join("");
  const colonnes = Math.ceil(cs.length / ts.LIGNES);
  return `<div class="magasin"><h4>${ts.MAGASINS[magasin]}</h4><div class="grille" style="grid-template-columns:repeat(${colonnes},1fr)">${cellules}</div></div>`;
}

/* ----- contrôles visuels ----- */
function corpsControles(v, fait) {
  const ro = fait || figee(v);
  const c = v.controles;
  let h = "";
  if (!ro) h += coche(c.rienASignaler, "rien-a-signaler", "", "Rien à signaler", c.signalements.length ? "Retirez d'abord les signalements" : "Baies, connectique et TS4300 vérifiées", c.signalements.length > 0, c._attente);
  else h += `<p><b class="${c.rienASignaler ? "vert" : "orange"}">${c.rienASignaler ? "✓ Rien à signaler" : pluriel(c.signalements.length, "signalement", "signalements")}</b></p>`;
  if (c.signalements.length) {
    h += `<ul class="liste">${c.signalements.map(s => `<li><span class="voyant ${s.voyant}" aria-hidden="true"></span><span class="txt"><b>${esc(s.element)}</b><small>Voyant ${esc(VOYANTS[s.voyant] || s.voyant)}${s.baie ? " · " + esc(s.baie) : ""}${s.commentaire ? " · " + esc(s.commentaire) : ""}</small></span>${attente(s)}${ro ? "" : `<button class="linkbtn danger" data-act="retirer-signalement" data-sid="${esc(s.id)}">Retirer</button>`}</li>`).join("")}</ul>`;
  }
  if (!ro && !c.rienASignaler) {
    h += `<details class="formulaire"${c.signalements.length ? "" : " open"}><summary>Ajouter un signalement</summary><form data-form="signalement">`
      + `<label class="field">Élément concerné<input name="element" required placeholder="ex. : Switch réseau baie 3"></label>`
      + `<fieldset class="choix"><legend>Voyant</legend>${Object.entries(VOYANTS).map(([k, l], n) => `<label class="voyant-choix ${k}"><input type="radio" name="voyant" value="${k}" ${n === 1 ? "checked" : ""}><span>${l}</span></label>`).join("")}</fieldset>`
      + `<label class="field">Baie<input name="baie" placeholder="ex. : Baie 3"></label>`
      + `<label class="field">Commentaire<input name="commentaire"></label>`
      + `<div class="actions"><button class="btn" type="submit">Ajouter le signalement</button></div></form></details>`;
  }
  if (!ro) h += boutonValider(v, "verification_visuelle", "Valider les contrôles");
  return h;
}

/* ----- opération ponctuelle et anomalies ----- */
function corpsOperation(v, fait) {
  const i = v.intervention, ro = fait || figee(v);
  let h = i.operation_ponctuelle_intitule ? `<p><b>${esc(i.operation_ponctuelle_intitule)}</b></p>` : "";
  const mat = v.materielPonctuel.filter(m => m.a_recuperer || m.utilise_le);
  if (mat.length) h += `<h3>Matériel utilisé</h3>` + mat.map(m => coche(!!m.utilise_le, "ponctuel", `data-item="${m.id}" data-quoi="utiliser"`, esc(m.intitule), "Quantité : " + m.quantite + (m.recupere_le ? "" : " · pas récupéré au siège"), ro, m._attente)).join("");
  h += `<h3>Problèmes rencontrés <small>${v.anomalies.length}</small></h3>`;
  h += v.anomalies.length ? `<ul class="liste">${v.anomalies.map(a => `<li class="anomalie"><span class="txt"><b>${esc(a.type)}</b> ${puce(PRIORITES[a.priorite] || a.priorite, a.priorite === "critique" || a.priorite === "haute" ? "alerte" : "neutre")}<small>${esc(a.description)}</small><small>${a._attente ? "En attente d'envoi" : (STATUTS_ANOMALIE[a.statut] || a.statut) + " · " + horodatage(a.created_at)} · ${pluriel(a.pieces_jointes.length, "photo", "photos")}</small><span class="vignettes">${a.pieces_jointes.filter(p => p.locale).map(p => `<img data-photo="${esc(p.id)}" alt="Photo en attente d'envoi">`).join("")}</span></span>${attente(a)}${ro || figee(v) ? "" : `<button class="linkbtn" data-act="photo-anomalie" data-aid="${esc(a.id)}">+ Photo</button>`}</li>`).join("")}</ul>` : `<p class="note">Aucun problème signalé.</p>`;
  if (!ro) {
    h += `<details class="formulaire"><summary>Signaler un problème</summary><form data-form="anomalie">`
      + `<label class="field">Type<input name="type" required placeholder="ex. : Câble endommagé"></label>`
      + `<fieldset class="choix"><legend>Priorité</legend>${Object.entries(PRIORITES).map(([k, l]) => `<label class="prio-choix"><input type="radio" name="priorite" value="${k}" ${k === "moyenne" ? "checked" : ""}><span>${l}</span></label>`).join("")}</fieldset>`
      + `<label class="field">Description<textarea name="description" rows="3" required></textarea></label>`
      + `<div class="vignettes">${etat.photosAnomalie.map(p => `<span class="vignette"><img src="${p.url}" alt=""><button type="button" class="linkbtn danger" data-act="retirer-photo-saisie" data-pid="${p.id}">✕</button></span>`).join("")}</div>`
      + `<div class="actions"><button class="btn" type="button" data-act="photo-saisie">📷 Ajouter une photo</button><button class="btn primary" type="submit">Signaler</button></div></form></details>`;
    h += boutonValider(v, "anomalies_ponctuelles", "Valider l'opération");
  }
  return h;
}

function corpsRetour(v, e) {
  if (!e.accessible && !e.validee) return `<p class="note">Disponible une fois le passage au datacenter validé.</p>`;
  const ro = lecture(v, e);
  let h = "";
  if (v.intervention.inclut_cartouches) {
    const n = v.aRestituer.filter(c => c.cartouche_etat === "a_ranger").length;
    h += `<h3>Cartouches à restituer <small>${n}/${v.aRestituer.length}</small></h3>`;
    if (v.aRestituer.length) h += (ro ? "" : zoneScan("restituer")) + v.aRestituer.map(c => coche(c.cartouche_etat === "a_ranger", "restituer", `data-cid="${c.cartouche_id}"`, `<span class="mono">${esc(c.cartouche_reference)}</span>`, c.cartouche_etat === "a_ranger" ? "Remise au siège" : "En transit", ro, c._attente)).join("");
    else h += `<p class="note">Aucune cartouche à ramener.</p>`;
  }
  const p = v.materielPonctuel.filter(m => m.a_ramener);
  if (p.length) h += `<h3>Matériel à ramener</h3>` + p.map(m => coche(!!m.restitue_le, "ponctuel", `data-item="${m.id}" data-quoi="restituer"`, esc(m.intitule), "Quantité : " + m.quantite, ro, m._attente)).join("");
  if (!ro) h += boutonValider(v, "retour_siege", "Valider le retour au siège");
  return h;
}

/* ----- réglages ----- */
function ecranReglages() {
  const s = etat.session, r = etat.reglages;
  const att = enAttente(), ref = refusees();
  let h = carteEtat(maj);
  h += `<h2>Compte</h2><div class="card">` + (s && s.user ? `<p style="margin-top:0"><b>${esc(s.user.nom)}</b><br><span class="note">${esc(s.user.email)}</span></p>` : "")
    + `<p class="note">Serveur : <span class="mono">${esc(r.adresse || "non renseigné")}</span> · ${enLigne() ? `<span class="vert">joignable</span>` : `<span class="orange">injoignable</span>`}</p>`
    + `<div class="actions"><button class="btn" data-act="changer-adresse">Changer de serveur</button><button class="btn" data-act="deconnexion">Se déconnecter</button></div></div>`;

  h += `<h2 id="file">Envoi des actions</h2><div class="card">`
    + `<p style="margin-top:0">${att.length ? pluriel(att.length, "action en attente", "actions en attente") : "Tout est envoyé."}${etat.sync.dernier ? ` <span class="note">· dernier envoi ${ilya(etat.sync.dernier)}</span>` : ""}</p>`
    + (att.length ? `<ul class="liste compacte">${att.slice(0, 30).map(a => `<li><span class="txt"><b>${esc(a.label)}</b><small>${horodatage(a.realiseLe)} · intervention ${a.interventionId}</small></span></li>`).join("")}</ul>` : "")
    + `<div class="actions"><button class="btn" data-act="sync-maintenant" ${att.length && !etat.sync.enCours ? "" : "disabled"}>${etat.sync.enCours ? "Envoi…" : "Envoyer maintenant"}</button></div>`;
  if (ref.length) {
    h += `<h3 id="refus">Refusées par le serveur</h3><ul class="liste">${ref.map(a => `<li class="refus"><span class="txt"><b>${esc(a.label)}</b><small>${horodatage(a.realiseLe)} · ${esc(a.erreur || "")}</small></span><span class="boutons"><button class="linkbtn" data-act="reessayer" data-aid="${a.id}">Réessayer</button><button class="linkbtn danger" data-act="abandonner" data-aid="${a.id}">Abandonner</button></span></li>`).join("")}</ul>`
      + `<p class="note">Une action est refusée quand le serveur ne l'accepte pas en l'état (étape déjà invalidée par l'administrateur, cartouche déjà déplacée…). « Réessayer » la renvoie telle quelle ; « Abandonner » la retire du téléphone.</p>`;
  }
  h += `</div>`;

  h += `<h2>Sécurité</h2><div class="card">` + coche(r.verrou, "verrou", "", "Verrouiller l'application", "Empreinte, visage ou code du téléphone à l'ouverture et après 2 minutes en arrière-plan") + `</div>`;
  h += `<h2>Notifications</h2><div class="card">` + coche(r.notifications, "notifications", "", "Interventions attribuées ou modifiées", "Nouvelle intervention, matériel prêt, changement d'horaire, annulation. Vérifié toutes les 30 minutes environ quand le téléphone joint le serveur.") + `</div>`;
  h += `<h2>Scanner</h2><div class="card"><p style="margin-top:0" id="etatScanner">${etat.scanner ? esc(etat.scanner) : "…"}</p><div class="actions"><button class="btn" data-act="installer-scanner">Vérifier / installer</button></div><p class="note">Le module de scan Google doit être installé avant d'aller au datacenter : il fonctionne ensuite sans réseau. Une douchette Bluetooth peut aussi saisir dans les champs « ou saisir ».</p></div>`;
  h += sectionReglages(maj);
  h += `<p class="note centre">SH Presta Terrain ${esc(maj.state.current || "")} · application du prestataire Smart Hands</p>`;
  return h;
}

/* ----- premier lancement : adresse puis connexion ----- */
function ecranAdresse() {
  return `<section class="accueil-connexion"><h2>Serveur SH Presta</h2><p class="note">Adresse communiquée par l'administrateur, par exemple <span class="mono">sh-presta.domsig.sem</span>. Le téléphone doit être connecté au réseau de l'entreprise (VPN).</p>`
    + `<form data-form="adresse"><label class="field">Adresse du serveur<input name="adresse" value="${esc(etat.reglages.adresse)}" required autocomplete="url" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="sh-presta.domsig.sem"></label>`
    + `<div class="actions"><button class="btn primary large" type="submit">Continuer</button></div></form></section>`;
}
function ecranConnexion() {
  const perdue = etat.session && etat.session.perdue;
  return `<section class="accueil-connexion"><h2>${perdue ? "Session expirée" : "Connexion"}</h2>`
    + (perdue ? `<p class="note">Reconnectez-vous pour envoyer vos actions : elles sont conservées sur le téléphone.</p>` : `<p class="note">Avec votre compte prestataire SH Presta.</p>`)
    + `<form data-form="connexion"><label class="field">Adresse e-mail<input name="email" type="email" value="${esc(etat.reglages.email || (perdue && etat.session.user ? etat.session.user.email : ""))}" required autocomplete="username" autocapitalize="off"></label>`
    + `<label class="field">Mot de passe<input name="password" type="password" required autocomplete="current-password"></label>`
    + `<div class="actions"><button class="btn primary large" type="submit">Se connecter</button></div></form>`
    + `<p class="note centre">Serveur : <span class="mono">${esc(etat.reglages.adresse)}</span> · <button class="linkbtn" data-act="changer-adresse">Changer</button></p></section>`;
}

/* ---------- rendu ---------- */
function render() {
  if (etat.verrouille) { $("#verrou").hidden = false; return; }
  $("#verrou").hidden = true;
  if (!etat.reglages.adresse) etat.ecran = "adresse";
  else if (!etat.session || (!etat.session.token && !etat.session.perdue)) { if (etat.ecran !== "adresse") etat.ecran = "connexion"; }
  const connecte = etat.session && (etat.session.token || etat.session.perdue);
  const e = etat.ecran;
  $("#retour").hidden = !(e === "intervention" || (e === "reglages") || (e === "connexion" && etat.session && etat.session.perdue));
  $("#titre").textContent = e === "intervention" ? "Intervention" : e === "reglages" ? "Réglages" : "SH Presta";
  $("#reseau").className = "reseau " + (etat.sync.enCours ? "sync" : enLigne() ? "en-ligne" : "hors-ligne");
  $("#reseau").textContent = etat.sync.enCours ? "Envoi…" : enLigne() ? "En ligne" : "Hors connexion";
  $("#reseau").hidden = !connecte;
  $("#ouvrirReglages").hidden = !connecte || e === "reglages" || e === "connexion" || e === "adresse";
  const ecrans = { accueil: ecranAccueil, intervention: ecranIntervention, reglages: ecranReglages, adresse: ecranAdresse, connexion: ecranConnexion };
  const actif = document.activeElement;
  const garder = actif && actif.matches && actif.matches("input, textarea") && $("#app").contains(actif) ? { form: actif.closest("form") && actif.closest("form").dataset.form, name: actif.name, ctx: actif.dataset.contexte, val: actif.value } : null;
  const valeurs = garderFormulaires();
  $("#app").innerHTML = (ecrans[e] || ecranAccueil)();
  restaurerFormulaires(valeurs);
  if (garder) {
    const sel = garder.form ? `form[data-form="${garder.form}"] [name="${garder.name}"]` : garder.ctx ? `.saisie-scan[data-contexte="${garder.ctx}"]` : null;
    const el = sel && $(sel);
    if (el) { el.focus(); if (garder.ctx) el.value = garder.val; }
  }
  afficherVignettes();
}

/* les formulaires en cours de saisie survivent aux rafraîchissements de l'écran (synchronisation en arrière-plan) */
function garderFormulaires() {
  const v = {};
  document.querySelectorAll("#app form[data-form]").forEach(f => {
    v[f.dataset.form] = { ouvert: f.closest("details") ? f.closest("details").open : null, champs: Object.fromEntries([...f.elements].filter(x => x.name).map(x => [x.name + (x.type === "radio" ? ":" + x.value : ""), x.type === "radio" ? x.checked : x.value])) };
  });
  return v;
}
function restaurerFormulaires(v) {
  document.querySelectorAll("#app form[data-form]").forEach(f => {
    const s = v[f.dataset.form];
    if (!s) return;
    if (s.ouvert != null && f.closest("details")) f.closest("details").open = s.ouvert;
    for (const x of f.elements) {
      if (!x.name) continue;
      const k = x.name + (x.type === "radio" ? ":" + x.value : "");
      if (!(k in s.champs)) continue;
      if (x.type === "radio") x.checked = s.champs[k]; else x.value = s.champs[k];
    }
  });
}
const urlsPhotos = new Map();
async function afficherVignettes() {
  for (const img of document.querySelectorAll("img[data-photo]")) {
    const id = img.dataset.photo;
    if (!urlsPhotos.has(id)) { const b = await st.lirePhoto(id); if (b) urlsPhotos.set(id, URL.createObjectURL(b)); }
    if (urlsPhotos.has(id)) img.src = urlsPhotos.get(id);
  }
}

/* ---------- gestes ---------- */
function ouvrirIntervention(id) {
  etat.interventionId = id; etat.ecran = "intervention"; etat.selection = null;
  render(); window.scrollTo(0, 0);
  if (enLigne() && !actionsDe(id).some(a => a.etat !== "rejetee")) telechargerDossier(id);
  else if (!etat.dossiers[id]) telechargerDossier(id, { silencieux: false });
}

function retour() {
  if (!$("#sheet").hidden) { feuilleFermer(); return true; }
  if (etat.selection) { etat.selection = null; render(); return true; }
  if (etat.ecran === "intervention" || etat.ecran === "reglages" || (etat.ecran === "connexion" && etat.session && etat.session.perdue)) { etat.ecran = "accueil"; render(); window.scrollTo(0, 0); return true; }
  return false;
}

/** Traite un code lu (scanner, douchette ou saisie) selon l'écran. */
async function codeLu(code, contexte) {
  const v = vueDe(etat.interventionId);
  if (!v || !code) return false;
  const norm = s => String(s || "").toUpperCase().replace(/\s+/g, "");
  const c = norm(code);
  const meme = r => norm(r) === c || norm(r).replace(/L\d$/, "") === c.replace(/L\d$/, "");
  const I = v.intervention.id;
  if (contexte === "recuperer") {
    const m = v.materielPrevu.find(x => meme(x.cartouche_reference));
    if (!m) { native.bip(false); toast(`${code} : cartouche non prévue pour cette intervention`, "alerte"); return false; }
    native.bip(true);
    if (m.recupere_le) { toast(`${m.cartouche_reference} déjà pointée`); return true; }
    await agir("recuperer_cartouche", { interventionId: I, cartoucheId: m.cartouche_id, recupere: true, reference: m.cartouche_reference });
    toast(`${m.cartouche_reference} récupérée`, "ok");
    return true;
  }
  if (contexte === "restituer") {
    const r = v.aRestituer.find(x => meme(x.cartouche_reference));
    if (!r) { native.bip(false); toast(`${code} : cartouche à ne pas restituer pour cette intervention`, "alerte"); return false; }
    native.bip(true);
    if (r.cartouche_etat === "a_ranger") { toast(`${r.cartouche_reference} déjà restituée`); return true; }
    await agir("restituer_cartouche", { interventionId: I, cartoucheId: r.cartouche_id, restitue: true, reference: r.cartouche_reference });
    toast(`${r.cartouche_reference} restituée`, "ok");
    return true;
  }
  if (contexte === "ts4300") {
    const b = ts.nettoyer(v, etat.brouillons[I]);
    const p = ts.plateau(v, b).find(x => meme(x.reference));
    if (p) {
      native.bip(true);
      if (p.cibleId && ts.libre(v, b, p.cibleId)) { await poserCartouche(v, p.id, p.cibleId); toast(`${p.reference} → ${p.cibleCode} : emplacement planifié`, "ok"); }
      else { etat.selection = { cartoucheId: p.id }; render(); toast(`${p.reference} : touchez l'emplacement`); }
      return true;
    }
    const e = v.emplacements.find(x => x.cartouche_reference && meme(x.cartouche_reference));
    if (e) { native.bip(true); menuEmplacement(v, b, e); return true; }
    native.bip(false); toast(`${code} : cartouche inconnue ici`, "alerte");
    return false;
  }
  return false;
}

async function scannerEnContinu(contexte) {
  try {
    for (;;) {
      const code = await native.scanner();
      if (!code) return;
      const ok = await codeLu(code, contexte);
      if (contexte === "ts4300" || !ok) return;
      /* récupération / restitution : on enchaîne les cartouches tant qu'il en reste */
      const v = vueDe(etat.interventionId);
      const reste = contexte === "recuperer" ? v.materielPrevu.some(m => !m.recupere_le) : v.aRestituer.some(c => c.cartouche_etat === "transit");
      if (!reste) { toast("Toutes les cartouches sont pointées", "ok"); return; }
    }
  } catch (e) { toast(e.message || String(e), "alerte"); }
}

async function changerBrouillon(id, b) { etat.brouillons[id] = b; await sauverBrouillons(); render(); }
async function poserCartouche(v, cid, empId) {
  const I = v.intervention.id;
  const r = ts.poser(v, ts.nettoyer(v, etat.brouillons[I]), cid, empId);
  if (!r.ok) { toast(r.erreur, "alerte"); return; }
  etat.selection = null;
  native.vibrer(true);
  await changerBrouillon(I, r.brouillon);
}

function menuEmplacement(v, b, e) {
  const enRetrait = b.retraits.includes(e.id);
  const posee = b.installs.find(([x]) => x === e.id);
  const prevu = v.retraitsPrevus.some(r => r.cartouche_id === e.cartouche_id);
  let h = `<p style="margin-top:0">${e.type === "ts4300_magasin2" ? "Magasin de droite" : "Magasin de gauche"} · <b class="mono">${esc(e.code_emplacement)}</b>${e.cartouche_reference ? ` · <span class="mono">${esc(e.cartouche_reference)}</span>` : " · vide"}</p>`;
  if (prevu && !enRetrait) h += `<div class="priority lv-orange"><b>Retrait planifié</b>Cette cartouche figure dans le plan de chargement comme à retirer.</div>`;
  h += `<div class="actions colonne">`;
  if (posee || enRetrait) h += `<button class="btn" data-act="annuler-emplacement" data-emp="${e.id}">Annuler ce qui est prévu ici</button>`;
  if (e.cartouche_id && !enRetrait) {
    h += `<button class="btn primary" data-act="retirer-emplacement" data-emp="${e.id}">Retirer la cartouche (retour au siège)</button>`;
    h += `<button class="btn" data-act="deplacer-emplacement" data-emp="${e.id}">Déplacer vers un autre emplacement</button>`;
  }
  h += `</div>`;
  feuilleOuvrir("Emplacement " + e.code_emplacement, h);
}

async function toucherEmplacement(empId) {
  const v = vueDe(etat.interventionId); if (!v) return;
  const I = v.intervention.id;
  const b = ts.nettoyer(v, etat.brouillons[I]);
  const e = v.emplacements.find(x => x.id === empId);
  const sel = etat.selection;
  if (sel && sel.cartoucheId) { if (ts.libre(v, b, empId)) return poserCartouche(v, sel.cartoucheId, empId); if (!e.cartouche_id) return toast("Emplacement déjà réservé", "alerte"); }
  if (sel && sel.mode === "deplacer") {
    const r = ts.deplacer(v, b, sel.emplacementId, empId);
    etat.selection = null;
    if (!r.ok) { toast(r.erreur, "alerte"); render(); return; }
    native.vibrer(true);
    return changerBrouillon(I, r.brouillon);
  }
  const pose = b.installs.find(([x]) => x === empId);
  if (pose && !e.cartouche_id) return changerBrouillon(I, ts.annuler(v, b, empId));
  if (e.cartouche_id || pose) return menuEmplacement(v, b, e);
  toast("Choisissez d'abord une cartouche à installer");
}

async function validerChargement() {
  const v = vueDe(etat.interventionId); if (!v) return;
  const I = v.intervention.id;
  const b = ts.nettoyer(v, etat.brouillons[I]);
  const mouv = ts.versMouvements(v, b, I);
  const restants = ts.plateau(v, b).filter(c => !c.retiree).length;
  if (restants && !confirm(`${pluriel(restants, "cartouche récupérée n'est pas installée", "cartouches récupérées ne sont pas installées")} : elle${restants > 1 ? "s" : ""} devra${restants > 1 ? "ont" : ""} être ramenée${restants > 1 ? "s" : ""} au siège. Valider quand même ?`)) return;
  for (const m of mouv) await agir("mouvement", m);
  await agir("valider_etape", { interventionId: I, etape: "chargement_ts4300", titre: ETAPES.chargement_ts4300 });
  delete etat.brouillons[I]; await sauverBrouillons();
  toast(mouv.length ? `Chargement validé : ${pluriel(mouv.length, "mouvement", "mouvements")}` : "Chargement validé", "ok");
  render();
}

async function prendrePhoto() {
  try { return await native.photo(); } catch (e) { toast("Photo impossible : " + (e.message || e), "alerte"); return null; }
}

const ACTIONS = {
  "ouvrir": el => ouvrirIntervention(Number(el.dataset.id)),
  "actualiser": () => rafraichirListe({ silencieux: false }),
  "telecharger": el => telechargerDossier(Number(el.dataset.id), { silencieux: false }),
  "plier": el => { const k = el.dataset.cle; const ouvert = el.getAttribute("aria-expanded") === "true"; etat.ouvert[k] = !ouvert; render(); },
  "recuperer": async el => {
    const v = vueDe(etat.interventionId), m = v.materielPrevu.find(x => x.cartouche_id === Number(el.dataset.cid));
    await agir("recuperer_cartouche", { interventionId: v.intervention.id, cartoucheId: m.cartouche_id, recupere: !m.recupere_le, reference: m.cartouche_reference });
  },
  "restituer": async el => {
    const v = vueDe(etat.interventionId), c = v.aRestituer.find(x => x.cartouche_id === Number(el.dataset.cid));
    await agir("restituer_cartouche", { interventionId: v.intervention.id, cartoucheId: c.cartouche_id, restitue: c.cartouche_etat !== "a_ranger", reference: c.cartouche_reference });
  },
  "ponctuel": async el => {
    const v = vueDe(etat.interventionId), m = v.materielPonctuel.find(x => x.id === Number(el.dataset.item)), quoi = el.dataset.quoi;
    const champ = { recuperer: "recupere_le", utiliser: "utilise_le", restituer: "restitue_le" }[quoi];
    await agir("ponctuel", { interventionId: v.intervention.id, itemId: m.id, quoi, fait: !m[champ], intitule: m.intitule });
  },
  "valider-etape": async el => {
    const v = vueDe(etat.interventionId), cle = el.dataset.etape;
    if (bloquants(v, cle).length) return;
    if (["depart_siege", "intervention", "retour_siege"].includes(cle) && !confirm(`Valider « ${ETAPES[cle]} » ? Seul l'administrateur pourra revenir dessus.`)) return;
    await agir("valider_etape", { interventionId: v.intervention.id, etape: cle, titre: ETAPES[cle] });
    toast(ETAPES[cle] + " : validé" + (enLigne() ? "" : " (envoi au retour du réseau)"), "ok");
    if (cle === "depart_siege" && enLigne()) setTimeout(() => telechargerDossier(v.intervention.id), 1500);
  },
  "scanner": el => scannerEnContinu(el.dataset.contexte),
  "choisir-cartouche": el => { const cid = Number(el.dataset.cid); etat.selection = etat.selection && etat.selection.cartoucheId === cid ? null : { cartoucheId: cid }; render(); },
  "emplacement": el => toucherEmplacement(Number(el.dataset.emp)),
  "placer-plan": async () => {
    const v = vueDe(etat.interventionId); const I = v.intervention.id;
    const r = ts.placerSelonPlan(v, ts.nettoyer(v, etat.brouillons[I]));
    await changerBrouillon(I, r.brouillon);
    toast(r.places ? `${pluriel(r.places, "cartouche placée", "cartouches placées")} selon le plan` : "Emplacements planifiés occupés : placement manuel", r.places ? "ok" : "alerte");
  },
  "retirer-emplacement": async el => { feuilleFermer(); const v = vueDe(etat.interventionId); const I = v.intervention.id; const r = ts.retirer(v, ts.nettoyer(v, etat.brouillons[I]), Number(el.dataset.emp)); if (r.ok) await changerBrouillon(I, r.brouillon); },
  "deplacer-emplacement": el => { feuilleFermer(); etat.selection = { emplacementId: Number(el.dataset.emp), mode: "deplacer" }; render(); toast("Touchez l'emplacement de destination"); },
  "annuler-emplacement": async el => { feuilleFermer(); const v = vueDe(etat.interventionId); const I = v.intervention.id; await changerBrouillon(I, ts.annuler(v, ts.nettoyer(v, etat.brouillons[I]), Number(el.dataset.emp))); },
  "vider-brouillon": async () => { if (!confirm("Annuler tous les mouvements prévus ?")) return; delete etat.brouillons[etat.interventionId]; await sauverBrouillons(); etat.selection = null; render(); },
  "valider-chargement": () => validerChargement(),
  "rien-a-signaler": async () => { const v = vueDe(etat.interventionId); await agir("rien_a_signaler", { interventionId: v.intervention.id, valeur: !v.controles.rienASignaler }); },
  "retirer-signalement": async el => {
    const v = vueDe(etat.interventionId), sid = estLocal(el.dataset.sid) ? el.dataset.sid : Number(el.dataset.sid);
    const s = v.controles.signalements.find(x => x.id === sid);
    if (estLocal(sid)) {
      const corr = await st.depot.correspondances();
      if (corr[sid] == null) { for (const id of annulerCreation(etat.actions, sid)) await st.retirerAction(id); etat.actions = await st.listerActions(); render(); return; }
    }
    await agir("retirer_signalement", { interventionId: v.intervention.id, signalementId: sid, element: s ? s.element : "" });
  },
  "photo-saisie": async () => { const b = await prendrePhoto(); if (!b) return; const id = "p-" + idLocal().slice(2); await st.ecrirePhoto(id, b); etat.photosAnomalie.push({ id, url: URL.createObjectURL(b) }); render(); },
  "retirer-photo-saisie": async el => { const id = el.dataset.pid; etat.photosAnomalie = etat.photosAnomalie.filter(p => p.id !== id); await st.effacerPhoto(id); render(); },
  "photo-anomalie": async el => {
    const v = vueDe(etat.interventionId), aid = estLocal(el.dataset.aid) ? el.dataset.aid : Number(el.dataset.aid);
    const an = v.anomalies.find(a => a.id === aid);
    const b = await prendrePhoto(); if (!b) return;
    const pid = "p-" + idLocal().slice(2);
    await st.ecrirePhoto(pid, b);
    await agir("photo", { interventionId: v.intervention.id, anomalieId: aid, photoId: pid, typeAnomalie: an ? an.type : "" });
    toast("Photo ajoutée" + (enLigne() ? "" : " (envoi au retour du réseau)"), "ok");
  },
  "sync-maintenant": () => { etat.sync.echecs = 0; lancerSync(); },
  "voir-refus": () => { etat.ecran = "reglages"; render(); setTimeout(() => { const r = $("#refus"); if (r) r.scrollIntoView({ block: "start" }); }, 50); },
  "reessayer": async el => { const a = etat.actions.find(x => x.id === el.dataset.aid); if (!a) return; await st.modifierAction({ ...a, etat: "attente", erreur: null }); etat.actions = await st.listerActions(); render(); lancerSync(); },
  "abandonner": async el => {
    const a = etat.actions.find(x => x.id === el.dataset.aid); if (!a) return;
    if (!confirm(`Abandonner « ${a.label} » ? Elle ne sera jamais envoyée.`)) return;
    await st.depot.retirer(a.id);
    etat.actions = await st.listerActions();
    if (!actionsDe(a.interventionId).length && enLigne()) telechargerDossier(Number(a.interventionId));
    render();
  },
  "reconnecter": () => { etat.ecran = "connexion"; render(); },
  "changer-adresse": () => {
    if (enAttente().length) { toast("Des actions attendent d'être envoyées à ce serveur : impossible de changer d'adresse maintenant", "alerte"); return; }
    etat.ecran = "adresse"; render();
  },
  "deconnexion": async () => {
    const n = enAttente().length + refusees().length;
    if (n && !confirm(`${pluriel(n, "action n'a", "actions n'ont")} pas été envoyée${n > 1 ? "s" : ""}. Elles restent sur le téléphone et partiront à la prochaine connexion du même compte. Se déconnecter ?`)) return;
    if (!n && !confirm("Se déconnecter ? Les dossiers enregistrés sur le téléphone seront effacés.")) return;
    await api.deconnexion();
    if (!n) { await st.toutEffacer(); etat.dossiers = {}; etat.liste = null; etat.brouillons = {}; etat.actions = []; await native.prefEcrire("veille.connues", null); }
    await partagerSession();
    etat.ecran = "connexion"; render();
  },
  "verrou": async () => {
    if (!etat.reglages.verrou) {
      const p = await native.verrouPossible();
      if (!p.possible) { toast(p.raison, "alerte"); return; }
      if (!(await native.deverrouiller())) return;
    }
    etat.reglages.verrou = !etat.reglages.verrou; sauverReglages(); render();
  },
  "notifications": async () => {
    const actif = !etat.reglages.notifications;
    if (actif && native.isNative && !(await native.notificationsAutorisees(true))) { toast("Notifications refusées dans les réglages d'Android", "alerte"); return; }
    etat.reglages.notifications = actif; sauverReglages();
    await partagerSession();
    await native.veille(actif && !!(etat.session && etat.session.token));
    render();
  },
  "installer-scanner": () => verifierScanner(true),
  "deverrouiller": () => deverrouiller(),
  "sheet-close": () => feuilleFermer(),
  "retour": () => { if (!retour()) history.back(); },
  "ouvrir-reglages": () => { etat.ecran = "reglages"; render(); window.scrollTo(0, 0); maj.autoCheck(1); verifierScanner(false); },
  /* mises à jour de l'application (@orfeo/updater) */
  "update-check": async () => { const m = await maj.check({ manual: true }); if (m) toast(m); },
  "update-open": () => feuilleOuvrir(titreFeuille(maj), feuille(maj)),
  "update-start": () => maj.start(),
  "update-cancel": () => maj.cancel(),
  "update-perm": () => maj.openInstallSettings()
};

async function verifierScanner(installer) {
  const p = await native.scannerPret();
  if (p.disponible) etat.scanner = "✓ Scanner prêt, utilisable sans réseau";
  else if (p.raison === "web") etat.scanner = "Disponible dans l'application Android";
  else if (p.raison === "module") {
    etat.scanner = "Module de scan à installer (réseau nécessaire)";
    if (installer) {
      etat.scanner = "Installation du module de scan…"; render();
      try { await native.installerScanner(pc => { etat.scanner = `Installation du module de scan… ${pc} %`; render(); }); etat.scanner = "Installation lancée : vérifiez dans un instant"; }
      catch (e) { etat.scanner = "Installation impossible : " + (e.message || e); }
    }
  } else etat.scanner = p.raison;
  render();
}

/* ---------- formulaires ---------- */
const FORMULAIRES = {
  async adresse(f) {
    const r = normaliserAdresse(f.adresse.value);
    if (!r.ok) { toast(r.erreur, "alerte"); return; }
    const btn = f.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = "Vérification…";
    const ok = await api.sante(r.adresse);
    btn.disabled = false; btn.textContent = "Continuer";
    if (!ok && !confirm(`Le serveur ${r.adresse} ne répond pas (réseau de l'entreprise ou VPN non connecté ?). Enregistrer quand même cette adresse ?`)) return;
    if (etat.reglages.adresse && etat.reglages.adresse !== r.adresse) { await api.deconnexion(); await st.toutEffacer(); etat.dossiers = {}; etat.liste = null; etat.actions = []; etat.brouillons = {}; }
    etat.reglages.adresse = r.adresse; sauverReglages();
    await partagerSession();
    etat.ecran = etat.session && etat.session.token ? "accueil" : "connexion";
    render();
  },
  async connexion(f) {
    const email = f.email.value.trim(), pwd = f.password.value;
    const btn = f.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = "Connexion…";
    let r;
    try { r = await api.connexion(email, pwd, (await native.infos()).appareil); } catch (e) { r = { ok: false, erreur: e.message || "Serveur injoignable : réseau de l'entreprise ou VPN connecté ?" }; }
    btn.disabled = false; btn.textContent = "Se connecter";
    if (!r.ok) { toast(r.erreur, "alerte"); return; }
    /* des actions laissées par un autre compte ne partent jamais sous ce compte-ci */
    const autres = etat.actions.filter(a => a.userId && a.userId !== r.session.user.id);
    if (autres.length) {
      if (!confirm(`${pluriel(autres.length, "action", "actions")} d'un autre compte n'${autres.length > 1 ? "ont" : "a"} pas été envoyée${autres.length > 1 ? "s" : ""}. Les supprimer pour continuer avec ce compte ?`)) { await api.deconnexion(); render(); return; }
      for (const a of autres) await st.depot.retirer(a.id);
      etat.actions = await st.listerActions();
    }
    etat.reglages.email = email; sauverReglages();
    await partagerSession();
    if (etat.reglages.notifications) { await native.notificationsAutorisees(true); await native.veille(true); }
    etat.ecran = "accueil"; render();
    await rafraichirListe({ silencieux: false });
    planifierSync(0);
  },
  async signalement(f) {
    const v = vueDe(etat.interventionId);
    const d = { element: f.element.value.trim(), voyant: f.voyant.value, baie: f.baie.value.trim(), commentaire: f.commentaire.value.trim() };
    if (!d.element) return;
    await agir("signalement", { interventionId: v.intervention.id, localId: idLocal(), ...d });
    f.reset();
    toast("Signalement ajouté", "ok");
  },
  async anomalie(f) {
    const v = vueDe(etat.interventionId);
    const d = { typeAnomalie: f.type.value.trim(), description: f.description.value.trim(), priorite: f.priorite.value };
    if (!d.typeAnomalie || !d.description) return;
    const localId = idLocal();
    await agir("anomalie", { interventionId: v.intervention.id, localId, ...d });
    for (const p of etat.photosAnomalie) await agir("photo", { interventionId: v.intervention.id, anomalieId: localId, photoId: p.id, typeAnomalie: d.typeAnomalie });
    etat.photosAnomalie = [];
    f.reset();
    const det = f.closest("details"); if (det) det.open = false;
    toast("Problème signalé" + (enLigne() ? "" : " (envoi au retour du réseau)"), "ok");
    render();
  }
};

/* ---------- événements ---------- */
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  try { await fn(el); } catch (err) { console.error(err); toast("Erreur : " + (err.message || err), "alerte"); }
});
document.addEventListener("submit", async e => {
  const f = e.target.closest("form[data-form]");
  if (!f) return;
  e.preventDefault();
  try { await FORMULAIRES[f.dataset.form](f); } catch (err) { console.error(err); toast("Erreur : " + (err.message || err), "alerte"); }
});
/* saisie manuelle ou douchette Bluetooth (qui « tape » le code puis Entrée) */
document.addEventListener("keydown", async e => {
  const el = e.target;
  if (e.key !== "Enter" || !el.classList || !el.classList.contains("saisie-scan")) return;
  e.preventDefault();
  const code = el.value.trim();
  el.value = "";
  if (code) await codeLu(code, el.dataset.contexte);
  const n = document.querySelector(`.saisie-scan[data-contexte="${el.dataset.contexte}"]`);
  if (n) n.focus();
});
$("#sheet").addEventListener("click", e => { if (e.target.id === "sheet") feuilleFermer(); });
window.addEventListener("popstate", () => { if (!retour()) native.quitter(); else history.pushState({}, ""); });
native.surRetour(() => { if (!retour()) native.quitter(); });

/* ---------- verrouillage ---------- */
let enArrierePlanDepuis = null;
const DELAI_VERROU_MS = 2 * 60 * 1000;
async function deverrouiller() {
  if (await native.deverrouiller()) { etat.verrouille = false; render(); }
}
native.surEtat(actif => {
  if (!actif) { enArrierePlanDepuis = Date.now(); return; }
  if (etat.reglages.verrou && enArrierePlanDepuis && Date.now() - enArrierePlanDepuis > DELAI_VERROU_MS) { etat.verrouille = true; render(); deverrouiller(); }
  enArrierePlanDepuis = null;
  /* retour dans l'application : réseau, envoi, nouveautés */
  native.reseauConnecte().then(c => { etat.reseau = c; if (c) { planifierSync(0); rafraichirListe(); } render(); });
});
native.surReseau(c => {
  etat.reseau = c;
  if (c) { etat.joignable = null; etat.sync.echecs = 0; planifierSync(1000); rafraichirListe(); }
  render();
});
native.surNotificationTouchee(id => ouvrirIntervention(id));

/* ---------- démarrage ---------- */
(async function demarrer() {
  if (etat.reglages.verrou && native.isNative) etat.verrouille = true;
  await chargerLocal();
  etat.reseau = await native.reseauConnecte();
  history.replaceState({ ecran: "accueil" }, "");
  history.pushState({ ecran: "accueil" }, "");
  render();
  if (etat.verrouille) await deverrouiller();
  if (etat.session && etat.session.token) {
    await partagerSession();
    rafraichirListe();
    planifierSync(500);
    if (etat.reglages.notifications) native.veille(true);
  }
  maj.autoCheck();
  verifierScanner(false);
  /* vérification régulière application ouverte : envoi en attente, nouveautés */
  setInterval(() => { if (etat.session && etat.session.token && etat.reseau) { rafraichirListe(); if (enAttente().length && !etat.sync.enCours) planifierSync(0); } }, 10 * 60 * 1000);
  setInterval(() => { if (etat.joignable === false && etat.reseau) api.sante().then(ok => { if (ok) { etat.joignable = true; planifierSync(0); render(); } }); }, 30000);
})();
