package com.arif.SMSForwarder

import android.util.Log
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object NetworkManager {

    var logUpdater: ((String) -> Unit)? = null

    // <-- পরিবর্তন করা হয়েছে
    private const val TARGET_URL = "https://duttauzzal.shop/sms.php" // <-- URL পরিবর্তন করা হয়েছে

    // Note: This function is not currently used in the app.
    // ForwardingWorker.kt is handling the network tasks.
    fun forwardSms(sender: String, message: String) {

        val timeStamp = SimpleDateFormat("hh:mm:ss", Locale.getDefault()).format(Date())
        val logStart = "$timeStamp | From $sender"

        logUpdater?.invoke("$logStart -> Sending to Domain...")

        Thread {
            var connection: HttpURLConnection? = null
            try {
                val encodedSender = URLEncoder.encode(sender, "UTF-8")
                val encodedMessage = URLEncoder.encode(message, "UTF-8")

                // This URL format is incorrect (missing the phone= parameter)
                // <-- সতর্কবার্তা: এই URL ফরম্যাটটি ForwardingWorker-এর সাথে মেলে না।
                val urlString = "$TARGET_URL?sender=$encodedSender&message=$encodedMessage"
                val url = URL(urlString)

                connection = url.openConnection() as HttpURLConnection
                connection.requestMethod = "GET"
                connection.connectTimeout = 10000

                val responseCode = connection.responseCode

                if (responseCode == HttpURLConnection.HTTP_OK) {
                    Log.i("SMS_FWD_NET", "Success: 200")
                    logUpdater?.invoke("$logStart -> SUCCESS (Code 200)")
                } else {
                    Log.e("SMS_FWD_NET", "Failed: $responseCode")
                    logUpdater?.invoke("$logStart -> FAILED (Code $responseCode)")
                }
            } catch (e: Exception) {
                Log.e("SMS_FWD_NET", "Network Error: ${e.message}")
                logUpdater?.invoke("$logStart -> ERROR: Network issue")
            } finally {
                connection?.disconnect()
            }
        }.start()
    }

    // ✅ টেস্ট ফরওয়ার্ড — phone+sender+message সহ (ForwardingWorker এর সাথে মেলে)
    // onResult(true/false) মূল থ্রেডে নয়, ব্যাকগ্রাউন্ড থ্রেডে ডাকা হয় — UI তে Toast দিতে runOnUiThread লাগবে।
    fun sendTest(number: String, message: String, onResult: ((Boolean) -> Unit)? = null) {
        Thread {
            var connection: HttpURLConnection? = null
            try {
                val encodedNumber = URLEncoder.encode(number, "UTF-8")
                val encodedMessage = URLEncoder.encode(message, "UTF-8")
                val urlString =
                    "$TARGET_URL?phone=$encodedNumber&sender=$encodedNumber&message=$encodedMessage"
                connection = URL(urlString).openConnection() as HttpURLConnection
                connection.requestMethod = "GET"
                connection.connectTimeout = 10000
                connection.readTimeout = 10000
                val ok = connection.responseCode == HttpURLConnection.HTTP_OK
                Log.i("SMS_FWD_TEST", "Test result: ${connection.responseCode}")
                onResult?.invoke(ok)
            } catch (e: Exception) {
                Log.e("SMS_FWD_TEST", "Test error: ${e.message}")
                onResult?.invoke(false)
            } finally {
                connection?.disconnect()
            }
        }.start()
    }
}