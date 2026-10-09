package com.arif.SMSForwarder

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class SmsListenerService : Service() {

    companion object {
        const val CHANNEL_ID = "SmsForwarderServiceChannel"
        const val ACTION_START = "ACTION_START"
        const val ACTION_STOP = "ACTION_STOP"
    }

    override fun onBind(intent: Intent?): IBinder? {
        return null
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        // নোটিফিকেশন তৈরি এবং ফোরগ্রাউন্ড সার্ভিস চালু
        startForegroundService()

        // সিস্টেমকে মেমোরি ক্লিয়ার করার সময় সার্ভিস রিস্টার্ট করতে বলে
        return START_STICKY
    }

    private fun startForegroundService() {
        createNotificationChannel()

        val notificationIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        // --- পরিবর্তন: মিনিমাল নোটিফিকেশন সেটআপ ---
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("SMS Forwarder Active")
            .setContentText("Running in background")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(pendingIntent)
            .setOngoing(true) // ইউজার সরাতে পারবে না (সার্ভিস বেঁচে থাকার জন্য জরুরি)
            .setPriority(NotificationCompat.PRIORITY_MIN) // <-- পরিবর্তন: এটি আইকন হাইড করে রাখবে
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setShowWhen(false) // সময় দেখাবে না
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(1, notification)
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // --- পরিবর্তন: ইম্পর্টেন্স MIN করা হয়েছে ---
            val serviceChannel = NotificationChannel(
                CHANNEL_ID,
                "SMS Forwarder Service Channel",
                NotificationManager.IMPORTANCE_MIN // <-- পরিবর্তন: এটি সাউন্ড/আইকন বন্ধ করবে
            ).apply {
                setShowBadge(false) // অ্যাপ আইকনে ডট দেখাবে না
                lockscreenVisibility = Notification.VISIBILITY_SECRET // লকস্ক্রিনে দেখাবে না
            }

            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(serviceChannel)
        }
    }
}