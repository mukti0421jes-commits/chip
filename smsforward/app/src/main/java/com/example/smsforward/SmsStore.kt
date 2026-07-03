package com.example.smsforward

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * A tiny local store for received messages, backed by SharedPreferences.
 * Nothing here leaves the device — it is only used to render the on-screen list.
 */
data class SmsItem(
    val sender: String,
    val body: String,
    val otp: String?,
    val time: Long
)

object SmsStore {
    private const val PREFS = "sms_store"
    private const val KEY = "messages"
    private const val MAX = 100

    /** Extract a plausible OTP: the first standalone 4–8 digit run in the text. */
    fun extractOtp(body: String): String? {
        val match = Regex("(?<!\\d)(\\d{4,8})(?!\\d)").find(body)
        return match?.groupValues?.get(1)
    }

    fun add(context: Context, sender: String, body: String, time: Long) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val arr = JSONArray(prefs.getString(KEY, "[]"))
        val obj = JSONObject()
            .put("sender", sender)
            .put("body", body)
            .put("otp", extractOtp(body) ?: JSONObject.NULL)
            .put("time", time)
        // newest first
        val newArr = JSONArray()
        newArr.put(obj)
        for (i in 0 until minOf(arr.length(), MAX - 1)) newArr.put(arr.get(i))
        prefs.edit().putString(KEY, newArr.toString()).apply()
    }

    fun all(context: Context): List<SmsItem> {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val arr = JSONArray(prefs.getString(KEY, "[]"))
        val out = ArrayList<SmsItem>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            out.add(
                SmsItem(
                    sender = o.optString("sender"),
                    body = o.optString("body"),
                    otp = if (o.isNull("otp")) null else o.optString("otp"),
                    time = o.optLong("time")
                )
            )
        }
        return out
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().remove(KEY).apply()
    }
}
