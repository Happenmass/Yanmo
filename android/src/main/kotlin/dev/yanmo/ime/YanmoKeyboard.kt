package dev.yanmo.ime

import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kingzcheung.xime.ui.keyboard.KeyButton
import java.util.Locale
import kotlinx.coroutines.delay

internal val LocalYanmoDictationStage = compositionLocalOf { VoiceSession.IDLE }

internal object YanmoDictationPreview {
    val confirmed = mutableStateOf("")
    val provisional = mutableStateOf("")

    @JvmStatic
    fun update(value: String?) {
        update(value, "")
    }

    @JvmStatic
    fun update(confirmedValue: String?, provisionalValue: String?) {
        confirmed.value = confirmedValue?.trim().orEmpty()
        provisional.value = provisionalValue?.replace(Regex("[\\t\\r\\n]+"), " ")?.trim().orEmpty()
    }
}

@Composable
internal fun YanmoLanguageKey(
    english: Boolean,
    switchLanguage: () -> Unit,
    backgroundColor: Color,
    textColor: Color,
    modifier: Modifier,
    onPress: (() -> Unit)?,
    onRelease: (() -> Unit)? = null,
    shadowEnabled: Boolean,
    shadowElevation: Dp,
    shadowShapeRadius: Dp,
) {
    KeyButton(
        text = "中/英", onClick = switchLanguage, backgroundColor = backgroundColor, textColor = textColor,
        modifier = modifier.testTag("language-key-control").semantics {
            role = Role.Button
            stateDescription = if (english) "英文输入" else "中文输入"
            onClick(label = "切换中英文") { switchLanguage(); true }
        },
        onPress = onPress, onRelease = onRelease, shadowEnabled = shadowEnabled,
        shadowElevation = shadowElevation, shadowShapeRadius = shadowShapeRadius,
        labelContent = { size ->
            val active = SpanStyle(color = textColor, fontSize = size.sp, fontWeight = FontWeight.SemiBold)
            val secondary = SpanStyle(color = textColor.copy(alpha = 0.68f), fontSize = (size * 0.75f).sp)
            val label = buildAnnotatedString {
                withStyle(if (english) secondary else active) { append("中") }
                withStyle(secondary) { append("/") }
                withStyle(if (english) active else secondary) { append("英") }
            }
            Text(label, maxLines = 1, softWrap = false)
        },
    )
}

@Composable
internal fun YanmoDictationBar(stage: Int, background: Color, foreground: Color) {
    val recording = stage == VoiceSession.RECORDING
    val status = when (stage) {
        VoiceSession.RECORDING -> "正在录音"
        VoiceSession.POLISHING -> "正在整理"
        else -> "正在识别"
    }
    var seconds by remember(stage) { mutableLongStateOf(0L) }
    val confirmed by YanmoDictationPreview.confirmed
    val provisional by YanmoDictationPreview.provisional
    val combined = confirmed + provisional
    val maxTailChars = 26
    val tailText = remember(confirmed, provisional) {
        if (combined.isEmpty()) null
        else {
            val truncated = combined.length > maxTailChars
            val window = if (truncated) combined.takeLast(maxTailChars) else combined
            val cut = combined.length - window.length
            val confirmedLenInWindow = (confirmed.length - cut).coerceIn(0, window.length)
            Triple(if (truncated) "…" else "", window.substring(0, confirmedLenInWindow), window.substring(confirmedLenInWindow))
        }
    }
    LaunchedEffect(recording) {
        if (recording) {
            val start = SystemClock.elapsedRealtime()
            while (true) {
                delay(250)
                seconds = (SystemClock.elapsedRealtime() - start) / 1000
            }
        }
    }
    Row(
        Modifier.fillMaxWidth().height(44.dp).background(background)
            .padding(horizontal = 12.dp).testTag("yanmo-dictation-status"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (recording) Box(Modifier.size(8.dp).background(Color(0xFFB85442), CircleShape))
        else CircularProgressIndicator(
            modifier = Modifier.size(16.dp), color = foreground, strokeWidth = 2.dp,
        )
        Text(status, color = foreground, fontSize = 14.sp, maxLines = 1,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        if (recording) {
            Text(String.format(Locale.ROOT, "%02d:%02d", seconds / 60, seconds % 60),
                color = foreground, fontSize = 13.sp, maxLines = 1)
            if (tailText != null) {
                val (prefix, conf, prov) = tailText
                val styled = buildAnnotatedString {
                    if (prefix.isNotEmpty()) {
                        withStyle(SpanStyle(color = foreground.copy(alpha = 0.65f))) { append(prefix) }
                    }
                    if (conf.isNotEmpty()) {
                        withStyle(SpanStyle(color = foreground.copy(alpha = 0.92f))) { append(conf) }
                    }
                    if (prov.isNotEmpty()) {
                        withStyle(SpanStyle(color = foreground.copy(alpha = 0.52f))) { append(prov) }
                    }
                }
                Text(
                    styled,
                    fontSize = 12.sp,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            } else {
                Text(
                    "上滑取消 · 松手结束",
                    color = foreground.copy(alpha = 0.75f),
                    fontSize = 12.sp,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        } else if (tailText != null) {
            val (prefix, conf, prov) = tailText
            val styled = buildAnnotatedString {
                if (prefix.isNotEmpty()) {
                    withStyle(SpanStyle(color = foreground.copy(alpha = 0.65f))) { append(prefix) }
                }
                if (conf.isNotEmpty()) {
                    withStyle(SpanStyle(color = foreground.copy(alpha = 0.88f))) { append(conf) }
                }
                if (prov.isNotEmpty()) {
                    withStyle(SpanStyle(color = foreground.copy(alpha = 0.52f))) { append(prov) }
                }
            }
            Text(
                styled,
                fontSize = 12.sp,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
