# Building this fork on Windows (step by step)

You need to do steps 1–3 once. After that, step 5 is all you run to start the app.

## 1. Install the tools

Open **PowerShell** and run these one at a time (winget ships with Windows 10/11):

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

The last one is the C++ compiler Rust needs on Windows; it takes a while. WebView2 is already part of Windows 11 (and recent Windows 10).

Close PowerShell and open a new one so it sees the new programs, then check:

```powershell
git --version
node --version     # v20 or newer
cargo --version
```

## 2. Get the code

On GitHub, open https://github.com/jky-sh/f95-app and press **Fork** (top right). That makes your own copy, `github.com/<you>/f95-app`. Then:

```powershell
cd $HOME\Documents
git clone https://github.com/<you>/f95-app.git
cd f95-app
```

## 3. Apply the changes

Copy `organized-library.patch` into the `f95-app` folder, then:

```powershell
git checkout -b organized-library
git am organized-library.patch
git push -u origin organized-library
```

(`git am` adds the changes as a commit; `git push` saves them to your fork on GitHub.)

## 4. Install the JavaScript packages

```powershell
npm install
npm --prefix src-tauri/sidecar install
npm --prefix src-tauri/sidecar run build
```

## 5. Run it

```powershell
npm run tauri dev
```

The first run compiles the Rust side and takes several minutes; later runs are quick. A window opens — log in with your F95Zone account.

## 6. First-time setup in the app

1. **Library → Import folders** → pick your external drive's games folder (e.g. `E:\Games`).
2. Check each match, type the version you have (or press "I have vX" if you're up to date), keep "Move each game's files into a Current sub-folder" ticked, and press **Import**.
3. **Settings → Downloads**: tick **Download updates automatically after each update check**.
4. **Settings → Hosts**: add accounts for hosts you use (Mega, GoFile…) if you have them; it makes downloads more reliable.
5. **Library → Check for updates** to try it.

Keep the external drive plugged in when the app checks for updates — the downloads go to the same drive as the game.

## Making an installer (optional)

```powershell
npm run tauri build
```

The installer ends up in `src-tauri\target\release\bundle\nsis\`.
