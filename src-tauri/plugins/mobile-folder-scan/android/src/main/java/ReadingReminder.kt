package work.fundamentals.theorem.libraryscan

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.util.Calendar
import java.util.Locale

/**
 * The daily reading reminder, kept by Android itself so it fires while Theorem is closed.
 *
 * Only the next reminder is ever scheduled. When it fires it posts the notification and
 * schedules the following day; [ReminderRescheduleReceiver] schedules it again after a reboot,
 * an app update, a clock or time zone change, or when exact alarms are allowed. The app sends
 * the settings (on/off, time, text, and "skip today" once the goal is met) through
 * [configure]; everything else happens here.
 */
object ReadingReminder {
  private const val PREFS = "theorem_reading_reminder"
  const val CHANNEL_ID = "reading-reminders"
  const val NOTIFICATION_ID = 7_000_001
  private const val REQUEST_CODE = 7_000_001
  /**
   * A reminder that was due within this long ago and never shown (the phone was off, or a
   * clock correction rescheduled it while Android was still holding it in its delivery window)
   * is shown at once instead of being skipped.
   */
  const val CATCH_UP_MS = 2 * 60 * 60 * 1000L

  data class Config(
    val enabled: Boolean,
    val hour: Int,
    val minute: Int,
    val title: String,
    val body: String,
    /** "yyyy-MM-dd": no reminder on this local day (the goal is already met). */
    val skipDate: String?,
  )

  fun configure(context: Context, config: Config) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putBoolean("enabled", config.enabled)
      .putInt("hour", config.hour)
      .putInt("minute", config.minute)
      .putString("title", config.title)
      .putString("body", config.body)
      .putString("skipDate", config.skipDate)
      .apply()
    schedule(context)
  }

  fun load(context: Context): Config? {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (!prefs.contains("enabled")) return null
    return Config(
      enabled = prefs.getBoolean("enabled", false),
      hour = prefs.getInt("hour", 20),
      minute = prefs.getInt("minute", 0),
      title = prefs.getString("title", null) ?: "Time to read",
      body = prefs.getString("body", null) ?: "",
      skipDate = prefs.getString("skipDate", null),
    )
  }

  fun dateKey(calendar: Calendar): String = String.format(
    Locale.ROOT,
    "%04d-%02d-%02d",
    calendar.get(Calendar.YEAR),
    calendar.get(Calendar.MONTH) + 1,
    calendar.get(Calendar.DAY_OF_MONTH),
  )

  /** The next moment to remind, strictly after [now], in the device's current time zone. */
  fun nextTrigger(config: Config, now: Calendar): Calendar {
    val next = now.clone() as Calendar
    next.set(Calendar.HOUR_OF_DAY, config.hour)
    next.set(Calendar.MINUTE, config.minute)
    next.set(Calendar.SECOND, 0)
    next.set(Calendar.MILLISECOND, 0)
    // At most two steps: past today's time, then the skipped day.
    while (!next.after(now) || dateKey(next) == config.skipDate) {
      next.add(Calendar.DAY_OF_MONTH, 1)
      // Set again: on a daylight-saving day the hour can shift.
      next.set(Calendar.HOUR_OF_DAY, config.hour)
      next.set(Calendar.MINUTE, config.minute)
    }
    return next
  }

  fun canScheduleExact(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
      (context.getSystemService(AlarmManager::class.java)?.canScheduleExactAlarms() ?: false)

  private fun pendingIntent(context: Context): PendingIntent {
    val intent = Intent(context, ReminderReceiver::class.java)
    return PendingIntent.getBroadcast(
      context,
      REQUEST_CODE,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** The day ("yyyy-MM-dd") whose reminder has been handled, shown or skipped. */
  fun markHandled(context: Context, day: String) {
    prefs(context).edit().putString("handledDate", day).apply()
  }

  /**
   * The reminder that was due at [scheduledAt] but has not been handled, if it is recent
   * enough and still matches the settings (a new reminder time never triggers a catch-up).
   */
  fun missedReminder(config: Config, scheduledAt: Long, handledDate: String?, now: Long): Boolean {
    if (scheduledAt <= 0 || scheduledAt > now || now - scheduledAt > CATCH_UP_MS) return false
    val due = Calendar.getInstance().apply { timeInMillis = scheduledAt }
    if (due.get(Calendar.HOUR_OF_DAY) != config.hour || due.get(Calendar.MINUTE) != config.minute) return false
    val day = dateKey(due)
    return day != handledDate && day != config.skipDate
  }

  /** Replaces the scheduled reminder with the next one, or removes it when reminders are off. */
  fun schedule(context: Context) {
    val alarms = context.getSystemService(AlarmManager::class.java) ?: return
    val pending = pendingIntent(context)
    alarms.cancel(pending)
    val config = load(context) ?: return
    if (!config.enabled) return
    val prefs = prefs(context)
    val now = System.currentTimeMillis()
    val scheduledAt = prefs.getLong("scheduledAt", 0L)
    val at = if (missedReminder(config, scheduledAt, prefs.getString("handledDate", null), now)) {
      // Keep "scheduledAt" so the receiver knows which day it is showing.
      now + 1_000L
    } else {
      nextTrigger(config, Calendar.getInstance()).timeInMillis.also {
        prefs.edit().putLong("scheduledAt", it).apply()
      }
    }
    // Exact when allowed. Otherwise Android 12+ may deliver it up to an hour late; both kinds
    // still fire while the phone dozes.
    if (canScheduleExact(context)) {
      alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
    } else {
      alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
    }
  }

  /** When the scheduled reminder is due, as last scheduled. */
  fun nextTriggerMillis(context: Context): Long? {
    val config = load(context) ?: return null
    if (!config.enabled) return null
    val scheduledAt = prefs(context).getLong("scheduledAt", 0L)
    return if (scheduledAt > 0) scheduledAt else nextTrigger(config, Calendar.getInstance()).timeInMillis
  }

  fun scheduledDay(context: Context): String? {
    val scheduledAt = prefs(context).getLong("scheduledAt", 0L)
    if (scheduledAt <= 0) return null
    return dateKey(Calendar.getInstance().apply { timeInMillis = scheduledAt })
  }

  fun post(context: Context, config: Config) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(CHANNEL_ID, "Reading reminders", NotificationManager.IMPORTANCE_DEFAULT)
      channel.description = "A daily reminder when you have not met your reading goal yet"
      context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val contentIntent = launch?.let {
      it.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
      PendingIntent.getActivity(context, REQUEST_CODE, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_theorem)
      .setContentTitle(config.title)
      .setContentText(config.body)
      .setCategory(NotificationCompat.CATEGORY_REMINDER)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setAutoCancel(true)
      .apply { if (contentIntent != null) setContentIntent(contentIntent) }
      .build()
    try {
      NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
    } catch (_: SecurityException) {
      // Notifications were turned off between the check and the post.
    }
  }
}

/** The reminder is due: show it unless today's goal is met, then schedule tomorrow's. */
class ReminderReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val config = ReadingReminder.load(context) ?: return
    // The day this reminder belongs to: a late delivery after midnight is still yesterday's.
    val day = ReadingReminder.scheduledDay(context) ?: ReadingReminder.dateKey(Calendar.getInstance())
    if (config.enabled && day != config.skipDate) {
      ReadingReminder.post(context, config)
    }
    ReadingReminder.markHandled(context, day)
    ReadingReminder.schedule(context)
  }
}

/** Android drops alarms on reboot and app update, and a clock change moves "20:00". */
class ReminderRescheduleReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    ReadingReminder.schedule(context)
  }
}
