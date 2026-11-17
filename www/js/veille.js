/* Notifications des interventions attribuées, planifiées, déplacées ou annulées.

   La liste des interventions déjà connues est partagée avec la vérification en arrière-plan
   (android/…/VeilleService.java, même règle) dans la préférence « veille.connues » :
   { "12": "planifiee|2026-11-23|10:00", … }. Une même nouveauté n'est donc notifiée qu'une fois,
   qu'elle soit vue application ouverte ou fermée. Lors de la toute première vérification, rien n'est
   notifié : on mémorise seulement l'existant. */

import { jourDe, heureDe } from "./format.js";

const OUVERTS = new Set(["creee", "planifiee", "en_cours"]);

export const signature = it => `${it.statut || ""}|${jourDe(it.date)}|${heureDe(it.heure_prevue)}`;

/** Même règle que VeilleService.titrePour(). */
export function titreNotification(avant, statut, jour, heure) {
  const ouverte = OUVERTS.has(statut);
  if (avant == null) return ouverte ? "Nouvelle intervention" : null;
  const [aStatut = "", aJour = "", aHeure = ""] = String(avant).split("|");
  if (aStatut !== statut) {
    if (statut === "annulee") return "Intervention annulée";
    if (statut === "planifiee") return "Intervention planifiée : matériel prêt";
    return null;
  }
  if (ouverte && (aJour !== jour || aHeure !== heure)) return "Intervention déplacée";
  return null;
}

const jourCourt = j => (j.length === 10 ? `${j.slice(8, 10)}/${j.slice(5, 7)}` : j);

/**
 * Compare la liste reçue du serveur aux interventions connues.
 * Renvoie { connues (à enregistrer), notifications: [{ id, titre, texte }] }.
 */
export function comparer(liste, connues) {
  const nouvelles = {};
  const notifications = [];
  for (const it of liste || []) {
    const id = String(it.id), jour = jourDe(it.date), heure = heureDe(it.heure_prevue);
    nouvelles[id] = signature(it);
    if (connues == null) continue;
    const titre = titreNotification(connues[id], it.statut || "", jour, heure);
    if (titre) notifications.push({ id: Number(it.id), titre, texte: jourCourt(jour) + (heure ? " à " + heure : "") + (it.datacenter ? " · " + it.datacenter : "") });
  }
  return { connues: nouvelles, notifications };
}
