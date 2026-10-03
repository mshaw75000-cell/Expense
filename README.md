# Mentis Expenses

A phone app for work receipts. It runs in the browser and needs no install, account, or server.

1. **Snap** a receipt with the camera, or pick a photo from your library.
2. **Crop**: the app finds the receipt's edges and straightens it. You can drag the corners to adjust. **Enhance** turns it into a clean black-and-white scan.
3. **Read**: the app reads the receipt on the phone and fills in the **vendor**, **total**, **GST** and **date**. Check them and fix anything it got wrong (**Read again** re-scans).
4. **Note** what it is and what it was for. The **expense type** is guessed from the receipt (fuel, parking, meals, travel…). Pick another from the list, or choose **Type your own…** to add a new type; your own types are remembered and can be removed in Settings.
5. **Send**: tick the receipts you want, pick a saved email address, and send them as **one PDF expense report** (a summary page plus one page per receipt) or as separate photos.

Receipts are kept **only on your phone**, in the browser's storage. Sent receipts move to the **Sent** tab. You can delete them from Settings.

## GST

| Field | How it's worked out |
| --- | --- |
| Total (inc GST) | The receipt's own arithmetic first: if three figures fit **ex-GST + GST = total** (e.g. 83.25 + 8.32 = 91.57), that total is used. Otherwise it's the **highest dollar value** on the receipt, ignoring cash handed over, change, points and savings. You can type over it. |
| GST | The GST figure from that sum, or the amount on a GST line closest to 1/11 of the total, otherwise **1/11 of the total** (10% GST). Type over it to override. |
| Ex GST | Always **Total − GST**, recalculated automatically. |

Example: a total of 11.00 gives GST 1.00 and ex-GST 10.00. Change GST to 0.50 and ex-GST becomes 10.50. **GST = 1/11 of total** puts the automatic GST back, and **No GST** sets it to 0. The PDF report shows ex-GST, GST and total for each receipt, plus overall totals.

Receipt reading uses [Tesseract](https://github.com/naptha/tesseract.js), which runs on the phone itself. The first scan downloads about 5 MB from cdn.jsdelivr.net; after that it works offline. Receipt photos are never uploaded anywhere.

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
| `ocr.js` | Receipt reading: vendor, total, GST, date, ABN |
| `pdf.js` | Builds the PDF expense report (no external libraries) |
| `sw.js`, `manifest.webmanifest`, `icon*` | Offline support and home-screen icon |
