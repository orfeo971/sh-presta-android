/* Stockage sur le téléphone (IndexedDB) : dossiers d'intervention, actions en attente, photos, brouillons.
   Tout reste dans l'espace privé de l'application et n'est jamais sauvegardé dans le cloud
   (android:allowBackup="false"). Sans IndexedDB (rare), un stockage en mémoire prend le relais. */

const BASE = "shpresta", VERSION = 1;
let db = null;

function ouvrir() {
  if (db) return Promise.resolve(db);
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise(resolve => {
    const r = indexedDB.open(BASE, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      if (!d.objectStoreNames.contains("actions")) d.createObjectStore("actions", { keyPath: "id" });
      if (!d.objectStoreNames.contains("photos")) d.createObjectStore("photos");
    };
    r.onsuccess = () => { db = r.result; resolve(db); };
    r.onerror = () => resolve(null);
  });
}

const memoire = { kv: new Map(), actions: new Map(), photos: new Map() };

async function op(magasin, mode, fn) {
  const d = await ouvrir();
  if (!d) return fn(null, memoire[magasin]);
  return new Promise((resolve, reject) => {
    const tx = d.transaction(magasin, mode);
    const s = tx.objectStore(magasin);
    let res;
    const req = fn(s, null);
    if (req && "onsuccess" in req) req.onsuccess = () => { res = req.result; };
    tx.oncomplete = () => resolve(res);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/* ---------- clé → valeur ---------- */
export const lire = cle => op("kv", "readonly", (s, m) => (s ? s.get(cle) : m.get(cle)));
export const ecrire = (cle, valeur) => op("kv", "readwrite", (s, m) => (s ? s.put(valeur, cle) : void m.set(cle, valeur)));
export const effacer = cle => op("kv", "readwrite", (s, m) => (s ? s.delete(cle) : void m.delete(cle)));

/* ---------- actions en attente (ordre de création conservé) ---------- */
let compteur = 0;
export async function listerActions() {
  const toutes = await op("actions", "readonly", (s, m) => (s ? s.getAll() : [...m.values()]));
  return (toutes || []).sort((a, b) => a.ordre - b.ordre);
}
export function ajouterAction(a) {
  const action = { ...a, ordre: a.ordre ?? Date.now() * 1000 + (compteur++ % 1000) };
  return op("actions", "readwrite", (s, m) => (s ? s.put(action) : void m.set(action.id, action)));
}
export const modifierAction = a => op("actions", "readwrite", (s, m) => (s ? s.put(a) : void m.set(a.id, a)));
export const retirerAction = id => op("actions", "readwrite", (s, m) => (s ? s.delete(id) : void m.delete(id)));

/* ---------- photos (Blob) ---------- */
export const ecrirePhoto = (id, blob) => op("photos", "readwrite", (s, m) => (s ? s.put(blob, id) : void m.set(id, blob)));
export const lirePhoto = id => op("photos", "readonly", (s, m) => (s ? s.get(id) : m.get(id)));
export const effacerPhoto = id => op("photos", "readwrite", (s, m) => (s ? s.delete(id) : void m.delete(id)));

/** Tout effacer (déconnexion sans action en attente, changement de compte). */
export async function toutEffacer() {
  for (const m of ["kv", "actions", "photos"]) await op(m, "readwrite", (s, mem) => (s ? s.clear() : void mem.clear()));
}

/** Dépôt utilisé par la file d'envoi (file.js). */
export const depot = {
  lister: listerActions,
  modifier: modifierAction,
  retirer: async id => {
    const a = (await listerActions()).find(x => x.id === id);
    await retirerAction(id);
    if (a && a.type === "photo") await effacerPhoto(a.params.photoId);
  },
  correspondances: async () => (await lire("correspondances")) || {},
  associer: async (local, serveur) => { const c = (await lire("correspondances")) || {}; c[local] = serveur; await ecrire("correspondances", c); }
};
