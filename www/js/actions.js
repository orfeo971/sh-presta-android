/* Actions de terrain : chaque geste de l'opérateur devient une action enregistrée sur le téléphone,
   puis envoyée au serveur (immédiatement si le réseau est là, sinon plus tard, dans l'ordre).

   Une action porte :
   - id : identifiant unique, envoyé dans l'en-tête Idempotency-Key (le serveur ne l'applique jamais deux fois) ;
   - realiseLe : moment réel du geste, envoyé dans l'en-tête X-Realise-Le ;
   - type et params : ce qu'il faut faire, d'où l'on construit la requête au moment de l'envoi ;
   - label : description lisible (bandeau « actions en attente ») ;
   - etat : « attente » ou « rejetee » (refusée par le serveur, avec le message d'erreur).

   Les créations (signalement, anomalie) reçoivent un identifiant local « l-… ». Une action qui en dépend
   (photo d'une anomalie pas encore envoyée, retrait d'un signalement) s'y réfère ; l'identifiant serveur
   est connu après l'envoi (table des correspondances). */

export function nouvelId() {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : null;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const o = new Uint8Array(16);
  if (c && c.getRandomValues) c.getRandomValues(o);
  else for (let k = 0; k < 16; k++) o[k] = Math.floor(Math.random() * 256);
  o[6] = (o[6] & 0x0f) | 0x40; o[8] = (o[8] & 0x3f) | 0x80;
  const h = Array.from(o, x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const idLocal = () => "l-" + nouvelId();
export const estLocal = id => typeof id === "string" && id.startsWith("l-");

const base = i => `/interventions/${i}`;

/** Description de chaque type d'action : requête à envoyer et libellé. */
export const TYPES = {
  recuperer_cartouche: {
    requete: p => ({ method: "PATCH", url: `${base(p.interventionId)}/materiel-prevu/${p.cartoucheId}/recuperer`, body: { recupere: p.recupere } }),
    label: p => (p.recupere ? "Récupération " : "Annulation de la récupération ") + p.reference
  },
  ponctuel: {
    requete: p => ({ method: "PATCH", url: `${base(p.interventionId)}/materiel-ponctuel/${p.itemId}/${p.quoi}`, body: { [{ recuperer: "recupere", utiliser: "utilise", restituer: "restitue" }[p.quoi]]: p.fait } }),
    label: p => `${p.fait ? "" : "Annulation : "}${{ recuperer: "récupéré", utiliser: "utilisé", restituer: "restitué" }[p.quoi]} — ${p.intitule}`
  },
  mouvement: {
    requete: p => ({ method: "POST", url: `${base(p.interventionId)}/mouvements`, body: p.sens === "installation" ? { cartouche_id: p.cartoucheId, type: "installation", emplacement_id: p.emplacementId } : { cartouche_id: p.cartoucheId, type: "retrait" } }),
    label: p => (p.sens === "installation" ? `Installation ${p.reference} en ${p.code}` : `Retrait ${p.reference}`)
  },
  restituer_cartouche: {
    requete: p => ({ method: "PATCH", url: `${base(p.interventionId)}/mouvements/${p.cartoucheId}/restituer`, body: { restitue: p.restitue } }),
    label: p => (p.restitue ? "Restitution " : "Annulation de la restitution ") + p.reference
  },
  signalement: {
    requete: p => ({ method: "POST", url: `${base(p.interventionId)}/controles`, body: { element: p.element, voyant: p.voyant, ...(p.baie ? { baie: p.baie } : {}), ...(p.commentaire ? { commentaire: p.commentaire } : {}) } }),
    label: p => `Signalement : ${p.element} (voyant ${p.voyant})`,
    cree: p => p.localId
  },
  retirer_signalement: {
    requete: (p, ids) => ({ method: "DELETE", url: `${base(p.interventionId)}/controles/${ids(p.signalementId)}` }),
    label: p => `Retrait du signalement ${p.element || ""}`.trim(),
    depend: p => [p.signalementId]
  },
  rien_a_signaler: {
    requete: p => ({ method: "PATCH", url: `${base(p.interventionId)}/controles/rien-a-signaler`, body: { rienASignaler: p.valeur } }),
    label: p => (p.valeur ? "Rien à signaler" : "Annulation de « Rien à signaler »")
  },
  anomalie: {
    requete: p => ({ method: "POST", url: `${base(p.interventionId)}/anomalies`, body: { type: p.typeAnomalie, description: p.description, priorite: p.priorite } }),
    label: p => `Anomalie : ${p.typeAnomalie}`,
    cree: p => p.localId
  },
  photo: {
    requete: (p, ids) => ({ method: "POST", url: `/anomalies/${ids(p.anomalieId)}/pieces-jointes`, fichier: p.photoId }),
    label: p => `Photo de l'anomalie ${p.typeAnomalie || ""}`.trim(),
    depend: p => [p.anomalieId]
  },
  valider_etape: {
    requete: p => ({ method: "PUT", url: `${base(p.interventionId)}/etapes/${p.etape}`, body: { donnees: { source: "application" } } }),
    label: p => `Validation : ${p.titre || p.etape}`
  }
};

/** Crée une action prête à être enregistrée. */
export function creer(type, params, maintenant = new Date()) {
  const t = TYPES[type];
  if (!t) throw new Error("Type d'action inconnu : " + type);
  return { id: nouvelId(), type, interventionId: params.interventionId, params, label: t.label(params), realiseLe: maintenant.toISOString(), etat: "attente" };
}

/** Identifiants locaux dont l'action a besoin (créations pas encore envoyées). */
export function dependances(action) {
  const t = TYPES[action.type];
  return t.depend ? t.depend(action.params).filter(estLocal) : [];
}

/** Identifiant local créé par l'action (signalement, anomalie), ou null. */
export const creation = action => (TYPES[action.type].cree ? TYPES[action.type].cree(action.params) : null);

/**
 * Requête HTTP à envoyer pour une action. `correspondances` : identifiant local → identifiant serveur.
 * Renvoie null si une création dont elle dépend n'a pas encore d'identifiant serveur.
 */
export function requete(action, correspondances = {}) {
  for (const d of dependances(action)) if (correspondances[d] == null) return null;
  const ids = id => (estLocal(id) ? correspondances[id] : id);
  const r = TYPES[action.type].requete(action.params, ids);
  return { ...r, headers: { "Idempotency-Key": action.id, "X-Realise-Le": action.realiseLe } };
}
