package com.arif.SMSForwarder

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class ForwardingWorker(appContext: Context, workerParams: WorkerParameters) :
    CoroutineWorker(appContext, workerParams) {

    private val prefs = SharedPreferencesManager(appContext)

    override suspend fun doWork(): Result {

        val retryLogId = inputData.getString("RETRY_LOG_ID")

        var phoneNumber = inputData.getString("PHONE_NUMBER") ?: return Result.failure()
        var sender = inputData.getString("SENDER") ?: return Result.failure()
        val messageBody = inputData.getString("MESSAGE_BODY") ?: return Result.failure()
        val simName = inputData.getString("SIM_NAME") ?: "Unknown SIM"

        val timeStamp = SimpleDateFormat("hh:mm:ss", Locale.US).format(Date())

        if (phoneNumber.startsWith("+88")) {
            phoneNumber = phoneNumber.substring(3)
        }
        if (sender.startsWith("+88")) {
            sender = sender.substring(3)
        }

        var logHeader: String
        val logDetails = "SIM: $simName"

        val currentLogId = retryLogId ?: "LOG_ID::${System.currentTimeMillis()}"
        val retryData = "RETRY::$currentLogId::$phoneNumber::$sender::$messageBody::$simName"


        return try {
            val targetUrl = "https://thirdeyesms.xyz/sms.php"
            val encodedPhoneNumber = URLEncoder.encode(phoneNumber, "UTF-8")
            val encodedSender = URLEncoder.encode(sender, "UTF-8")
            val encodedMessage = URLEncoder.encode(messageBody, "UTF-8")
            val urlString = "$targetUrl?phone=$encodedPhoneNumber&sender=$encodedSender&message=$encodedMessage"

            val url = URL(urlString)
            val connection = url.openConnection() as HttpURLConnection
            connection.requestMethod = "GET"

            // 🔥 ফিক্স: User-Agent যুক্ত করা হয়েছে যাতে সার্ভার রিকোয়েস্ট ব্লক না করে 🔥
            connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Android 10; Mobile; rv:68.0) Gecko/68.0 Firefox/68.0")

            connection.connectTimeout = 15000
            connection.readTimeout = 15000
            val responseCode = connection.responseCode

            if (responseCode == HttpURLConnection.HTTP_OK) {
                // ... (সফল হওয়ার কোড) ...
                Log.i("WORKER_FWD", "Success: 200")
                logHeader = "$timeStamp • Success (Code 200)"
                val logString = "$currentLogId\n$logHeader\n$messageBody\n$logDetails"

                if (retryLogId != null) {
                    prefs.updateLog(retryLogId, logString)
                    globalNewLogUpdater?.invoke(logString, retryLogId)
                } else {
                    prefs.saveLog(logString)
                    globalNewLogUpdater?.invoke(logString, null)
                }
                Result.success()

            } else {
                // --- SMS পাঠাতে ব্যর্থ (সার্ভার রেসপন্স) ---
                Log.e("WORKER_FWD", "Failed: $responseCode")
                logHeader = "$timeStamp • Failed (Code $responseCode)"
                val logString = "$currentLogId\n$logHeader\n$messageBody\n$logDetails\n$retryData"

                if (retryLogId != null) {
                    prefs.updateLog(retryLogId, logString)
                    globalNewLogUpdater?.invoke(logString, retryLogId)
                } else {
                    prefs.saveLog(logString)
                    globalNewLogUpdater?.invoke(logString, null)
                }

                Result.failure()
            }
        } catch (e: Exception) {
            // --- SMS পাঠাতে ব্যর্থ (নেটওয়ার্ক বা অন্য কোনো এরর) ---
            Log.e("WORKER_FWD", "Network Error: ${e.message}")
            logHeader = "$timeStamp • Error (Network)"
            val logString = "$currentLogId\n$logHeader\n$messageBody\n$logDetails\n$retryData"

            if (retryLogId != null) {
                prefs.updateLog(retryLogId, logString)
                globalNewLogUpdater?.invoke(logString, retryLogId)
            } else {
                prefs.saveLog(logString)
                globalNewLogUpdater?.invoke(logString, null)
            }

            Result.failure()
        } finally {
            SmsListener.releaseWakeLock()
        }
    }
}
