package work.fundamentals.theorem.libraryscan

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.CancellationSignal
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import java.io.InputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicLong

/** Keeps the explicitly started native import alive; recovery always requires a user action. */
class ImportService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onCreate() {
    super.onCreate()
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Book imports", NotificationManager.IMPORTANCE_LOW))
    }
    val stop = PendingIntent.getService(this, 0, Intent(this, ImportService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 1, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val notification = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle("Importing books")
      .setContentText("Return to Library to see import progress")
      .setContentIntent(open)
      .setOngoing(true)
      .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stop)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION, notification)
    }
    wakeLock = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:book-import").also {
      it.acquire(6 * 60 * 60 * 1000L)
    }
  }

  internal var startedGeneration: Long = 0L

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val extraGen = intent?.getLongExtra(EXTRA_GENERATION, 0L) ?: 0L
    if (extraGen > 0L) {
      startedGeneration = extraGen
    } else if (startedGeneration == 0L && intent?.action != STOP) {
      startedGeneration = currentGeneration.get()
    }
    if (intent?.action == STOP) stopImport()
    return START_NOT_STICKY
  }

  override fun onTimeout(startId: Int, fgsType: Int) { stopImport() }

  private fun stopImport() {
    requestStop()
    stopSelf()
  }

  internal fun handleDestroy() {
    requestStopForGeneration(startedGeneration)
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  override fun onDestroy() {
    handleDestroy()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  companion object {
    private const val CHANNEL = "theorem-book-imports"
    private const val NOTIFICATION = 180
    private const val STOP = "work.fundamentals.theorem.STOP_IMPORT"
    private const val EXTRA_GENERATION = "work.fundamentals.theorem.IMPORT_GENERATION"
    private val currentGeneration = AtomicLong(0)
    val completedBytes = AtomicLong(0)
    val totalBytes = AtomicLong(-1)
    @Volatile var copying = false
    @Volatile var running = false
    @Volatile private var stopped = false
    private val activeInput = AtomicReference<InputStream?>(null)
    private val activeCancellation = AtomicReference<CancellationSignal?>(null)

    internal fun attachCancellation(signal: CancellationSignal): Boolean {
      activeCancellation.set(signal)
      if (stopped) { requestStop(); return false }
      return true
    }

    internal fun detachCancellation(signal: CancellationSignal) { activeCancellation.compareAndSet(signal, null) }
    private val closeExecutor = Executors.newSingleThreadExecutor { task -> Thread(task, "import-cancel").apply { isDaemon = true } }

    internal fun attachInput(input: InputStream): Boolean {
      activeInput.set(input)
      if (stopped) { requestStop(); return false }
      return true
    }

    internal fun detachInput(input: InputStream) { activeInput.compareAndSet(input, null) }

    internal fun prepare() {
      currentGeneration.incrementAndGet()
      stopped = false
      running = true
      copying = false
      completedBytes.set(0)
      totalBytes.set(-1)
    }

    fun start(context: Context) {
      prepare()
      val generation = currentGeneration.get()
      try {
        val intent = Intent(context, ImportService::class.java).putExtra(EXTRA_GENERATION, generation)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
      } catch (error: Exception) {
        running = false
        stopped = true
        throw error
      }
    }

    internal fun requestStopForGeneration(generation: Long) {
      if (generation == 0L || currentGeneration.get() == generation) {
        requestStop()
      }
    }

    fun requestStop() {
      stopped = true
      running = false
      activeCancellation.getAndSet(null)?.let { signal -> closeExecutor.execute { runCatching { signal.cancel() } } }
      activeInput.getAndSet(null)?.let { input -> closeExecutor.execute { runCatching { input.close() } } }
    }

    fun isStopped(): Boolean = stopped

    fun finish(context: Context) {
      requestStop()
      context.stopService(Intent(context, ImportService::class.java))
    }
  }
}
