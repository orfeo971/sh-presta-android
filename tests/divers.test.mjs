/* Adresse du serveur, notifications, mise en forme. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliserAdresse, hoteInterne } from "../www/js/adresse.js";
import { comparer, titreNotification } from "../www/js/veille.js";
import { jourLisible, heureDe, jourDe, horodatage, ilya } from "../www/js/format.js";

test("adresse : HTTP accepté sur le réseau de l'entreprise uniquement", () => {
  assert.deepEqual(normaliserAdresse("sh-presta.domsig.sem"), { ok: true, adresse: "http://sh-presta.domsig.sem", chiffree: false });
  assert.equal(normaliserAdresse("http://192.168.1.20:8080/api/").adresse, "http://192.168.1.20:8080");
  assert.equal(normaliserAdresse("10.0.0.5").adresse, "http://10.0.0.5");
  assert.equal(normaliserAdresse("http://100.101.2.3").ok, true, "VPN (plage 100.64/10)");
  assert.equal(normaliserAdresse("http://sh-presta").ok, true);
  assert.equal(normaliserAdresse("sh-presta.exemple.fr").adresse, "https://sh-presta.exemple.fr");
  assert.equal(normaliserAdresse("http://sh-presta.exemple.com").ok, false);
  assert.match(normaliserAdresse("http://8.8.8.8").erreur, /HTTPS obligatoire/);
  assert.equal(normaliserAdresse("https://8.8.8.8").ok, true);
  assert.equal(normaliserAdresse("ftp://serveur").ok, false);
  assert.equal(normaliserAdresse("").ok, false);
  assert.equal(normaliserAdresse("http://moi:secret@10.0.0.1").ok, false);
  assert.equal(hoteInterne("172.32.0.1"), false);
  assert.equal(hoteInterne("172.20.0.1"), true);
});

test("notifications : rien à la première vérification, puis nouveautés seulement", () => {
  const l1 = [{ id: 1, statut: "creee", date: "2026-11-23T00:00:00.000Z", heure_prevue: "10:00:00", datacenter: "Jarry" }];
  const a = comparer(l1, null);
  assert.deepEqual(a.notifications, []);
  assert.deepEqual(a.connues, { 1: "creee|2026-11-23|10:00" });
  const l2 = [{ ...l1[0], statut: "planifiee" }, { id: 2, statut: "creee", date: "2026-11-30T00:00:00.000Z", heure_prevue: "09:30:00", datacenter: null }];
  const b = comparer(l2, a.connues);
  assert.deepEqual(b.notifications, [
    { id: 1, titre: "Intervention planifiée : matériel prêt", texte: "23/11 à 10:00 · Jarry" },
    { id: 2, titre: "Nouvelle intervention", texte: "30/11 à 09:30" }
  ]);
  assert.deepEqual(comparer(l2, b.connues).notifications, [], "déjà notifié");
  const c = comparer([{ ...l2[1], heure_prevue: "14:00:00" }, { ...l2[0], statut: "annulee" }], b.connues);
  assert.deepEqual(c.notifications.map(n => n.titre), ["Intervention déplacée", "Intervention annulée"]);
});

test("notifications : passage en cours ou terminé sans notification", () => {
  assert.equal(titreNotification("planifiee|2026-11-23|10:00", "en_cours", "2026-11-23", "10:00"), null);
  assert.equal(titreNotification(undefined, "validee", "2026-11-23", "10:00"), null);
});

test("mise en forme", () => {
  assert.equal(jourDe("2026-11-23T00:00:00.000Z"), "2026-11-23");
  assert.equal(heureDe("09:30:00"), "09:30");
  assert.equal(jourLisible("2026-11-23", "2026-11-23"), "aujourd'hui");
  assert.equal(jourLisible("2026-11-24", "2026-11-23"), "demain");
  assert.equal(jourLisible("2026-11-30", "2026-11-23"), "lundi 30 novembre");
  assert.equal(jourLisible("2027-01-04", "2026-11-23"), "lundi 4 janvier 2027");
  assert.equal(horodatage("2026-11-17T14:05:00Z"), "17/11 à 10:05", "heure de Guadeloupe");
  assert.equal(ilya("2026-11-17T10:00:00Z", Date.parse("2026-11-17T10:12:00Z")), "il y a 12 min");
});
