package fr.orfeo.shpresta;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Vérification périodique, application fermée : interroge le serveur SH Presta et notifie les
 * interventions nouvellement attribuées, planifiées, déplacées ou annulées.
 *
 * Même règle que www/js/veille.js (vérification application ouverte), qui partage la liste des
 * interventions déjà connues (« veille.connues ») : une même nouveauté n'est notifiée qu'une fois.
 * N'utilise que la session courante, sans jamais la renouveler (le renouvellement fait tourner le
 * jeton et reste l'affaire de l'application) : si elle a expiré, rien n'est fait jusqu'à la
 * prochaine ouverture de l'application.
 */
public class VeilleService extends JobService {
    static final String PREFS = "CapacitorStorage";
    static final String CANAL = "interventions";

    @Override
    public boolean onStartJob(final JobParameters params) {
        new Thread(() -> {
            try {
                verifier(getApplicationContext());
            } catch (Exception e) {
                // Réseau absent, serveur injoignable : on réessaiera à la prochaine période.
            } finally {
                jobFinished(params, false);
            }
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }

    static void verifier(Context ctx) throws Exception {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!"1".equals(p.getString("veille.actif", null))) return;
        String serveur = p.getString("veille.serveur", null);
        String jeton = p.getString("veille.jeton", null);
        if (serveur == null || jeton == null) return;

        HttpURLConnection c = (HttpURLConnection) new URL(serveur + "/api/interventions").openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(20000);
        c.setRequestProperty("Authorization", "Bearer " + jeton);
        c.setRequestProperty("Accept", "application/json");
        try {
            if (c.getResponseCode() != 200) return;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
                String l;
                while ((l = r.readLine()) != null) sb.append(l);
            }
            JSONArray liste = new JSONArray(sb.toString());

            String brut = p.getString("veille.connues", null);
            boolean premiere = brut == null;
            JSONObject connues = premiere ? new JSONObject() : new JSONObject(brut);
            JSONObject nouvelles = new JSONObject();
            for (int i = 0; i < liste.length(); i++) {
                JSONObject it = liste.getJSONObject(i);
                String id = String.valueOf(it.getInt("id"));
                String statut = it.optString("statut", "");
                String jour = debut(it.optString("date", ""), 10);
                String heure = debut(it.optString("heure_prevue", ""), 5);
                String sig = statut + "|" + jour + "|" + heure;
                nouvelles.put(id, sig);
                if (premiere) continue;
                String avant = connues.optString(id, null);
                String titre = titrePour(avant, statut, jour, heure);
                if (titre != null) {
                    String dc = it.isNull("datacenter") ? "" : " · " + it.optString("datacenter", "");
                    notifier(ctx, Integer.parseInt(id), titre, jourCourt(jour) + (heure.isEmpty() ? "" : " à " + heure) + dc);
                }
            }
            p.edit().putString("veille.connues", nouvelles.toString()).apply();
        } finally {
            c.disconnect();
        }
    }

    /** Même règle que titreNotification() dans www/js/veille.js. */
    static String titrePour(String avant, String statut, String jour, String heure) {
        boolean ouverte = statut.equals("creee") || statut.equals("planifiee") || statut.equals("en_cours");
        if (avant == null) return ouverte ? "Nouvelle intervention" : null;
        String[] a = avant.split("\\|", -1);
        String aStatut = a.length > 0 ? a[0] : "", aJour = a.length > 1 ? a[1] : "", aHeure = a.length > 2 ? a[2] : "";
        if (!aStatut.equals(statut)) {
            if (statut.equals("annulee")) return "Intervention annulée";
            if (statut.equals("planifiee")) return "Intervention planifiée : matériel prêt";
            return null;
        }
        if (ouverte && (!aJour.equals(jour) || !aHeure.equals(heure))) return "Intervention déplacée";
        return null;
    }

    static String debut(String s, int n) {
        return s.length() >= n ? s.substring(0, n) : s;
    }

    /** « 2026-11-23 » → « 23/11 » */
    static String jourCourt(String jour) {
        return jour.length() == 10 ? jour.substring(8, 10) + "/" + jour.substring(5, 7) : jour;
    }

    static void notifier(Context ctx, int id, String titre, String texte) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !nm.areNotificationsEnabled()) return;
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CANAL, "Interventions", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("Interventions attribuées, planifiées, déplacées ou annulées");
            nm.createNotificationChannel(ch);
            b = new Notification.Builder(ctx, CANAL);
        } else {
            b = new Notification.Builder(ctx);
        }
        Intent ouvrir = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (ouvrir != null) {
            ouvrir.putExtra("intervention", id);
            b.setContentIntent(PendingIntent.getActivity(ctx, id, ouvrir, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
        b.setSmallIcon(R.drawable.ic_stat_shpresta).setContentTitle(titre).setContentText(texte).setAutoCancel(true);
        nm.notify(100000 + id, b.build());
    }
}
