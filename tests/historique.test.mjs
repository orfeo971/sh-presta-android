/* Historique complet de l'entreprise. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { filtrer, parMois, passee } from "../www/js/historique.js";

const L = [
  { id: 1, date: "2026-11-17T00:00:00.000Z", heure_prevue: "10:00:00", statut: "planifiee", datacenter: "Jarry" },
  { id: 2, date: "2026-11-10T00:00:00.000Z", heure_prevue: "10:00:00", statut: "validee", datacenter: "Jarry", ticket_hebergeur: "TCK-47002" },
  { id: 3, date: "2026-10-02T00:00:00.000Z", heure_prevue: "09:00:00", statut: "annulee", datacenter: "Baie-Mahault" },
  { id: 4, date: "2025-03-05T00:00:00.000Z", heure_prevue: "09:00:00", statut: "validee", datacenter: "Datacenter Jarry" },
  { id: 5, date: "2026-11-12T00:00:00.000Z", heure_prevue: "08:00:00", statut: "en_cours", datacenter: "Jarry" }
];
const auj = "2026-11-17";

test("tout l'historique, sans limite de durée, du plus récent au plus ancien", () => {
  assert.deepEqual(filtrer(L, { aujourdhui: auj }).map(i => i.id), [2, 3, 4]);
  assert.equal(passee(L[4]), false, "intervention ouverte, même en retard : reste sur l'accueil");
});

test("filtre par statut et recherche (accents et casse ignorés)", () => {
  assert.deepEqual(filtrer(L, { aujourdhui: auj, filtre: "cloturees" }).map(i => i.id), [2, 4]);
  assert.deepEqual(filtrer(L, { aujourdhui: auj, recherche: "baie mahault" }).map(i => i.id), [3]);
  assert.deepEqual(filtrer(L, { aujourdhui: auj, recherche: "tck-47002" }).map(i => i.id), [2]);
  assert.deepEqual(filtrer(L, { aujourdhui: auj, recherche: "2025-03" }).map(i => i.id), [4]);
});

test("regroupement par mois", () => {
  assert.deepEqual(parMois(filtrer(L, { aujourdhui: auj })).map(g => [g.mois, g.interventions.length]), [["novembre 2026", 1], ["octobre 2026", 1], ["mars 2025", 1]]);
});
