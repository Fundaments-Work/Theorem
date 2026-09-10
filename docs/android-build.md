# Android Build Guide

This document explains how to build Theorem for Android.

## Prerequisites

- Node.js 22+
- pnpm 10+
- Rust stable
- Android SDK (with NDK)
- Java 17

## Initial Setup

### 1. Install Android SDK and NDK

You can install Android Studio or just the command-line tools:

```bash
# Using Android Studio
# Install via: https://developer.android.com/studio

# Or using SDK Manager (command-line)
sdkmanager "platform-tools" "platforms;android-36" "ndk;29.0.13846066"
```

### 2. Set Environment Variables

```bash
export ANDROID_HOME=$HOME/Android/Sdk
export NDK_HOME=$ANDROID_HOME/ndk/29.0.13846066
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

### 3. Add Rust Android Targets

```bash
rustup target add aarch64-linux-android
rustup target add armv7-linux-androideabi
rustup target add i686-linux-android
rustup target add x86_64-linux-android
```

## Generate Android Project

The Android project is NOT committed to the repository. It must be regenerated on each machine:

```bash
pnpm install
pnpm tauri android init --ci
pnpm tauri icon public/favicon.svg
```

This creates `src-tauri/gen/android/` with the Android Studio project.
`tauri icon` must run after each fresh `android init` so launcher assets keep Theorem branding.

## Build APK

### Debug Build

```bash
pnpm tauri android build --debug
```

### Release Build (Unsigned)

```bash
pnpm tauri android build
```

The APK will be at:
```
src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

## Signing for Release

### Generate a Signing Key

Interactive:

```bash
keytool -genkeypair -v \
  -keystore theorem-release.jks \
  -alias theorem \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

Note: `keytool` password input is hidden (no characters are shown while typing). If your terminal has trouble with interactive prompts, use a non-interactive command:

```bash
keytool -genkeypair -keystore theorem-release.jks -storetype PKCS12 -storepass "YourStrongPass123" -alias theorem -keyalg RSA -keysize 2048 -validity 10000 -keypass "YourStrongPass123" -dname "CN=Theorem, OU=Dev, O=Fundamentals, L=City, ST=State, C=US" -noprompt
```

### Configure Signing

Tauri v2 reads signing config from `src-tauri/gen/android/keystore.properties`:

```properties
keyAlias=theorem
password=YOUR_KEYSTORE_PASSWORD
storeFile=/absolute/path/to/theorem-release.jks
```

The generated Gradle project must load it in a `signingConfigs` block — the release workflow patches `app/build.gradle.kts` to read `rootProject.file("keystore.properties")`. Note that `tauri.properties` (in `app/`) only carries `tauri.android.versionName` / `versionCode`, and the Tauri CLI does **not** read `ANDROID_KEYSTORE_PATH` or similar environment variables.

### Build Signed APK

```bash
pnpm tauri android build
```

## CI/CD Setup

For GitHub Actions, store the keystore as a base64-encoded secret:

```bash
base64 -i theorem-release.jks | pbcopy  # macOS
base64 -w 0 theorem-release.jks         # Linux
```

Add these secrets to your repository:
- `ANDROID_KEY_BASE64` (preferred) or `ANDROID_KEYSTORE_BASE64`: Base64-encoded keystore file
- `ANDROID_KEY_ALIAS`: Key alias
- `ANDROID_KEY_PASSWORD`: Key password
- `ANDROID_KEYSTORE_PASSWORD`: Keystore password (optional, defaults to `ANDROID_KEY_PASSWORD`)

The release workflow fails if these required signing values are missing, and only uploads signed APKs.

## Distribution

### APK Distribution

Upload the signed APK to:
- GitHub Releases
- Your website
- Direct distribution

### Google Play Store

For Play Store distribution, you need an AAB (Android App Bundle):

```bash
pnpm tauri android build --aab
```

The AAB will be at:
```
src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab
```

## Troubleshooting

### NDK Not Found

```bash
# Set NDK_HOME explicitly
export NDK_HOME=$ANDROID_HOME/ndk/29.0.13846066
```

### Gradle Permission Denied

```bash
chmod +x src-tauri/gen/android/gradlew
```

### Build Fails with Java Error

Ensure Java 17 is installed and `JAVA_HOME` is set:

```bash
export JAVA_HOME=/usr/lib/jvm/temurin-17-jdk
```

## Architecture Support

The default build creates a universal APK with all architectures:
- `arm64-v8a` (most modern devices)
- `armeabi-v7a` (older 32-bit devices)
- `x86_64` (emulators)
- `x86` (older emulators)

For smaller APKs, build for specific architectures:

```bash
pnpm tauri android build --target aarch64
```
