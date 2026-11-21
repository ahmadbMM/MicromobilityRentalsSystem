# MM Display (TV app)

A tiny app for the TV sticks in the bike collection areas. It opens
`https://staff.micromobility.sa/display` full screen and keeps it there: it starts by
itself when the stick is switched on, keeps the screen awake, and reconnects on its own if
the internet drops.

## Where to get the app

Every change to this folder on `main` builds a new version. Open the repository's
**Releases** page on GitHub and pick the newest release named "MM Display 1.0.N". It has two files:

- `mm-display.apk`: **this is the one for the TVs.**
- `mm-display-staging.apk`: the test version (shows the staging site). Not for the shop floor.

The newest TV file is also always at this link (if the repo has no other releases):
`https://github.com/ahmadbMM/MicromobilityRentalsSystem/releases/latest/download/mm-display.apk`

That link is long to type with a remote. Make a short link for it first (any link shortener).

## Install on a Fire TV stick

1. **Turn on Developer options.** Settings > My Fire TV > About. Select the device name
   (first line) 7 times until it says you are a developer. (On older sticks Developer options
   is already there.)
2. Settings > My Fire TV > Developer options:
   - Turn on **ADB debugging** (optional, harmless).
   - Turn on **Apps from Unknown Sources** (on newer sticks: Install unknown apps >
     **Downloader** > On, after step 3).
3. **Install Downloader.** Home > Find (magnifier) > type "Downloader" > install the orange
   Downloader app (by AFTVnews).
4. Open Downloader, allow it to access files if asked, type the APK link (or the short link)
   in the address box, select **Go**. When the download finishes, select **Install**.
5. Select **Open** (or find "MM Display" under Your Apps). The TV shows a 6-digit code: pair
   it from the staff app. After that it remembers the pairing.
6. Optional: delete the downloaded APK when Downloader offers to.

## Install on an Android TV / Google TV

1. Settings > Device Preferences (or System) > About > select **Android TV OS build**
   7 times to become a developer.
2. Settings > Apps > Security & restrictions > **Unknown sources**: allow the app you will
   install from (for example **Send Files to TV** or your file manager).
3. Install **Send Files to TV** from the Play Store on the TV and on an Android phone.
   Download `mm-display.apk` on the phone, then send it to the TV with the app.
   (Or copy the APK onto a USB stick, plug it into the TV, and open it with a file manager
   such as "File Commander".)
4. Open the APK on the TV and choose **Install**, then **Open**. Pair it from the staff app.
   Downloader (step 3-4 of the Fire TV steps) also works on Android TV.

After a restart the app opens by itself. If it does not on your stick, open it once from
the apps row. Sticks running a newer Android may block apps from starting at boot; then
open it by hand after a power cut.

## Updating

Install the newer `mm-display.apk` the same way, over the old one. Do not uninstall first:
installing over keeps the pairing. (If Android says the app "conflicts with an existing
package", that build was signed with a temporary key; ask the developer.)

## The hidden menu

The Back button on the remote does nothing on purpose. To open the menu:

- **Hold Back** for about a second, or
- press the **Menu** button (three lines) **5 times quickly**.

The menu has:

- **Reload**: loads the page again.
- **Clear pairing and reload**: forgets the pairing; the TV shows a new 6-digit code.
- **Close app**: closes it (it opens again at the next restart, or from the apps row).

## For developers

- Source: `app/src/main/java/sa/micromobility/display/`. The page address is
  `BuildConfig.DISPLAY_URL`, set per flavor (`prod`, `staging`) in `app/build.gradle.kts`.
- Built by `.github/workflows/android-tv.yml` with Gradle 8.11.1 (no wrapper jar in the repo;
  run `gradle wrapper --gradle-version 8.11.1` once to use `./gradlew` locally).
- Release signing reads `TV_KEYSTORE_FILE`, `TV_KEYSTORE_PASSWORD`, `TV_KEY_ALIAS`,
  `TV_KEY_PASSWORD` from the environment. In CI they come from the repo secrets
  `TV_KEYSTORE_BASE64` (the keystore, base64) and the other three. Keep the keystore safe:
  losing it means every TV must uninstall and pair again.
