package work.fundamentals.theorem.libraryscan

import android.content.res.AssetFileDescriptor
import java.io.FileInputStream
import java.io.IOException
import org.junit.Test
import org.junit.Assert.*
import org.mockito.Mockito.*

class ImportDocumentStreamTest {
  @Test fun missingDescriptorProducesNoStream() {
    assertNull(openImportDescriptor(null))
  }

  @Test fun streamCreationFailureClosesTheDescriptorAndKeepsTheOriginalFailure() {
    val descriptor = mock(AssetFileDescriptor::class.java)
    val failure = IOException("Provider stream unavailable")
    `when`(descriptor.createInputStream()).thenThrow(failure)
    assertSame(failure, assertThrows(IOException::class.java) { openImportDescriptor(descriptor) })
    verify(descriptor).close()
  }

  @Test fun successfulStreamStaysOpenUntilItsConsumerFinishes() {
    val descriptor = mock(AssetFileDescriptor::class.java)
    val stream = mock(FileInputStream::class.java)
    `when`(descriptor.createInputStream()).thenReturn(stream)
    val opened = openImportDescriptor(descriptor)
    assertSame(stream, opened)
    verify(descriptor, never()).close()
    verify(stream, never()).close()
    opened.use { }
    verify(stream).close()
  }
}
