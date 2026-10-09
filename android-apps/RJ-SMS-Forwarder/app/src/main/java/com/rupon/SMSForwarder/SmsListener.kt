package com.arif.SMSForwarder

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.PowerManager
import android.provider.Telephony
import android.telephony.SubscriptionManager
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import com.arif.SMSForwarder.SharedPreferencesManager

/**
 * এই ভেরিয়েবলটি SmsListener এবং ForwardingWorker থেকে MainActivity-এর UI-তে
 * লগ পাঠানোর জন্য ব্যবহৃত হয়। এটিই একমাত্র সংজ্ঞা হওয়া উচিত।
 *
 * @param logString SMS বা Error এর বিস্তারিত লগ মেসেজ
 * @param retryLogId যদি একটি পুরনো লগ আপডেট করা হয়, তবে তার ID
 */
@JvmField // কনফ্লিক্ট এড়াতে
var globalNewLogUpdater: ((logString: String, retryLogId: String?) -> Unit)? = null


class SmsListener : BroadcastReceiver() {

    companion object {
        private var wakeLock: PowerManager.WakeLock? = null

        fun acquireWakeLock(context: Context) {
            try {
                val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                // WakeLock 10 মিনিটের জন্য (600,000 milliseconds)
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SMSForwarder::WakeLockTag")
                wakeLock?.acquire(10 * 60 * 1000L)
                Log.d("SmsListener", "WakeLock acquired")
            } catch (e: Exception) {
                Log.e("SmsListener", "Error acquiring WakeLock", e)
            }
        }

        fun releaseWakeLock() {
            try {
                if (wakeLock?.isHeld == true) {
                    wakeLock?.release()
                    wakeLock = null
                    Log.d("SmsListener", "WakeLock released")
                }
            } catch (e: Exception) {
                Log.e("SmsListener", "Error releasing WakeLock", e)
            }
        }
    }

    override fun onReceive(context: Context?, intent: Intent?) {
        // নিশ্চিত করুন যে এটি একটি SMS_RECEIVED অ্যাকশন এবং কনটেক্সট নাল নয়
        if (intent?.action == Telephony.Sms.Intents.SMS_RECEIVED_ACTION && context != null) {

            val prefs = SharedPreferencesManager(context)

            // READ_PHONE_STATE পারমিশন চেক করা
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
                Log.e("SMS_LISTENER", "READ_PHONE_STATE permission is missing!")
                // পারমিশন না থাকলে লগ সেভ করুন এবং রিটার্ন করুন
                val logString = "LOG_ID::${System.currentTimeMillis()}\nError: READ_PHONE_STATE permission missing."
                prefs.saveLog(logString)
                globalNewLogUpdater?.invoke(logString, null)
                return
            }

            val sim1Number = prefs.getSimNumber(1)
            val sim2Number = prefs.getSimNumber(2)

            val subId = intent.getIntExtra("subscription", -1)
            if (subId == -1) {
                Log.e("SMS_LISTENER", "Could not get subscription ID.")
                val logString = "LOG_ID::${System.currentTimeMillis()}\nError: Could not get subscription ID."
                prefs.saveLog(logString)
                globalNewLogUpdater?.invoke(logString, null)
                return
            }

            // SIM সল্ট ইনফরমেশন পাওয়া
            val subManager = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as SubscriptionManager
            val subInfo = subManager.getActiveSubscriptionInfo(subId)

            if (subInfo == null) {
                Log.e("SMS_LISTENER", "Could not get SubscriptionInfo for subId: $subId")
                val logString = "LOG_ID::${System.currentTimeMillis()}\nError: Could not get SIM info."
                prefs.saveLog(logString)
                globalNewLogUpdater?.invoke(logString, null)
                return
            }

            val slotIndex = subInfo.simSlotIndex

            val forwarderNumber: String
            val simName: String

            // SIM নম্বর এবং নাম নির্ধারণ
            if (slotIndex == 0 && sim1Number.isNotBlank()) {
                forwarderNumber = sim1Number
                simName = "SIM1"
            } else if (slotIndex == 1 && sim2Number.isNotBlank()) {
                forwarderNumber = sim2Number
                simName = "SIM2"
            } else {
                // নম্বর সেভ করা না থাকলে SMS ইগনোর করা
                Log.w("SMS_LISTENER", "Ignoring SMS on Slot ${slotIndex + 1}. No number saved.")
                return
            }

            // WakeLock চালু করা যাতে SMS ফরওয়ার্ড করার সময় ফোন ঘুমিয়ে না যায়
            acquireWakeLock(context)

            // SMS মেসেজ বের করা
            val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
            messages?.forEach { sms ->
                val messageBody = sms.displayMessageBody
                val timestamp = sms.timestampMillis

                // WorkManager এ ডেটা পাস করার জন্য Data অবজেক্ট তৈরি করা
                val workData = Data.Builder()
                    .putString("PHONE_NUMBER", forwarderNumber)
                    .putString("SENDER", forwarderNumber)
                    .putString("MESSAGE_BODY", messageBody)
                    .putString("SIM_NAME", simName)
                    .build()

                // ফরওয়ার্ডিং এর জন্য OneTimeWorkRequest তৈরি করা
                val workRequest = OneTimeWorkRequest.Builder(ForwardingWorker::class.java)
                    .setInputData(workData)
                    .build()

                // WorkManager এ কাজ যুক্ত করা
                val uniqueWorkName = "sms_fwd_${timestamp}"
                WorkManager.getInstance(context).enqueueUniqueWork(
                    uniqueWorkName,
                    ExistingWorkPolicy.KEEP, // একই নামের কাজ থাকলে, পুরনো কাজটি রাখা
                    workRequest
                )
            }
        }
    }
}