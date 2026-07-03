package com.example.smsforward

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/**
 * Listens for incoming SMS and stores them locally so the UI can show the OTP.
 * It does not forward anything anywhere.
 */
class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (messages.isEmpty()) return

        // Multipart messages are split; join their bodies into one.
        val sender = messages[0].originatingAddress ?: "Unknown"
        val body = messages.joinToString("") { it.messageBody ?: "" }
        val time = System.currentTimeMillis()

        SmsStore.add(context, sender, body, time)

        // Tell the activity (if open) to refresh.
        context.sendBroadcast(Intent(ACTION_NEW_SMS).setPackage(context.packageName))
    }

    companion object {
        const val ACTION_NEW_SMS = "com.example.smsforward.NEW_SMS"
    }
}
