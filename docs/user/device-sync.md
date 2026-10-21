# Sync Between Devices

Pair two devices with a QR code or pairing code and keep your library, notes, vocabulary and reading progress in step without creating an account.

Device sync is peer to peer. Your devices talk to each other directly, and there is no Theorem account or Theorem server that stores your data. Sync is available in the desktop and Android apps, not in the browser demo.

## What syncs

- Your book list and its details, including favorites, ratings, tags and series
- Reading progress and reading statistics
- Highlights, notes and bookmarks
- Shelves
- Vocabulary
- RSS feeds and articles
- App settings
- Deletions, so that a book or highlight you delete does not come back from the other device

Book files are not copied right away. A book that arrived by sync shows up in the Library with a No file badge until you download it. Opening it downloads the file from a paired device, and a Downloading Book screen shows the progress. You can also download it ahead of time: right-click the book, choose More..., then Download File. The other device must be reachable and running Theorem. If the transfer takes longer than two minutes, you see Book download timed out with a Try Again button.

Sync transfers book files. An audiobook file you attached to a book is linked on the device where you attached it and is not sent to your other devices.

## Pair two devices

You pair once. After that the devices remember each other.

1. On both devices, open Settings and select the Devices & Export tab (called Devices on Android). Find the Device Sync section.
2. On the first device, under Pair a Device, click Show Pairing QR. A QR code and a pairing code appear.
3. On the second device, pair using one of these methods:
   - **Scan the QR code** (Android only). Click Scan QR Code and allow camera access when asked. Point the camera at the code.
   - **Enter the code.** On the first device, click Copy next to the code, or Open QR to enlarge it. Send the code to the second device, paste it into the box that reads "Paste code from other device...", and click the button next to it.
4. Wait for the message Device paired!. The other device appears under Paired Devices.

The desktop apps do not scan QR codes. To pair two computers, copy the pairing code from one and paste it on the other.

## Sync now

- Click the sync button (Sync devices) at the top right of the window. It shows a small status dot and, on wide windows, when you last synced.
- Or open Settings, Devices & Export, Paired Devices, and click Sync Now next to a device. Click Cancel to stop a sync that is running.

The Paired Devices list shows when each device last synced. When the sync finishes, Theorem tells you if anything changed or says Already in sync.

On desktop, the system tray menu also has a Sync Now item.

## Automatic sync

By default Theorem syncs on its own. In the Sync Settings card, Auto-sync is On. While it is on, Theorem syncs:

- About five seconds after the app starts
- Every two minutes
- When a paired device comes online
- A couple of seconds after you change something, such as a highlight

Click the On button to switch Auto-sync Off. You can still sync by hand.

Both devices must be running Theorem. The This Device card shows Receiver active when the app is ready to receive a sync. It reads Pair a device to enable incoming sync until you have paired a device.

Under Settings, General tab, Sync Notifications controls whether Theorem shows a notification when a sync finishes or fails.

## How devices connect

Devices connect directly, for example over the same Wi-Fi network, and Theorem finds paired devices on your local network without any setup. When two devices cannot reach each other directly, the traffic can go through a relay server. The data stays encrypted between your devices, so the relay only passes along data it cannot read. Only paired devices share data.

## If two devices disagree

Theorem merges changes from both sides.

- **Reading progress.** The most recently recorded position wins.
- **Highlights and notes.** Edits to the same highlight keep the newer one. Highlights created on either device are all kept.
- **Shelves.** Books from both versions are combined.
- **Vocabulary.** Words are merged, so nothing is lost.
- **Settings.** The newer settings win. Each device keeps its own sync pairing details.
- **Deletions.** A deletion made on one device is applied on the other.

## Unpair a device

1. Open Settings, Devices & Export, and find the device under Paired Devices.
2. Click Unpair and confirm.

Unpairing stops syncing with that device. It does not delete books or notes on either device.
