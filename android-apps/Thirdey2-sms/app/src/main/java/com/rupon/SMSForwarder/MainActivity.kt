package com.arif.SMSForwarder

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.googlefonts.Font
import androidx.compose.ui.text.googlefonts.GoogleFont
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import com.arif.SMSForwarder.SharedPreferencesManager
import com.arif.SMSForwarder.SmsListenerService

// --- Font Provider ---
val provider = GoogleFont.Provider(
    providerAuthority = "com.google.android.gms.fonts",
    providerPackage = "com.google.android.gms",
    certificates = 0
)
val interFont = GoogleFont("Inter")
val interFontFamily = FontFamily(
    Font(googleFont = interFont, fontProvider = provider),
    Font(googleFont = interFont, fontProvider = provider, weight = FontWeight.Bold)
)

// --- App Colors ---
val colorPrimary = Color(0xFF007BFF)
val colorBackground = Color(0xFFEEEEEE)
val colorSurface = Color.White
val colorSuccess = Color(0xFF28A745)
val colorError = Color(0xFFDC3545)
val colorTextPrimary = Color(0xFF212529)
val colorTextSecondary = Color(0xFF6C757D)
val colorBorder = Color(0xFFDEE2E6)
val colorRetry = Color(0xFFFFC107) // হলুদ

// --- Gradient Colors ---
val gradientOn = Brush.horizontalGradient(listOf(Color(0xFF198754), Color(0xFF22C55E)))
val gradientOff = Brush.horizontalGradient(listOf(Color(0xFFDC3545), Color(0xFFEF4444)))
val gradientTopBar = Brush.horizontalGradient(listOf(Color(0xFF198754), Color(0xFF22C55E)))

// --- Global Log Updater ---
// এই ফাইলের সংজ্ঞাটি SmsListener.kt থেকে আসছে।

class MainActivity : ComponentActivity() {

    private lateinit var sharedPreferencesManager: SharedPreferencesManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sharedPreferencesManager = SharedPreferencesManager(this)

        setContent {
            MaterialTheme(
                typography = MaterialTheme.typography.copy(
                    bodyLarge = MaterialTheme.typography.bodyLarge.copy(fontFamily = interFontFamily),
                    titleLarge = MaterialTheme.typography.titleLarge.copy(fontFamily = interFontFamily),
                    titleMedium = MaterialTheme.typography.titleMedium.copy(fontFamily = interFontFamily),
                    labelLarge = MaterialTheme.typography.labelLarge.copy(fontFamily = interFontFamily)
                )
            ) {
                SmsForwarderScreen(
                    sharedPrefsManager = sharedPreferencesManager,
                    context = this
                )
            }
        }
    }
}

// =================================================================
// UI Components and Logic
// =================================================================

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SmsForwarderScreen(
    sharedPrefsManager: SharedPreferencesManager,
    context: Context
) {
    val localContext = LocalContext.current

    var sim1Number by remember { mutableStateOf(sharedPrefsManager.getSimNumber(1)) }
    var sim2Number by remember { mutableStateOf(sharedPrefsManager.getSimNumber(2)) }
    var isListening by remember { mutableStateOf(sharedPrefsManager.getListeningState()) }

    val logMessages = remember {
        mutableStateListOf<String>().apply {
            addAll(sharedPrefsManager.getLogs())
        }
    }
    var showNoticeDialog by remember { mutableStateOf(false) }

    // --- Battery Optimization Fix ---
    // অ্যাপ ওপেন করলেই এটি চেক করবে এবং পারমিশন চাইবে যাতে অ্যাপ ব্যাকগ্রাউন্ডে কিল না হয়
    LaunchedEffect(Unit) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (!pm.isIgnoringBatteryOptimizations(context.packageName)) {
                try {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:${context.packageName}")
                    }
                    context.startActivity(intent)
                } catch (e: Exception) {
                    Log.e("BatteryOpt", "Failed to open battery settings", e)
                    Toast.makeText(context, "Please disable Battery Optimization manually", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    // --- Log Update Logic ---
    val updateLog: (String, String?) -> Unit = { newLog, oldLogIdToReplace ->
        (context as ComponentActivity).runOnUiThread {
            if (oldLogIdToReplace != null) {
                val index = logMessages.indexOfFirst { it.startsWith(oldLogIdToReplace) }
                if (index != -1) {
                    logMessages[index] = newLog
                } else {
                    logMessages.add(0, newLog)
                }
            } else {
                logMessages.add(0, newLog)
            }
            while (logMessages.size > 50) {
                logMessages.removeLast()
            }
        }
    }

    DisposableEffect(Unit) {
        // এখানে globalNewLogUpdater এর মান সেট করা হচ্ছে
        globalNewLogUpdater = updateLog
        onDispose {
            globalNewLogUpdater = null
        }
    }

    // --- Permissions ---
    val basePermissions = remember {
        mutableListOf(
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_SMS,
            Manifest.permission.READ_PHONE_STATE
        ).apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                add(Manifest.permission.FOREGROUND_SERVICE_DATA_SYNC)
            }
        }.toTypedArray()
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions(),
        onResult = { permissionsMap ->
            val allGranted = permissionsMap.all { it.value }
            if (allGranted) {
                Toast.makeText(localContext, "All Permissions Granted!", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(localContext, "Some permissions were denied.", Toast.LENGTH_LONG).show()
            }
        }
    )

    LaunchedEffect(Unit) {
        val neededPermissions = basePermissions.filter {
            ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
        }.toTypedArray()

        if (neededPermissions.isNotEmpty()) {
            permissionLauncher.launch(neededPermissions)
        }
    }

    // --- Retry Logic ---
    val onRetryClick: (String) -> Unit = { retryString ->
        try {
            val parts = retryString.split("::")
            if (parts.size < 6 || parts[0] != "RETRY") {
                Log.e("RETRY_LOGIC", "Invalid retry data format.")
                Toast.makeText(localContext, "Retry data corrupted", Toast.LENGTH_SHORT).show()
            } else {
                val logId = parts[1] + "::" + parts[2]
                val phoneNumber = parts[3]
                val sender = parts[4]
                val messageBody = parts[5]
                val simName = parts[6]

                SmsListener.acquireWakeLock(localContext)

                val workData = Data.Builder()
                    .putString("PHONE_NUMBER", phoneNumber)
                    .putString("SENDER", sender)
                    .putString("MESSAGE_BODY", messageBody)
                    .putString("SIM_NAME", simName)
                    .putString("RETRY_LOG_ID", logId)
                    .build()

                val workRequest = OneTimeWorkRequest.Builder(ForwardingWorker::class.java)
                    .setInputData(workData)
                    .build()

                val uniqueWorkName = "sms_fwd_retry_${System.currentTimeMillis()}"

                WorkManager.getInstance(localContext).enqueueUniqueWork(
                    uniqueWorkName,
                    ExistingWorkPolicy.KEEP,
                    workRequest
                )

                Toast.makeText(localContext, "Retrying to send SMS...", Toast.LENGTH_SHORT).show()
            }
        } catch (e: Exception) {
            Log.e("RETRY_LOGIC", "Retry failed", e)
            Toast.makeText(localContext, "Retry failed: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    if (showNoticeDialog) {
        NoticeDialog(onDismiss = { showNoticeDialog = false })
    }

    Scaffold(
        topBar = {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(gradientTopBar)
            ) {
                TopAppBar(
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = Icons.Default.Visibility,
                                contentDescription = "Eye Logo",
                                tint = Color.White,
                                modifier = Modifier.size(28.dp)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = "Thirdey2 sms",
                                fontWeight = FontWeight.Bold,
                                fontFamily = interFontFamily,
                                color = Color.White
                            )
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = Color.Transparent,
                        titleContentColor = Color.White
                    )
                )
            }
        },
        containerColor = colorBackground
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            ServiceControlCard(
                isListening = isListening,
                onToggle = { newState ->
                    isListening = newState
                    sharedPrefsManager.saveListeningState(newState)
                    toggleService(localContext, isListening)
                }
            )

            SimConfigurationCard(
                sim1Number = sim1Number,
                sim2Number = sim2Number,
                onSim1Change = { sim1Number = it },
                onSim2Change = { sim2Number = it },
                onSim1Save = {
                    val numberToSave = if (sim1Number.equals("No", ignoreCase = true)) "" else sim1Number
                    sharedPrefsManager.saveSimNumber(1, numberToSave)
                    sim1Number = numberToSave
                    Toast.makeText(localContext, "SIM 1 number saved!", Toast.LENGTH_SHORT).show()
                },
                onSim2Save = {
                    val numberToSave = if (sim2Number.equals("No", ignoreCase = true)) "" else sim2Number
                    sharedPrefsManager.saveSimNumber(2, numberToSave)
                    sim2Number = numberToSave
                    Toast.makeText(localContext, "SIM 2 number saved!", Toast.LENGTH_SHORT).show()
                }
            )

            LogSection(
                logMessages = logMessages,
                onClearLogs = {
                    logMessages.clear()
                    sharedPrefsManager.clearLogs()
                    Toast.makeText(localContext, "Logs Cleared", Toast.LENGTH_SHORT).show()
                },
                onShowNotice = {
                    showNoticeDialog = true
                },
                onRetryClick = onRetryClick,
                modifier = Modifier.weight(1f)
            )
        }
    }
}

// =================================================================
// Component Functions
// =================================================================

@Composable
fun ServiceControlCard(isListening: Boolean, onToggle: (Boolean) -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = colorSurface),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                if (isListening) "Running" else "Stopped",
                fontFamily = interFontFamily,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                color = if (isListening) colorSuccess else colorError
            )
            CustomToggleButton(
                isListening = isListening,
                onToggle = onToggle
            )
        }
    }
}

@Composable
fun CustomToggleButton(
    isListening: Boolean,
    onToggle: (Boolean) -> Unit
) {
    val toggleShape = RoundedCornerShape(50.dp)
    val onModifier = if (isListening) Modifier.background(gradientOn, toggleShape) else Modifier.background(Color.Transparent, toggleShape)
    val offModifier = if (!isListening) Modifier.background(gradientOff, toggleShape) else Modifier.background(Color.Transparent, toggleShape)

    Row(
        modifier = Modifier
            .border(1.dp, colorBorder, toggleShape)
            .clip(toggleShape)
    ) {
        Box(
            modifier = offModifier
                .clickable { if (isListening) onToggle(false) }
                .padding(horizontal = 16.dp, vertical = 8.dp),
            contentAlignment = Alignment.Center
        ) {
            Text("OFF", fontFamily = interFontFamily, fontWeight = FontWeight.Bold, color = if (!isListening) Color.White else colorTextSecondary, fontSize = 12.sp)
        }
        Box(
            modifier = onModifier
                .clickable { if (!isListening) onToggle(true) }
                .padding(horizontal = 16.dp, vertical = 8.dp),
            contentAlignment = Alignment.Center
        ) {
            Text("ON", fontFamily = interFontFamily, fontWeight = FontWeight.Bold, color = if (isListening) Color.White else colorTextSecondary, fontSize = 12.sp)
        }
    }
}

@Composable
fun SimConfigurationCard(
    sim1Number: String,
    sim2Number: String,
    onSim1Change: (String) -> Unit,
    onSim2Change: (String) -> Unit,
    onSim1Save: () -> Unit,
    onSim2Save: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = colorSurface),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            SimInputSection("SIM 1 Number", sim1Number, onSim1Change, onSim1Save)
            SimInputSection("SIM 2 Number", sim2Number, onSim2Change, onSim2Save)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SimInputSection(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    onSaveClick: () -> Unit
) {
    val focusManager = LocalFocusManager.current
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label, fontFamily = interFontFamily) },
        leadingIcon = { Icon(Icons.Default.PhoneAndroid, contentDescription = null) },
        trailingIcon = {
            Button(
                onClick = {
                    onSaveClick()
                    focusManager.clearFocus()
                },
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = colorPrimary),
                modifier = Modifier.padding(end = 4.dp),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)
            ) {
                Text("Save", fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = interFontFamily, color = Color.White)
            }
        },
        shape = RoundedCornerShape(12.dp),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
        singleLine = true,
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = colorPrimary,
            unfocusedBorderColor = colorBorder,
            focusedLabelColor = colorPrimary,
            unfocusedLabelColor = colorTextSecondary
        ),
        textStyle = TextStyle(fontFamily = interFontFamily)
    )
}

@Composable
fun LogSection(
    logMessages: List<String>,
    onClearLogs: () -> Unit,
    onShowNotice: () -> Unit,
    onRetryClick: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    Column(modifier = modifier) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("SMS Logs", fontWeight = FontWeight.Bold, fontSize = 18.sp, fontFamily = interFontFamily, color = colorTextPrimary)
            Spacer(modifier = Modifier.weight(1f))

            // --- Notice Button ---
            Button(
                onClick = onShowNotice,
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = colorPrimary),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)
            ) {
                Text("Notice", fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = interFontFamily, color = Color.White)
            }

            Spacer(modifier = Modifier.width(8.dp))

            Button(
                onClick = onClearLogs,
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = colorError),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)
            ) {
                Text("Clear Logs", fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = interFontFamily, color = Color.White)
            }
        }
        Spacer(modifier = Modifier.height(8.dp))
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = colorSurface),
            elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
        ) {
            if (logMessages.isEmpty()) {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize().padding(32.dp)) {
                    Text("No SMS logs yet", color = colorTextSecondary, fontFamily = interFontFamily)
                }
            } else {
                Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                    logMessages.forEachIndexed { index, logString ->
                        LogItem(logString = logString, onRetry = onRetryClick)
                        if (index < logMessages.size - 1) {
                            Divider(modifier = Modifier.padding(horizontal = 16.dp), color = colorBorder)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun LogItem(
    logString: String,
    onRetry: (String) -> Unit
) {
    val lines = logString.lines()
    val logId = lines.firstOrNull { it.startsWith("LOG_ID::") } ?: ""
    val header = lines.firstOrNull { !it.startsWith("LOG_ID::") } ?: logString
    var retryString = ""
    if (lines.lastOrNull()?.startsWith("RETRY::") == true) {
        retryString = lines.last()
    }
    var details = ""
    val potentialDetailsIndex = if (retryString.isNotEmpty()) lines.size - 2 else lines.size - 1
    if (lines.getOrNull(potentialDetailsIndex)?.startsWith("SIM:") == true) {
        details = lines[potentialDetailsIndex]
    }
    val messageBodyStartIndex = if (logId.isNotEmpty() && header != logString) 2 else 1
    val messageBodyEndIndex = if (details.isNotEmpty()) potentialDetailsIndex else if (retryString.isNotEmpty()) lines.size - 1 else lines.size
    val messageBody = if (messageBodyStartIndex < messageBodyEndIndex) lines.subList(messageBodyStartIndex, messageBodyEndIndex).joinToString("\n") else ""

    val isSuccess = header.contains("Success")
    val isError = header.contains("Error") || header.contains("Failed")
    val canRetry = isError && retryString.isNotEmpty()

    val headerColor = when {
        isSuccess -> colorSuccess
        isError -> colorError
        else -> colorTextSecondary
    }
    val icon = when {
        isSuccess -> Icons.Default.CheckCircle
        isError -> Icons.Default.Error
        else -> Icons.Default.Info
    }

    Row(
        verticalAlignment = Alignment.Top,
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 12.dp)
    ) {
        Icon(imageVector = icon, contentDescription = "Status", tint = headerColor, modifier = Modifier.padding(top = 3.dp).size(18.dp))
        Spacer(modifier = Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(text = header, fontFamily = interFontFamily, fontWeight = FontWeight.Bold, color = headerColor, fontSize = 14.sp)
            Spacer(modifier = Modifier.height(4.dp))
            Text(text = messageBody, fontFamily = interFontFamily, color = colorTextPrimary, fontSize = 14.sp, lineHeight = 20.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
            Spacer(modifier = Modifier.height(4.dp))
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(text = details, fontFamily = interFontFamily, color = colorTextSecondary, fontSize = 12.sp, modifier = Modifier.weight(1f))
                if (canRetry) {
                    Button(
                        onClick = { onRetry(retryString) },
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = colorRetry),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                        modifier = Modifier.padding(start = 8.dp)
                    ) {
                        Text("Retry", fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = interFontFamily, color = Color.Black)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NoticeDialog(onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("নোটিশ:", fontFamily = interFontFamily, fontWeight = FontWeight.Bold, color = colorTextPrimary, fontSize = 18.sp)
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Default.Close, contentDescription = "Close Dialog")
                }
            }
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                NoticeItem(Icons.Default.PrivacyTip, colorPrimary, "এই অ্যাপটি আপনার গোপনীয়তা রক্ষা করে এবং শুধুমাত্র Appointment নম্বর থেকে প্রাপ্ত SMS পাঠানো হয়।")
                NoticeItem(Icons.Default.Schedule, Color(0xFFD97706), "*** আপনার Appointment কনফার্মের জন্য বিকাল ৩:০০ - ৮:০০ পর্যন্ত অ্যাপটি চালু বা ব্যাকগ্রাউন্ডে রাখুন, রিমুভ করবেন না। মোবাইল ডাটা বা ওয়াইফাই চালু রাখুন। ***", isBold = true)
                NoticeItem(Icons.Default.BatteryAlert, colorError, "** সর্বোচ্চ পারফরম্যান্স নিশ্চিত করুন: পাওয়ার সেভিং মোড বন্ধ রাখুন এবং ব্যাটারি অনুমতি দিন।**", isBold = true)
            }
        },
        confirmButton = {},
        dismissButton = {},
        shape = RoundedCornerShape(16.dp),
        containerColor = colorSurface
    )
}

@Composable
fun NoticeItem(icon: ImageVector, iconColor: Color, text: String, isBold: Boolean = false) {
    Row(verticalAlignment = Alignment.Top) {
        Icon(imageVector = icon, contentDescription = null, tint = iconColor, modifier = Modifier.padding(top = 2.dp).size(18.dp))
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = buildAnnotatedString {
                if (isBold) withStyle(style = SpanStyle(fontWeight = FontWeight.Bold)) { append(text) } else append(text)
            },
            fontFamily = interFontFamily,
            color = if (isBold) iconColor else colorTextPrimary,
            fontSize = 13.sp,
            lineHeight = 18.sp
        )
    }
}

// =================================================================
// Utility Functions
// =================================================================

fun toggleService(context: Context, start: Boolean) {
    val intent = Intent(context, SmsListenerService::class.java)
    if (start) {
        intent.action = SmsListenerService.ACTION_START
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
        Toast.makeText(context, "Service Started", Toast.LENGTH_SHORT).show()
    } else {
        intent.action = SmsListenerService.ACTION_STOP
        context.startService(intent)
        Toast.makeText(context, "Service Stopped", Toast.LENGTH_SHORT).show()
    }
}