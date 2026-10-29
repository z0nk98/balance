# Tracking App

Track your own spending, and keep track of money you've lent to other people.
Borrowers get a private access code to see what they owe each month and when it's due.

It runs entirely on **GitHub Pages**. There's no server to pay for or maintain.

- **This repo (`Tracking-App`, private)** holds the app's code.
- **The site repo (`balance`, public)** holds a copy of the pages plus your data, **encrypted**. GitHub Pages publishes it.

## How privacy works

Pages sites are public, so nothing readable is stored there:

- **Your records** (borrowers, loans, payments, contact details, codes) are in `data/owner.json`, encrypted with **your passphrase**.
- **Each borrower's view** is in its own file under `data/b/`, encrypted with **their access code**. The file name comes from the code too, so you can't even tell which file is whose without it.
- Encryption is AES-256-GCM, with keys stretched using PBKDF2-SHA256 at 600,000 rounds. Access codes are 12 random characters (about 59 bits).
- Commit messages and reminder logs never include names, amounts or addresses.

What someone without a code *can* see: roughly how many borrowers you have, and when you made changes.

**If you forget your passphrase, the data can't be recovered.** Write it down, and use *Download backup* now and then.

## Pages

| Page | Who it's for |
| --- | --- |
| `index.html` | You: personal expenses (stored in your browser only) |
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

- **Add a borrower.** You get a code like `K7QM-3XRP-T8WD` and a *Copy invite* button with the link. *Show code* shows it again anytime. *New code* replaces it and the old one stops working.
- **Add a loan.** Enter the amount, number of months and first due date; it's split into monthly payments. Or add single payments.
- **Record payments** with *Mark paid* or *Record payment* (partial).
- **Every change is saved straight to the site repo.** Borrowers see it within about a minute.

## Reminders (optional)

A GitHub Action in the site repo (`.github/workflows/reminders.yml`) runs once a day. It emails or texts a borrower:

- `N` days before a payment is due (default 3, set in Settings)
- on the due date
- the day after, if it's still unpaid

Borrowers send you their email or phone number. You add it under their name and tick which reminders they want.

To turn reminders on, open the `balance` repo's **Settings → Secrets and variables → Actions** and add:

| Name | Type | Value |
| --- | --- | --- |
| `OWNER_PASSPHRASE` | Secret | Your passphrase, so the job can read the data |
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
python3 -m http.server 8000       # then open http://localhost:8000
```

The earlier server-based version (Node server with its own login) is in this repo's git history if you ever want to self-host instead.
