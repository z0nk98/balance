# Tracking App

Track your own spending, and keep track of money you've lent to other people.
Borrowers get a private access code to see what they owe each month and when it's due.

It runs entirely on **GitHub Pages**. There's no server to pay for or maintain.

- **This repo (`Tracking-App`, private)** holds the app's code.
- **The site repo (`balance`, public)** holds a copy of the pages plus your data, **encrypted**. GitHub Pages publishes it.

## How privacy works

Pages sites are public, so nothing readable is stored there:

- **Your records** (borrowers, loans, payments, contact details, codes) are in `data/owner.json`, encrypted with **your passphrase**.
- **Expenses and bills**, once you turn on sync, are in `data/money.json`, encrypted with the same passphrase.
- **Each borrower's view** is in its own file under `data/b/`, encrypted with **their access code**. The file name comes from the code too, so you can't even tell which file is whose without it.
- Encryption is AES-256-GCM, with keys stretched using PBKDF2-SHA256 at 600,000 rounds. Access codes are 12 random characters (about 59 bits).
- Commit messages and reminder logs never include names, amounts or addresses.

What someone without a code *can* see: roughly how many borrowers you have, and when you made changes.

**If you forget your passphrase, the data can't be recovered.** Write it down, and use *Download backup* now and then.

## Light or dark

Every page has a theme switch in the header: sun for **Light**, moon for **Dark**, half-circle for **Auto** (follow the device's setting, the default). The choice is remembered on that device for all pages.

## Hiding amounts

Every page has an eye button in the header, next to the theme switch. Tap it to hide all amounts on the page (they show as ₱•••••, and amount boxes in forms are masked until you tap into them); tap again to show them. The choice is remembered on that device and applies to Expenses, Tracker and Money lent together. The borrower page has its own eye button and setting, on the borrower's device.

## Using it on a phone

On phone screens the page links sit in a tab bar along the bottom, the header scrolls away instead of covering the page, Money lent payment rows show as small labelled cards, and *Saved* / *Not saved* pops up at the bottom wherever you are.

## Pages

| Page | Who it's for |
| --- | --- |
| `index.html` | You: Expenses Dashboard, money in minus bills paid in the Tracker (on this device; synced if you turn it on) |
| `tracker.html` | You: Personal Bills Tracker, for your bills and loans (on this device; synced if you turn it on) |
| `lend.html` | You: money lent. Needs your GitHub access key and passphrase |
| `borrow.html` | Borrowers: enter their code to see what they owe |

## Setup (one time)

1. **Create the site repo.** On GitHub: **New repository**, named `balance`, **Public**, with "Add a README" ticked.
2. **Copy the app into it.** Copy all files from this repo into `balance` (Claude can do this for you).
3. **Turn on Pages.** In `balance`: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**. A minute later the site is at `https://<your-username>.github.io/balance/`.
4. **Make an access key for the owner page.** GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**:
   - Repository access: **Only select repositories → `balance`**
   - Permissions: **Contents → Read and write**
   - Pick an expiration you're comfortable with. You'll make a new key when it expires.
5. **Open `lend.html`** on the site, paste the key, and choose your passphrase. Done.

If you named the site repo something other than `balance`, change `repo` in `config.json` to match.

## Using it

- **Add a borrower.** You get a code like `K7QM-3XRP-T8WD` and a *Copy invite* button with the link. *Show code* shows it again anytime. *Change code* replaces it and the old one stops working. To pick a code yourself, tick *I'll choose the code* when adding a borrower (or use *Change code*). Chosen codes are **exact**: small letters, capitals and symbols all count (e.g. `lang.88!Blue`), so borrowers must type them exactly. They need 8–40 characters with at least one letter and one number, no spaces, and must differ from other borrowers' codes; you're warned if one is short, contains the borrower's name, or uses only capitals and numbers. Generated codes, and custom codes made before this change, ignore case, spaces and dashes. The site is public, so a guessable code lets others see that borrower's balance; leave it blank for a strong random code.
- **Add a loan.** Enter the amount, number of months and first due date; it's split into monthly payments. Or add single payments.
- **Record payments** with *Mark paid* or *Record payment* (partial).
- **Paid-off loans** move into a collapsed *Paid off loans* section in each borrower's card (it opens by itself under the *Paid* filter). Borrowers see theirs under a collapsed *Paid off* in *My loans*.
- **Payments & reminders** under each borrower starts collapsed every time you open the page, even with a filter remembered. Tap it to expand. Changing a filter yourself expands the borrowers that match.
- **Every change is saved straight to the site repo.** Borrowers see it within about a minute.

## Expenses: money in minus bills paid

The Expenses Dashboard (`index.html`, **Expenses Dashboard** in the menu) works month by month (arrows in the header):

- **Money in**: what you add here (salary, business, freelance, gifts, refunds, interest…).
- **Expenses paid**: every payment you log in your **Personal Bills Tracker**, at the full amount you entered, in the month you logged it under (for a fixed-amount bill or loan, the *Month paid*; for a bill that varies, its bill month). One payment covering four terms counts all four that month. They're added automatically; change them on the Tracker.
- **Net** = money in − expenses paid. The **Budget** compares expenses paid with a monthly amount you set.
- **Expenses this month** starts collapsed every time you open the page (only how many items it holds shows); tap **Show** to expand it. It shows the Tracker's dashboard for the month (due, paid, left to pay, overdue) with each bill or loan and its status: the same numbers as the Tracker's *By month* view, where *Paid* is also what you logged that month.
- *Bills paid* breaks them down by bill, *Money in by category* by category, and *Transactions* lists both (bills paid are tagged *Tracker*).
- Money-out entries typed in before this change, and payments from the old Bills page, are kept but not counted; a note under Transactions says when a month has some. CSV export still includes every saved entry; it doesn't include Tracker payments.

## Tracker: bills and loans you are paying off

`tracker.html` (**Tracker** in the menu, titled *Personal Bills Tracker*) follows each bill or loan month by month. Tap **+ Add expense** at the top of the page. Everything you add is an expense. Its **Category** (in the form, next to the name) is **Bill**, **Loan** or **Other**; it shows as a small tag after the name on cards and rows, and is what the *Category* sort and filter use. A new expense starts with the category you used last. Ones added before categories existed count as a loan if they have a fixed amount and a bill if the amount varies; edit one to change it. Then pick how the amount works:

- **Fixed amount**: the same amount every month for a set number of months (an installment, a loan, a bill split over a few months). Enter the amount per month, the number of months (e.g. 6) and the first month due. Optionally add the lender, the due day, the amount you borrowed (to show the interest) and a note.
  - **Record payment** asks for the month you paid, how many months (terms) it covers and the amount (filled in as terms × amount; change it if you paid something different). Paying three terms in one month counts as three terms.
  - Each one shows terms paid out of the total, a box per term (green paid, red overdue, blue next), what's paid and left, and whether you're **behind**, **on track**, **ahead** or **paid off**.
- **Varies each month**: a bill whose amount changes, like electricity or water. Enter the first month due, and optionally the provider, a usual amount (used as an estimate), the due day, and a number of months (leave blank if it never ends).
  - **Record payment** asks for the bill month and the actual amount.
  - Each one shows a chip per month with the amount paid (green) or unpaid (red), the total paid, the average and last amounts, and whether it's **up to date**, **due this month**, **N months unpaid** or **paid off**.
- **By month** (the default): use the arrows in the header to pick a month. The totals show what's due that month, what's paid, what's left and what's overdue, and the list shows every bill and loan due that month with its status (Paid, Overdue, Due this month, Upcoming). Amounts for bills that vary show with `~` until paid. **Mark paid** asks for the amount: for a bill that varies, the actual amount for that month; for a fixed-amount one, it records that term, plus any earlier unpaid terms, since terms are paid in order (the button then says *Pay 3 terms*, for example). **Undo** on a paid bill that varies removes that month's payment. On the current month, *Still unpaid from earlier months* lists anything you missed, with a button to pay it. *All*, *Unpaid* and *Paid* filter the month's list.
- **Undo**: after any change (a payment, *Mark paid*, adding, editing or deleting a bill or loan), a message pops up at the bottom with an **Undo** button for about 8 seconds; it puts things back exactly as they were. In the month view, every paid row also has an **Undo** button: for a bill that varies it removes that month's payment; for a fixed-amount one it removes the payment that covered that term (it tells you which terms first, since one payment can cover several).
- **Collapsed lists**: *My expenses* and the month view's list start collapsed every time you open the page, showing only their name and how many items they hold. Tap **Show** to expand one and **Hide** to collapse it again; it stays open while you work and collapses again next time you open the page. The totals at the top stay visible (use the eye button to hide their amounts).
- **All bills & loans** shows the full cards described above, with filters and sorting. The page remembers which view you used last on that device.
- **Filter** above the list: **All**, **Needs paying** (something due by this month isn't paid), **Up to date** or **Paid off**; **Category** (all expenses, bills, loans, other, fixed amount, or varies each month); **Providers**; and **Search** (name, provider or note). Filters combine, and a line shows how many match with what's left and due on just those. *Clear filters* resets them. The status, type and provider are remembered on that device; the top totals always cover everything.
- **Sort by**: **Due first** (the default: anything unpaid on top, then by the next month due), **Category** (grouped under *Bills*, *Loans* and *Other* headings), **Provider** (grouped A–Z, with ones that have none at the end), or **Name**. The choice is remembered on that device and applies to the *Paid off* list too.
- **Paying a loan off in advance**: in *Record payment*, tap **Pay off the rest** to fill in every remaining term and the balance left (change the amount if you got a discount). A fixed-amount bill or loan counts as paid off as soon as what you've paid covers its total, even if you recorded fewer terms, and moves to *Paid off* marked **Paid off early**. It no longer shows as due or overdue in the months after.
- *Payment history* lists each payment. Things you've paid off move into a collapsed *Paid off* list.
- The totals at the top show what's left on everything, what's due by this month, and what you paid this month. For bills that vary, amounts not paid yet are estimated from the usual amount, or else the average so far, and marked *estimated*.
- The type can't be changed once a payment is recorded.

## Syncing expenses and bills across devices

Expenses and your Tracker bills and loans are saved in each browser. To see the same ones everywhere, use the bar at the top of any of those pages: **Sync across devices**, then enter the GitHub key and passphrase from your Money lent page. After that, every change is merged into an encrypted copy (`data/money.json`) and pulled in whenever the page is opened.

- Entries already on a device are kept and merged with the others the first time it syncs, so nothing is lost. Adds, edits and deletes from different devices all come through; if one device edits an entry another deleted, the edit wins.
- Each browser counts as its own device. Safari, Chrome and in-app browsers (like Messenger's) each keep their own storage, so set up sync in each one you use.
- **Remember passphrase on this device** (on any of the three pages) saves it in that browser, so the pages open and sync without asking. Without it, you're asked again once you close the tab. *Lock* on Money lent, or *Forget passphrase* in the sync bar, removes it. Only use it on your own devices.

## Borrowers sending their contact details

Borrowers can enter their email or mobile number (local numbers like `0917 123 4567` are fine) under **Payment reminders** on their page and tap **Send**.

- The details are encrypted on their phone so that only your owner page can read them. They travel through [ntfy.sh](https://ntfy.sh), a free notification relay that needs no account and only ever sees scrambled text.
- **To get a phone notification:** install the free **ntfy** app, tap **+**, and subscribe to the topic shown under **Settings** on your owner page. Keep the topic private.
- **To apply an update:** open your owner page. New updates appear at the top under **Updates from borrowers**, with **Apply** and **Dismiss**. Nothing changes until you apply. **Check for borrower updates** (in Settings) checks right away, and the page also checks every minute while it's open.
- ntfy keeps messages for about 12 hours. If `OWNER_PASSPHRASE` is set (see below), the hourly **Save borrower updates** workflow copies new messages into `data/inbox/`, still encrypted, so you can apply them later. Applying or dismissing removes the saved copy.

## Reminders (optional)

A GitHub Action in the site repo (`.github/workflows/reminders.yml`) runs once a day. It emails or texts a borrower:

- `N` days before a payment is due (default 3, set in Settings)
- on the due date
- the day after, if it's still unpaid

Borrowers send their email or phone from their page (see above), or you can type it in under their name and tick which reminders they want.

To turn reminders on, open the `balance` repo's **Settings → Secrets and variables → Actions** and add:

| Name | Type | Value |
| --- | --- | --- |
| `OWNER_PASSPHRASE` | Secret | Your passphrase, so the jobs can read the data (also used to save borrower updates) |
| `TIMEZONE` | Variable | e.g. `America/New_York` (default UTC) |
| `RESEND_API_KEY` | Secret | For email, from [resend.com](https://resend.com) |
| `EMAIL_FROM` | Variable | e.g. `Reminders <reminders@yourdomain.com>` (domain verified in Resend) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Secrets | For texts, from [twilio.com](https://www.twilio.com) |
| `TWILIO_FROM` | Variable | Your Twilio number, e.g. `+15551234567` |

To test it, open **Actions → Payment reminders → Run workflow**. The log only shows counts.

GitHub pauses scheduled jobs in repos with no activity for 60 days. Saving a change on the owner page counts as activity.

## Development

```sh
npm test                          # unit tests
npm run stamp                     # after changing any .js/.css file, so browsers fetch the new version
python3 -m http.server 8000       # then open http://localhost:8000
```

The earlier server-based version (Node server with its own login) is in this repo's git history if you ever want to self-host instead.
