/* Mise en forme des dates et heures, en français et en 24 h.
   Les horodatages sont affichés dans le fuseau de l'exploitation (America/Guadeloupe), comme sur le site
   web, pour que l'heure soit la même quel que soit le réglage du téléphone.
   Le jour d'une intervention (« date ») arrive du serveur sous la forme « 2026-11-23T00:00:00.000Z » :
   seuls les 10 premiers caractères comptent, comme sur le site web. */

export const FUSEAU = "America/Guadeloupe";

export const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** « 2026-11-23T00:00:00.000Z » → « 2026-11-23 » */
export const jourDe = date => (date ? String(date).slice(0, 10) : "");

/** « 10:00:00 » → « 10:00 » */
export const heureDe = h => (h ? String(h).slice(0, 5) : "");

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** Jour civil d'aujourd'hui dans le fuseau de l'exploitation, au format « 2026-11-23 ». */
export function aujourdhui(maintenant = new Date()) {
  const p = new Intl.DateTimeFormat("fr-CA", { timeZone: FUSEAU, year: "numeric", month: "2-digit", day: "2-digit" }).format(maintenant);
  return p.slice(0, 10);
}

/** Nombre de jours entre deux jours civils « AAAA-MM-JJ » (b − a). */
export function ecartJours(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

/** « 2026-11-23 » → « lundi 23 novembre », ou « aujourd'hui », « demain », « hier ». */
export function jourLisible(jour, reference = aujourdhui()) {
  if (!jour) return "date à définir";
  const e = ecartJours(reference, jour);
  if (e === 0) return "aujourd'hui";
  if (e === 1) return "demain";
  if (e === -1) return "hier";
  const d = new Date(jour + "T12:00:00Z");
  const annee = d.getUTCFullYear() !== Number(reference.slice(0, 4)) ? " " + d.getUTCFullYear() : "";
  return `${JOURS[d.getUTCDay()]} ${d.getUTCDate()} ${MOIS[d.getUTCMonth()]}${annee}`;
}

/** Horodatage ISO → « 17/11 à 10:05 » (fuseau de l'exploitation). */
export function horodatage(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const f = new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const v = t => (f.find(x => x.type === t) || {}).value || "";
  return `${v("day")}/${v("month")} à ${v("hour")}:${v("minute")}`;
}

/** Durée écoulée lisible : « à l'instant », « il y a 5 min », « il y a 2 h », « il y a 3 j ». */
export function ilya(iso, maintenant = Date.now()) {
  const s = Math.round((maintenant - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 45) return "à l'instant";
  if (s < 3600) return `il y a ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}

export const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;
