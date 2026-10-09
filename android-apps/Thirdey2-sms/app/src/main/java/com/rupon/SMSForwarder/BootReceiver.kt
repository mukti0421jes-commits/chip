package com.arif.SMSForwarder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == "android.intent.action.QUICKBOOT_POWERON") {

            val prefs = SharedPreferencesManager(context)
            // অ্যাপ যদি আগে চালু (ON) অবস্থায় ছিল, তবেই রিস্টার্টের পর চালু হবে
            if (prefs.getListeningState()) {
                val serviceIntent = Intent(context, SmsListenerService::class.java)
                serviceIntent.action = SmsListenerService.ACTION_START

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    // এটি অ্যাপ ওপেন করবে না, শুধু নোটিফিকেশন বারে সার্ভিস আনবে
                    context.startForegroundService(serviceIntent)
                } else {
                    context.startService(serviceIntent)
                }
                Log.d("BootReceiver", "Service started automatically after reboot")
            }
        }
    }
}