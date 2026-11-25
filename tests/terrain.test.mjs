/* Parcours terrain complet sur un vrai dossier renvoyé par le serveur (tests/donnees/dossier.json) :
   règles des étapes, vue « optimiste » hors connexion, chargement TS4300. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { creer, requete } from "../www/js/actions.js";
import { appliquer } from "../www/js/optimiste.js";
import { bloquants, etapes, etapeCourante, aInstaller, statutApres, figee } from "../www/js/regles.js";
import * as ts from "../www/js/ts4300.js";

const dossier = JSON.parse(readFileSync(new URL("./donnees/dossier.json", import.meta.url)));
const I = dossier.intervention.id;
const ref = r => dossier.materielPrevu.find(m => m.cartouche_reference === r);
const emp = (magasin, code) => dossier.emplacements.find(e => e.type === magasin && e.code_emplacement === code);
const G = "ts4300_magasin1", D = "ts4300_magasin2";

/* rejoue une liste de [type, params] comme le ferait l'opérateur */
function gestes(liste) { return liste.map(([t, p]) => creer(t, { interventionId: I, ...p })); }

test("étape 1 : bloquée tant que tout n'est pas récupéré", () => {
  const v = appliquer(dossier, []);
  assert.equal(etapeCourante(v), "depart_siege");
  assert.deepEqual(bloquants(v, "depart_siege"), ["3 cartouches à récupérer", "1 élément de matériel à récupérer"]);
  const e = etapes(v);
  assert.equal(e[1].accessible, false);
});

test("vue optimiste : récupération hors connexion, puis validation de l'étape 1", () => {
  const acts = gestes([
    ["recuperer_cartouche", { cartoucheId: ref("SRQ011L9").cartouche_id, recupere: true, reference: "SRQ011L9" }],
    ["recuperer_cartouche", { cartoucheId: ref("SRQ012L9").cartouche_id, recupere: true, reference: "SRQ012L9" }],
    ["recuperer_cartouche", { cartoucheId: ref("SRQ013L9").cartouche_id, recupere: true, reference: "SRQ013L9" }],
    ["ponctuel", { itemId: dossier.materielPonctuel[0].id, quoi: "recuperer", fait: true, intitule: "Câble" }]
  ]);
  let v = appliquer(dossier, acts);
  assert.deepEqual(bloquants(v, "depart_siege"), []);
  assert.ok(v.materielPrevu.every(m => m.cartouche_etat === "transit" && m._attente));
  assert.equal(v.aRestituer.length, 3, "récupérées : à ramener si jamais chargées");
  assert.equal(aInstaller(v).length, 0, "pas de plateau avant la validation de l'étape 1");
  v = appliquer(dossier, [...acts, creer("valider_etape", { interventionId: I, etape: "depart_siege" })]);
  assert.equal(v.intervention.statut, "en_cours");
  assert.equal(aInstaller(v).length, 3);
  assert.equal(etapeCourante(v), "intervention");
});

test("une action refusée par le serveur n'est pas rejouée", () => {
  const a = creer("recuperer_cartouche", { interventionId: I, cartoucheId: ref("SRQ011L9").cartouche_id, recupere: true, reference: "SRQ011L9" });
  const v = appliquer(dossier, [{ ...a, etat: "rejetee" }]);
  assert.equal(v.materielPrevu.find(m => m.cartouche_reference === "SRQ011L9").recupere_le, null);
});

test("TS4300 : placer selon le plan, échanger, valider ; vue cohérente", () => {
  const recup = gestes([
    ...["SRQ011L9", "SRQ012L9", "SRQ013L9"].map(r => ["recuperer_cartouche", { cartoucheId: ref(r).cartouche_id, recupere: true, reference: r }]),
    ["ponctuel", { itemId: dossier.materielPonctuel[0].id, quoi: "recuperer", fait: true, intitule: "Câble" }],
    ["valider_etape", { etape: "depart_siege" }]
  ]);
  const v = appliquer(dossier, recup);
  let b = ts.brouillonVide();
  assert.equal(ts.plateau(v, b).length, 3);
  const { brouillon, places } = ts.placerSelonPlan(v, b);
  assert.equal(places, 3, "SLOT-06/07/08 du magasin de gauche sont libres");
  b = brouillon;
  assert.equal(ts.plateau(v, b).length, 0);
  /* retrait planifié de SRQ001L9 (SLOT-01 gauche) et déplacement de SRQ006L9 (SLOT-01 droite → SLOT-10 droite) */
  b = ts.retirer(v, b, emp(G, "SLOT-01").id).brouillon;
  b = ts.deplacer(v, b, emp(D, "SLOT-01").id, emp(D, "SLOT-10").id).brouillon;
  assert.equal(ts.libre(v, b, emp(G, "SLOT-01").id), true, "emplacement en cours de retrait : réutilisable");
  assert.equal(ts.libre(v, b, emp(G, "SLOT-02").id), false);
  const casesG = ts.cases(v, b, G);
  assert.equal(casesG.find(c => c.code === "SLOT-02").retraitPrevu, true, "retrait planifié signalé");
  assert.equal(casesG.find(c => c.code === "SLOT-01").retrait, true);

  const mouv = ts.versMouvements(v, b, I);
  assert.deepEqual(mouv.map(m => m.sens), ["retrait", "retrait", "installation", "installation", "installation", "installation"]);

  const apres = appliquer(dossier, [...recup, ...mouv.map(p => creer("mouvement", p)), creer("valider_etape", { interventionId: I, etape: "chargement_ts4300" })]);
  const g = Object.fromEntries(apres.emplacements.filter(e => e.type === G).map(e => [e.code_emplacement, e.cartouche_reference]));
  const d = Object.fromEntries(apres.emplacements.filter(e => e.type === D).map(e => [e.code_emplacement, e.cartouche_reference]));
  assert.equal(g["SLOT-01"], null);
  assert.equal(g["SLOT-06"], "SRQ011L9");
  assert.equal(d["SLOT-01"], null);
  assert.equal(d["SLOT-10"], "SRQ006L9");
  assert.deepEqual(apres.aRestituer.map(c => c.cartouche_reference), ["SRQ001L9"], "seule la cartouche retirée reste à ramener");
  assert.ok(apres.materielPrevu.every(m => m.cartouche_etat === "ts4300"));
  assert.deepEqual(ts.plateau(apres, ts.brouillonVide()).map(c => [c.reference, c.retiree]), [["SRQ001L9", true]], "la cartouche retirée peut être réinstallée");
});

test("TS4300 : annuler un retrait annule aussi la pose qui l'utilisait", () => {
  const v = appliquer(dossier, gestes([
    ...["SRQ011L9", "SRQ012L9", "SRQ013L9"].map(r => ["recuperer_cartouche", { cartoucheId: ref(r).cartouche_id, recupere: true, reference: r }]),
    ["valider_etape", { etape: "depart_siege" }]
  ]));
  let b = ts.retirer(v, ts.brouillonVide(), emp(G, "SLOT-01").id).brouillon;
  b = ts.poser(v, b, ref("SRQ011L9").cartouche_id, emp(G, "SLOT-01").id).brouillon;
  assert.equal(b.installs.length, 1);
  b = ts.annuler(v, b, emp(G, "SLOT-01").id);
  assert.deepEqual(b, { installs: [], retraits: [] });
  assert.equal(ts.poser(v, b, ref("SRQ011L9").cartouche_id, emp(G, "SLOT-01").id).ok, false, "emplacement occupé");
});

test("grille : colonnes de bas en haut", () => {
  assert.deepEqual(ts.colonnesBasEnHaut([1, 2, 3, 4, 5, 6, 7], 5), [5, 4, 3, 2, 1, null, null, null, 7, 6]);
});

test("datacenter : contrôles, opération ponctuelle, passage validé, retour", () => {
  const base = gestes([
    ...["SRQ011L9", "SRQ012L9", "SRQ013L9"].map(r => ["recuperer_cartouche", { cartoucheId: ref(r).cartouche_id, recupere: true, reference: r }]),
    ["ponctuel", { itemId: dossier.materielPonctuel[0].id, quoi: "recuperer", fait: true, intitule: "Câble" }],
    ["valider_etape", { etape: "depart_siege" }],
    ["valider_etape", { etape: "chargement_ts4300" }]
  ]);
  let v = appliquer(dossier, base);
  assert.deepEqual(bloquants(v, "verification_visuelle"), ["Cocher « Rien à signaler » ou ajouter un signalement"]);
  assert.deepEqual(bloquants(v, "anomalies_ponctuelles"), ["1 élément récupéré à pointer comme utilisé"]);
  assert.match(bloquants(v, "intervention").join(), /Contrôles visuels, Opération ponctuelle/);

  const suite = [...base, ...gestes([
    ["signalement", { localId: "l-s1", element: "Switch baie 3", voyant: "orange" }],
    ["ponctuel", { itemId: dossier.materielPonctuel[0].id, quoi: "utiliser", fait: true, intitule: "Câble" }],
    ["anomalie", { localId: "l-a1", typeAnomalie: "Câble", description: "Câble abîmé", priorite: "haute" }],
    ["photo", { anomalieId: "l-a1", photoId: "p1", typeAnomalie: "Câble" }],
    ["valider_etape", { etape: "verification_visuelle" }],
    ["valider_etape", { etape: "anomalies_ponctuelles" }]
  ])];
  v = appliquer(dossier, suite);
  assert.equal(v.controles.signalements[0]._attente, true);
  assert.equal(v.anomalies[0].pieces_jointes.length, 1);
  assert.deepEqual(bloquants(v, "intervention"), []);
  v = appliquer(dossier, [...suite, creer("valider_etape", { interventionId: I, etape: "intervention" })]);
  assert.equal(etapeCourante(v), "retour_siege");
  /* 3 cartouches récupérées mais jamais chargées + l'ancien câble à ramener */
  assert.deepEqual(bloquants(v, "retour_siege"), ["3 cartouches à restituer", "1 élément de matériel à restituer"]);
  const fin = [...suite, ...gestes([
    ["valider_etape", { etape: "intervention" }],
    ...["SRQ011L9", "SRQ012L9", "SRQ013L9"].map(r => ["restituer_cartouche", { cartoucheId: ref(r).cartouche_id, restitue: true, reference: r }]),
    ["ponctuel", { itemId: dossier.materielPonctuel[1].id, quoi: "restituer", fait: true, intitule: "Ancien câble" }]
  ])];
  v = appliquer(dossier, fin);
  assert.deepEqual(bloquants(v, "retour_siege"), []);
  v = appliquer(dossier, [...fin, creer("valider_etape", { interventionId: I, etape: "retour_siege" })]);
  assert.equal(v.intervention.statut, "terminee");
  assert.equal(etapeCourante(v), null);
});

test("statut : intervention sans retour au siège terminée dès le passage au datacenter", () => {
  const v = { intervention: { statut: "en_cours", inclut_cartouches: false, ponctuelle_materiel_a_ramener: false }, etapes: [], aRestituer: [] };
  assert.equal(statutApres(v, "intervention"), "terminee");
  assert.equal(statutApres({ ...v, intervention: { ...v.intervention, statut: "terminee" } }, "depart_siege"), "terminee");
});

test("rien à ramener (cartouches seulement installées) : pas d'étape 3, intervention terminée", () => {
  /* sans matériel ponctuel à ramener ni retrait planifié : toutes les cartouches récupérées sont installées */
  const d = { ...dossier, intervention: { ...dossier.intervention, ponctuelle_materiel_a_ramener: false, inclut_verification: false, inclut_anomalies_ponctuelles: false }, materielPonctuel: [], retraitsPrevus: [] };
  const recup = ["SRQ011L9", "SRQ012L9", "SRQ013L9"].map(r => creer("recuperer_cartouche", { interventionId: I, cartoucheId: ref(r).cartouche_id, recupere: true, reference: r }));
  let v = appliquer(d, [...recup, creer("valider_etape", { interventionId: I, etape: "depart_siege" })]);
  assert.equal(etapes(v)[2].applicable, true, "avant le chargement : retour encore prévu");
  const b = ts.placerSelonPlan(v, ts.brouillonVide()).brouillon;
  const fin = [...recup, creer("valider_etape", { interventionId: I, etape: "depart_siege" }),
    ...ts.versMouvements(v, b, I).map(p => creer("mouvement", p)),
    creer("valider_etape", { interventionId: I, etape: "chargement_ts4300" })];
  v = appliquer(d, fin);
  assert.equal(etapes(v)[2].applicable, false, "chargement validé sans retrait : rien à ramener");
  v = appliquer(d, [...fin, creer("valider_etape", { interventionId: I, etape: "intervention" })]);
  assert.equal(v.intervention.statut, "terminee");
  assert.equal(etapeCourante(v), null);
});

test("intervention clôturée : figée", () => {
  const v = appliquer({ ...dossier, intervention: { ...dossier.intervention, statut: "validee" } }, []);
  assert.equal(figee(v), true);
  assert.deepEqual(bloquants(v, "depart_siege"), ["Intervention clôturée"]);
});

test("requêtes : en-têtes, identifiants locaux résolus après création", () => {
  const an = creer("anomalie", { interventionId: I, localId: "l-a1", typeAnomalie: "Câble", description: "x", priorite: "basse" });
  const ph = creer("photo", { interventionId: I, anomalieId: "l-a1", photoId: "p1" });
  const r = requete(an);
  assert.equal(r.method, "POST");
  assert.equal(r.url, `/interventions/${I}/anomalies`);
  assert.equal(r.headers["Idempotency-Key"], an.id);
  assert.equal(r.headers["X-Realise-Le"], an.realiseLe);
  assert.equal(requete(ph), null, "photo en attente de l'anomalie");
  assert.equal(requete(ph, { "l-a1": 42 }).url, "/anomalies/42/pieces-jointes");
  assert.match(an.id, /^[A-Za-z0-9_-]{8,100}$/, "format accepté par le serveur");
});
