# Mentis Expenses

A phone app for work receipts. It runs in the browser and needs no install, account, or server.

1. **Snap** a receipt with the camera, or pick a photo from your library.
2. **Crop**: the app finds the receipt's edges and straightens it. You can drag the corners to adjust. **Enhance** turns it into a clean black-and-white scan.
3. **Read**: the app reads the receipt on the phone and fills in the **vendor**, **total**, **GST**, **date** and a guessed **expense type**. Check them and fix anything it got wrong (**Read again** re-scans).
4. **Complete**: add what it was for, choose the **business unit** (Mentis or Macrack), and add any **supporting photos** (invoice, booking confirmation, attendee list…).
5. **Submit monthly**: receipts are grouped by the month of their date. Each month is one claim; tap **Submit claim** to email accounts a **PDF** (summary by business unit, every receipt and supporting photo) and an **Excel spreadsheet** of every line.

**No receipt yet?** Tap **No receipt yet** to start the claim with just the details (vendor, total, date, unit, purpose). It shows as *Receipt to follow*; open it any time and tap **Take photo** or **Choose photo** to add the receipt – the reader fills in anything still blank. You can submit a month with receipts still to follow (you'll be asked to confirm); they're marked *Receipt to follow* in the PDF and spreadsheet, and adding the photo later reopens the claim and appears on the exception report as "Receipt photo added". **Add claim** in Reconciliation also creates one of these, filled in from the bank line.

Receipts are kept **only on your phone**, in the browser's storage.

### Sending

The submit screen has a **Send with** choice (remembered for next time):

- **Choose an app** – your phone's app menu opens so you can pick Gmail, Outlook, Mail or anything else, with the files attached. Tap **Copy** beside the address first if you want to paste it into "To" (it can't be copied in the same tap that opens the app menu). Android phones won't share Excel files this way, so there the spreadsheet is attached as a CSV (opens in Excel).
- **My default email app** – opens your default email app with the message filled in; the files are saved for you to attach.
- **Just save the files** – saves the PDF and spreadsheet to your phone.

## Locking, reopening and exception reports

- A submitted claim is **locked**: its receipts can be viewed but not changed or deleted.
- **Reopen claim** (on the month, or on a locked receipt) unlocks it.
- On **Resubmit**, the app compares the claim with what was last sent and adds an **exception report** to the PDF, the spreadsheet (Exceptions sheet) and the email: every receipt added, removed or changed, with old → new values, plus the previous and new totals.
- Saving a new receipt into a month that has already been submitted asks to reopen that claim.
- **Send copy** re-sends a submitted claim without changing anything.

## Reconciliation

Tap the bank icon at the top and choose a statement exported from online banking (**CSV**, OFX/QFX or QIF – PDF statements can't be read). The app matches each purchase with a claim (same amount, within 5 days) and lists:

- **Incorrect claims** – the bank shows a different amount (or date) for the same vendor.
- **Not claimed** – purchases with no claim. Mark them **Personal / not claimable**, or tap **Add claim** to photograph the receipt with the bank amount and date filled in.
- **Not on statement** – claims with no matching purchase (paid another way, or wrong date/amount).

**Share results (Excel)** exports the reconciliation.

## GST

| Field | How it's worked out |
| --- | --- |
| Total (inc GST) | The receipt's own arithmetic first: if three figures fit **ex-GST + GST = total** (e.g. 83.25 + 8.32 = 91.57), that total is used. Failing that, a net/ex-GST figure plus a GST figure of 10% of it (e.g. 62.73 + 6.27 = 69.00). Otherwise it's the **highest dollar value** on the receipt, ignoring cash handed over, change, points and savings. You can type over it. |
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
| `pdf.js` | Builds the PDF claim report (no external libraries) |
| `xlsx.js` | Builds the Excel spreadsheets (no external libraries) |
| `recon.js` | Reads bank statements and matches them to claims |
| `sw.js`, `manifest.webmanifest`, `icon*` | Offline support and home-screen icon |
