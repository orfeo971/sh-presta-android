package fr.orfeo.shpresta;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Extensions propres à l'application, à déclarer avant le démarrage du pont Capacitor.
        registerPlugin(VeillePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
