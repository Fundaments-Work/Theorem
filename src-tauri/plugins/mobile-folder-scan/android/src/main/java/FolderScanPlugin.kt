package work.fundamentals.theorem.libraryscan

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.documentfile.provider.DocumentFile
import app.tauri.Logger
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import kotlinx.coroutines.*
import java.io.File
import java.io.FileOutputStream
import java.util.Collections
import java.util.Locale
import java.util.concurrent.Executors

@InvokeArg
class ScanFolderArgs {
  lateinit var treeUri: String
  var recursive: Boolean? = true
}

@InvokeArg
class SaveImageArgs {
  lateinit var filename: String
  lateinit var base64Data: String
}

@InvokeArg
class MaterializeContentUriArgs {
  lateinit var uri: String
  lateinit var fileName: String
}

@TauriPlugin
class FolderScanPlugin(private val activity: Activity) : Plugin(activity) {
  private val supportedSuffixes = arrayOf(
    ".epub",
    ".mobi",
    ".azw3",
    ".azw",
    ".fb2.zip",
    ".fb2",
    ".fbz",
    ".cbz",
    ".cbr",
    ".pdf"
  )
  private val scanExecutor = Executors.newSingleThreadExecutor()

  @Command
  fun pickFolder(invoke: Invoke) {
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        addFlags(
          Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        )
      }
      startActivityForResult(invoke, intent, "pickFolderResult")
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Failed to open folder picker")
    }
  }

  @ActivityCallback
  fun pickFolderResult(invoke: Invoke, result: ActivityResult) {
    val response = JSObject()
    when (result.resultCode) {
      Activity.RESULT_OK -> {
        val uri = result.data?.data
        if (uri != null) {
          val requestedFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION
          val grantFlags =
            (result.data?.flags ?: 0) and
              requestedFlags
          val persistFlags = if (grantFlags == 0) Intent.FLAG_GRANT_READ_URI_PERMISSION else grantFlags
          try {
            activity.contentResolver.takePersistableUriPermission(uri, persistFlags)
          } catch (error: SecurityException) {
            Logger.warn("Failed to persist folder permission: ${error.message}")
          }
          response.put("uri", uri.toString())
        } else {
          response.put("uri", null)
        }
        invoke.resolve(response)
      }
      Activity.RESULT_CANCELED -> {
        response.put("uri", null)
        invoke.resolve(response)
      }
      else -> invoke.reject("Failed to pick folder")
    }
  }

  @Command
  fun scanFolder(invoke: Invoke) {
    scanExecutor.execute {
      try {
        val args = invoke.parseArgs(ScanFolderArgs::class.java)
        val treeUriValue = args.treeUri.trim()
        if (treeUriValue.isEmpty()) {
          invoke.reject("Folder URI is empty.")
          return@execute
        }

        val treeUri = Uri.parse(treeUriValue)
        val root = DocumentFile.fromTreeUri(activity, treeUri)
        if (root == null || !root.isDirectory || !root.canRead()) {
          invoke.reject("Selected folder is not accessible.")
          return@execute
        }

        val files = collectBookUris(root, args.recursive != false)

        val result = JSObject()
        result.put("files", JSArray.from(files.toTypedArray()))
        invoke.resolve(result)
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Failed to scan folder")
      }
    }
  }

  private fun collectBookUris(root: DocumentFile, recursive: Boolean): List<String> {
    val results = Collections.synchronizedList(ArrayList<String>())

    fun scanDirectory(dir: DocumentFile) {
      val entries = try {
        dir.listFiles()
      } catch (_: Exception) {
        return
      }

      val subdirs = ArrayList<DocumentFile>()

      for (entry in entries) {
        if (entry.isDirectory) {
          if (recursive) {
            subdirs.add(entry)
          }
          continue
        }

        if (entry.isFile && isSupportedBookFile(entry)) {
          results.add(entry.uri.toString())
        }
      }

      if (subdirs.isNotEmpty() && recursive) {
        runBlocking {
          subdirs.map { subdir ->
            async(Dispatchers.IO) { scanDirectory(subdir) }
          }.awaitAll()
        }
      }
    }

    scanDirectory(root)
    return results
  }

  private fun isSupportedBookFile(entry: DocumentFile): Boolean {
    val name = entry.name?.lowercase(Locale.ROOT)
    if (name != null && supportedSuffixes.any { suffix -> name.endsWith(suffix) }) {
      return true
    }

    val mimeType = entry.type?.lowercase(Locale.ROOT) ?: return false
    return mimeType == "application/epub+zip" ||
      mimeType == "application/x-mobipocket-ebook" ||
      mimeType == "application/vnd.amazon.ebook" ||
      mimeType == "application/vnd.amazon.mobi8-ebook" ||
      mimeType == "application/x-fictionbook+xml" ||
      mimeType == "application/vnd.comicbook+zip" ||
      mimeType == "application/pdf"
  }

  @Command
  fun saveImage(invoke: Invoke) {
    scanExecutor.execute {
      try {
        val args = invoke.parseArgs(SaveImageArgs::class.java)
        val filename = args.filename
        val base64Data = args.base64Data

        if (filename.isEmpty() || base64Data.isEmpty()) {
          invoke.reject("Filename and image data are required.")
          return@execute
        }

        val bytes = android.util.Base64.decode(base64Data, android.util.Base64.DEFAULT)

        val contentValues = ContentValues().apply {
          put(MediaStore.Images.Media.DISPLAY_NAME, filename)
          put(MediaStore.Images.Media.MIME_TYPE, "image/png")
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Theorem")
            put(MediaStore.Images.Media.IS_PENDING, 1)
          }
        }

        val uri = activity.contentResolver.insert(
          MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
          contentValues
        )

        if (uri != null) {
          activity.contentResolver.openOutputStream(uri)?.use { os ->
            os.write(bytes)
          }

          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            contentValues.clear()
            contentValues.put(MediaStore.Images.Media.IS_PENDING, 0)
            activity.contentResolver.update(uri, contentValues, null, null)
          }

          val response = JSObject()
          response.put("uri", uri.toString())
          invoke.resolve(response)
        } else {
          invoke.reject("Failed to create MediaStore entry")
        }
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Failed to save image")
      }
    }
  }

  @Command
  fun saveFile(invoke: Invoke) {
    scanExecutor.execute {
      try {
        val args = invoke.parseArgs(SaveImageArgs::class.java)
        val filename = args.filename
        val base64Data = args.base64Data

        if (filename.isEmpty() || base64Data.isEmpty()) {
          invoke.reject("Filename and file data are required.")
          return@execute
        }

        val bytes = android.util.Base64.decode(base64Data, android.util.Base64.DEFAULT)

        val contentValues = ContentValues().apply {
          put(MediaStore.Downloads.DISPLAY_NAME, filename)
          put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            put(MediaStore.Downloads.RELATIVE_PATH, "Download/Theorem")
            put(MediaStore.Downloads.IS_PENDING, 1)
          }
        }

        val uri = activity.contentResolver.insert(
          MediaStore.Downloads.EXTERNAL_CONTENT_URI,
          contentValues
        )

        if (uri != null) {
          activity.contentResolver.openOutputStream(uri)?.use { os ->
            os.write(bytes)
          }

          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            contentValues.clear()
            contentValues.put(MediaStore.Downloads.IS_PENDING, 0)
            activity.contentResolver.update(uri, contentValues, null, null)
          }

          val response = JSObject()
          response.put("uri", uri.toString())
          invoke.resolve(response)
        } else {
          invoke.reject("Failed to create MediaStore entry")
        }
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Failed to save file")
      }
    }
  }

  @Command
  fun getAndroidId(invoke: Invoke) {
    val response = JSObject()
    val androidId = Settings.Secure.getString(
      activity.contentResolver,
      Settings.Secure.ANDROID_ID
    )
    response.put("androidId", androidId ?: "")
    invoke.resolve(response)
  }

  @Command
  fun materializeContentUri(invoke: Invoke) {
    scanExecutor.execute {
      try {
        val args = invoke.parseArgs(MaterializeContentUriArgs::class.java)
        val uri = Uri.parse(args.uri)
        val fileName = args.fileName

        val inputStream = activity.contentResolver.openInputStream(uri)
        if (inputStream == null) {
          invoke.reject("Cannot open content URI for reading")
          return@execute
        }

        val importDir = File(activity.filesDir, "theorem_import")
        if (!importDir.exists()) {
          importDir.mkdirs()
        }

        // Sanitize filename to avoid path traversal
        val safeName = fileName.replace("[^a-zA-Z0-9._-]".toRegex(), "_")
        val outFile = File(importDir, safeName)

        inputStream.use { input ->
          FileOutputStream(outFile).use { output ->
            input.copyTo(output)
          }
        }

        val response = JSObject()
        response.put("path", outFile.absolutePath)
        invoke.resolve(response)
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Failed to materialize content URI")
      }
    }
  }
}
