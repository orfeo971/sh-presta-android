/* Vue d'une intervention = dossier terrain reçu du serveur + actions encore en attente d'envoi.

   Au datacenter, sans réseau, l'opérateur doit voir immédiatement le résultat de ses gestes : cartouche
   cochée, emplacement occupé, signalement ajouté, étape validée… Cette fonction rejoue sur une copie du
   dossier les actions en attente, avec les mêmes effets que le serveur. Les éléments ainsi modifiés portent
   `_attente: true` (affichés « en attente d'envoi »). Les actions refusées par le serveur ne sont pas
   rejouées : la vue reflète alors ce que le serveur a réellement.

   Les listes dérivées (cartouches à restituer, état des cartouches prévues, occupants des emplacements)
   sont recalculées à partir de l'état de chaque cartouche, comme les requêtes SQL du serveur. */

import { statutApres } from "./regles.js";

const copie = o => JSON.parse(JSON.stringify(o));

export function appliquer(dossier, actions = []) {
  const v = copie(dossier);
  const id = Number(v.intervention.id);
  const miennes = actions.filter(a => a.etat !== "rejetee" && Number(a.interventionId) === id);

  /* état de chaque cartouche connue du dossier */
  const cartouches = new Map();
  const connaitre = (cid, ref, etat) => { if (cid == null) return; const c = cartouches.get(cid); if (!c) cartouches.set(cid, { reference: ref, etat }); else { if (ref) c.reference = ref; if (etat) c.etat = etat; } };
  for (const e of v.emplacements) if (e.cartouche_id) connaitre(e.cartouche_id, e.cartouche_reference, e.cartouche_etat || "ts4300");
  for (const c of v.aRestituer) connaitre(c.cartouche_id, c.cartouche_reference, c.cartouche_etat);
  for (const m of v.materielPrevu) connaitre(m.cartouche_id, m.cartouche_reference, m.cartouche_etat);
  const retirees = new Set(v.mouvements.filter(m => m.type === "retrait").map(m => m.cartouche_id));
  const changees = new Set();
  const etat = (cid, e) => { connaitre(cid, null, e); cartouches.get(cid).etat = e; changees.add(cid); };

  for (const a of miennes) {
    const p = a.params;
    switch (a.type) {
      case "recuperer_cartouche": {
        const m = v.materielPrevu.find(x => x.cartouche_id === p.cartoucheId);
        if (!m) break;
        if (p.recupere) { m.recupere_le = a.realiseLe; etat(p.cartoucheId, "transit"); }
        else { m.recupere_le = null; if (cartouches.get(p.cartoucheId)?.etat === "transit") etat(p.cartoucheId, "preparee"); }
        m._attente = true;
        break;
      }
      case "ponctuel": {
        const m = v.materielPonctuel.find(x => x.id === p.itemId);
        if (!m) break;
        m[{ recuperer: "recupere_le", utiliser: "utilise_le", restituer: "restitue_le" }[p.quoi]] = p.fait ? a.realiseLe : null;
        m._attente = true;
        break;
      }
      case "mouvement": {
        if (p.sens === "retrait") {
          for (const e of v.emplacements) if (e.cartouche_id === p.cartoucheId) { e.cartouche_id = null; e.cartouche_reference = null; e.cartouche_etat = null; e._attente = true; }
          connaitre(p.cartoucheId, p.reference, null);
          etat(p.cartoucheId, "transit");
          retirees.add(p.cartoucheId);
        } else {
          for (const e of v.emplacements) if (e.cartouche_id === p.cartoucheId) { e.cartouche_id = null; e.cartouche_reference = null; e.cartouche_etat = null; e._attente = true; }
          const e = v.emplacements.find(x => x.id === p.emplacementId);
          connaitre(p.cartoucheId, p.reference, null);
          if (e) { e.cartouche_id = p.cartoucheId; e.cartouche_reference = cartouches.get(p.cartoucheId).reference; e.cartouche_etat = "ts4300"; e._attente = true; }
          etat(p.cartoucheId, "ts4300");
        }
        v.mouvements.push({ id: a.id, cartouche_id: p.cartoucheId, cartouche_reference: p.reference, type: p.sens, emplacement_ts4300: p.code || null, horodatage: a.realiseLe, _attente: true });
        break;
      }
      case "restituer_cartouche": {
        const c = cartouches.get(p.cartoucheId);
        if (!c) break;
        if (p.restitue && c.etat === "transit") etat(p.cartoucheId, "a_ranger");
        else if (!p.restitue && c.etat === "a_ranger") etat(p.cartoucheId, "transit");
        break;
      }
      case "signalement":
        v.controles.signalements.push({ id: p.localId, element: p.element, voyant: p.voyant, baie: p.baie || null, commentaire: p.commentaire || null, created_at: a.realiseLe, _attente: true });
        v.controles.rienASignaler = false;
        break;
      case "retirer_signalement":
        v.controles.signalements = v.controles.signalements.filter(s => s.id !== p.signalementId);
        break;
      case "rien_a_signaler":
        v.controles.rienASignaler = p.valeur;
        v.controles._attente = true;
        break;
      case "anomalie":
        v.anomalies.unshift({ id: p.localId, type: p.typeAnomalie, description: p.description, priorite: p.priorite, statut: "ouverte", created_at: a.realiseLe, pieces_jointes: [], _attente: true });
        break;
      case "photo": {
        const an = v.anomalies.find(x => x.id === p.anomalieId);
        if (an) an.pieces_jointes.push({ id: p.photoId, locale: true, _attente: true });
        break;
      }
      case "valider_etape": {
        v.etapes = v.etapes.filter(e => e.etape !== p.etape);
        v.etapes.push({ etape: p.etape, valide_le: a.realiseLe, donnees: {}, _attente: true });
        v.intervention.statut = statutApres(v.intervention, p.etape);
        break;
      }
    }
  }

  /* listes dérivées, comme les requêtes du serveur */
  for (const m of v.materielPrevu) {
    const c = cartouches.get(m.cartouche_id);
    if (c && c.etat !== m.cartouche_etat) { m.cartouche_etat = c.etat; m._attente = true; }
  }
  for (const e of v.emplacements) if (e.cartouche_id && cartouches.get(e.cartouche_id)) e.cartouche_etat = cartouches.get(e.cartouche_id).etat;
  const concernees = new Set([...retirees, ...v.materielPrevu.filter(m => m.recupere_le).map(m => m.cartouche_id)]);
  v.aRestituer = [...concernees]
    .filter(cid => cartouches.has(cid) && ["transit", "a_ranger"].includes(cartouches.get(cid).etat))
    .map(cid => ({ cartouche_id: cid, cartouche_reference: cartouches.get(cid).reference, cartouche_etat: cartouches.get(cid).etat, ...(changees.has(cid) ? { _attente: true } : {}) }))
    .sort((a, b) => String(a.cartouche_reference).localeCompare(String(b.cartouche_reference)));

  v.enAttente = miennes.length;
  return v;
}
