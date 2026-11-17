/* Adresse du serveur SH Presta, saisie dans l'application (rien n'est écrit en dur dans l'APK).

   Le serveur est aujourd'hui en HTTP simple, joignable uniquement sur le réseau de l'entreprise (VPN).
   Android ne sait pas limiter le HTTP à une adresse choisie après l'installation : c'est donc ici que le
   HTTP est refusé vers toute adresse qui pourrait être publique. Il n'est accepté que vers :
   - une adresse IP privée (10.x, 172.16-31.x, 192.168.x, 100.64-127.x des VPN, 127.x) ;
   - un nom sans point (« sh-presta ») ;
   - un nom de domaine interne, dont l'extension n'est pas une extension publique courante
     (« sh-presta.domsig.sem », « serveur.local », « nas.lan »…).
   Vers toute autre adresse, HTTPS est obligatoire. */

const EXTENSIONS_PUBLIQUES = new Set(("com net org info biz fr gp mq gf re yt pm bl mf eu io co me tv app dev cloud page site online tech pro "
  + "be ch de es it nl pt uk us ca lu mc ai xyz shop store blog web host link live news one top world ovh").split(" "));

function ipPrivee(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some(x => Number(x) > 255)) return false;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

/** L'hôte est-il interne au réseau de l'entreprise ? */
export function hoteInterne(hote) {
  const h = String(hote || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost") return true;
  const ip = ipPrivee(h);
  if (ip !== null) return ip;
  if (h.includes(":")) return /^(fc|fd|fe80|::1)/.test(h); /* IPv6 locale */
  if (!h.includes(".")) return true;
  const ext = h.split(".").pop();
  if (/^\d+$/.test(ext)) return false;
  return !EXTENSIONS_PUBLIQUES.has(ext);
}

/**
 * Normalise la saisie (« sh-presta.domsig.sem » → « http://sh-presta.domsig.sem ») et la contrôle.
 * Renvoie { ok: true, adresse } ou { ok: false, erreur }.
 */
export function normaliserAdresse(saisie) {
  let s = String(saisie || "").trim();
  if (!s) return { ok: false, erreur: "Indiquez l'adresse du serveur SH Presta" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = (hoteInterne(s.split(/[/:]/)[0]) ? "http://" : "https://") + s;
  let u;
  try { u = new URL(s); } catch (e) { return { ok: false, erreur: "Adresse illisible" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, erreur: "L'adresse doit commencer par http:// ou https://" };
  if (u.username || u.password) return { ok: false, erreur: "L'adresse ne doit pas contenir d'identifiant" };
  if (u.protocol === "http:" && !hoteInterne(u.hostname)) {
    return { ok: false, erreur: "Adresse publique : HTTPS obligatoire (le HTTP n'est accepté que sur le réseau de l'entreprise)" };
  }
  let chemin = u.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return { ok: true, adresse: `${u.protocol}//${u.host}${chemin}`, chiffree: u.protocol === "https:" };
}
