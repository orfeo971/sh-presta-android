/* Échanges avec le serveur SH Presta.

   Session : jeton d'accès (12 h) + jeton de renouvellement (60 jours, remplacé à chaque usage), gardés dans
   l'espace privé de l'application. Un 401 déclenche un renouvellement transparent ; s'il est refusé, la
   session est perdue (reconnexion nécessaire) mais les actions en attente sont conservées.

   Toute absence de réponse (réseau coupé, serveur injoignable, délai dépassé) lève { reseau: true }. */

const CLE = "shp.session";
const DELAI_MS = 15000;

export function lireSession() {
  try { return JSON.parse(localStorage.getItem(CLE) || "null"); } catch (e) { return null; }
}
function ecrireSession(s) {
  try { s ? localStorage.setItem(CLE, JSON.stringify(s)) : localStorage.removeItem(CLE); } catch (e) { /* ignoré */ }
}

export function creerApi({ adresse, surSession = () => {}, surJoignable = () => {} }) {
  let renouvellement = null;

  async function brut(method, url, { body, headers = {}, fichier, jeton, delai = DELAI_MS } = {}) {
    const base = adresse();
    if (!base) throw { reseau: true, message: "Adresse du serveur non renseignée" };
    const h = { Accept: "application/json", ...headers };
    if (jeton) h.Authorization = "Bearer " + jeton;
    let corps;
    if (fichier) {
      corps = new FormData();
      corps.append("file", fichier.blob, fichier.nom);
    } else if (body !== undefined) {
      h["Content-Type"] = "application/json";
      corps = JSON.stringify(body);
    }
    const ctrl = new AbortController();
    const minuterie = setTimeout(() => ctrl.abort(), delai);
    let r;
    try {
      r = await fetch(base + "/api" + url, { method, headers: h, body: corps, signal: ctrl.signal });
    } catch (e) {
      surJoignable(false);
      throw { reseau: true, message: ctrl.signal.aborted ? "Le serveur ne répond pas" : "Serveur injoignable" };
    } finally {
      clearTimeout(minuterie);
    }
    surJoignable(true);
    let data = null;
    const texte = await r.text().catch(() => "");
    if (texte) { try { data = JSON.parse(texte); } catch (e) { data = null; } }
    return { status: r.status, data };
  }

  /** Nouvelle session à partir du jeton de renouvellement. true / false ; { reseau } si injoignable. */
  function renouveler() {
    if (renouvellement) return renouvellement;
    renouvellement = (async () => {
      const s = lireSession();
      if (!s || !s.refreshToken) return false;
      const r = await brut("POST", "/auth/refresh", { body: { refreshToken: s.refreshToken } });
      if (r.status === 200 && r.data && r.data.token) {
        const n = { ...s, token: r.data.token, refreshToken: r.data.refreshToken, user: r.data.user, renouveleLe: new Date().toISOString() };
        ecrireSession(n);
        surSession(n);
        return true;
      }
      if (r.status === 401 || r.status === 400) {
        ecrireSession({ ...s, token: null, refreshToken: null, perdue: true });
        surSession(lireSession());
        return false;
      }
      throw { reseau: true, message: "Renouvellement de session impossible pour l'instant" };
    })().finally(() => { renouvellement = null; });
    return renouvellement;
  }

  /** Requête authentifiée, avec renouvellement transparent de la session. */
  async function appel(method, url, opts = {}) {
    const s = lireSession();
    let r = await brut(method, url, { ...opts, jeton: s && s.token });
    if (r.status === 401 && s && s.refreshToken) {
      if (await renouveler()) r = await brut(method, url, { ...opts, jeton: lireSession().token });
    }
    return r;
  }

  return {
    appel,
    renouveler,
    async sante(base) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      try {
        const r = await fetch((base || adresse()) + "/api/health", { signal: ctrl.signal });
        const d = await r.json().catch(() => null);
        return !!(r.ok && d && d.status === "ok");
      } catch (e) {
        return false;
      } finally { clearTimeout(t); }
    },
    async connexion(email, password, appareil) {
      const r = await brut("POST", "/auth/login", { body: { email, password, appareil } });
      if (r.status !== 200) return { ok: false, erreur: (r.data && r.data.error) || "Connexion impossible (" + r.status + ")" };
      if (r.data.user.role !== "prestataire") return { ok: false, erreur: "Cette application est réservée aux comptes prestataires" };
      if (!r.data.refreshToken) return { ok: false, erreur: "Le serveur SH Presta n'est pas à jour pour l'application mobile" };
      const s = { token: r.data.token, refreshToken: r.data.refreshToken, user: r.data.user, connecteLe: new Date().toISOString() };
      ecrireSession(s);
      surSession(s);
      return { ok: true, session: s };
    },
    async deconnexion() {
      const s = lireSession();
      if (s && s.refreshToken) { try { await brut("POST", "/auth/logout", { body: { refreshToken: s.refreshToken }, delai: 5000 }); } catch (e) { /* hors connexion : le jeton expirera */ } }
      ecrireSession(null);
      surSession(null);
    },
    /** Fichier protégé (rapport PDF) : Blob, ou { status } en cas de refus. */
    async fichier(chemin) {
      const charger = async () => {
        const s = lireSession();
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 60000);
        try {
          return await fetch(adresse() + "/api" + chemin, { headers: s && s.token ? { Authorization: "Bearer " + s.token } : {}, signal: ctrl.signal });
        } catch (e) { surJoignable(false); throw { reseau: true, message: "Serveur injoignable" }; } finally { clearTimeout(t); }
      };
      let r = await charger();
      if (r.status === 401 && (await renouveler())) r = await charger();
      surJoignable(true);
      return r.ok ? { ok: true, blob: await r.blob() } : { ok: false, status: r.status };
    },
    /** Envoi d'une requête de la file (file.js) : le fichier d'une photo est lu au dernier moment. */
    async envoyer(req, lirePhoto) {
      const s = lireSession();
      let fichier;
      if (req.fichier) {
        const blob = await lirePhoto(req.fichier);
        if (!blob) return { status: 410, data: { error: "Photo introuvable sur le téléphone" } };
        fichier = { blob, nom: "photo-" + req.fichier.slice(0, 8) + ".jpg" };
      }
      return brut(req.method, req.url, { body: req.body, headers: req.headers, fichier, jeton: s && s.token, delai: fichier ? 60000 : DELAI_MS });
    }
  };
}
