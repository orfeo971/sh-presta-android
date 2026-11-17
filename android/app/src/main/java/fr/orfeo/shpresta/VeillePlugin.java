package fr.orfeo.shpresta;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Active ou arrête la vérification périodique des interventions (VeilleService), application fermée.
 * Les réglages (adresse du serveur, session, interventions déjà connues) sont écrits par l'application
 * dans les préférences partagées « CapacitorStorage » (extension @capacitor/preferences).
 */
@CapacitorPlugin(name = "Veille")
public class VeillePlugin extends Plugin {
    static final int JOB_ID = 4711;
    /** Toutes les 30 minutes au mieux : Android regroupe les tâches pour économiser la batterie. */
    static final long PERIODE_MS = 30L * 60L * 1000L;

    @PluginMethod
    public void activer(PluginCall call) {
        Context ctx = getContext();
        JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(ctx, VeilleService.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(PERIODE_MS)
            .setPersisted(true)
            .build();
        int r = js.schedule(job);
        JSObject ret = new JSObject();
        ret.put("actif", r == JobScheduler.RESULT_SUCCESS);
        call.resolve(ret);
    }

    @PluginMethod
    public void desactiver(PluginCall call) {
        JobScheduler js = (JobScheduler) getContext().getSystemService(Context.JOB_SCHEDULER_SERVICE);
        js.cancel(JOB_ID);
        JSObject ret = new JSObject();
        ret.put("actif", false);
        call.resolve(ret);
    }

    @PluginMethod
    public void etat(PluginCall call) {
        JobScheduler js = (JobScheduler) getContext().getSystemService(Context.JOB_SCHEDULER_SERVICE);
        boolean actif = false;
        for (JobInfo j : js.getAllPendingJobs()) {
            if (j.getId() == JOB_ID) actif = true;
        }
        JSObject ret = new JSObject();
        ret.put("actif", actif);
        call.resolve(ret);
    }
}
