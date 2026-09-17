# Real-device performance checklist (iPhone / Android)

Captures real-device numbers with the opt-in probe. Run it once **before** the mobile
fixes are deployed (baseline) and once **after**, on the same phone, same account,
same network. Nothing is sent anywhere: you copy the results and paste them into the chat.

## Setup (once per phone)
1. Open `https://app.ollasuper.com/login?perf=1` and sign in
   (use an account that has at least one long conversation).
2. A dark **PERF** box appears at the top right. It stays on for this browser until
   you open any page with `?perf=0`.
3. The box shows the current step (`1/10 cold-open`). Use **▶** to move to the next step
   **before** doing that step. **Copy** puts all results on the clipboard.

## Run A — Wi-Fi, portrait (all steps)
| Step | What to do |
|---|---|
| 1 cold-open | Close the tab. Open `https://app.ollasuper.com/en/chat` again and wait until you can type. |
| 2 type | Tap the message box and type: `The quick brown fox jumps over the lazy dog again and again` (do not send). Clear it. |
| 3 send-short | Send `Reply with exactly the word ok.` Wait for the reply to finish. |
| 4 send-long | Send `Explain TCP congestion control in about 600 words with a table and two Python code blocks.` While it writes: scroll up and down a few times, then type a few words in the box. |
| 5 menus-dialogs | Open the conversations menu (top-left) and close it. Open the account menu and close it. On a reply, tap Share and close the dialog. |
| 6 scroll-long-thread | Open your longest conversation. Flick from top to bottom and back 5 times. |
| 7 background-return | Switch to another app for 60 seconds, come back, send `ok`. |
| 8 offline-return | Turn on Airplane mode for 10 seconds, turn it off, immediately send `ok`. Note what the screen showed while offline. |
| 9 network-switch | Send the long prompt from step 4, and while it writes turn Wi-Fi off (phone moves to mobile data). Note whether the reply finished. |

Tap **Copy** and paste the result into the chat, labelled `Run A (Wi-Fi portrait)`.

## Run B — mobile data, portrait
Tap **Reset**, go back to step 1 with **◀**, then do steps 1–4 and 6 on mobile data.
Copy → paste as `Run B (mobile data portrait)`.

## Run C — Wi-Fi, landscape
Tap **Reset**, go back to step 2, rotate the phone to landscape, do steps 2, 4, 5 and 6.
Copy → paste as `Run C (Wi-Fi landscape)`.

## Also note by hand (these cannot be measured by the page)
- Did the phone get warm during the runs? (no / slightly / hot)
- With the keyboard open: was the message box fully visible above the keyboard? Did the
  header jump or disappear?
- Anything that felt stuck, and at which step.
