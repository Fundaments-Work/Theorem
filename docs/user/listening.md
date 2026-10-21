# Listening with Text-to-Speech and Audiobooks

Have a book read aloud with your system voice or an offline neural voice, attach a narrated audiobook file, or generate an audiobook from a book on desktop.

Theorem offers three ways to listen. All of them work offline.

| Way | What it is | Where |
| :--- | :--- | :--- |
| System voice | Your operating system's built-in text-to-speech | Desktop and Android |
| Neural voice | A higher-quality voice that Theorem runs on your computer after a one-time download | Desktop only |
| Audiobook file | A human-narrated `.m4b`, `.m4a` or `.mp3` file that you attach to a book | Desktop and Android |

Listening is not available for PDFs. It works with EPUB, MOBI, AZW, AZW3, FB2 and RSS articles.

## Read a book aloud

1. Open a book.
2. Click the headphones button in the reader toolbar. On a narrow screen it is in the More options menu, under Immersion Reading.
3. Click the play button in the bar at the bottom of the reader.
4. Use pause and stop as needed. Theorem reads the text on the current page and then turns the page and keeps going.
5. Click the headphones button again (Exit Immersion Reading) to return to normal reading.

The bar shows Reading aloud, Paused or Loading..., and the time left. If text-to-speech was switched off in Settings, opening Immersion Reading switches it back on.

### System voices

The system voice depends on your platform:

- **Linux** uses speech-dispatcher. Install it, and a speech engine, if the `spd-say` command is missing.
- **macOS** uses the built-in `say` voices.
- **Windows** uses the voices installed in Windows.
- **Android** uses the speech engine selected in Settings. See the Android section below.

Theorem uses the book's language when it has one, and English otherwise.

## Install the neural voice (desktop)

The neural voice runs completely on your computer. Nothing is bundled with the app, so you download it once.

It is available on Linux (64-bit x86), Windows (64-bit) and macOS on Apple Silicon. Intel Macs, and Windows or Linux on ARM chips, are not supported. On those computers Settings says that Neural Voice is not available on this platform, and the reader does not offer the download.

1. Open Settings and select the General tab.
2. Make sure Text-to-Speech is on. The Neural Voice section appears below the retention settings only when it is on.
3. In Neural Voice, click Download. The row shows the size, about 400 MB, and the number of files. A progress bar shows the transfer. Each file is checked after it downloads.
4. When the section shows Installed, open a book and start Immersion Reading. It now uses the neural voice.

Until the voice is installed, Theorem uses your system voice. The download icon in the reader's listening bar takes you to Settings.

### Choose a voice and speed

1. In the listening bar, click the voice and speed button (Voice & speed).
2. Choose one of ten voices: F1 to F5 (Female 1 to 5) or M1 to M5 (Male 1 to 5).
3. Choose a speed: 0.75x, 1x, 1.25x or 1.5x.

Without the neural voice on desktop, this button is not shown and the system voice speaks at its normal speed.

### Remove the neural voice

In Settings, General tab, Neural Voice, click Remove next to Installed and confirm. This deletes the downloaded files and the cached audio.

## Neural voice on Android

Android does not use the desktop download. Instead, Theorem speaks through an Android speech engine of your choice, and the free Theorem Neural Voice app is an engine you can install for natural voices.

1. Open Settings and select the General tab.
2. In Text-to-Speech Engine, click Get the app next to Theorem Neural Voice, and install the app.
3. Back in Theorem, open the Voice engine menu and choose the engine you want. If the list says No engines found, install an engine first.
4. Start Immersion Reading in a book. The voice and speed button lets you choose a speed.

## Attach an audiobook

1. In the Library, right-click a book (or long-press it) and choose More..., then Attach Audiobook....
2. In the file picker, choose an `.m4b`, `.m4a` or `.mp3` file.
3. Wait for the message that the audiobook is attached.

Theorem reads the duration and chapter marks from the file. It links to the file where it is and does not copy it, so keep the file in the same place. To remove the link, choose More..., then Detach Audiobook. That does not delete the audio file.

### Play an audiobook

1. Open the book and click the headphones button. The audiobook player replaces the text-to-speech controls.
2. Use play and pause, the position slider, and the back and forward buttons that jump 15 seconds.
3. Choose a speed of 0.75x, 1x, 1.25x, 1.5x or 2x.
4. Open the chapter list to jump to a chapter, when the file has chapter marks.
5. Set the sleep timer to 15 min, 30 min, 45 min or End of chapter. Choose Off to cancel it.
6. Click Close player to stop.

Theorem saves your listening position every few seconds and remembers your speed. Headphone and lock-screen media controls work for play, pause and seeking. System text-to-speech stops while the audiobook plays.

## Generate an audiobook (desktop)

If the neural voice is installed, Theorem can turn a whole book into an audiobook file.

1. Open a book (not a PDF) and click the headphones button.
2. In the listening bar, click the disc button (Generate audiobook).
3. Wait. The bar shows Generating, with a count of sections done out of the total.
4. When a message says the audiobook is ready, open Immersion Reading again to listen.

Theorem saves the result as an Ogg Opus file in its app data folder, with chapter marks, and attaches it to the book. It takes roughly 16 MB per hour of audio. The generate button is hidden when the book already has an audiobook. Generating audiobooks is not available on Android.
