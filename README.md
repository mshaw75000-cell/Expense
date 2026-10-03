# Mentis Expenses

A phone app for work receipts. It runs in the browser and needs no install, account, or server.

1. **Snap** a receipt with the camera, or pick a photo from your library.
2. **Crop**: the app finds the receipt's edges and straightens it. You can drag the corners to adjust. **Enhance** turns it into a clean black-and-white scan.
3. **Note** what it is, what it was for, the amount, the date and a category.
4. **Send**: tick the receipts you want, pick a saved email address, and send them as **one PDF expense report** (a summary page plus one page per receipt) or as separate photos.

Receipts are kept **only on your phone**, in the browser's storage. Sent receipts move to the **Sent** tab. You can delete them from Settings.

## Putting it on your phone

The camera and sharing features need the page to be served over `https://`. The simplest free option is **GitHub Pages**:

1. In this repo on GitHub, go to **Settings → Pages**.
2. Under *Source* choose **Deploy from a branch**, pick the branch and `/ (root)`, then **Save**.
3. After a minute, open the URL it gives you (`https://<user>.github.io/<repo>/`) on your phone.
4. **iPhone:** in Safari, tap Share → **Add to Home Screen**. **Android:** in Chrome, tap ⋮ → **Add to Home screen** / **Install app**.

It then opens full-screen like a normal app and works offline. Only the app's code is hosted; your receipts never leave the phone until you email them.

> GitHub Pages for a **private** repo needs a paid GitHub plan. Other options: make the repo public (it contains no personal data), or drop the folder onto Netlify Drop or any internal web server.

## How sending works

A web page can't send email by itself. So when you tap **Send**:

- **On a phone**, the share sheet opens with the PDF or photos attached and the message written. Choose **Mail** or **Outlook**. The recipient's address is copied to your clipboard, so paste it into **To**. When the share finishes, the receipts are marked as sent.
- **On a computer**, the files download and your email program opens with the address, subject and message filled in. Attach the downloaded files.

## Branding

Open **Settings** (the gear icon):

- **Upload logo** to replace the text "mentis." wordmark in the header.
- **Primary / Accent colour** change the app and PDF colours.

To change the default colours for everyone, edit `--primary` and `--accent` at the top of `styles.css`, and `primary` / `accent` in `app.js` (`defaults`).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App layout |
| `styles.css` | Look and feel (brand colours at the top) |
| `app.js` | Screens, storage, sending |
| `crop.js` | Receipt edge detection, perspective straightening, enhance |
| `pdf.js` | Builds the PDF expense report (no external libraries) |
| `sw.js`, `manifest.webmanifest`, `icon*` | Offline support and home-screen icon |
