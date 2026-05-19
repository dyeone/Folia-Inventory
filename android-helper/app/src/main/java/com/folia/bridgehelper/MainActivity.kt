package com.folia.bridgehelper

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.NetworkInterface
import java.net.URL

// Folia Bridge Helper — phase 2.
//
// Responsibilities:
//   1. One-time config: operator pastes Vercel base URL + bridge token,
//      stored in SharedPreferences.
//   2. Detect WiFi IP and wireless-debug state (via getprop, same as
//      before — Android doesn't expose these as APIs without root).
//   3. Try to enable wireless debugging programmatically by writing
//      Settings.Global.adb_wifi_enabled = 1. Requires the one-time ADB
//      grant of WRITE_SECURE_SETTINGS:
//          adb shell pm grant com.folia.bridgehelper android.permission.WRITE_SECURE_SETTINGS
//      If the grant isn't there, falls back to opening the settings
//      panel for a single user tap.
//   4. mDNS-browse the local network via NSD for _adb-tls-connect._tcp
//      (the service Android's adbd advertises when wireless debug is
//      on). Pick the entry whose host IP matches this phone's WiFi IP,
//      read its dynamic port.
//   5. Every 10s POST {deviceIp, debugPort} to /api/bridge?action=
//      phone-heartbeat. Mac bridge pulls this via ?action=phone-target.

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    HelperScreen()
                }
            }
        }
    }
}

private const val PREFS_NAME = "folia-bridge"
private const val PREF_URL = "bridge_url"
private const val PREF_TOKEN = "bridge_token"

@Composable
fun HelperScreen() {
    val ctx = LocalContext.current
    val prefs = remember { ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE) }
    var bridgeUrl by remember { mutableStateOf(prefs.getString(PREF_URL, "") ?: "") }
    var bridgeToken by remember { mutableStateOf(prefs.getString(PREF_TOKEN, "") ?: "") }
    var keepAwake by remember { mutableStateOf(true) }
    var ip by remember { mutableStateOf<String?>(null) }
    var tcpPort by remember { mutableStateOf<String?>(null) }
    var tlsPort by remember { mutableStateOf<String?>(null) }
    // mDNS-discovered live port — preferred when present since
    // service.adb.tls.port is sometimes a listener port that doesn't
    // match the port adbd actually advertises.
    var mdnsPort by remember { mutableStateOf<Int?>(null) }
    var lastHeartbeat by remember { mutableStateOf<String?>(null) }
    var canWriteSettings by remember { mutableStateOf(hasWriteSecureSettings(ctx)) }

    // Keep-screen-on toggle.
    LaunchedEffect(keepAwake) {
        val window = (ctx as? ComponentActivity)?.window ?: return@LaunchedEffect
        if (keepAwake) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    // Status poll: WiFi IP + wireless-debug ports every 2 s. Cheap.
    LaunchedEffect(Unit) {
        while (true) {
            ip = currentWifiIp()
            tcpPort = readSysProp("service.adb.tcp.port").takeIf { it.isNotBlank() }
            tlsPort = readSysProp("service.adb.tls.port").takeIf { it.isNotBlank() }
            canWriteSettings = hasWriteSecureSettings(ctx)
            delay(2_000)
        }
    }

    // mDNS browser. Runs continuously while the app is in foreground;
    // resolves the live _adb-tls-connect._tcp port whenever adbd
    // advertises it. NSD is the public Android API for mDNS — no extra
    // permissions needed beyond CHANGE_WIFI_MULTICAST_STATE on some
    // OEMs, which the manifest declares.
    DisposableEffect(Unit) {
        val nsd = ctx.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
        val listener = AdbMdnsListener(nsd) { port -> mdnsPort = port }
        listener.start()
        onDispose { listener.stop() }
    }

    // Heartbeat to Vercel every 10 s when we have a live target and a
    // configured bridge.
    val resolvedPort = mdnsPort?.toString() ?: tlsPort ?: tcpPort
    val hasConfig = bridgeUrl.isNotBlank() && bridgeToken.isNotBlank()
    LaunchedEffect(ip, resolvedPort, hasConfig, bridgeUrl, bridgeToken) {
        if (!hasConfig) return@LaunchedEffect
        while (true) {
            val curIp = ip
            val curPort = resolvedPort?.toIntOrNull()
            if (curIp != null && curPort != null) {
                val ok = sendHeartbeat(bridgeUrl.trim(), bridgeToken.trim(), curIp, curPort)
                lastHeartbeat = if (ok) "ok ${nowHm()}" else "failed ${nowHm()}"
            }
            delay(10_000)
        }
    }

    val wifiOn = ip != null
    val wirelessAdbOn = resolvedPort != null
    val readyForMac = wifiOn && wirelessAdbOn && hasConfig

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(WhiteBg)
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Folia Bridge Helper", fontSize = 22.sp, fontWeight = FontWeight.SemiBold)

        // Connection rollup.
        InfoCard(title = "Status") {
            StatusRow(
                ok = readyForMac,
                text = when {
                    !hasConfig -> "Bridge URL + token not set"
                    !wifiOn -> "WiFi off"
                    !wirelessAdbOn -> "Wireless debug off"
                    else -> "Heartbeating to bridge"
                },
            )
            if (lastHeartbeat != null) {
                Spacer(Modifier.height(6.dp))
                Text("Last heartbeat: $lastHeartbeat", fontSize = 12.sp, color = MutedColor)
            }
            if (ip != null) {
                Spacer(Modifier.height(6.dp))
                Text(
                    "Reporting $ip:${resolvedPort ?: "—"}",
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MutedColor,
                )
            }
        }

        // Wireless-debug controls.
        InfoCard(title = "Wireless ADB") {
            StatusRow(
                ok = wirelessAdbOn,
                text = if (wirelessAdbOn)
                    "On · port ${mdnsPort ?: tlsPort ?: tcpPort}"
                else
                    "Off — operator action needed",
            )
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Button(
                    onClick = {
                        // Try programmatic enable first. Falls back to
                        // opening the Wireless Debugging panel.
                        val ok = tryEnableWirelessDebug(ctx)
                        if (!ok) openWirelessDebuggingSettings(ctx)
                    },
                    shape = RoundedCornerShape(8.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = PrimaryColor),
                ) {
                    Text(if (canWriteSettings) "Turn on" else "Open settings")
                }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(
                    onClick = { openWirelessDebuggingSettings(ctx) },
                    shape = RoundedCornerShape(8.dp),
                ) { Text("Settings") }
            }
            if (!canWriteSettings) {
                Spacer(Modifier.height(10.dp))
                Text(
                    "To enable wireless debug WITHOUT tapping settings each time, " +
                        "grant the permission once via ADB over USB:",
                    fontSize = 12.sp,
                    color = MutedColor,
                )
                Spacer(Modifier.height(4.dp))
                val cmd = "adb shell pm grant com.folia.bridgehelper " +
                    "android.permission.WRITE_SECURE_SETTINGS"
                Text(
                    cmd,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MutedColor,
                    modifier = Modifier.clickable { copyToClipboard(ctx, cmd) },
                )
                Text("tap to copy", fontSize = 10.sp, color = MutedColor)
            }
        }

        // Bridge config — paste once.
        InfoCard(title = "Bridge") {
            Text(
                "Vercel deployment + bridge token. The helper POSTs the " +
                    "phone's IP + wireless-debug port here so the Mac bridge " +
                    "can find it without mDNS.",
                fontSize = 12.sp,
                color = MutedColor,
            )
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(
                value = bridgeUrl,
                onValueChange = { bridgeUrl = it },
                label = { Text("Vercel URL (https://your-app.vercel.app)") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = bridgeToken,
                onValueChange = { bridgeToken = it },
                label = { Text("Bridge token (Admin → Users → Generate token)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(10.dp))
            Button(
                onClick = {
                    prefs.edit()
                        .putString(PREF_URL, bridgeUrl.trim())
                        .putString(PREF_TOKEN, bridgeToken.trim())
                        .apply()
                    Toast.makeText(ctx, "Saved", Toast.LENGTH_SHORT).show()
                },
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(containerColor = PrimaryColor),
            ) { Text("Save") }
        }

        // Keep-screen-on toggle.
        InfoCard(title = "Display") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(checked = keepAwake, onCheckedChange = { keepAwake = it })
                Spacer(Modifier.width(12.dp))
                Text("Keep screen on", fontSize = 16.sp, fontWeight = FontWeight.Medium)
            }
            Spacer(Modifier.height(4.dp))
            Text(
                "Prevents the phone from sleeping and dropping the wireless adb connection during a live sale.",
                fontSize = 12.sp,
                color = MutedColor,
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// mDNS via Android's NSD. We browse for _adb-tls-connect._tcp and
// resolve each one to read its port + host. The phone's own adbd
// advertises a service when wireless debug is on; we match its host
// IP against this device's WiFi IP and surface the port.
// ─────────────────────────────────────────────────────────────────────

private class AdbMdnsListener(
    private val nsd: NsdManager,
    private val onPort: (Int) -> Unit,
) : NsdManager.DiscoveryListener {
    private var registered = false
    private val serviceType = "_adb-tls-connect._tcp."

    fun start() {
        if (registered) return
        try {
            nsd.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, this)
            registered = true
        } catch (_: Exception) { /* device-dependent; ignore */ }
    }

    fun stop() {
        if (!registered) return
        try { nsd.stopServiceDiscovery(this) } catch (_: Exception) { /* */ }
        registered = false
    }

    override fun onServiceFound(serviceInfo: NsdServiceInfo) {
        try {
            nsd.resolveService(serviceInfo, object : NsdManager.ResolveListener {
                override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {}
                override fun onServiceResolved(info: NsdServiceInfo) {
                    // The resolved service has a port. We don't try to
                    // filter by host here — only one phone advertises
                    // _adb-tls-connect on its own loopback / WiFi NIC,
                    // and on the operator's LAN there's typically just
                    // the one. Take the port and let the heartbeater
                    // pair it with the current WiFi IP.
                    val port = info.port
                    if (port > 0) onPort(port)
                }
            })
        } catch (_: Exception) { /* ignore */ }
    }

    override fun onServiceLost(serviceInfo: NsdServiceInfo) { /* */ }
    override fun onDiscoveryStarted(serviceType: String) { /* */ }
    override fun onDiscoveryStopped(serviceType: String) { /* */ }
    override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
    override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
}

// ─────────────────────────────────────────────────────────────────────
// Heartbeat POST.
// ─────────────────────────────────────────────────────────────────────

private suspend fun sendHeartbeat(
    baseUrl: String,
    token: String,
    deviceIp: String,
    debugPort: Int,
): Boolean = withContext(Dispatchers.IO) {
    try {
        val cleaned = baseUrl.trimEnd('/')
        val url = URL("$cleaned/api/bridge?action=phone-heartbeat")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 4000
        conn.readTimeout = 4000
        conn.setRequestProperty("Authorization", "Bearer $token")
        conn.setRequestProperty("Content-Type", "application/json")
        conn.doOutput = true
        val body = """{"action":"phone-heartbeat","deviceIp":"$deviceIp","debugPort":$debugPort}"""
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        val ok = conn.responseCode in 200..299
        conn.disconnect()
        ok
    } catch (_: Exception) {
        false
    }
}

// ─────────────────────────────────────────────────────────────────────
// Programmatic enable. Writes Settings.Global.adb_wifi_enabled = 1.
// Requires WRITE_SECURE_SETTINGS (signature-only; grant via ADB).
// ─────────────────────────────────────────────────────────────────────

private const val SETTING_ADB_WIFI_ENABLED = "adb_wifi_enabled"

private fun hasWriteSecureSettings(ctx: Context): Boolean =
    ContextCompat.checkSelfPermission(ctx, Manifest.permission.WRITE_SECURE_SETTINGS) ==
        PackageManager.PERMISSION_GRANTED

private fun tryEnableWirelessDebug(ctx: Context): Boolean {
    if (!hasWriteSecureSettings(ctx)) return false
    return try {
        Settings.Global.putInt(ctx.contentResolver, SETTING_ADB_WIFI_ENABLED, 1)
        true
    } catch (_: Exception) {
        false
    }
}

// ─────────────────────────────────────────────────────────────────────
// Misc helpers.
// ─────────────────────────────────────────────────────────────────────

private fun currentWifiIp(): String? = try {
    NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback }
        .flatMap { it.inetAddresses.toList() }
        .firstOrNull { !it.isLoopbackAddress && it.hostAddress?.contains(':') == false }
        ?.hostAddress
} catch (_: Exception) { null }

private fun readSysProp(key: String): String = try {
    val p = Runtime.getRuntime().exec(arrayOf("getprop", key))
    p.inputStream.bufferedReader().readText().trim()
} catch (_: Exception) { "" }

private fun copyToClipboard(ctx: Context, text: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("folia-bridge", text))
    Toast.makeText(ctx, "Copied", Toast.LENGTH_SHORT).show()
}

private fun openWirelessDebuggingSettings(ctx: Context) {
    launchFirst(
        ctx,
        Intent("android.settings.WIRELESS_DEBUGGING_SETTINGS"),
        Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS),
        Intent(Settings.ACTION_SETTINGS),
    )
}

private fun launchFirst(ctx: Context, vararg intents: Intent) {
    for (i in intents) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try { ctx.startActivity(i); return } catch (_: Exception) { /* try next */ }
    }
}

private fun nowHm(): String {
    val cal = java.util.Calendar.getInstance()
    val h = cal.get(java.util.Calendar.HOUR_OF_DAY)
    val m = cal.get(java.util.Calendar.MINUTE)
    return String.format("%02d:%02d", h, m)
}

// ─────────────────────────────────────────────────────────────────────
// UI building blocks.
// ─────────────────────────────────────────────────────────────────────

@Composable
private fun InfoCard(title: String, content: @Composable () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = CardBg),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                title.uppercase(),
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                color = MutedColor,
            )
            Spacer(Modifier.height(8.dp))
            content()
        }
    }
}

@Composable
private fun StatusRow(ok: Boolean, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .background(
                    color = if (ok) OkColor else ErrColor,
                    shape = RoundedCornerShape(5.dp),
                ),
        )
        Spacer(Modifier.width(10.dp))
        Text(text, fontSize = 14.sp)
    }
}

private val WhiteBg = androidx.compose.ui.graphics.Color(0xFFFFFFFF)
private val MutedColor = androidx.compose.ui.graphics.Color(0xFF6B7280)
private val OkColor = androidx.compose.ui.graphics.Color(0xFF059669)
private val ErrColor = androidx.compose.ui.graphics.Color(0xFFDC2626)
private val CardBg = androidx.compose.ui.graphics.Color(0xFFF9FAFB)
private val PrimaryColor = androidx.compose.ui.graphics.Color(0xFF1F2937)
