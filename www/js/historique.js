/* Historique complet des interventions de l'entreprise prestataire (tous intervenants confondus,
   sans limite de durée) : recherche, filtre par statut, regroupement par mois. */
import { jourDe } from "./format.js";

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export const FILTRES = {
  toutes: { libelle: "Toutes", garde: () => true },
  terminees: { libelle: "Terminées", garde: i => i.statut === "terminee" },
  cloturees: { libelle: "Clôturées", garde: i => i.statut === "validee" },
  annulees: { libelle: "Annulées", garde: i => i.statut === "annulee" }
};

/** Interventions passées : terminées, clôturées ou annulées. Une intervention encore ouverte reste
    sur l'écran d'accueil. */
export const passee = i => ["terminee", "validee", "annulee"].includes(i.statut);

const normaliser = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Filtre par statut et par texte (datacenter, ticket, numéro, consignes, opération). */
export function filtrer(liste, { aujourdhui, filtre = "toutes", recherche = "" }) {
  const mots = normaliser(recherche).split(/\s+/).filter(Boolean);
  const garde = (FILTRES[filtre] || FILTRES.toutes).garde;
  return (liste || [])
    .filter(i => passee(i) && garde(i))
    .filter(i => {
      if (!mots.length) return true;
      const texte = normaliser([i.datacenter, i.ticket_hebergeur, "#" + i.id, i.id, i.commentaires, i.operation_ponctuelle_intitule, jourDe(i.date)].join(" "));
      return mots.every(m => texte.includes(m));
    })
    .sort((a, b) => (jourDe(b.date) + (b.heure_prevue || "")).localeCompare(jourDe(a.date) + (a.heure_prevue || "")));
}

/** Regroupe une liste triée par mois : [{ mois: "novembre 2026", interventions: [...] }]. */
export function parMois(liste) {
  const groupes = [];
  for (const i of liste) {
    const j = jourDe(i.date);
    const mois = j ? `${MOIS[Number(j.slice(5, 7)) - 1]} ${j.slice(0, 4)}` : "Date inconnue";
    const g = groupes[groupes.length - 1];
    if (g && g.mois === mois) g.interventions.push(i); else groupes.push({ mois, interventions: [i] });
  }
  return groupes;
}
