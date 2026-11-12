package work.fundamentals.theorem.libraryscan

import android.content.ContentResolver
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.mockito.Mockito.*

class FolderScanPluginTest {
  @Before fun prepare() {
    ImportService.prepare()
  }

  @Test fun resolvePickedBookDocumentSurvivesSecurityExceptionAndExtractsMime() {
    val resolver = mock(ContentResolver::class.java)
    val uri = mock(Uri::class.java)
    val cursor = mock(Cursor::class.java)
    `when`(uri.toString()).thenReturn("content://provider/doc/42")

    doThrow(SecurityException("Provider does not allow persistable grants"))
      .`when`(resolver)
      .takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)

    `when`(cursor.moveToFirst()).thenReturn(true)
    `when`(cursor.isNull(0)).thenReturn(false)
    `when`(cursor.getString(0)).thenReturn("untitled-document")
    `when`(resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null))
      .thenReturn(cursor)
    `when`(resolver.getType(uri)).thenReturn("application/epub+zip")

    val doc = resolvePickedBookDocument(resolver, uri)

    assertEquals("content://provider/doc/42", doc.source)
    assertEquals("untitled-document", doc.name)
    assertEquals("application/epub+zip", doc.mimeType)
    verify(cursor).close()
  }

  @Test fun resolvePickedBookDocumentRejectsMissingDisplayName() {
    val resolver = mock(ContentResolver::class.java)
    val uri = mock(Uri::class.java)
    val cursor = mock(Cursor::class.java)
    `when`(cursor.moveToFirst()).thenReturn(false)
    `when`(resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null))
      .thenReturn(cursor)

    val err = assertThrows(IllegalArgumentException::class.java) {
      resolvePickedBookDocument(resolver, uri)
    }
    assertTrue(err.message!!.contains("filename"))
    verify(cursor).close()
  }

  @Test fun copyImportStreamRemovesPartialFileOnMidStreamReadFailure() {
    val dir = Files.createTempDirectory("theorem-plugin-io-test").toFile()
    try {
      val failingStream = object : InputStream() {
        private var reads = 0
        override fun read(): Int = if (reads++ < 8) 0x41 else throw IOException("Disk read reset")
        override fun read(b: ByteArray, off: Int, len: Int): Int {
          if (reads++ == 0) {
            b[off] = 0x41
            return 1
          }
          throw IOException("Provider stream failed mid-copy")
        }
      }

      val err = assertThrows(IOException::class.java) {
        copyImportStreamToFile(
          fileName = "broken.epub",
          importDir = dir,
          managedImport = true,
          openStream = { failingStream },
          querySize = { 1024L },
        )
      }
      assertTrue(err.message!!.contains("mid-copy"))
      assertEquals(0, dir.listFiles()?.size ?: 0)
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test fun copyImportStreamRejectsRevokedPermissionWithoutLeavingTempFiles() {
    val dir = Files.createTempDirectory("theorem-plugin-perm-test").toFile()
    try {
      val uri = mock(Uri::class.java)
      assertThrows(SecurityException::class.java) {
        copyImportStreamToFile(
          fileName = "../../secret.epub",
          importDir = dir,
          managedImport = false,
          openStream = { throw SecurityException("Permission Denial: reading $uri") },
          querySize = { -1L },
        )
      }
      assertEquals(0, dir.listFiles()?.size ?: 0)
    } finally {
      dir.deleteRecursively()
    }
  }
}
