/* Envoi des actions en attente au serveur, dans l'ordre où elles ont été faites.

   Règles :
   - succès (2xx) : l'action quitte la file ; une création (signalement, anomalie) mémorise l'identifiant
     donné par le serveur pour les actions qui en dépendent (photo, retrait du signalement) ;
   - réseau absent, serveur en panne (5xx), action encore en cours côté serveur : on s'arrête, sans rien
     perdre, et on réessaiera plus tard ;
   - session expirée (401) : on renouvelle la session et on renvoie l'action ; si le renouvellement est
     refusé, on s'arrête (il faudra se reconnecter, la file est conservée) ;
   - refus du serveur (autre 4xx : étape non validable, cartouche déjà installée…) : l'action est marquée
     « refusée » avec le message du serveur, et on continue avec les suivantes. Les actions qui dépendent
     d'une création refusée sont refusées aussi. L'opérateur voit ces refus et décide (réessayer, abandonner).
   Le même identifiant d'action est renvoyé à chaque tentative : le serveur ne l'applique jamais deux fois.

   `depot` : { lister(), modifier(action), retirer(id), correspondances(), associer(idLocal, idServeur) }
   `envoyer(requete)` : renvoie { status, data } ; lève une erreur { reseau: true } si le serveur est injoignable.
   `renouveler()` : renvoie true si une nouvelle session a été obtenue. */

import { creation, dependances, requete } from "./actions.js";

export const ARRET = { RESEAU: "reseau", SESSION: "session", EN_COURS: "en_cours" };

export async function synchroniser({ depot, envoyer, renouveler, surProgression = () => {} }) {
  const bilan = { envoyees: 0, refusees: 0, arret: null, interventions: new Set() };
  const vues = new Set();
  for (;;) {
    const actions = (await depot.lister()).filter(a => a.etat !== "rejetee" && !vues.has(a.id));
    if (!actions.length) break;
    const a = actions[0];
    vues.add(a.id);
    const corr = await depot.correspondances();
    const req = requete(a, corr);
    if (!req) {
      /* dépend d'une création qui n'a pas abouti */
      const refusees = new Set((await depot.lister()).filter(x => x.etat === "rejetee").map(creation).filter(Boolean));
      const manquante = dependances(a).find(d => corr[d] == null);
      if (refusees.has(manquante) || !(await depot.lister()).some(x => creation(x) === manquante)) {
        await depot.modifier({ ...a, etat: "rejetee", erreur: "Dépend d'une action refusée ou abandonnée" });
        bilan.refusees++;
        continue;
      }
      bilan.arret = ARRET.RESEAU;
      break;
    }
    let r;
    try {
      r = await envoyer(req);
      if (r.status === 401) {
        if (!(await renouveler())) { bilan.arret = ARRET.SESSION; break; }
        r = await envoyer(req);
        if (r.status === 401) { bilan.arret = ARRET.SESSION; break; }
      }
    } catch (e) {
      bilan.arret = ARRET.RESEAU;
      break;
    }
    if (r.status >= 200 && r.status < 300) {
      const cree = creation(a);
      if (cree && r.data && r.data.id != null) await depot.associer(cree, r.data.id);
      await depot.retirer(a.id);
      bilan.envoyees++;
      bilan.interventions.add(Number(a.interventionId));
      surProgression(bilan);
      continue;
    }
    if (r.status === 409 && r.data && r.data.code === "IDEMPOTENCE_EN_COURS") { bilan.arret = ARRET.EN_COURS; break; }
    if (r.status >= 500 || r.status === 429 || r.status === 0) { bilan.arret = ARRET.RESEAU; break; }
    const message = (r.data && r.data.error) || `Refusée par le serveur (${r.status})`;
    await depot.modifier({ ...a, etat: "rejetee", erreur: message, statut: r.status });
    bilan.refusees++;
    bilan.interventions.add(Number(a.interventionId));
    surProgression(bilan);
  }
  return bilan;
}

/**
 * Retire de la file une création encore en attente et tout ce qui en dépend (l'opérateur supprime un
 * signalement ou une anomalie qu'il vient d'ajouter hors connexion : rien ne part au serveur).
 * Renvoie les identifiants retirés.
 */
export function annulerCreation(actions, idLocal) {
  const retires = new Set();
  for (const a of actions) {
    if (creation(a) === idLocal || dependances(a).includes(idLocal) || (a.params && (a.params.signalementId === idLocal || a.params.anomalieId === idLocal))) retires.add(a.id);
  }
  return retires;
}

/** Délai avant la prochaine tentative après un échec réseau : 5 s, 10 s, 20 s… plafonné à 2 min. */
export const delaiNouvelEssai = echecs => Math.min(120000, 5000 * 2 ** Math.max(0, echecs - 1));
