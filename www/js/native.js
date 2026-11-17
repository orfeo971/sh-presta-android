/* Fonctions du téléphone : scanner, appareil photo, vibration, réseau, verrouillage, notifications,
   vérification en arrière-plan. Dans un navigateur (développement), chaque fonction a un repli simple. */
import { Capacitor, registerPlugin, CapacitorHttp } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Network } from "@capacitor/network";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Preferences } from "@capacitor/preferences";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { LocalNotifications } from "@capacitor/local-notifications";
import { BarcodeScanner } from "@capacitor-mlkit/barcode-scanning";
import { BiometricAuth } from "@aparajita/capacitor-biometric-auth";

export const isNative = Capacitor.isNativePlatform();
export const capacitor = { Capacitor, registerPlugin, CapacitorHttp };
const Veille = isNative ? registerPlugin("Veille") : null;

/* ---------- application ---------- */
export function surRetour(fn) { if (isNative) App.addListener("backButton", fn); }
export function surEtat(fn) {
  if (isNative) App.addListener("appStateChange", s => fn(s.isActive));
  else document.addEventListener("visibilitychange", () => fn(!document.hidden));
}
export const quitter = () => isNative && App.minimizeApp();
export async function infos() {
  if (!isNative) return { version: "web", appareil: navigator.userAgent.slice(0, 60) };
  const i = await App.getInfo();
  return { version: i.version, appareil: "Android " + (navigator.userAgent.match(/Android ([\d.]+)/) || [])[1] };
}

/* ---------- réseau ---------- */
export async function reseauConnecte() {
  try { return (await Network.getStatus()).connected; } catch (e) { return navigator.onLine; }
}
export function surReseau(fn) {
  try { Network.addListener("networkStatusChange", s => fn(s.connected)); } catch (e) { /* ignoré */ }
  window.addEventListener("online", () => fn(true));
  window.addEventListener("offline", () => fn(false));
}

/* ---------- retour sensoriel du scan ---------- */
let audio = null;
export function bip(ok) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = ok ? 1320 : 220;
    g.gain.value = 0.12;
    o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + (ok ? 0.12 : 0.35));
  } catch (e) { /* ignoré */ }
  vibrer(ok);
}
export function vibrer(ok = true) {
  if (!isNative) return;
  (ok ? Haptics.impact({ style: ImpactStyle.Medium }) : Haptics.notification({ type: NotificationType.Error })).catch(() => {});
}

/* ---------- scanner de codes-barres (Google ML Kit) ---------- */
/** Le module de scan est-il installé (indispensable au datacenter, sans réseau) ? */
export async function scannerPret() {
  if (!isNative) return { disponible: false, raison: "web" };
  try {
    const { supported } = await BarcodeScanner.isSupported();
    if (!supported) return { disponible: false, raison: "Ce téléphone ne permet pas le scan" };
    const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    return available ? { disponible: true } : { disponible: false, raison: "module" };
  } catch (e) { return { disponible: false, raison: e.message || String(e) }; }
}
export async function installerScanner(surProgression) {
  if (!isNative) return;
  const l = await BarcodeScanner.addListener("googleBarcodeScannerModuleInstallProgress", e => surProgression && surProgression(e.progress));
  try { await BarcodeScanner.installGoogleBarcodeScannerModule(); } finally { setTimeout(() => l.remove(), 60000); }
}
/** Ouvre le scanner ; renvoie le texte lu, ou null si l'opérateur annule. */
export async function scanner() {
  const p = await scannerPret();
  if (!p.disponible) throw new Error(p.raison === "module" ? "Scanner en cours d'installation : réessayez dans un instant (réseau nécessaire la première fois)" : p.raison === "web" ? "Scanner disponible dans l'application Android" : p.raison);
  try {
    const { barcodes } = await BarcodeScanner.scan();
    return barcodes && barcodes.length ? String(barcodes[0].rawValue || barcodes[0].displayValue || "").trim() : null;
  } catch (e) {
    if (/cancel/i.test(e.message || "")) return null;
    throw e;
  }
}

/* ---------- appareil photo ---------- */
/** Photo prise sur le moment ou choisie dans la galerie, compressée en JPEG. Renvoie un Blob ou null. */
export async function photo() {
  if (!isNative) return choisirFichierWeb();
  try {
    const p = await Camera.getPhoto({ quality: 70, width: 1600, height: 1600, correctOrientation: true, resultType: CameraResultType.Base64, source: CameraSource.Prompt,
      promptLabelHeader: "Photo de l'anomalie", promptLabelPhoto: "Choisir dans la galerie", promptLabelPicture: "Prendre une photo", promptLabelCancel: "Annuler" });
    const octets = Uint8Array.from(atob(p.base64String), c => c.charCodeAt(0));
    return new Blob([octets], { type: "image/" + (p.format || "jpeg") });
  } catch (e) {
    if (/cancel/i.test(e.message || "")) return null;
    throw e;
  }
}
function choisirFichierWeb() {
  return new Promise(resolve => {
    const i = document.createElement("input");
    i.type = "file"; i.accept = "image/*"; i.capture = "environment";
    i.onchange = () => resolve(i.files && i.files[0] ? i.files[0] : null);
    i.click();
  });
}

/* ---------- documents (rapport PDF) ---------- */
/** Ouvre un PDF : Android propose les applications capables de l'afficher (ou de l'envoyer). */
export async function ouvrirPdf(blob, nom) {
  if (!isNative) { window.open(URL.createObjectURL(blob), "_blank"); return; }
  const base64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  const f = await Filesystem.writeFile({ path: nom, data: base64, directory: Directory.Cache });
  await Share.share({ title: nom, url: f.uri, dialogTitle: "Ouvrir le rapport avec…" });
}

/* ---------- verrouillage (empreinte, visage ou code du téléphone) ---------- */
export async function verrouPossible() {
  if (!isNative) return { possible: false, raison: "Disponible dans l'application Android" };
  try {
    const r = await BiometricAuth.checkBiometry();
    if (r.isAvailable || r.deviceIsSecure) return { possible: true };
    return { possible: false, raison: "Aucun verrouillage d'écran n'est configuré sur ce téléphone" };
  } catch (e) { return { possible: false, raison: e.message || String(e) }; }
}
export async function deverrouiller() {
  if (!isNative) return true;
  try {
    await BiometricAuth.authenticate({ reason: "Déverrouiller SH Presta", androidTitle: "SH Presta", androidSubtitle: "Déverrouiller l'application", allowDeviceCredential: true, cancelTitle: "Annuler" });
    return true;
  } catch (e) { return false; }
}

/* ---------- préférences partagées avec la vérification en arrière-plan (VeilleService) ---------- */
export async function prefLire(cle) { try { return (await Preferences.get({ key: cle })).value; } catch (e) { return localStorage.getItem("pref." + cle); } }
export async function prefEcrire(cle, valeur) {
  try {
    if (valeur == null) await Preferences.remove({ key: cle }); else await Preferences.set({ key: cle, value: String(valeur) });
  } catch (e) { valeur == null ? localStorage.removeItem("pref." + cle) : localStorage.setItem("pref." + cle, String(valeur)); }
}

/* ---------- notifications ---------- */
export async function notificationsAutorisees(demander = false) {
  if (!isNative) return false;
  try {
    let p = await LocalNotifications.checkPermissions();
    if (p.display !== "granted" && demander) p = await LocalNotifications.requestPermissions();
    return p.display === "granted";
  } catch (e) { return false; }
}
export async function notifier(liste) {
  if (!isNative || !liste.length) return;
  try {
    await LocalNotifications.schedule({ notifications: liste.map(n => ({ id: 100000 + n.id, title: n.titre, body: n.texte, smallIcon: "ic_stat_shpresta", extra: { intervention: n.id } })) });
  } catch (e) { /* ignoré */ }
}
export function surNotificationTouchee(fn) {
  if (!isNative) return;
  LocalNotifications.addListener("localNotificationActionPerformed", e => { const id = e.notification && e.notification.extra && e.notification.extra.intervention; if (id) fn(Number(id)); });
}
/** Vérification périodique, application fermée (VeillePlugin.java). */
export async function veille(actif) {
  if (!Veille) return false;
  try { return (await (actif ? Veille.activer() : Veille.desactiver())).actif; } catch (e) { return false; }
}
