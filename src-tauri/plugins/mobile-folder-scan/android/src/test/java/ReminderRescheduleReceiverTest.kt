package work.fundamentals.theorem.libraryscan

import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import org.junit.Test
import org.mockito.Mockito.CALLS_REAL_METHODS
import org.mockito.Mockito.mock
import org.mockito.Mockito.reset
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.Mockito.`when`

class ReminderRescheduleReceiverTest {
  private val context = mock(Context::class.java)
  // Android's JVM stub constructor throws; bypass construction while exercising
  // the actual onReceive implementation against mocked platform boundaries.
  private val receiver = mock(ReminderRescheduleReceiver::class.java, CALLS_REAL_METHODS)

  private fun deliver(action: String?) {
    val intent = mock(Intent::class.java)
    `when`(intent.action).thenReturn(action)
    receiver.onReceive(context, intent)
  }

  @Test
  fun ignoresMissingUnknownAndLookalikeActions() {
    for (action in listOf(null, "", "BOOT_COMPLETED", "android.intent.action.TIME_TICK",
      "android.intent.action.BOOT_COMPLETED.extra", "work.fundamentals.theorem.RESCHEDULE")) {
      reset(context)
      deliver(action)
      verifyNoInteractions(context)
    }
  }

  @Test
  fun reschedulesForEverySupportedSystemAction() {
    for (action in listOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED,
      Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED,
      AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED)) {
      reset(context)
      deliver(action)
      verify(context).getSystemService(AlarmManager::class.java)
    }
  }
}
