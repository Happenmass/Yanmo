package dev.yanmo.ime

import android.app.TimePickerDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.view.View
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.twotone.AutoAwesome
import androidx.compose.material.icons.twotone.CloudSync
import androidx.compose.material.icons.twotone.Devices
import androidx.compose.material.icons.twotone.Key
import androidx.compose.material.icons.twotone.QrCodeScanner
import androidx.compose.material.icons.twotone.Schedule
import androidx.compose.material.icons.twotone.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MediumTopAppBar
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.kingzcheung.xime.ui.settings.SettingsItem
import com.kingzcheung.xime.ui.settings.SettingsListRow
import com.kingzcheung.xime.ui.settings.SettingsNote
import com.kingzcheung.xime.ui.settings.SettingsRowDivider
import com.kingzcheung.xime.ui.settings.SettingsSection
import com.kingzcheung.xime.ui.settings.SettingsStatusTone
import com.kingzcheung.xime.ui.settings.SettingsToggleItem
import com.kingzcheung.xime.ui.theme.XimeTheme
import java.text.DateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

internal class YanmoSyncUi(
    private val activity: YanmoActivity,
    private val back: Runnable,
    private val scanQr: Runnable,
) {
    private val manager = SyncManager.get(activity)
    private val io = Executors.newSingleThreadExecutor()

    private var state by mutableStateOf(manager.snapshot())
    private var busy by mutableStateOf(false)
    private var feedback by mutableStateOf<String?>(null)
    private var errorMsg by mutableStateOf<String?>(null)
    private var pendingSwitchQr by mutableStateOf<String?>(null)

    private var showPasteDialog by mutableStateOf(false)
    private var showRestoreDialog by mutableStateOf(false)
    private var showRecoveryDialog by mutableStateOf(false)
    private var recoveryCodeText by mutableStateOf<String?>(null)
    private var editHubTarget by mutableStateOf<SyncModels.KnownHub?>(null)
    private var showDevicesDialog by mutableStateOf(false)
    private var devicesList by mutableStateOf<List<SyncModels.PairedDeviceDTO>>(emptyList())
    private var devicesLoading by mutableStateOf(false)
    private var showDisableConfirm by mutableStateOf(false)

    val view: View = ComposeView(activity).apply {
        setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
        setContent { XimeTheme(themeId = "cream_beige") { SyncScreen() } }
    }

    fun refresh() {
        state = manager.snapshot()
    }

    fun handleScannedQr(qrText: String, allowReplaceSpace: Boolean = false) {
        busy = true
        errorMsg = null
        feedback = null
        io.execute {
            try {
                manager.redeemQrBlocking(qrText, allowReplaceSpace)
                activity.runOnUiThread {
                    busy = false
                    pendingSwitchQr = null
                    feedback = "配对成功，已同步空间设置。"
                    refresh()
                }
            } catch (switchRequired: SyncPairing.SpaceSwitchRequiredException) {
                activity.runOnUiThread {
                    busy = false
                    pendingSwitchQr = qrText
                }
            } catch (failure: Exception) {
                activity.runOnUiThread {
                    busy = false
                    errorMsg = failure.message ?: "二维码配对失败。"
                    refresh()
                }
            }
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun SyncScreen() {
        DisposableEffect(manager) {
            val listener = SyncManager.Listener { refresh() }
            manager.addListener(listener)
            onDispose { manager.removeListener(listener) }
        }

        val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
        Scaffold(
            modifier = Modifier
                .fillMaxSize()
                .nestedScroll(scroll.nestedScrollConnection),
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            topBar = {
                MediumTopAppBar(
                    title = { Text("跨设备同步") },
                    navigationIcon = {
                        IconButton(onClick = back::run) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                        }
                    },
                    windowInsets = WindowInsets(0, 0, 0, 0),
                    scrollBehavior = scroll,
                )
            }
        ) { insets ->
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(insets),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
            ) {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        feedback?.let {
                            Text(it, color = MaterialTheme.colorScheme.primary)
                        }
                        val combinedError = errorMsg ?: state.lastError
                        combinedError?.let {
                            Text(it, color = MaterialTheme.colorScheme.error)
                        }
                        if (!state.enabled) {
                            UnconfiguredContent()
                        } else {
                            ConfiguredContent()
                        }
                    }
                }
            }
        }

        SyncDialogs()
    }

    @Composable
    private fun UnconfiguredContent() {
        SettingsNote("通过局域网中同账号的 Mac AcpmRuntime 端到端加密同步词库与文稿，中心节点仅密文存储。")
        Button(
            onClick = scanQr::run,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(if (busy) "正在配对…" else "扫码加入同步空间")
        }
        SettingsSection("其他加入方式") {
            SettingsItem(
                icon = Icons.TwoTone.QrCodeScanner,
                title = "粘贴配对链接",
                subtitle = "粘贴桌面端复制的 yanmo-pair:// 配对链接",
                status = "",
                onClick = { showPasteDialog = true },
                showArrow = true,
            )
            SettingsRowDivider()
            SettingsItem(
                icon = Icons.TwoTone.Key,
                title = "使用恢复码加入",
                subtitle = "输入 YM1-... 个人恢复码与同步节点地址",
                status = "",
                onClick = { showRestoreDialog = true },
                showArrow = true,
            )
        }
    }

    @Composable
    private fun ConfiguredContent() {
        val lastAtText = if (state.lastSyncAtMs > 0) {
            DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(state.lastSyncAtMs))
        } else {
            "尚未同步"
        }
        val statusSummary = buildString {
            append(if (state.syncing || busy) "同步中…" else "已开启")
            if (state.pendingCount > 0) append(" · 待上传 ${state.pendingCount} 条")
        }

        SettingsSection("个人同步空间") {
            SettingsListRow("空间编号", state.vaultId.orEmpty().take(12))
            SettingsRowDivider()
            SettingsListRow("本机设备", state.deviceId.take(12))
            SettingsRowDivider()
            SettingsListRow("同步状态", "$statusSummary · $lastAtText")
            if (state.lastSyncSummary.isNotEmpty()) {
                SettingsRowDivider()
                SettingsListRow("最近结果", state.lastSyncSummary)
            }
            SettingsRowDivider()
            SettingsItem(
                icon = Icons.TwoTone.Schedule,
                title = "每日定时同步",
                subtitle = "每天定时执行一次完整同步；变更满 ${state.changeThreshold} 条时也会在空闲时自动同步",
                status = String.format(Locale.ROOT, "%02d:%02d", state.dailySyncHour, state.dailySyncMinute),
                onClick = {
                    TimePickerDialog(
                        activity,
                        { _, hour, minute ->
                            manager.setDailySyncTime(hour, minute) {
                                feedback = String.format(Locale.ROOT, "已将每日同步时间设为 %02d:%02d。", hour, minute)
                                refresh()
                            }
                        },
                        state.dailySyncHour,
                        state.dailySyncMinute,
                        true
                    ).show()
                },
                showArrow = true,
            )
            SettingsRowDivider()
            SettingsToggleItem(
                icon = Icons.TwoTone.CloudSync,
                title = "自动上传与缓存附件",
                subtitle = "上传本机录音与截屏；关闭后仅同步文字并在查看时按需下载",
                checked = state.autoCacheBlobs,
                onCheckedChange = { checked ->
                    SyncStorage.setAutoCacheBlobs(activity, checked)
                    refresh()
                }
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Button(
                onClick = {
                    errorMsg = null
                    feedback = null
                    manager.syncNow { refresh() }
                },
                enabled = !state.syncing && !busy,
                modifier = Modifier.weight(1f)
            ) {
                Text(if (state.syncing) "同步中…" else "立即同步")
            }
            OutlinedButton(
                onClick = {
                    errorMsg = null
                    manager.scanLANHubs { refresh() }
                },
                enabled = !state.syncing && !busy,
                modifier = Modifier.weight(1f)
            ) {
                Text("扫描局域网")
            }
        }

        SettingsSection("同步节点") {
            if (state.knownHubs.isEmpty()) {
                SettingsListRow("尚未绑定节点", "扫码配对或输入节点地址")
            } else {
                state.knownHubs.forEachIndexed { idx, hub ->
                    if (idx > 0) SettingsRowDivider()
                    val isOnline = state.discoveredHubIds.contains(hub.hubInstanceId)
                    val isSpoofed = state.spoofedHubIds.contains(hub.hubInstanceId)
                    val statusLabel = when {
                        isSpoofed -> "指纹不匹配"
                        isOnline -> "局域网在线"
                        else -> "已配对"
                    }
                    val subtitle = hub.manualRemoteUrl ?: hub.lastKnownUrl ?: "指纹 ${hub.serverPubkeyFp}"
                    SettingsItem(
                        icon = Icons.TwoTone.Tune,
                        title = hub.hubName,
                        subtitle = subtitle,
                        status = statusLabel,
                        statusTone = if (isSpoofed) SettingsStatusTone.WARNING else SettingsStatusTone.OK,
                        onClick = { editHubTarget = hub },
                        showArrow = true,
                    )
                }
            }
        }

        SettingsSection("设备与安全") {
            SettingsItem(
                icon = Icons.TwoTone.QrCodeScanner,
                title = "扫码授权或切换设备",
                subtitle = "扫描待加入设备二维码完成授权，或加入新空间",
                status = "",
                onClick = scanQr::run,
                showArrow = true,
            )
            SettingsRowDivider()
            SettingsItem(
                icon = Icons.TwoTone.Devices,
                title = "已配对设备",
                subtitle = "查看或撤销已授权同步的设备",
                status = "",
                onClick = ::openDevicesDialog,
                showArrow = true,
            )
            SettingsRowDivider()
            SettingsItem(
                icon = Icons.TwoTone.Key,
                title = "查看恢复码",
                subtitle = "YM1 个人恢复码可恢复本同步空间的全部加密数据",
                status = "",
                onClick = ::openRecoveryCode,
                showArrow = true,
            )
            SettingsRowDivider()
            SettingsItem(
                icon = Icons.TwoTone.AutoAwesome,
                title = "退出本机同步",
                subtitle = "清除本机同步密钥，已保存的本地文稿和词库保留",
                status = "",
                statusTone = SettingsStatusTone.WARNING,
                onClick = { showDisableConfirm = true },
                showArrow = true,
            )
        }
    }

    private fun openRecoveryCode() {
        io.execute {
            try {
                val code = manager.exportRecoveryCodeBlocking()
                activity.runOnUiThread {
                    recoveryCodeText = code
                    showRecoveryDialog = true
                }
            } catch (e: Exception) {
                activity.runOnUiThread { errorMsg = e.message ?: "无法导出恢复码。" }
            }
        }
    }

    private fun openDevicesDialog() {
        showDevicesDialog = true
        devicesLoading = true
        io.execute {
            try {
                val list = manager.listDevicesBlocking(null)
                activity.runOnUiThread {
                    devicesLoading = false
                    devicesList = list
                }
            } catch (e: Exception) {
                activity.runOnUiThread {
                    devicesLoading = false
                    showDevicesDialog = false
                    errorMsg = e.message ?: "无法获取已配对设备列表。"
                }
            }
        }
    }

    @Composable
    private fun SyncDialogs() {
        if (pendingSwitchQr != null) {
            val qr = pendingSwitchQr!!
            AlertDialog(
                onDismissRequest = { pendingSwitchQr = null },
                title = { Text("切换个人同步空间？") },
                text = { Text("本机已加入另一个同步空间。确认更换为新空间的主密钥并覆盖本机同步凭据吗？") },
                confirmButton = {
                    TextButton(onClick = { handleScannedQr(qr, allowReplaceSpace = true) }) {
                        Text("确认切换")
                    }
                },
                dismissButton = {
                    TextButton(onClick = { pendingSwitchQr = null }) { Text("取消") }
                }
            )
        }

        if (showPasteDialog) {
            var input by remember { mutableStateOf("") }
            AlertDialog(
                onDismissRequest = { showPasteDialog = false },
                title = { Text("粘贴配对链接") },
                text = {
                    OutlinedTextField(
                        value = input,
                        onValueChange = { input = it },
                        label = { Text("yanmo-pair://...") },
                        minLines = 3,
                        modifier = Modifier.fillMaxWidth()
                    )
                },
                confirmButton = {
                    TextButton(onClick = {
                        val clean = input.trim()
                        if (clean.isNotEmpty()) {
                            showPasteDialog = false
                            handleScannedQr(clean)
                        }
                    }) { Text("连接并加入") }
                },
                dismissButton = {
                    TextButton(onClick = { showPasteDialog = false }) { Text("取消") }
                }
            )
        }

        if (showRestoreDialog) {
            var code by remember { mutableStateOf("") }
            var hubUrl by remember { mutableStateOf("") }
            AlertDialog(
                onDismissRequest = { showRestoreDialog = false },
                title = { Text("使用恢复码加入") },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedTextField(
                            value = code,
                            onValueChange = { code = it },
                            label = { Text("个人恢复码 (YM1-...)") },
                            minLines = 2,
                            modifier = Modifier.fillMaxWidth()
                        )
                        OutlinedTextField(
                            value = hubUrl,
                            onValueChange = { hubUrl = it },
                            label = { Text("节点地址 (可选，如 http://192.168.1.10:18790)") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        showRestoreDialog = false
                        busy = true
                        errorMsg = null
                        io.execute {
                            try {
                                manager.restoreRecoveryBlocking(code.trim(), hubUrl.trim(), false)
                                activity.runOnUiThread {
                                    busy = false
                                    feedback = "已通过恢复码导入同步空间。"
                                    refresh()
                                }
                            } catch (e: Exception) {
                                activity.runOnUiThread {
                                    busy = false
                                    errorMsg = e.message ?: "恢复码导入失败。"
                                }
                            }
                        }
                    }) { Text("恢复") }
                },
                dismissButton = {
                    TextButton(onClick = { showRestoreDialog = false }) { Text("取消") }
                }
            )
        }

        if (showRecoveryDialog && recoveryCodeText != null) {
            val code = recoveryCodeText!!
            AlertDialog(
                onDismissRequest = { showRecoveryDialog = false },
                title = { Text("个人恢复码") },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("请妥善保存此恢复码，切勿分享给他人。")
                        Text(code, style = MaterialTheme.typography.bodySmall)
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        activity.getSystemService(ClipboardManager::class.java)
                            .setPrimaryClip(ClipData.newPlainText("言墨恢复码", code))
                        feedback = "已复制恢复码。"
                        showRecoveryDialog = false
                    }) { Text("复制") }
                },
                dismissButton = {
                    TextButton(onClick = { showRecoveryDialog = false }) { Text("关闭") }
                }
            )
        }

        editHubTarget?.let { hub ->
            var manualUrl by remember(hub.hubInstanceId) {
                mutableStateOf(hub.manualRemoteUrl ?: hub.lastKnownUrl.orEmpty())
            }
            AlertDialog(
                onDismissRequest = { editHubTarget = null },
                title = { Text(hub.hubName) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("公钥指纹：${hub.serverPubkeyFp}", style = MaterialTheme.typography.bodySmall)
                        OutlinedTextField(
                            value = manualUrl,
                            onValueChange = { manualUrl = it },
                            label = { Text("手动节点地址 (Tailscale / HTTPS / LAN)") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        val clean = manualUrl.trim()
                        editHubTarget = null
                        io.execute {
                            try {
                                manager.setHubManualUrlBlocking(hub.hubInstanceId, clean)
                                activity.runOnUiThread {
                                    feedback = "已保存节点地址。"
                                    refresh()
                                }
                            } catch (e: Exception) {
                                activity.runOnUiThread { errorMsg = e.message }
                            }
                        }
                    }) { Text("保存") }
                },
                dismissButton = {
                    TextButton(onClick = { editHubTarget = null }) { Text("取消") }
                }
            )
        }

        if (showDevicesDialog) {
            AlertDialog(
                onDismissRequest = { showDevicesDialog = false },
                title = { Text("已配对设备") },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (devicesLoading) {
                            Text("正在加载设备列表…")
                        } else if (devicesList.isEmpty()) {
                            Text("暂无已配对设备记录。")
                        } else {
                            devicesList.forEach { dev ->
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text("${dev.deviceName} (${dev.platform})")
                                        val desc = if (dev.deviceId == state.deviceId) "本机" else if (dev.revokedAtMs != null) "已撤销" else dev.deviceId.take(8)
                                        Text(desc, style = MaterialTheme.typography.bodySmall)
                                    }
                                    if (dev.deviceId != state.deviceId && dev.revokedAtMs == null) {
                                        TextButton(onClick = {
                                            io.execute {
                                                try {
                                                    manager.revokeDeviceBlocking(dev.deviceId, null)
                                                    val updated = manager.listDevicesBlocking(null)
                                                    activity.runOnUiThread { devicesList = updated }
                                                } catch (e: Exception) {
                                                    activity.runOnUiThread { errorMsg = e.message }
                                                }
                                            }
                                        }) {
                                            Text("撤销")
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                confirmButton = {
                    TextButton(onClick = { showDevicesDialog = false }) { Text("关闭") }
                }
            )
        }

        if (showDisableConfirm) {
            AlertDialog(
                onDismissRequest = { showDisableConfirm = false },
                title = { Text("退出本机跨设备同步？") },
                text = { Text("本机同步密钥与配对节点将被移除；本地已保存的文稿与词库不受影响。") },
                confirmButton = {
                    TextButton(onClick = {
                        showDisableConfirm = false
                        io.execute {
                            try {
                                manager.disableSyncBlocking()
                                activity.runOnUiThread {
                                    feedback = "已退出本机同步。"
                                    refresh()
                                }
                            } catch (e: Exception) {
                                activity.runOnUiThread { errorMsg = e.message }
                            }
                        }
                    }) { Text("退出同步") }
                },
                dismissButton = {
                    TextButton(onClick = { showDisableConfirm = false }) { Text("取消") }
                }
            )
        }
    }
}
