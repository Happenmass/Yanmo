package dev.yanmo.ime

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.util.Size
import android.view.MotionEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.GlobalHistogramBinarizer
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.kingzcheung.xime.ui.theme.XimeTheme
import java.util.EnumMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class QrScannerActivity : ComponentActivity() {
    companion object {
        const val EXTRA_QR_TEXT = "qr_text"
    }

    private var hasCameraPermission by mutableStateOf(false)
    private var scanError by mutableStateOf<String?>(null)
    private var showPasteDialog by mutableStateOf(false)
    private val delivered = AtomicBoolean(false)

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasCameraPermission = granted
        if (!granted) {
            scanError = "未获得相机权限，可从相册选择二维码图片或直接粘贴配对链接。"
        }
    }

    private val pickImageLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri != null) decodeFromImageUri(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        hasCameraPermission = ContextCompat.checkSelfPermission(
            this, Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED
        if (!hasCameraPermission) {
            requestPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
        setContent {
            XimeTheme(themeId = "cream_beige") {
                ScannerScreen()
            }
        }
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun ScannerScreen() {
        var pasted by remember { mutableStateOf("") }
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text("扫描同步二维码") },
                    navigationIcon = {
                        IconButton(onClick = ::finish) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                        }
                    }
                )
            }
        ) { insets ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(insets)
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .background(Color(0xFF1E1B18), RoundedCornerShape(16.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    if (hasCameraPermission) {
                        CameraPreviewBox(onDecoded = ::returnQrResult)
                        Box(
                            modifier = Modifier
                                .size(240.dp)
                                .border(2.dp, Color(0xCCFFFFFF), RoundedCornerShape(12.dp))
                        )
                    } else {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                            modifier = Modifier.padding(24.dp)
                        ) {
                            Text(
                                "需要相机权限以扫描另一台设备上的二维码",
                                color = Color.White
                            )
                            Button(onClick = {
                                requestPermissionLauncher.launch(Manifest.permission.CAMERA)
                            }) {
                                Text("授权相机")
                            }
                        }
                    }
                }

                Text(
                    text = scanError ?: "对准 Mac 或其他言墨设备显示的配对二维码",
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (scanError != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    OutlinedButton(
                        onClick = { pickImageLauncher.launch("image/*") },
                        modifier = Modifier.weight(1f)
                    ) {
                        Text("从相册选择")
                    }
                    OutlinedButton(
                        onClick = { showPasteDialog = true },
                        modifier = Modifier.weight(1f)
                    ) {
                        Text("粘贴配对链接")
                    }
                }
            }
        }

        if (showPasteDialog) {
            AlertDialog(
                onDismissRequest = { showPasteDialog = false },
                title = { Text("粘贴配对链接") },
                text = {
                    OutlinedTextField(
                        value = pasted,
                        onValueChange = { pasted = it },
                        label = { Text("yanmo-pair://...") },
                        minLines = 3,
                        modifier = Modifier.fillMaxWidth()
                    )
                },
                confirmButton = {
                    TextButton(onClick = {
                        val trimmed = pasted.trim()
                        if (trimmed.isNotEmpty()) {
                            showPasteDialog = false
                            returnQrResult(trimmed)
                        }
                    }) {
                        Text("确定")
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showPasteDialog = false }) {
                        Text("取消")
                    }
                }
            )
        }
    }

    @Composable
    private fun CameraPreviewBox(onDecoded: (String) -> Unit) {
        val context = LocalContext.current
        val lifecycleOwner = LocalLifecycleOwner.current
        val analyzerExecutor = remember { Executors.newSingleThreadExecutor() }
        val previewView = remember { PreviewView(context) }

        DisposableEffect(lifecycleOwner) {
            val future = ProcessCameraProvider.getInstance(context)
            val mainExecutor = ContextCompat.getMainExecutor(context)
            var boundCamera: Camera? = null
            previewView.setOnTouchListener { v, event ->
                if (event.action == MotionEvent.ACTION_UP) {
                    val cam = boundCamera
                    if (cam != null) {
                        val point = previewView.meteringPointFactory.createPoint(event.x, event.y)
                        cam.cameraControl.startFocusAndMetering(FocusMeteringAction.Builder(point).build())
                    }
                    v.performClick()
                }
                true
            }
            future.addListener({
                try {
                    val provider = future.get()
                    val preview = Preview.Builder().build().apply {
                        setSurfaceProvider(previewView.surfaceProvider)
                    }
                    val resolutionSelector = ResolutionSelector.Builder()
                        .setResolutionStrategy(
                            ResolutionStrategy(
                                Size(1280, 720),
                                ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
                            )
                        )
                        .build()
                    val analysis = ImageAnalysis.Builder()
                        .setResolutionSelector(resolutionSelector)
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                        .apply {
                            setAnalyzer(analyzerExecutor) { image ->
                                try {
                                    val decoded = decodeYuvImage(image)
                                    if (decoded != null) {
                                        runOnUiThread { onDecoded(decoded) }
                                    }
                                } finally {
                                    image.close()
                                }
                            }
                        }
                    provider.unbindAll()
                    boundCamera = provider.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        analysis
                    )
                } catch (failure: Exception) {
                    scanError = "无法启动相机预览，请尝试从相册选择或粘贴链接。"
                }
            }, mainExecutor)

            onDispose {
                previewView.setOnTouchListener(null)
                boundCamera = null
                try {
                    if (future.isDone) future.get().unbindAll()
                } catch (_: Exception) {
                }
                analyzerExecutor.shutdownNow()
            }
        }

        AndroidView(
            factory = { previewView },
            modifier = Modifier.fillMaxSize()
        )
    }

    private fun decodeYuvImage(image: ImageProxy): String? {
        val plane = image.planes.firstOrNull() ?: return null
        val width = image.width
        val height = image.height
        if (width <= 0 || height <= 0) return null
        val rowStride = plane.rowStride
        val pixelStride = plane.pixelStride
        val buffer = plane.buffer
        val data = ByteArray(width * height)
        if (pixelStride == 1 && rowStride == width) {
            buffer.get(data, 0, minOf(buffer.remaining(), data.size))
        } else {
            val rowBuffer = ByteArray(rowStride)
            val totalRemaining = buffer.remaining()
            for (row in 0 until height) {
                val offset = row * rowStride
                if (offset >= totalRemaining) break
                val len = minOf(rowStride, totalRemaining - offset)
                buffer.position(offset)
                buffer.get(rowBuffer, 0, len)
                if (pixelStride == 1) {
                    System.arraycopy(rowBuffer, 0, data, row * width, minOf(width, len))
                } else {
                    for (col in 0 until width) {
                        val idx = col * pixelStride
                        if (idx < len) data[row * width + col] = rowBuffer[idx]
                    }
                }
            }
        }
        val source = PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false)
        return decodeLuminanceSource(source)
    }

    private fun decodeFromImageUri(uri: Uri) {
        try {
            val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
            if (bytes == null) {
                scanError = "无法读取所选图片。"
                return
            }
            val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
            var sample = 1
            while (maxOf(options.outWidth, options.outHeight) / sample > 1200) {
                sample *= 2
            }
            val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sample }
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, decodeOpts)
            if (bmp == null) {
                scanError = "所选文件不是有效的图片。"
                return
            }
            val pixels = IntArray(bmp.width * bmp.height)
            bmp.getPixels(pixels, 0, bmp.width, 0, 0, bmp.width, bmp.height)
            val source = RGBLuminanceSource(bmp.width, bmp.height, pixels)
            val decoded = decodeLuminanceSource(source)
            if (decoded != null) {
                returnQrResult(decoded)
            } else {
                scanError = "未在图片中识别到二维码。"
            }
        } catch (failure: Exception) {
            scanError = "识别图片二维码失败。"
        }
    }

    private fun decodeLuminanceSource(source: LuminanceSource): String? =
        decodeBitmapSource(BinaryBitmap(HybridBinarizer(source)))
            ?: decodeBitmapSource(BinaryBitmap(GlobalHistogramBinarizer(source)))

    private fun decodeBitmapSource(bitmap: BinaryBitmap): String? {
        val hints = EnumMap<DecodeHintType, Any>(DecodeHintType::class.java).apply {
            put(DecodeHintType.TRY_HARDER, true)
        }
        return try {
            QRCodeReader().decode(bitmap, hints).text
        } catch (_: Exception) {
            null
        }
    }

    private fun returnQrResult(text: String) {
        if (!delivered.compareAndSet(false, true)) return
        setResult(RESULT_OK, Intent().putExtra(EXTRA_QR_TEXT, text))
        finish()
    }
}
