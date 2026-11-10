package work.fundamentals.theorem.libraryscan

import android.app.Service
import android.content.Intent
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import org.mockito.Mockito.*

class ImportServiceTest {
  private val service = mock(ImportService::class.java)

  @Before fun prepare() { ImportService.prepare() }

  @Test fun timeoutRequestsNativeCancellationAndStopsTheService() {
    assertFalse(ImportService.isStopped())
    doCallRealMethod().`when`(service).onTimeout(1, 1)
    service.onTimeout(1, 1)
    assertTrue(ImportService.isStopped())
    assertFalse(ImportService.running)
    verify(service).stopSelf()
  }

  @Test fun stopActionCancelsWithoutRequestingAnAutomaticRestart() {
    val intent = mock(Intent::class.java)
    `when`(intent.action).thenReturn("work.fundamentals.theorem.STOP_IMPORT")
    doCallRealMethod().`when`(service).onStartCommand(intent, 0, 1)
    assertEquals(Service.START_NOT_STICKY, service.onStartCommand(intent, 0, 1))
    assertTrue(ImportService.isStopped())
    verify(service).stopSelf()
  }

  @Test fun nullAndUnknownIntentsDoNotCancelOrRestartWork() {
    val intent = mock(Intent::class.java)
    `when`(intent.action).thenReturn("work.fundamentals.theorem.STOP_IMPORT.extra")
    doCallRealMethod().`when`(service).onStartCommand(intent, 0, 1)
    doCallRealMethod().`when`(service).onStartCommand(null, 0, 2)
    assertEquals(Service.START_NOT_STICKY, service.onStartCommand(intent, 0, 1))
    assertEquals(Service.START_NOT_STICKY, service.onStartCommand(null, 0, 2))
    assertFalse(ImportService.isStopped())
    verify(service, never()).stopSelf()
  }

  @Test fun aNewExplicitImportResetsCancellationAndProgressWithLongCounters() {
    ImportService.completedBytes.set(5L * 1024 * 1024 * 1024)
    ImportService.totalBytes.set(6L * 1024 * 1024 * 1024)
    assertTrue(ImportService.completedBytes.get() > Int.MAX_VALUE)
    ImportService.requestStop()
    ImportService.prepare()
    assertFalse(ImportService.isStopped())
    assertTrue(ImportService.running)
    assertEquals(0L, ImportService.completedBytes.get())
    assertEquals(-1L, ImportService.totalBytes.get())
  }

  @Test fun stopClosesAnAttachedProviderStreamWithoutBlockingTheServiceCallback() {
    val closed = java.util.concurrent.CountDownLatch(1)
    val stream = object : java.io.ByteArrayInputStream(byteArrayOf(1)) {
      override fun close() { closed.countDown(); super.close() }
    }
    assertTrue(ImportService.attachInput(stream))
    ImportService.requestStop()
    assertTrue(closed.await(5, java.util.concurrent.TimeUnit.SECONDS))
    assertFalse(ImportService.running)
  }

  @Test fun aProviderStreamOpenedAfterStopIsClosedInsteadOfImported() {
    ImportService.requestStop()
    val closed = java.util.concurrent.CountDownLatch(1)
    val stream = object : java.io.ByteArrayInputStream(byteArrayOf(1)) {
      override fun close() { closed.countDown(); super.close() }
    }
    assertFalse(ImportService.attachInput(stream))
    assertTrue(closed.await(5, java.util.concurrent.TimeUnit.SECONDS))
  }


  @Test fun stopCancelsAnInFlightDocumentProviderRequest() {
    val cancelled = java.util.concurrent.CountDownLatch(1)
    val signal = mock(android.os.CancellationSignal::class.java)
    doAnswer { cancelled.countDown(); null }.`when`(signal).cancel()
    assertTrue(ImportService.attachCancellation(signal))
    ImportService.requestStop()
    assertTrue(cancelled.await(5, java.util.concurrent.TimeUnit.SECONDS))
    verify(signal).cancel()
  }

}
