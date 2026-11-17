/* Chargement de la bandothèque TS4300, adapté au téléphone.

   Sur le site web, l'opérateur glisse les cartouches d'un magasin à l'autre. Sur le téléphone, il touche :
   une cartouche (ou la scanne), puis l'emplacement. Les gestes forment un brouillon, conservé sur le
   téléphone, qui ne devient des mouvements qu'au moment de « Valider le chargement » — exactement comme
   sur le site web : retraits d'abord (un emplacement échangé doit être libéré avant d'être réoccupé),
   puis installations.

   Brouillon : { installs: [[idEmplacement, idCartouche], …], retraits: [idEmplacement, …] } */

import { aInstaller, retireesReinstallables } from "./regles.js";

export const MAGASINS = { ts4300_magasin1: "Magasin de gauche", ts4300_magasin2: "Magasin de droite" };
export const LIGNES = 5;

export const brouillonVide = () => ({ installs: [], retraits: [] });
const copie = b => ({ installs: b.installs.map(x => [...x]), retraits: [...b.retraits] });

const emplacement = (v, id) => v.emplacements.find(e => e.id === id) || null;
const poseSur = (b, empId) => (b.installs.find(([e]) => e === empId) || [])[1] ?? null;
const empDePose = (b, cid) => (b.installs.find(([, c]) => c === cid) || [])[0] ?? null;

/** Emplacement disponible pour une installation : vide (ou en cours de retrait) et pas déjà réservé. */
export function libre(v, b, empId) {
  const e = emplacement(v, empId);
  if (!e) return false;
  if (poseSur(b, empId) != null) return false;
  return !e.cartouche_id || b.retraits.includes(empId);
}

/** Cartouches à placer : récupérées au siège (et retirées réinstallables), pas encore posées dans le brouillon. */
export function plateau(v, b) {
  const posees = new Set(b.installs.map(([, c]) => c));
  const prevues = aInstaller(v).map(m => ({ id: m.cartouche_id, reference: m.cartouche_reference, cibleId: m.emplacement_prevu_id, cibleCode: m.emplacement_prevu_code, cibleMagasin: m.emplacement_prevu_type, retiree: false }));
  const retirees = retireesReinstallables(v).map(c => ({ id: c.cartouche_id, reference: c.cartouche_reference, cibleId: null, cibleCode: null, retiree: true }));
  return [...prevues, ...retirees].filter(c => !posees.has(c.id));
}

/** Référence d'une cartouche connue de la vue (plateau, magasins, à restituer). */
export function referenceDe(v, cid) {
  const e = v.emplacements.find(x => x.cartouche_id === cid);
  if (e) return e.cartouche_reference;
  const m = v.materielPrevu.find(x => x.cartouche_id === cid);
  if (m) return m.cartouche_reference;
  const r = v.aRestituer.find(x => x.cartouche_id === cid);
  return r ? r.cartouche_reference : String(cid);
}

/** Pose une cartouche sur un emplacement libre (une cartouche n'est posée qu'à un seul endroit). */
export function poser(v, b, cid, empId) {
  if (!libre(v, b, empId)) return { ok: false, erreur: "Emplacement occupé" };
  const n = copie(b);
  n.installs = n.installs.filter(([, c]) => c !== cid);
  n.installs.push([empId, cid]);
  return { ok: true, brouillon: n };
}

/** Marque la cartouche d'un emplacement comme à retirer (elle partira au siège, ou sera reposée ailleurs). */
export function retirer(v, b, empId) {
  const e = emplacement(v, empId);
  if (!e || !e.cartouche_id) return { ok: false, erreur: "Emplacement vide" };
  if (b.retraits.includes(empId)) return { ok: true, brouillon: b };
  const n = copie(b);
  n.retraits.push(empId);
  return { ok: true, brouillon: n };
}

/** Déplace la cartouche d'un emplacement vers un autre emplacement libre (retrait puis installation). */
export function deplacer(v, b, source, cible) {
  const e = emplacement(v, source);
  if (!e || !e.cartouche_id) return { ok: false, erreur: "Emplacement vide" };
  if (source === cible) return { ok: false, erreur: "Même emplacement" };
  const r = retirer(v, b, source);
  const p = poser(v, r.brouillon, e.cartouche_id, cible);
  return p.ok ? p : { ok: false, erreur: p.erreur };
}

/** Annule ce qui est prévu sur un emplacement (pose et/ou retrait), avec ce qui en dépend. */
export function annuler(v, b, empId) {
  const n = copie(b);
  n.installs = n.installs.filter(([e]) => e !== empId);
  if (n.retraits.includes(empId)) {
    n.retraits = n.retraits.filter(e => e !== empId);
    /* la cartouche de cet emplacement reste en place : un déplacement prévu ailleurs n'a plus lieu */
    const e = emplacement(v, empId);
    if (e && e.cartouche_id) n.installs = n.installs.filter(([, c]) => c !== e.cartouche_id);
    /* une cartouche posée « par-dessus » (échange) n'a plus de place */
    n.installs = n.installs.filter(([emp]) => libre(v, { installs: [], retraits: n.retraits }, emp));
  }
  return n;
}

/** Place en un geste chaque cartouche du plateau sur l'emplacement planifié par l'administrateur, s'il est libre. */
export function placerSelonPlan(v, b) {
  let n = copie(b);
  let places = 0;
  for (const c of plateau(v, n)) {
    if (!c.cibleId || !libre(v, n, c.cibleId)) continue;
    n = poser(v, n, c.id, c.cibleId).brouillon;
    places++;
  }
  return { brouillon: n, places };
}

/** État de chaque emplacement d'un magasin, pour l'affichage. */
export function cases(v, b, magasin) {
  const cibles = new Map(plateau(v, b).filter(c => c.cibleId).map(c => [c.cibleId, c.reference]));
  const retraitsPrevus = new Set(v.retraitsPrevus.map(r => r.cartouche_id));
  return v.emplacements.filter(e => e.type === magasin).map(e => {
    const pose = poseSur(b, e.id);
    const retrait = b.retraits.includes(e.id);
    return {
      id: e.id, code: e.code_emplacement,
      occupant: e.cartouche_reference || null, occupantId: e.cartouche_id || null,
      pose: pose != null ? referenceDe(v, pose) : null,
      retrait,
      cible: cibles.get(e.id) || null,
      retraitPrevu: !!(e.cartouche_id && retraitsPrevus.has(e.cartouche_id) && !retrait),
      attente: !!e._attente
    };
  });
}

/** Grille physique : colonnes remplies de bas en haut (SLOT-01 en bas à gauche), comme sur le site web. */
export function colonnesBasEnHaut(items, lignes = LIGNES) {
  const reste = items.length % lignes;
  const complet = reste === 0 ? [...items] : [...items, ...Array(lignes - reste).fill(null)];
  const colonnes = [];
  for (let i = 0; i < complet.length; i += lignes) colonnes.push(complet.slice(i, i + lignes));
  return colonnes.map(c => [...c].reverse()).flat();
}

/** Mouvements à envoyer pour le brouillon : retraits d'abord, puis installations. */
export function versMouvements(v, b, interventionId) {
  const m = [];
  for (const empId of b.retraits) {
    const e = emplacement(v, empId);
    if (!e || !e.cartouche_id) continue;
    m.push({ interventionId, sens: "retrait", cartoucheId: e.cartouche_id, reference: e.cartouche_reference, code: e.code_emplacement });
  }
  for (const [empId, cid] of b.installs) {
    const e = emplacement(v, empId);
    if (!e) continue;
    m.push({ interventionId, sens: "installation", cartoucheId: cid, emplacementId: empId, reference: referenceDe(v, cid), code: e.code_emplacement + (e.type === "ts4300_magasin2" ? " (droite)" : " (gauche)") });
  }
  return m;
}

/** Brouillon encore applicable à la vue (après une synchronisation, des emplacements ont pu changer). */
export function nettoyer(v, b) {
  if (!b) return brouillonVide();
  const n = { installs: [], retraits: b.retraits.filter(id => { const e = emplacement(v, id); return e && e.cartouche_id; }) };
  for (const [e, c] of b.installs) if (libre(v, n, e)) n.installs.push([e, c]);
  return n;
}

export const brouillonVidePour = b => !b || (b.installs.length === 0 && b.retraits.length === 0);
export { empDePose };
