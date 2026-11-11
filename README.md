# Recipe Box

A personal recipe database that runs entirely in your browser and stores everything in **your own Google Drive**.

- Each recipe is its own Google Doc. An index Google Sheet holds the titles and tags.
- No server, no database, no build step, nothing to pay for. It is a handful of static files hosted free on GitHub Pages.
- It uses the narrow `drive.file` permission, so it can only see files it created itself.
- Each Google account you sign in with gets its own separate recipe collection.

## What's in this folder

| File | What it does |
| --- | --- |
| `index.html` | The page |
| `styles.css` | The look |
| `app.js` | All the logic (sign-in, Drive/Sheets/Docs calls, search, filters) |
| `config.js` | **The one file you edit**: holds your OAuth Client ID |
| `manifest.json`, `icons/` | Lets you add the app to your phone's home screen |
| `serve.ps1` | Optional helper to test on Windows without installing anything |

## Setup (about 15 minutes, one time)

You need a Google account and a GitHub account. Everything below is free and no credit card is needed.

> Google renames its console menus from time to time. If a label differs slightly from what's written here, look for the closest match. The steps themselves don't change.

### Step 1: Create a Google Cloud project and enable three APIs

1. Go to <https://console.cloud.google.com/> and sign in.
2. If asked, accept the terms of service. You do **not** need to start a free trial or add billing.
3. Click the project picker at the top of the page (next to the "Google Cloud" logo), then **New project**.
4. Name it `Recipe Box`, leave Organisation as it is, and click **Create**. Wait a few seconds, then make sure the new project is selected in the project picker.
5. Open the menu (☰) and go to **APIs & Services → Library**.
6. Search for each of these, open it, and click **Enable**. Come back to the Library after each one:
   - **Google Drive API**
   - **Google Sheets API**
   - **Google Docs API**

### Step 2: Configure the OAuth consent screen

This is the screen Google shows when you sign in to the app.

1. Open the menu (☰) and go to **APIs & Services → OAuth consent screen**. (It may open as "Google Auth Platform".) Click **Get started** if you see it.
2. **App information**: App name `Recipe Box`, and pick your email as the user support email. Click **Next**.
3. **Audience**: choose **External**. Click **Next**.
4. **Contact information**: enter your email. Click **Next**, agree to the policy, then **Create**.
5. Now open **Audience** in the left-hand menu:
   - Check the publishing status says **Testing**. Leave it that way. Don't press "Publish app".
   - Under **Test users**, click **Add users** and add the email address of every Google account you want to use with Recipe Box (yours, a partner's, and so on; up to 100). Click **Save**.

Only accounts on the test users list can sign in. Anyone else gets an "Access blocked" message.

You can skip the "Data access" / scopes page. The app asks for the permissions it needs when you sign in.

### Step 3: Create the OAuth Client ID

1. In the left-hand menu, open **Clients** (or **APIs & Services → Credentials**), then **Create client** (or **Create credentials → OAuth client ID**).
2. Application type: **Web application**. Name: `Recipe Box web`.
3. Under **Authorised JavaScript origins**, click **Add URI** twice and enter these, replacing `<your-username>` with your GitHub username in lowercase:
   - `https://<your-username>.github.io`
   - `http://localhost:8000`

   Enter them exactly: no trailing slash and no folder path after `.io`. For example `https://janedoe.github.io`, not `https://janedoe.github.io/recipe-box/`.
4. Leave **Authorised redirect URIs** empty.
5. Click **Create**. Copy the **Client ID**. It looks like `1234567890-abc123def456.apps.googleusercontent.com`.

If a "client secret" is shown, ignore it. This app does not use one, and it must never go in the code.

### Step 4: Paste the Client ID into `config.js`

Open `config.js` in any text editor and replace the placeholder:

```js
window.RECIPE_BOX_CONFIG = {
  CLIENT_ID: '1234567890-abc123def456.apps.googleusercontent.com',
};
```

Save the file. A Client ID is not a secret, so it's fine for it to be in a public repository: Google only accepts it from the two website addresses you listed in step 3.

### Step 5: Test on your own computer

Google sign-in does not work when you double-click `index.html` (a `file://` address). The page has to be served from `http://localhost:8000`, which is why that address is in step 3. Pick one option:

**Windows, nothing to install.** Open the project folder in File Explorer, click the address bar, type `powershell` and press Enter. Then run:

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1
```

**Any computer with Python installed.** Open a terminal in the project folder and run:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000> in your browser. Use exactly `localhost`, not `127.0.0.1`.

1. Click **Sign in with Google** and pick your account.
2. You will see "Google hasn't verified this app". See [the note below](#google-hasnt-verified-this-app). Click **Continue**.
3. Tick the box allowing access to Google Drive files the app creates, if it is shown, and continue.
4. The app creates a **Recipe Box** folder in your Drive containing a **Recipe Index** sheet and a **Recipe Template** doc. Press **+** to add your first recipe.

Press Ctrl+C in the terminal to stop the local server when you're done.

### Step 6: Put it on GitHub Pages

1. On <https://github.com>, click **+ → New repository**. Name it, for example, `recipe-box`. Set it to **Public** (GitHub Pages is free for public repositories) and click **Create repository**.
2. On the new repository's page, click **uploading an existing file**. Drag in everything from this folder, including the `icons` folder, and click **Commit changes**.
3. Go to the repository's **Settings → Pages**. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to **main** and folder **/ (root)**, then **Save**.
4. Wait a minute or two, then refresh the page. Your address is shown at the top: `https://<your-username>.github.io/recipe-box/`.

Open that address on your computer or phone and sign in.

**Add it to your phone's home screen**

- Android (Chrome): menu **⋮ → Add to Home screen** (or **Install app**).
- iPhone (Safari): **Share → Add to Home Screen**.

## "Google hasn't verified this app"

The first time each account signs in, Google shows a warning screen saying the app hasn't been verified. Click **Continue** (on some screens it's **Advanced → Go to Recipe Box (unsafe)**).

Why you see it: verification is a review Google does for apps offered to the general public. Your project is in **Testing** mode and is only usable by the test users you listed, so it has not been through that review.

Why it's safe to continue here:

- **You are the developer.** The warning is about trusting an unknown developer. This is your own Google Cloud project, and only accounts you added as test users can sign in at all.
- **There is no server.** The code runs in your browser and talks directly to Google. Your recipes and your sign-in never pass through anyone else's computer.
- **The permission is narrow.** `drive.file` lets the app see and change only the files it created itself (the Recipe Box folder, the index sheet, the template and your recipe docs). It cannot read the rest of your Drive.
- **The code is public and short.** Everything it does is in `app.js` in your repository.

Only click through this warning for apps you set up yourself or fully trust.

## Using the app

- **Search** filters by title and tags as you type. Switch on **Search inside recipes** to also search the text of the recipe Docs. Google can take a minute or so to index newly typed text.
- **Tag chips** filter the list. Selecting several shows only recipes that have all of them. **Clear filters** resets.
- **Tap a card** to open the recipe's Google Doc. On a phone with the Google Docs app installed, it opens there.
- **+** adds a recipe: the app copies your template, fills in the title and tags, adds it to the index, and opens the new Doc for you to write in.
- **⋮ on a card** lets you edit the title and tags, or delete. Deleting moves the Doc to your Drive trash, where it stays restorable for 30 days.
- **Account button (top right)** shows who is signed in, with **Switch account** and **Sign out**. Signing out also withdraws the app's permission, so the next sign-in shows Google's permission screen again.
- You can edit the **Recipe Template** doc in Drive to change how new recipes start. Keep `{{TITLE}}` and `{{TAGS}}` where you want those filled in.

## Staying signed in

After the first sign-in on a device, the app opens straight to your recipes every time. There is no sign-in screen again unless you press **Sign out**.

How it works: the browser remembers which account you used and keeps a copy of your recipe list, so the list appears instantly and cards open their Docs straight away. Google only hands a website a one-hour pass, and a site with no server cannot hold anything longer-lived, so the app renews that pass quietly in the background when it needs to talk to Google (refreshing, adding, editing, deleting, searching inside recipes).

Two things make this completely invisible:

1. **Allow pop-ups for the site (recommended).** The renewal uses a small Google window that opens and closes by itself in under a second. Browsers block such windows unless they follow a click. If you allow pop-ups for your Recipe Box address, renewal happens the moment you open the app. If you don't, it happens on your first click or tap instead, and the list on screen may be slightly out of date until then.
   - Chrome / Edge: click the icon at the left of the address bar → **Site settings** → **Pop-ups and redirects** → **Allow**.
   - Safari (iPhone): Settings → Safari → turn off **Block Pop-ups**.
2. **Consider publishing the app (optional).** While the consent screen is in **Testing** mode, Google expires each account's permission 7 days after it was granted, so about once a week you would see Google's permission screen again. To stop that, go to **Audience** in the Google Cloud console and press **Publish app**. Because Recipe Box only uses a non-sensitive permission, Google's documentation says no verification review is required. The trade-off: any Google account could then sign in to your copy of the site, not just your test users. Each person would only ever see their own Drive, never yours.

Both of those are optional. If you skip them, the occasional sign-in is always **one click**, because the app remembers your account:

- If a background renewal fails, a **Reconnect** bar appears. One click and you carry on where you were.
- If you are on the sign-in screen (for example after pressing Sign out), a **Continue as you@gmail.com** button signs you straight back in. **Use a different Google account** is there if you want the account chooser instead.

Google itself may add a step now and then, such as its permission screen (weekly in Testing mode, and after Sign out) or a password prompt if you have signed out of Google in that browser. Clearing the browser's site data or using a private/incognito window makes the app forget your account.

On a shared computer, press **Sign out** when you finish: it removes the Google pass and the saved recipe list from that browser. Only your email address stays, to offer the one-click button.

## Good to know

- **You stay signed in.** See [Staying signed in](#staying-signed-in) below.
- **Pop-ups.** After saving a new recipe the app opens the Doc in a new tab. If your browser blocks it, a message with an **Open the Doc** link appears instead.
- **Don't rename the columns** in the Recipe Index sheet, and avoid sorting it while the app is open on another device. You can safely fix a typo in a title or tag cell directly. Tags are comma-separated and lowercase.
- **Moving files.** Keep recipe Docs inside the Recipe Box folder, or "Search inside recipes" won't find them.
- **Docs you create yourself in Drive** won't appear in the app: it can only see files it created. Add the recipe with **+** and paste your text into the new Doc.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "Setup needed" on the sign-in screen | `config.js` still has the placeholder. Do step 4. |
| "Access blocked: Recipe Box has not completed the Google verification process" | That Google account isn't a test user. Add it in step 2.5. |
| "Error 400: redirect_uri_mismatch" or "origin_mismatch" | The address you're visiting isn't in **Authorised JavaScript origins**. Check step 3.3 for typos, `http` vs `https`, or a trailing slash. Changes can take a few minutes to apply. |
| "A Google API is not enabled for this project" | Enable all three APIs in step 1.6, wait a minute, press Refresh. |
| The sign-in window never appears | Allow pop-ups for the site, and check that an ad or script blocker isn't blocking `accounts.google.com`. |
| Sign-in does nothing when opened from a file | Serve the folder as in step 5; don't open `index.html` directly. |
| A second, empty "Recipe Box" folder appeared | You signed in with a different Google account. Each account has its own collection. Use **Switch account**. |
