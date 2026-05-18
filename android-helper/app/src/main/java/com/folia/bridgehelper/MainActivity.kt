package com.folia.bridgehelper

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.wifi.WifiManager
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
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.NetworkInterface
import java.net.URL

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

@Composable
fun HelperScreen() {
    val ctx = LocalContext.current
    var keepAwake by remember { mutableStateOf(true) }
    var ip by remember { mutableStateOf<String?>(null) }
    var ssid by remember { mutableStateOf<String?>(null) }
    var tcpPort by remember { mutableStateOf<String?>(null) }
    var tlsPort by remember { mutableStateOf<String?>(null) }
    var u2Status by remember { mutableStateOf("checking…") }
    var hasWifiNamePerm by remember { mutableStateOf(hasWifiNamePermission(ctx)) }

    val permLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasWifiNamePerm = granted
        if (granted) ssid = currentWifiSsid(ctx)
    }

    // Keep-screen-on toggle. FLAG_KEEP_SCREEN_ON only takes effect while
    // the window is in foreground, which is exactly what we want during
    // live sales — operator can see the IP card and the screen won't
    // sleep and drop the WiFi adb connection.
    LaunchedEffect(keepAwake) {
        val window = (ctx as? ComponentActivity)?.window ?: return@LaunchedEffect
        if (keepAwake) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    // Refresh network/adb info every 2 s and u2 status every 3 s.
    LaunchedEffect(hasWifiNamePerm) {
        while (true) {
            ip = currentWifiIp()
            ssid = if (hasWifiNamePerm) currentWifiSsid(ctx) else null
            tcpPort = readSysProp("service.adb.tcp.port").takeIf { it.isNotBlank() }
            tlsPort = readSysProp("service.adb.tls.port").takeIf { it.isNotBlank() }
            delay(2_000)
        }
    }
    LaunchedEffect(Unit) {
        while (true) {
            u2Status = probeU2()
            delay(3_000)
        }
    }

    // Pick the wireless-debugging port that's actually live. Android 11+
    // Wireless Debugging exposes a dynamic TLS port (service.adb.tls.port);
    // legacy `adb tcpip 5555` mode exposes service.adb.tcp.port. The Mac
    // bridge talks to whichever one is open.
    val activePort = tlsPort ?: tcpPort
    val wirelessAdbOn = activePort != null
    val wifiOn = ip != null
    val readyForMac = wifiOn && wirelessAdbOn
    val connectCmd = ip?.let { "adb connect $it:${tcpPort ?: "5555"}" }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.WHITE.toUiColor())
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            "Folia Bridge Helper",
            fontSize = 22.sp,
            fontWeight = FontWeight.SemiBold,
        )

        // Top-level rollup: is the phone reachable from the Mac bridge?
        // Combines WiFi up + wireless adbd listening into one green/red
        // line so the operator can tell at a glance. When the rollup is
        // red we expand step-by-step instructions so the user can't miss
        // that they have to flip the Wireless Debugging toggle themselves
        // — Android won't let any non-system app do it.
        InfoCard(title = "Connection") {
            StatusRow(
                ok = readyForMac,
                text = when {
                    !wifiOn -> "Not ready — WiFi off"
                    !wirelessAdbOn -> "Not ready — wireless ADB off"
                    else -> "Ready for Mac to connect"
                },
            )

            if (!readyForMac) {
                Spacer(Modifier.height(14.dp))
                Text(
                    "How to connect:",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(6.dp))
                if (!wifiOn) {
                    NumberedStep(1, "Connect this phone to WiFi.")
                    NumberedStep(2, "Tap “Open Wireless Debugging” below.")
                    NumberedStep(3, "Turn the “Use wireless debugging” toggle ON.")
                    NumberedStep(4, "Come back here — the status above should turn green.")
                } else {
                    NumberedStep(1, "Tap “Open Wireless Debugging” below.")
                    NumberedStep(
                        2,
                        "On that screen, turn the “Use wireless debugging” toggle ON.",
                        emphasis = true,
                    )
                    NumberedStep(3, "Press the back button to return here.")
                    NumberedStep(4, "Status above should turn green within 2 seconds.")
                }
            } else {
                Spacer(Modifier.height(10.dp))
                Text(
                    "On the Mac, run:  ./bridge/reconnect.sh",
                    fontSize = 13.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MutedColor,
                )
            }

            Spacer(Modifier.height(14.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Button(
                    onClick = { openWirelessDebuggingSettings(ctx) },
                    shape = RoundedCornerShape(8.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = PrimaryColor),
                ) { Text("Open Wireless Debugging") }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(
                    onClick = {
                        // Force an immediate re-read of the system props so the
                        // user gets instant feedback after coming back from the
                        // settings panel, without waiting for the 2 s poll.
                        tcpPort = readSysProp("service.adb.tcp.port").takeIf { it.isNotBlank() }
                        tlsPort = readSysProp("service.adb.tls.port").takeIf { it.isNotBlank() }
                        ip = currentWifiIp()
                    },
                    shape = RoundedCornerShape(8.dp),
                ) { Text("Refresh") }
            }
        }

        // Network card: WiFi IP + SSID + tap-to-copy + QR.
        InfoCard(title = "WiFi") {
            if (ip == null) {
                Text("Not connected to WiFi", color = ErrColor)
            } else {
                if (ssid != null) {
                    Text(
                        ssid!!,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Medium,
                    )
                    Spacer(Modifier.height(8.dp))
                } else if (!hasWifiNamePerm) {
                    OutlinedButton(
                        onClick = { permLauncher.launch(wifiNamePermission()) },
                        shape = RoundedCornerShape(8.dp),
                    ) { Text("Show network name") }
                    Spacer(Modifier.height(10.dp))
                }
                Text(
                    ip!!,
                    fontSize = 30.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.clickable { copyToClipboard(ctx, ip!!) },
                )
                Spacer(Modifier.height(6.dp))
                Text("tap to copy", fontSize = 11.sp, color = MutedColor)
                if (connectCmd != null) {
                    Spacer(Modifier.height(12.dp))
                    Text(
                        connectCmd,
                        fontSize = 14.sp,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.clickable { copyToClipboard(ctx, connectCmd) },
                    )
                    Spacer(Modifier.height(4.dp))
                    Text("tap to copy", fontSize = 11.sp, color = MutedColor)
                    Spacer(Modifier.height(12.dp))
                    QrCode(text = connectCmd, sizeDp = 200)
                }
            }
        }

        // Wireless ADB status card — both legacy TCP and Android 11+ TLS.
        InfoCard(title = "Wireless ADB") {
            StatusRow(
                ok = tlsPort != null,
                text = if (tlsPort != null)
                    "Wireless Debugging on (port $tlsPort)"
                else
                    "Wireless Debugging off",
            )
            Spacer(Modifier.height(6.dp))
            StatusRow(
                ok = tcpPort != null,
                text = if (tcpPort != null)
                    "Legacy TCP mode on port $tcpPort"
                else
                    "Legacy TCP mode off",
            )
            if (!wirelessAdbOn) {
                Spacer(Modifier.height(8.dp))
                Text(
                    "Use the Connect button above, or plug into a Mac and run:  adb tcpip 5555",
                    fontSize = 12.sp,
                    color = MutedColor,
                    fontFamily = FontFamily.Monospace,
                )
            }
            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = { openDeveloperSettings(ctx) },
                shape = RoundedCornerShape(8.dp),
            ) { Text("Open Developer Options") }
        }

        // u2 server card.
        InfoCard(title = "u2 server") {
            val ok = u2Status == "pong"
            StatusRow(
                ok = ok,
                text = if (ok) "Responding on :9008" else "Not responding ($u2Status)",
            )
        }

        // Keep-screen-on toggle.
        InfoCard(title = "Display") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(checked = keepAwake, onCheckedChange = { keepAwake = it })
                Spacer(Modifier.width(12.dp))
                Text(
                    "Keep screen on",
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                "Prevents the phone from sleeping and dropping ADB during a live sale.",
                fontSize = 12.sp,
                color = MutedColor,
            )
        }
    }
}

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
                .clip(RoundedCornerShape(5.dp))
                .background(if (ok) OkColor else ErrColor),
        )
        Spacer(Modifier.width(10.dp))
        Text(text, fontSize = 14.sp)
    }
}

@Composable
private fun NumberedStep(n: Int, text: String, emphasis: Boolean = false) {
    Row(modifier = Modifier.padding(vertical = 3.dp)) {
        Text(
            "$n.",
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.width(20.dp),
        )
        Text(
            text,
            fontSize = 13.sp,
            fontWeight = if (emphasis) FontWeight.SemiBold else FontWeight.Normal,
            color = if (emphasis) ErrColor else androidx.compose.ui.graphics.Color.Black,
        )
    }
}

@Composable
private fun QrCode(text: String, sizeDp: Int) {
    val bitmap = remember(text) { generateQr(text, sizeDp * 4) }
    Image(
        bitmap = bitmap.asImageBitmap(),
        contentDescription = "QR code",
        modifier = Modifier.size(sizeDp.dp),
    )
}

private fun generateQr(text: String, pixelSize: Int): Bitmap {
    val hints = mapOf(
        EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
        EncodeHintType.MARGIN to 1,
    )
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, pixelSize, pixelSize, hints)
    val w = matrix.width
    val h = matrix.height
    val pixels = IntArray(w * h)
    for (y in 0 until h) for (x in 0 until w) {
        pixels[y * w + x] = if (matrix[x, y]) Color.BLACK else Color.WHITE
    }
    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    bmp.setPixels(pixels, 0, w, 0, 0, w, h)
    return bmp
}

private fun currentWifiIp(): String? {
    // NetworkInterface scan — avoids the deprecated WifiInfo.getIpAddress
    // ordering quirk and works whether Wi-Fi or Ethernet over USB-C dock.
    return try {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }
            .firstOrNull { !it.isLoopbackAddress && it.hostAddress?.contains(':') == false }
            ?.hostAddress
    } catch (_: Exception) {
        null
    }
}

private fun readSysProp(key: String): String {
    // android.os.SystemProperties is hidden API. Shelling out to the
    // getprop binary avoids reflection on hidden APIs and works on
    // every Android version.
    return try {
        val p = Runtime.getRuntime().exec(arrayOf("getprop", key))
        p.inputStream.bufferedReader().readText().trim()
    } catch (_: Exception) {
        ""
    }
}

private suspend fun probeU2(): String = withContext(Dispatchers.IO) {
    try {
        val url = URL("http://127.0.0.1:9008/ping")
        val conn = url.openConnection() as HttpURLConnection
        conn.connectTimeout = 1500
        conn.readTimeout = 1500
        conn.requestMethod = "GET"
        val body = conn.inputStream.bufferedReader().readText().trim()
        conn.disconnect()
        body.ifEmpty { "no body" }
    } catch (e: Exception) {
        e.javaClass.simpleName
    }
}

private fun copyToClipboard(ctx: Context, text: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("folia-bridge", text))
    Toast.makeText(ctx, "Copied", Toast.LENGTH_SHORT).show()
}

private fun openWirelessDebuggingSettings(ctx: Context) {
    // Direct shortcut to the Wireless Debugging panel (Android 11+).
    // That screen has the toggle the operator needs to flip and the
    // "Pair device" entry point. Falls back to Developer Options if
    // the dedicated action isn't available on this OEM build.
    launchFirst(
        ctx,
        Intent("android.settings.WIRELESS_DEBUGGING_SETTINGS"),
        Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS),
        Intent(Settings.ACTION_SETTINGS),
    )
}

private fun openDeveloperSettings(ctx: Context) {
    // Generic Developer Options entry — used as a fallback when the
    // operator needs to enable Developer Options itself (or the OEM
    // hides the wireless-debugging deep link).
    launchFirst(
        ctx,
        Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS),
        Intent("android.settings.WIRELESS_DEBUGGING_SETTINGS"),
        Intent(Settings.ACTION_SETTINGS),
    )
}

private fun launchFirst(ctx: Context, vararg intents: Intent) {
    for (i in intents) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            ctx.startActivity(i)
            return
        } catch (_: Exception) {
            /* try the next one */
        }
    }
}

private fun wifiNamePermission(): String =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        Manifest.permission.NEARBY_WIFI_DEVICES
    else
        Manifest.permission.ACCESS_FINE_LOCATION

private fun hasWifiNamePermission(ctx: Context): Boolean =
    ContextCompat.checkSelfPermission(ctx, wifiNamePermission()) ==
        PackageManager.PERMISSION_GRANTED

private fun currentWifiSsid(ctx: Context): String? {
    // Best-effort SSID readback. Without the required permission Android
    // returns the literal string "<unknown ssid>" — we filter that out so
    // the caller can decide what to show.
    return try {
        val wifi = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val raw = wifi.connectionInfo?.ssid?.trim('"') ?: return null
        if (raw.isBlank() || raw == "<unknown ssid>") null else raw
    } catch (_: Exception) {
        null
    }
}

private val MutedColor = androidx.compose.ui.graphics.Color(0xFF6B7280)
private val OkColor = androidx.compose.ui.graphics.Color(0xFF059669)
private val ErrColor = androidx.compose.ui.graphics.Color(0xFFDC2626)
private val CardBg = androidx.compose.ui.graphics.Color(0xFFF9FAFB)
private val PrimaryColor = androidx.compose.ui.graphics.Color(0xFF1F2937)

private fun Int.toUiColor() = androidx.compose.ui.graphics.Color(this)
