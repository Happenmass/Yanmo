package dev.yanmo.ime

import android.Manifest
import android.content.pm.PackageManager
import android.view.View
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.twotone.AutoAwesome
import androidx.compose.material.icons.twotone.CloudSync
import androidx.compose.material.icons.twotone.Description
import androidx.compose.material.icons.twotone.Keyboard
import androidx.compose.material.icons.twotone.Mic
import androidx.compose.material.icons.twotone.Screenshot
import androidx.compose.material.icons.twotone.Tune
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MediumTopAppBar
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.kingzcheung.xime.ui.settings.SettingsItem
import com.kingzcheung.xime.ui.settings.SettingsListRow
import com.kingzcheung.xime.ui.settings.SettingsNote
import com.kingzcheung.xime.ui.settings.SettingsRowDivider
import com.kingzcheung.xime.ui.settings.SettingsSection
import com.kingzcheung.xime.ui.settings.SettingsStatusTone
import com.kingzcheung.xime.ui.settings.SettingsToggleItem
import com.kingzcheung.xime.ui.theme.XimeTheme
import java.io.IOException
import java.util.function.Consumer

internal class YanmoSettings(
    private val activity: YanmoActivity,
    private val manageMicrophone: Runnable,
    private val changeScreenshot: Consumer<Boolean>,
    private val openApi: Consumer<Boolean>,
    private val openSync: Runnable,
) {
    private var keyboardStatus by mutableStateOf("")
    private var microphoneGranted by mutableStateOf(false)
    private var screenshotEnabled by mutableStateOf(false)
    private var syncEnabled by mutableStateOf(false)

    val view: View = settingsView(activity) { Overview() }

    init { refresh() }

    fun refresh() {
        keyboardStatus = when {
            activity.isKeyboardSelected() -> "已选用"
            activity.isKeyboardEnabled() -> "待选用"
            else -> "待启用"
        }
        microphoneGranted = activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        screenshotEnabled = ScreenCapture.enabled(activity)
        syncEnabled = SyncManager.get(activity).isEnabledFast()
    }

    @Composable
    private fun Overview() {
        val api = Polish.settings(activity)
        val endpoint = api.getString("endpoint", "").orEmpty()
        val model = api.getString("model", "").orEmpty()
        val configured = endpoint.isNotBlank() && model.isNotBlank()
        var enabled by remember { mutableStateOf(Polish.enabled(activity)) }
        var readContext by remember { mutableStateOf(EditorContext.enabled(activity)) }
        var error by remember { mutableStateOf<String?>(null) }
        SettingsPage("设置") {
            SettingsSection("语音输入") {
                SettingsItem(
                    icon = Icons.TwoTone.Keyboard,
                    title = "言墨键盘",
                    subtitle = "启用和选用键盘后即可听写",
                    status = keyboardStatus,
                    statusTone = if (keyboardStatus == "已选用") SettingsStatusTone.OK else SettingsStatusTone.WARNING,
                    onClick = activity::manageKeyboard,
                    showArrow = true,
                )
                SettingsRowDivider()
                SettingsItem(
                    icon = Icons.TwoTone.Mic,
                    title = "麦克风权限",
                    subtitle = "长按空格开始听写",
                    status = if (microphoneGranted) "已授权" else "待授权",
                    statusTone = if (microphoneGranted) SettingsStatusTone.OK else SettingsStatusTone.WARNING,
                    onClick = manageMicrophone::run,
                    showArrow = true,
                )
            }
            SettingsSection("文字整理与纠正") {
                SettingsToggleItem(
                    icon = Icons.TwoTone.AutoAwesome,
                    title = "自然整理",
                    subtitle = "使用文字 API 整理听写，并从写入后 10 秒内的手动纠正学习词条",
                    checked = enabled,
                    onCheckedChange = { checked ->
                        error = null
                        if (checked && !configured) {
                            openApi.accept(true)
                        } else {
                            try {
                                Polish.save(activity, checked, endpoint, model, "", false)
                                enabled = checked
                            } catch (failure: Exception) {
                                error = saveError(failure)
                            }
                        }
                    },
                )
                SettingsRowDivider()
                SettingsItem(
                    icon = Icons.TwoTone.Tune,
                    title = "文字 API",
                    subtitle = "服务地址、模型与密钥",
                    status = if (configured) "已配置" else "未配置",
                    onClick = { openApi.accept(false) },
                    showArrow = true,
                )
                error?.let { SettingsError(it) }
            }
            SettingsSection("隐私与存储") {
                SettingsToggleItem(
                    icon = Icons.TwoTone.Tune,
                    title = "读取输入框上下文",
                    subtitle = "读取光标前后各最多 300 字，辅助本地识别及已启用的文字整理",
                    checked = readContext,
                    onCheckedChange = {
                        EditorContext.setEnabled(activity, it)
                        readContext = it
                    },
                )
                SettingsRowDivider()
                SettingsToggleItem(
                    icon = Icons.TwoTone.Screenshot,
                    title = "录音时截屏",
                    subtitle = "在系统无障碍设置中开启后，结束口述时截取一张画面，随文稿保存在本机",
                    checked = screenshotEnabled,
                    onCheckedChange = changeScreenshot::accept,
                    lockMessage = if (ScreenCapture.supported()) null else "需要 Android 11 或更新版本",
                )
                SettingsRowDivider()
                SettingsListRow("文稿保存", "录音、识别原文和整理稿保存在本机")
            }
            SettingsSection("跨设备同步") {
                SettingsItem(
                    icon = Icons.TwoTone.CloudSync,
                    title = "个人同步空间",
                    subtitle = "通过局域网中同账号的 AcpmRuntime 端到端加密同步词库与文稿",
                    status = if (syncEnabled) "已开启" else "未开启",
                    statusTone = if (syncEnabled) SettingsStatusTone.OK else SettingsStatusTone.WARNING,
                    onClick = openSync::run,
                    showArrow = true,
                )
            }
        }
    }

    companion object {
        @JvmStatic
        fun apiPage(activity: YanmoActivity, requestEnable: Boolean, back: Runnable): View =
            settingsView(activity) { ApiPage(activity, requestEnable, back) }
    }
}

private fun settingsView(activity: YanmoActivity, content: @Composable () -> Unit) =
    ComposeView(activity).apply {
        setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
        setContent { XimeTheme(themeId = "cream_beige", content = content) }
    }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsPage(title: String, back: Runnable? = null, content: @Composable () -> Unit) {
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    Scaffold(
        modifier = Modifier.fillMaxSize().nestedScroll(scroll.nestedScrollConnection),
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            MediumTopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    if (back != null) IconButton(onClick = back::run) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                windowInsets = WindowInsets(0, 0, 0, 0),
                scrollBehavior = scroll,
            )
        },
    ) { insets ->
        LazyColumn(
            Modifier.fillMaxSize().padding(insets),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
        ) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(16.dp)) { content() }
            }
        }
    }
}

@Composable
private fun ApiPage(activity: YanmoActivity, requestEnable: Boolean, back: Runnable) {
    val api = Polish.settings(activity)
    var enabled by remember { mutableStateOf(requestEnable || Polish.enabled(activity)) }
    var endpoint by remember { mutableStateOf(api.getString("endpoint", "").orEmpty()) }
    var model by remember { mutableStateOf(api.getString("model", "").orEmpty()) }
    var key by remember { mutableStateOf("") }
    var clearKey by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val hasKey = api.contains("credential")
    val focus = LocalFocusManager.current

    SettingsPage("文字 API", back) {
        SettingsSection("文字服务") {
            SettingsToggleItem(
                icon = Icons.TwoTone.AutoAwesome,
                title = "启用自然整理",
                subtitle = "启用后，识别原文和相关词条将发送到你配置的服务",
                checked = enabled,
                onCheckedChange = { enabled = it },
            )
            SettingsRowDivider()
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                ApiField("服务根地址", endpoint, "https://api.deepseek.com/v1", KeyboardType.Uri) { endpoint = it }
                ApiField("模型 ID", model, null, KeyboardType.Uri) { model = it }
                ApiField("API Key", key, if (hasKey) "已保存，留空则继续使用" else "服务免密时可以留空",
                    KeyboardType.Password) { key = it }
            }
            if (hasKey) {
                SettingsRowDivider()
                SettingsToggleItem(
                    icon = Icons.TwoTone.Description,
                    title = "移除已保存的 API Key",
                    subtitle = "保存后生效",
                    checked = clearKey,
                    onCheckedChange = { clearKey = it },
                )
            }
        }
        SettingsNote("关闭自然整理时，言墨直接写入识别原文。")
        error?.let { SettingsError(it) }
        Button(onClick = {
            try {
                Polish.save(activity, enabled, endpoint.trim(), model.trim(), key.trim(), clearKey)
                focus.clearFocus()
                back.run()
            } catch (failure: Exception) {
                error = saveError(failure)
            }
        }, modifier = Modifier.fillMaxWidth()) {
            Text("保存设置")
        }
    }
}

@Composable
private fun ApiField(
    label: String,
    value: String,
    hint: String?,
    keyboardType: KeyboardType,
    change: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = change,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        placeholder = hint?.let { { Text(it) } },
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        visualTransformation = if (keyboardType == KeyboardType.Password) PasswordVisualTransformation() else VisualTransformation.None,
        singleLine = true,
    )
}

@Composable
private fun SettingsError(text: String) {
    Text(text, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error)
}

private fun saveError(failure: Exception) =
    if (failure is IOException) failure.message ?: "无法保存文字 API 设置。" else "无法安全保存 API Key，请稍后重试。"
