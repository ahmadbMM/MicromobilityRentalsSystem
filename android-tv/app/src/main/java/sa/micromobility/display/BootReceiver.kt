package sa.micromobility.display

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Opens the display when the stick finishes booting. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val launch = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(launch)
    }
}
