package com.arif.SMSForwarder

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

class SharedPreferencesManager(context: Context) {

    private val prefs = context.getSharedPreferences("sms_fwd_prefs", Context.MODE_PRIVATE)
    private val gson = Gson()

    private val KEY_LOGS = "sms_logs"

    fun saveSimNumber(simId: Int, number: String) {
        prefs.edit().putString("sim_$simId", number).apply()
    }

    fun getSimNumber(simId: Int): String {
        return prefs.getString("sim_$simId", "") ?: ""
    }

    fun saveListeningState(isListening: Boolean) {
        prefs.edit().putBoolean("is_listening", isListening).apply()
    }

    fun getListeningState(): Boolean {
        return prefs.getBoolean("is_listening", false)
    }

    private fun saveLogsList(logs: List<String>) {
        val logsJson = gson.toJson(logs)
        prefs.edit().putString(KEY_LOGS, logsJson).apply()
    }

    fun saveLog(logMessage: String) {
        val logs = getLogs().toMutableList()
        logs.add(0, logMessage) // নতুন লগ প্রথমে যোগ করা
        while (logs.size > 50) { // সর্বোচ্চ ৫০টি লগ রাখা
            logs.removeLast()
        }
        saveLogsList(logs) // হেলপার দিয়ে সেভ
    }

    fun updateLog(logIdToUpdate: String, newLogString: String) {
        val logs = getLogs().toMutableList()
        // যে লগের *শুরুতে* logIdToUpdate আছে, সেটি খুঁজে বের করা
        val indexToUpdate = logs.indexOfFirst { it.startsWith(logIdToUpdate) }

        if (indexToUpdate != -1) {
            logs[indexToUpdate] = newLogString // পুরনো লগটি রিপ্লেস করা
            saveLogsList(logs) // পুরো লিস্ট আবার সেভ করা
        } else {
            // যদি কোনো কারণে খুঁজে না পায়, তাহলে নতুন হিসেবে সেভ করা
            saveLog(newLogString)
        }
    }

    fun getLogs(): List<String> {
        val logsJson = prefs.getString(KEY_LOGS, null)
        if (logsJson.isNullOrEmpty()) {
            return emptyList()
        }
        val type = object : TypeToken<List<String>>() {}.type
        return gson.fromJson(logsJson, type)
    }

    fun clearLogs() {
        prefs.edit().remove(KEY_LOGS).apply()
    }
}