/* Règles du terrain, identiques à celles du serveur SH Presta (backend/src/modules/etapes-terrain/routes.ts).
   Elles servent à guider l'opérateur et à ne proposer que des validations que le serveur acceptera :
   le serveur reste juge, une action refusée apparaît dans « Actions refusées ».
   Toutes les fonctions travaillent sur la « vue » d'une intervention : le dossier terrain reçu du serveur,
   auquel sont appliquées les actions encore en attente d'envoi (voir optimiste.js). */

export const STATUTS = {
  creee: "Créée",
  planifiee: "Planifiée",
  en_cours: "En cours",
  terminee: "Terminée",
  validee: "Clôturée",
  annulee: "Annulée"
};
export const STATUT_TON = { creee: "neutre", planifiee: "info", en_cours: "actif", terminee: "ok", validee: "ok", annulee: "alerte" };
export const ORDRE_STATUTS = ["creee", "planifiee", "en_cours", "terminee", "validee"];

export const ETAPES = {
  depart_siege: "Récupération au siège",
  arrivee_datacenter: "Arrivée au datacenter",
  intervention: "Passage au datacenter",
  retour_siege: "Retour au siège",
  chargement_ts4300: "Cartouches TS4300",
  verification_visuelle: "Contrôles visuels",
  anomalies_ponctuelles: "Opération ponctuelle"
};
export const SOUS_ETAPES = ["chargement_ts4300", "verification_visuelle", "anomalies_ponctuelles"];

export const VOYANTS = { jaune: "Jaune", orange: "Orange", rouge: "Rouge" };
export const PRIORITES = { basse: "Basse", moyenne: "Moyenne", haute: "Haute", critique: "Critique" };
export const STATUTS_ANOMALIE = { ouverte: "Ouverte", analyse: "En analyse", cloturee: "Clôturée" };

/**
 * Arrivée au datacenter : le clic « Je suis arrivé au datacenter » ; à défaut (intervention commencée
 * avant ce bouton, saisie depuis le site), le premier geste fait sur place. Même règle que le serveur
 * (ARRIVEE_EXPR). Renvoie { le: ISO, clic: bool } ou null.
 */
export function arriveeAuDatacenter(v) {
  const clic = etapeDe(v, "arrivee_datacenter");
  if (clic) return { le: clic.valide_le, clic: true };
  const gestes = [
    ...v.mouvements.map(m => m.horodatage),
    ...v.controles.signalements.map(s => s.created_at),
    ...v.anomalies.map(a => a.created_at),
    ...v.materielPonctuel.map(m => m.utilise_le),
    ...v.etapes.filter(e => [...SOUS_ETAPES, "intervention"].includes(e.etape)).map(e => e.valide_le)
  ].filter(Boolean).map(d => Date.parse(d)).filter(t => !Number.isNaN(t));
  return gestes.length ? { le: new Date(Math.min(...gestes)).toISOString(), clic: false } : null;
}

/** Faut-il d'abord signaler l'arrivée ? Pas pour une intervention déjà commencée sur place sans ce bouton. */
export const arriveeRequise = v =>
  !etapeValidee(v, "arrivee_datacenter") && !etapeValidee(v, "intervention") && !SOUS_ETAPES.some(e => etapeValidee(v, e));

/** Rien à récupérer au siège : l'étape 1 ne s'applique pas. */
export const departApplicable = i => !!(i.inclut_cartouches || i.ponctuelle_materiel_a_recuperer);
/**
 * Y a-t-il réellement quelque chose à ramener au siège (étape 3) ? Même règle que le serveur
 * (etapes-terrain/routes.ts, retourNecessaire) : du matériel ponctuel à ramener, ou des cartouches
 * retirées de la TS4300 ou récupérées au siège et jamais chargées. « inclut_cartouches » seul ne
 * suffit pas : une intervention qui n'a fait qu'installer des cartouches n'a rien à ramener. Tant
 * que le chargement n'est pas validé, les retraits ne sont pas connus : l'étape reste prévue.
 */
export function retourNecessaire(v) {
  const i = v.intervention;
  if (i.ponctuelle_materiel_a_ramener) return true;
  if (!i.inclut_cartouches) return false;
  if (!etapeValidee(v, "chargement_ts4300") && !etapeValidee(v, "intervention")) return true;
  return v.aRestituer.length > 0;
}

export function sousEtapesRequises(i) {
  return SOUS_ETAPES.filter(e => (e === "chargement_ts4300" ? i.inclut_cartouches : e === "verification_visuelle" ? i.inclut_verification : i.inclut_anomalies_ponctuelles));
}

export const etapeValidee = (v, cle) => v.etapes.some(e => e.etape === cle);
export const etapeDe = (v, cle) => v.etapes.find(e => e.etape === cle) || null;
/** Clôturée ou annulée : plus aucune modification possible. */
export const figee = v => v.intervention.statut === "validee" || v.intervention.statut === "annulee";

/** Cartouches prêtes à être installées dans la TS4300 : récupérées au siège (étape 1 validée), encore en transit. */
export function aInstaller(v) {
  if (!etapeValidee(v, "depart_siege")) return [];
  return v.materielPrevu.filter(m => m.recupere_le && m.cartouche_etat === "transit");
}

/** Cartouches retirées pendant cette intervention et encore en transit : elles peuvent être réinstallées. */
export function retireesReinstallables(v) {
  const prevues = new Set(v.materielPrevu.map(m => m.cartouche_id));
  return v.aRestituer.filter(c => c.cartouche_etat === "transit" && !prevues.has(c.cartouche_id));
}

const plur = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;

/** Ce qui empêche encore de valider une étape, en phrases courtes (liste vide : validable). */
export function bloquants(v, cle) {
  const i = v.intervention;
  const b = [];
  if (figee(v)) return ["Intervention " + (i.statut === "annulee" ? "annulée" : "clôturée")];
  if (cle === "depart_siege") {
    if (i.statut === "creee") b.push("Le matériel n'a pas encore été mis à disposition au siège");
    const c = v.materielPrevu.filter(m => !m.recupere_le).length;
    const p = v.materielPonctuel.filter(m => m.a_recuperer && !m.recupere_le).length;
    if (c) b.push(plur(c, "cartouche") + " à récupérer");
    if (p) b.push(plur(p, "élément") + " de matériel à récupérer");
    return b;
  }
  const departOk = !departApplicable(i) || etapeValidee(v, "depart_siege");
  if (cle === "intervention" || SOUS_ETAPES.includes(cle)) {
    if (!departOk) b.push("Valider d'abord la récupération au siège");
    else if (arriveeRequise(v)) b.push("Signaler d'abord votre arrivée au datacenter");
  }
  if (cle === "chargement_ts4300") return b;
  if (cle === "verification_visuelle") {
    if (!v.controles.rienASignaler && v.controles.signalements.length === 0) b.push("Cocher « Rien à signaler » ou ajouter un signalement");
    return b;
  }
  if (cle === "anomalies_ponctuelles") {
    if (i.ponctuelle_materiel_a_recuperer) {
      const n = v.materielPonctuel.filter(m => m.recupere_le && !m.utilise_le).length;
      if (n) b.push(plur(n, "élément") + " récupéré" + (n > 1 ? "s" : "") + " à pointer comme utilisé" + (n > 1 ? "s" : ""));
    }
    return b;
  }
  if (cle === "intervention") {
    if (!i.ticket_hebergeur) b.push("Aucun ticket hébergeur : à demander à l'administrateur");
    const manquantes = sousEtapesRequises(i).filter(e => !etapeValidee(v, e));
    if (manquantes.length) b.push("À valider : " + manquantes.map(e => ETAPES[e]).join(", "));
    return b;
  }
  if (cle === "retour_siege") {
    if (!etapeValidee(v, "intervention")) b.push("Valider d'abord le passage au datacenter");
    const c = v.aRestituer.filter(x => x.cartouche_etat === "transit").length;
    const p = i.ponctuelle_materiel_a_ramener ? v.materielPonctuel.filter(m => m.a_ramener && !m.restitue_le).length : 0;
    if (c) b.push(plur(c, "cartouche") + " à restituer");
    if (p) b.push(plur(p, "élément") + " de matériel à restituer");
    return b;
  }
  return b;
}

/**
 * Les trois étapes de l'intervention, dans l'ordre, pour l'affichage :
 * applicable, validée (et quand), accessible (l'étape précédente est faite), bloquants.
 */
export function etapes(v) {
  const i = v.intervention;
  const liste = [];
  const departOk = !departApplicable(i) || etapeValidee(v, "depart_siege");
  liste.push({ cle: "depart_siege", numero: 1, applicable: departApplicable(i), accessible: i.statut !== "creee" || etapeValidee(v, "depart_siege") });
  liste.push({ cle: "intervention", numero: 2, applicable: true, accessible: departOk });
  liste.push({ cle: "retour_siege", numero: 3, applicable: retourNecessaire(v) || etapeValidee(v, "retour_siege"), accessible: etapeValidee(v, "intervention") });
  return liste.map(e => {
    const et = etapeDe(v, e.cle);
    return { ...e, titre: ETAPES[e.cle], validee: !!et, valideLe: et ? et.valide_le : null, enAttente: !!(et && et._attente), bloquants: bloquants(v, e.cle) };
  });
}

/** L'étape sur laquelle l'opérateur doit travailler maintenant (la première applicable non validée). */
export function etapeCourante(v) {
  const e = etapes(v).find(x => x.applicable && !x.validee);
  return e ? e.cle : null;
}

/** Avancement global en pourcentage (étapes applicables validées), pour la liste des interventions. */
export function avancement(v) {
  const e = etapes(v).filter(x => x.applicable);
  return e.length ? Math.round((e.filter(x => x.validee).length / e.length) * 100) : 0;
}

/** Statut atteint après la validation d'une étape (comme advanceStatutTo côté serveur). */
export function statutApres(v, etape) {
  const i = v.intervention;
  const vers = (cible) => (ORDRE_STATUTS.indexOf(cible) > ORDRE_STATUTS.indexOf(i.statut) ? cible : i.statut);
  if (i.statut === "annulee") return i.statut;
  if (etape === "depart_siege" || etape === "arrivee_datacenter") return vers("en_cours");
  if (etape === "intervention") return retourNecessaire(v) ? vers("en_cours") : vers("terminee");
  if (etape === "retour_siege") return vers("terminee");
  return i.statut;
}
