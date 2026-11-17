/* File d'envoi : ordre, coupures réseau, session expirée, refus du serveur, dépendances. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { creer } from "../www/js/actions.js";
import { synchroniser, annulerCreation, delaiNouvelEssai, ARRET } from "../www/js/file.js";

function depotMemoire(actions) {
  let liste = actions.map(a => ({ ...a }));
  const corr = {};
  return {
    liste: () => liste,
    lister: async () => liste.map(a => ({ ...a })),
    modifier: async a => { liste = liste.map(x => (x.id === a.id ? { ...a } : x)); },
    retirer: async id => { liste = liste.filter(x => x.id !== id); },
    correspondances: async () => ({ ...corr }),
    associer: async (l, s) => { corr[l] = s; },
    corr
  };
}
const I = 1;
const recup = n => creer("recuperer_cartouche", { interventionId: I, cartoucheId: n, recupere: true, reference: "C" + n });

test("tout part dans l'ordre", async () => {
  const d = depotMemoire([recup(1), recup(2), recup(3)]);
  const vus = [];
  const b = await synchroniser({ depot: d, envoyer: async r => { vus.push(r.url); return { status: 200, data: {} }; }, renouveler: async () => true });
  assert.equal(b.envoyees, 3);
  assert.equal(b.arret, null);
  assert.deepEqual(vus.map(u => u.split("/")[4]), ["1", "2", "3"]);
  assert.equal(d.liste().length, 0);
});

test("coupure réseau : arrêt sans rien perdre, reprise ensuite", async () => {
  const d = depotMemoire([recup(1), recup(2)]);
  let n = 0;
  const b = await synchroniser({ depot: d, envoyer: async () => { if (++n === 2) throw { reseau: true }; return { status: 200, data: {} }; }, renouveler: async () => true });
  assert.equal(b.envoyees, 1);
  assert.equal(b.arret, ARRET.RESEAU);
  assert.equal(d.liste().length, 1);
  const b2 = await synchroniser({ depot: d, envoyer: async () => ({ status: 200, data: {} }), renouveler: async () => true });
  assert.equal(b2.envoyees, 1);
  assert.equal(d.liste().length, 0);
});

test("session expirée : renouvelée puis action renvoyée avec le même identifiant", async () => {
  const a = recup(1);
  const d = depotMemoire([a]);
  const cles = [];
  let session = false;
  const b = await synchroniser({
    depot: d,
    envoyer: async r => { cles.push(r.headers["Idempotency-Key"]); return session ? { status: 200, data: {} } : { status: 401, data: {} }; },
    renouveler: async () => { session = true; return true; }
  });
  assert.equal(b.envoyees, 1);
  assert.deepEqual(cles, [a.id, a.id]);
});

test("renouvellement refusé : arrêt, la file est conservée", async () => {
  const d = depotMemoire([recup(1)]);
  const b = await synchroniser({ depot: d, envoyer: async () => ({ status: 401, data: {} }), renouveler: async () => false });
  assert.equal(b.arret, ARRET.SESSION);
  assert.equal(d.liste().length, 1);
  assert.equal(d.liste()[0].etat, "attente");
});

test("refus métier : action marquée refusée, les suivantes partent", async () => {
  const d = depotMemoire([recup(1), recup(2)]);
  const b = await synchroniser({ depot: d, envoyer: async r => (r.url.includes("/materiel-prevu/1/") ? { status: 409, data: { error: "Cette cartouche n'est pas au statut préparée" } } : { status: 200, data: {} }), renouveler: async () => true });
  assert.equal(b.refusees, 1);
  assert.equal(b.envoyees, 1);
  assert.equal(d.liste().length, 1);
  assert.equal(d.liste()[0].etat, "rejetee");
  assert.equal(d.liste()[0].erreur, "Cette cartouche n'est pas au statut préparée");
});

test("action encore en cours côté serveur : on réessaiera", async () => {
  const d = depotMemoire([recup(1)]);
  const b = await synchroniser({ depot: d, envoyer: async () => ({ status: 409, data: { code: "IDEMPOTENCE_EN_COURS" } }), renouveler: async () => true });
  assert.equal(b.arret, ARRET.EN_COURS);
  assert.equal(d.liste()[0].etat, "attente");
});

test("serveur en panne (500) : on réessaiera", async () => {
  const d = depotMemoire([recup(1)]);
  const b = await synchroniser({ depot: d, envoyer: async () => ({ status: 502, data: null }), renouveler: async () => true });
  assert.equal(b.arret, ARRET.RESEAU);
  assert.equal(d.liste()[0].etat, "attente");
});

test("photo d'une anomalie créée hors connexion : envoyée avec l'identifiant serveur", async () => {
  const an = creer("anomalie", { interventionId: I, localId: "l-a1", typeAnomalie: "T", description: "D", priorite: "basse" });
  const ph = creer("photo", { interventionId: I, anomalieId: "l-a1", photoId: "p1" });
  const d = depotMemoire([an, ph]);
  const urls = [];
  await synchroniser({ depot: d, envoyer: async r => { urls.push(r.url); return { status: 201, data: { id: urls.length === 1 ? 77 : 5 } }; }, renouveler: async () => true });
  assert.deepEqual(urls, [`/interventions/${I}/anomalies`, "/anomalies/77/pieces-jointes"]);
  assert.equal(d.corr["l-a1"], 77);
});

test("anomalie refusée : sa photo est refusée aussi", async () => {
  const an = creer("anomalie", { interventionId: I, localId: "l-a1", typeAnomalie: "T", description: "D", priorite: "basse" });
  const ph = creer("photo", { interventionId: I, anomalieId: "l-a1", photoId: "p1" });
  const d = depotMemoire([an, ph]);
  const b = await synchroniser({ depot: d, envoyer: async () => ({ status: 409, data: { error: "Intervention déjà clôturée" } }), renouveler: async () => true });
  assert.equal(b.refusees, 2);
  assert.match(d.liste()[1].erreur, /Dépend d'une action refusée/);
});

test("supprimer un signalement pas encore envoyé : rien ne part", () => {
  const s = creer("signalement", { interventionId: I, localId: "l-s1", element: "E", voyant: "rouge" });
  const r = creer("retirer_signalement", { interventionId: I, signalementId: "l-s1" });
  const autre = recup(9);
  assert.deepEqual([...annulerCreation([s, autre, r], "l-s1")].sort(), [s.id, r.id].sort());
});

test("délai entre deux tentatives", () => {
  assert.equal(delaiNouvelEssai(1), 5000);
  assert.equal(delaiNouvelEssai(3), 20000);
  assert.equal(delaiNouvelEssai(20), 120000);
});
