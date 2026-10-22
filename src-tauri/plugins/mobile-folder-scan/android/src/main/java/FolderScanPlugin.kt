package work.fundamentals.theorem.libraryscan

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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
import java.io.File
import java.io.FileOutputStream
import java.util.Locale
import java.util.concurrent.Executors

@InvokeArg
class ConfigureReminderArgs {
  var enabled: Boolean = false
  var hour: Int = 20
  var minute: Int = 0
  var title: String = "Time to read"
  var body: String = ""
  var skipDate: String? = null
}

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
class SaveFileFromPathArgs {
  lateinit var sourcePath: String
  lateinit var filename: String
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

  private companion object {
    const val MAX_SCAN_DEPTH = 64
  }

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

        val issues = ArrayList<JSObject>()
        val files = collectBooks(treeUri, root.name ?: "Imported folder", args.recursive != false, issues)

        val result = JSObject()
        result.put("files", JSArray.from(files.toTypedArray()))
        result.put("issues", JSArray.from(issues.toTypedArray()))
        result.put("cancelled", false)
        invoke.resolve(result)
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Failed to scan folder")
      }
    }
  }

  /**
   * List the books below a tree URI with one provider query per folder.
   * DocumentFile asks the provider again for every name, type and size,
   * which made large folders take minutes; this reads them all at once.
   * Folders that cannot be read are reported instead of skipped silently.
   */
  private fun collectBooks(
    treeUri: Uri,
    rootName: String,
    recursive: Boolean,
    issues: MutableList<JSObject>
  ): List<JSObject> {
    val resolver = activity.contentResolver
    val results = ArrayList<JSObject>()
    val projection = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_SIZE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED
    )
    val visited = HashSet<String>()
    val pending = ArrayDeque<Triple<String, String, Int>>()
    pending.addLast(Triple(DocumentsContract.getTreeDocumentId(treeUri), "", 0))
    var depthReported = false

    fun issue(relativeDir: String, reason: String) {
      val entry = JSObject()
      entry.put("path", if (relativeDir.isEmpty()) rootName else "$rootName/${relativeDir.trimEnd('/')}")
      entry.put("reason", reason)
      issues.add(entry)
    }

    while (pending.isNotEmpty()) {
      val (documentId, relativeDir, depth) = pending.removeLast()
      if (!visited.add(documentId)) continue
      val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId)
      try {
        val cursor = resolver.query(childrenUri, projection, null, null, null)
        if (cursor == null) {
          issue(relativeDir, "This folder could not be read")
          continue
        }
        cursor.use { rows ->
          while (rows.moveToNext()) {
            val id = rows.getString(0) ?: continue
            val name = rows.getString(1) ?: continue
            val mimeType = rows.getString(2) ?: ""
            // Hidden folders and files (.Trash, ._resource forks) are never books.
            if (name.startsWith(".")) continue
            if (mimeType == DocumentsContract.Document.MIME_TYPE_DIR) {
              if (!recursive) continue
              if (depth + 1 >= MAX_SCAN_DEPTH) {
                if (!depthReported) {
                  depthReported = true
                  issue(relativeDir + name, "Folders nested deeper than $MAX_SCAN_DEPTH levels were skipped")
                }
                continue
              }
              pending.addLast(Triple(id, "$relativeDir$name/", depth + 1))
              continue
            }
            if (!isSupportedBook(name, mimeType)) continue
            val file = JSObject()
            file.put("path", DocumentsContract.buildDocumentUriUsingTree(treeUri, id).toString())
            file.put("relativePath", relativeDir + name)
            file.put("rootName", rootName)
            if (!rows.isNull(3)) file.put("size", rows.getLong(3))
            if (!rows.isNull(4)) file.put("modifiedMs", rows.getLong(4))
            results.add(file)
          }
        }
      } catch (error: Exception) {
        issue(relativeDir, error.message ?: "This folder could not be read")
      }
    }
    results.sortBy { it.getString("relativePath") }
    return results
  }

  private fun isSupportedBook(name: String, mimeType: String): Boolean {
    val lower = name.lowercase(Locale.ROOT)
    if (supportedSuffixes.any { suffix -> lower.endsWith(suffix) }) {
      return true
    }
    return when (mimeType.lowercase(Locale.ROOT)) {
      "application/epub+zip",
      "application/x-mobipocket-ebook",
      "application/vnd.amazon.ebook",
      "application/vnd.amazon.mobi8-ebook",
      "application/x-fictionbook+xml",
      "application/vnd.comicbook+zip",
      "application/pdf" -> true
      else -> false
    }
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

  /** Copy a local file into Downloads/Theorem as a stream (backups can be GBs). */
  @Command
  fun saveFileFromPath(invoke: Invoke) {
    scanExecutor.execute {
      var uri: Uri? = null
      try {
        val args = invoke.parseArgs(SaveFileFromPathArgs::class.java)
        val source = File(args.sourcePath)
        if (args.filename.isEmpty() || !source.isFile) {
          invoke.reject("Filename and an existing source file are required.")
          return@execute
        }

        val contentValues = ContentValues().apply {
          put(MediaStore.Downloads.DISPLAY_NAME, args.filename)
          put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            put(MediaStore.Downloads.RELATIVE_PATH, "Download/Theorem")
            put(MediaStore.Downloads.IS_PENDING, 1)
          }
        }

        val target = activity.contentResolver.insert(
          MediaStore.Downloads.EXTERNAL_CONTENT_URI,
          contentValues
        )
        if (target == null) {
          invoke.reject("Failed to create MediaStore entry")
          return@execute
        }
        uri = target

        val output = activity.contentResolver.openOutputStream(target)
          ?: throw IllegalStateException("Cannot open the Downloads entry for writing")
        output.use { os ->
          source.inputStream().use { input -> input.copyTo(os, 1 shl 16) }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          contentValues.clear()
          contentValues.put(MediaStore.Downloads.IS_PENDING, 0)
          activity.contentResolver.update(target, contentValues, null, null)
        }

        val response = JSObject()
        response.put("uri", target.toString())
        invoke.resolve(response)
      } catch (error: Exception) {
        uri?.let { runCatching { activity.contentResolver.delete(it, null, null) } }
        invoke.reject(error.message ?: "Failed to save file")
      }
    }
  }

  /**
   * Whether daily reading reminders can fire at the exact minute, and when the next one is
   * due. Without "Alarms & reminders" access (not granted by default from Android 14),
   * Android 12+ may deliver them up to an hour late.
   */
  @Command
  fun reminderStatus(invoke: Invoke) {
    val response = JSObject()
    response.put("exactAlarms", ReadingReminder.canScheduleExact(activity))
    response.put("canRequestExactAlarms", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
    response.put("nextReminderAt", ReadingReminder.nextTriggerMillis(activity))
    invoke.resolve(response)
  }

  /** Stores the reminder settings and schedules the next reminder (or removes it). */
  @Command
  fun configureReminder(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ConfigureReminderArgs::class.java)
      if (args.hour !in 0..23 || args.minute !in 0..59) {
        invoke.reject("Invalid reminder time")
        return
      }
      ReadingReminder.configure(
        activity,
        ReadingReminder.Config(
          enabled = args.enabled,
          hour = args.hour,
          minute = args.minute,
          title = args.title,
          body = args.body,
          skipDate = args.skipDate,
        )
      )
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not schedule the reminder")
    }
  }

  /**
   * The space the status bar, navigation bar and camera cutout take at each edge, in CSS
   * pixels. Android's WebView reports only the cutout through env(safe-area-inset-*), so with
   * edge-to-edge (always on from Android 15) the page would otherwise draw under the bars.
   */
  @Command
  fun systemInsets(invoke: Invoke) {
    activity.runOnUiThread {
      val response = JSObject()
      val insets = ViewCompat.getRootWindowInsets(activity.window.decorView)
        ?.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val density = activity.resources.displayMetrics.density
      response.put("top", (insets?.top ?: 0) / density)
      response.put("right", (insets?.right ?: 0) / density)
      response.put("bottom", (insets?.bottom ?: 0) / density)
      response.put("left", (insets?.left ?: 0) / density)
      invoke.resolve(response)
    }
  }

  /** Opens the system page where the reader allows exact reminders for Theorem. */
  @Command
  fun openExactAlarmSettings(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      invoke.resolve()
      return
    }
    try {
      val intent = Intent(
        Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
        Uri.fromParts("package", activity.packageName, null)
      )
      activity.startActivity(intent)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not open the alarm settings")
    }
  }

  /** Opens Theorem's notification settings, for a reader who turned notifications off. */
  @Command
  fun openNotificationSettings(invoke: Invoke) {
    try {
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
      } else {
        Intent(
          Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
          Uri.fromParts("package", activity.packageName, null)
        )
      }
      activity.startActivity(intent)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not open the notification settings")
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
        // Unique per call: two books with the same name never share a file.
        // The importer deletes it once the book is in the library.
        val safeName = fileName.replace("[^a-zA-Z0-9._-]".toRegex(), "_")
        val outFile = File(importDir, "${java.util.UUID.randomUUID()}-$safeName")

        try {
          inputStream.use { input ->
            FileOutputStream(outFile).use { output ->
              input.copyTo(output)
            }
          }
        } catch (error: Exception) {
          // A half-written copy (provider error, disk full) is never used.
          outFile.delete()
          throw error
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
