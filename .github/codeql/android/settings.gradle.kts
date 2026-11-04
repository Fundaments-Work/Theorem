pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "theorem-android-security"
include(":tauri-android", ":tts", ":folder")
// Cargo metadata supplies the API version locked by the application.
project(":tauri-android").projectDir = file(file("tauri-path.txt").readText().trim())
project(":tts").projectDir = file("../../../src-tauri/plugins/android-tts-audio/android")
project(":folder").projectDir = file("../../../src-tauri/plugins/mobile-folder-scan/android")
