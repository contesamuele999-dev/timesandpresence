package it.presencer.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // i plugin dell'app vanno registrati prima che parta il bridge
        registerPlugin(PrintPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
