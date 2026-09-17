# Handoff notes for Claude

These notes carry over progress from earlier Claude Code sessions on another computer, whose chat history and memory aren't available here. **Delete this file before the final submission** (step 3 of "Resume here").

## What this is

- **The challenge:** a Caygnus hiring challenge for a Product Engineer role.
- **Candidate:** Sunidhi (GitHub `Sunidhisumbria`). The email is in `SUBMISSION.md`.
- **Fork:** https://github.com/Sunidhisumbria/product-engineer-ps (public), forked from `caygnus/product-engineer-ps`.
- **Chosen problem:** Problem 2, the webhook retry engine. The brief is at `problems/02-webhook-retry-engine/README.md`, and the rules and scoring are in `README.md` and `REVIEW_SCORECARD.md`. **Don't edit these files.**
- **Deadline:** 72 hours from when the user received or started the challenge. The challenge was published on 2026-09-15, and the build commits are dated 2026-09-17. Ask the user if the exact deadline matters.

## Status (2026-09-17)

**Done and pushed:**
- **Code:** the implementation is in `webhook-engine/`. It uses TypeScript, Hono, Zod, postgres.js, Postgres 17 in Docker, and Vitest.
- **Checks:** all 51 tests pass and the type check is clean. A fresh clone from GitHub installs and passes the tests.
- **Demos:** every demo scenario was verified live, plus a manual hard crash while a delivery was in flight.
- **`SUBMISSION.md`:** drafted. It covers setup, scenarios, architecture, decisions, the retry policy, the delivery guarantee, limitations and production answers.
- **The code is finished. Don't add features.** The brief says extra scope doesn't make up for an unreliable core.

**Resume here:**
1. **The user is recording the 3–5 minute demo video.** Their home PC can't run Docker, so they're recording in **GitHub Codespaces**. The script is below.
2. **Fill in the remaining `**TODO**` markers in `SUBMISSION.md`:**
   - **Demo video link:** it must be viewable by anyone with the link.
   - **AI usage:** the user must confirm or edit the draft, then add in their own words what they decided, changed or rejected.
   - **Credibility note:** get rough notes from the user and shape them. **Never invent any part of it.** Reviewers score it separately and ask about it in the call.
3. Delete this `CLAUDE.md`, then commit and push.
4. The user submits the fork link at https://binary.so/mWmcQzJ (or emails caygnus@gmail.com), with their resume and links to past work.

## Working with this user

- Explain in simple, plain English, one step at a time.
- **Always give commands with real values filled in.** The user has typed placeholders like `PASTE_ID_HERE` literally more than once.
- For each command, say which terminal it goes in and what output to wait for before moving on.

## Running it

In Codespaces, open three terminals with the **+** icon in the terminal panel.

```bash
# Terminal 1: the first time in a new Codespace, run all of these.
# Later, only `npm run dev` is needed.
cd /workspaces/product-engineer-ps/webhook-engine
npm ci
docker compose up -d --wait
npm run db:migrate
npm run dev              # wait for: api_listening url=http://localhost:3000

# Terminal 2
cd /workspaces/product-engineer-ps/webhook-engine
npm run receiver         # wait for: receiver_listening

# Terminal 3
cd /workspaces/product-engineer-ps/webhook-engine
npm run demo -- success
```

- `ECONNREFUSED ... :3000` means `npm run dev` isn't running.
- `npm run demo` with no argument lists the scenarios: success, retry, exhausted, rejected, duplicate and timeout.
- Each scenario prints the event ID on its `POST /events <id> -> 202` line.
- `npm test` needs only the Postgres container.
- On Windows PowerShell, the commands are the same. For HTTP requests, use `curl.exe` or `Invoke-RestMethod`.

## Video script (about 4½ minutes)

The brief requires the video to show:
- the project running
- a successful scenario
- a failure or recovery scenario
- the attempt history
- a repeated event handled idempotently
- the architecture
- one decision or trade-off

**Before recording:**
- Start `npm run dev` and `npm run receiver` off camera, or on camera as part 2.
- Clear the terminals and make the font bigger.
- Hide personal tabs.

**1. Intro (0:00–0:20)**
> "Hi, I'm Sunidhi. I chose Problem 2, the webhook retry engine. It's a small backend service that accepts an event, saves it, and delivers it to a webhook URL. If the receiver fails, it retries up to a limit. It records every attempt, and it never delivers the same event twice by mistake. It's built with TypeScript and Postgres."

**2. Project running (0:20–0:45).** Terminal 1: `npm run dev`. Terminal 2: `npm run receiver`.
> "Postgres runs in Docker. This is the API on port 3000, and the delivery worker runs in the same process. This is a fake webhook receiver that I can make succeed, fail or respond slowly."

**3. Success (0:45–1:05).** Terminal 3: `npm run demo -- success`
> "The receiver returns 200. My service accepts the event with 202, delivers it on the first attempt and marks it succeeded. The receiver got exactly one request."

**4 and 5. Retry and attempt history (1:05–2:05).** In Terminal 3, the first line runs the retry demo and saves the event ID. The second prints that event's history from the API.
```bash
ID=$(npm run demo -- retry | tee /dev/stderr | grep -o 'evt_retry_[a-z0-9]*' | head -1)
node -e "fetch('http://localhost:3000/events/$ID').then(r=>r.json()).then(e=>console.table(e.attempts,['attemptNumber','outcome','httpStatus','error','startedAt']))"
```
> "The receiver fails twice with 503, a temporary error, so the service retries. The wait roughly doubles each time, with a little randomness so retries don't all hit at once. The third attempt succeeds. The worker logs every attempt, and this call to `GET /events` shows every attempt stored in Postgres in order, with its number, time, outcome and status code."

**6. Retries stop (2:05–2:35).** `npm run demo -- exhausted` takes about 15 seconds, so talk while it runs.
> "Here the receiver never recovers. My service makes at most 5 attempts. It only retries errors that a retry can fix: 5xx, 408, 429, timeouts and network errors. Errors like 400 or 404 fail immediately. After 5 attempts it stops, and the event is marked failed with the reason."

**7. Duplicates (2:35–3:00).** `npm run demo -- duplicate`
> "I send the same event 5 times at the same moment. Only one request gets 202; the others get 200 with the existing event. Sending it again later also returns 200. The same ID with a different payload returns 409, because that's probably a caller bug. The receiver got only one request."

**8. Architecture (3:00–3:45).** Point at the folders in `webhook-engine/src`.
> "**http** is the API. It checks the request and returns 202, 200 or 409. **ingest** and **store** save the event. The event ID is the primary key, so Postgres guarantees one event per ID, even when requests arrive at the same moment. The event row is also the delivery job, so a second job can never be created. **delivery** is the worker. It picks up events that are due and locks each one for 30 seconds, so two workers never deliver the same event. It sends the request, the retry policy decides what happens next, and the result is saved. If the process crashes mid-delivery, the lock expires, the attempt is marked abandoned, and the event is retried. The abandoned attempt still counts toward the limit, so an event can never retry forever."

**9. Trade-off (3:45–4:25).** `npm run demo -- timeout`
> "My most important decision: delivery is at least once, not exactly once. Here the receiver processed the event but answered after my 5-second timeout, so my service retried and the receiver got it twice. Exactly once isn't possible over HTTP. I chose never to lose an event and to accept possible duplicates. Every request carries a Webhook-Id header that stays the same across attempts, so the receiver can ignore duplicates. I also used Postgres as both the database and the queue instead of adding Redis. That keeps things simpler, and the cost is that the worker checks for new events every half second."

**10. Tests and close (4:25–4:45).** `npm test`
> "There are 51 tests covering success, retries, running out of attempts, duplicates and crash recovery. They use a fake clock, so they don't depend on real timing. Setup and decisions are in SUBMISSION.md. Thank you."

If the video runs over 5 minutes, skip part 6.

**After recording:**
1. Upload to Loom, YouTube (unlisted) or Google Drive, shared so anyone with the link can view.
2. Open the link in a private window to check that it plays.
3. Give Claude the link to add to `SUBMISSION.md`.
4. Stop the Codespace: on GitHub, go to **Code**, open the **Codespaces** tab, click **…**, and choose **Stop codespace**.

## Gotchas from earlier sessions

- **Pushing from the original Windows PC:** Git's default GitHub login there is a different account, Parassunidhi, which gets a 403 on this fork. That clone's remote URL includes `Sunidhisumbria@` to force the right account.
- **Stopping servers on Windows:** stopping a backgrounded `npm run …` can leave its `node` process listening on port 3000 or 4000. Find and stop the process by its port.
- **Codespace was created before this file was pushed:** run `git pull` there to get it.
