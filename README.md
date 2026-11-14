# TineTech Nexus Tower

A browser-based executive command centre for TineTech, built with React, TypeScript, Three.js / React Three Fiber, Zustand, Express, Socket.IO, and optional PostgreSQL. This version adds a real server-side Google Gemini API integration and a bounded central task orchestrator.

## What is implemented

- 12-floor 3D tower scene and 1,000 instanced worker figures.
- Exactly 1,000 simulated worker profiles across 13 departments.
- Executive dashboard, department directory, workforce directory, work-order board, company pulse, settings, and read-only website health monitoring.
- **Google Gemini API brain:** the server accepts a directive, asks Gemini to plan a small set of specialist tasks, and asks Gemini for a draft deliverable for each selected department.
- **Central task queue:** bounded queue (default maximum 30), at most two active work orders, and at most four specialist subtasks per work order. Specialist calls are limited to two at a time.
- **Live progress:** work-order updates and brain status are broadcast over Socket.IO and shown on the dashboard.
- **Error reporting:** missing keys, model/API failures, malformed model responses and queue saturation become visible blocked tasks or API errors.
- **PostgreSQL-backed recovery:** production task submissions are accepted only when PostgreSQL is connected; queued and interrupted tasks are recovered and re-queued after a backend restart.
- **API authentication:** protected API routes and Socket.IO require a server-side `NEXUS_ADMIN_TOKEN`; only health probes remain public.
- Production website control actions remain blocked. The brain does not automatically deploy code, change the website, access Render logs, spend money, send messages, or run arbitrary tools.

## Important: what “1,000 agents” means

The 1,000 tower workers remain **simulated roster identities**, not 1,000 independently running AI processes or human employees. The central brain activates a small number of department-specialist prompts per directive. This balanced strategy avoids making 1,000 simultaneous API calls. Gemini generates plans, analyses and drafts from the information in the task; it does not automatically inspect private repositories or production systems. Review all generated work before relying on it.

The queue only runs while the backend process is running. For tasks to continue while your laptop is off, the backend must be deployed to a reliable server and configured with the Gemini secret there. This package has not been deployed for you.

## Requirements

- Node.js 20+ (Node.js 22 LTS recommended)
- npm 10+
- Internet access to install packages and call the Gemini API
- A Google Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
- Optional PostgreSQL for durable task and audit records

Gemini API usage has provider quota and may incur charges. Set usage limits or billing alerts in the provider account. Do not share the key.

## Run locally on Windows 11

1. Extract the project folder.
2. Install Node.js LTS from <https://nodejs.org/>.
3. Copy `.env.example` to a new file named `.env` in the project root (the startup script can create it automatically, but you need to add the key before issuing a directive).
4. Open `.env` in Notepad and set your private configuration:

   ```dotenv
   GEMINI_API_KEY=put_your_private_key_here
   GEMINI_MODEL=gemini-2.5-flash
   BRAIN_MAX_QUEUE=30
   NEXUS_ADMIN_TOKEN=put_a_random_secret_of_at_least_32_characters_here
   DATABASE_URL=your_private_postgres_connection_string
   ```

   Generate a long random admin token and keep it only in the server environment and your password manager. The app asks for it when it first connects; it is held only for the current browser session. Never commit it or put it in a `VITE_` variable.

   Keep the key private. Do not send it in chat, put it in client files, prefix it with `VITE_`, or commit `.env` to Git.
5. Run `START_NEXUS_TOWER.bat`, or in a terminal at the project root run:

   ```powershell
   npm install
   npm run dev
   ```

6. Open <http://localhost:5173>. Enter the `NEXUS_ADMIN_TOKEN` when prompted. The API health endpoint is <http://localhost:4000/api/health>; protected dashboard data requires the token.
7. Open **Settings → Nexus Brain**. The status should show **API KEY CONFIGURED**. If it does not, check `.env` and restart the backend.
8. Issue a directive. Follow progress in **Work Orders**; open a completed order to inspect the specialist deliverables.

If the API key is absent, tasks fail safely as blocked with a setup message. The application never displays the key itself.

## How a directive flows

1. The UI posts the objective, department and priority to `POST /api/agent/command`.
2. The server validates the request and places it in a bounded in-memory queue.
3. Gemini creates a short plan with up to four department assignments.
4. Specialist prompts produce drafts in controlled parallel calls.
5. The server stores status, progress, output and errors; Socket.IO sends updates to the dashboard.
6. The user reviews the output. No real-world action is taken automatically.

## API endpoints

- `GET /api/health` — server health
All API routes except `GET /api/health` and `GET /api/website/health` require `Authorization: Bearer <NEXUS_ADMIN_TOKEN>`. Socket.IO connections require the same token in the handshake auth field.
- `GET /api/brain/status` — provider configuration state, queue depth and counters (never returns the API key)
- `GET /api/brain/tasks` — recent tasks known to the current process
- `POST /api/agent/command` — enqueue a Gemini-backed directive: `{ "title": "Prepare a website performance review", "department": "webops", "priority": "normal" }`
- `GET /api/work-orders` — work-order list
- `POST /api/work-orders` — enqueue a Gemini-backed work order
- `POST /api/agent/plan` — compatibility endpoint that now enqueues a Gemini-backed task
- `GET /api/website/health` and `POST /api/website/check` — read-only public website reachability probe
- `GET /api/audit` — recent audit events
- `POST /api/website/action` — deliberately blocked for production mutations

Department IDs: `exec`, `engineering`, `product`, `sales`, `marketing`, `support`, `people`, `finance`, `legal`, `operations`, `data`, `webops`, `innovation`.

## Persistence and background operation

In local development, omitting `DATABASE_URL` uses in-memory storage. In production, task submission is blocked unless PostgreSQL is connected. Accepted work orders are written before entering the queue. On startup, orders left in `queued`, `assigned` or `in_progress` are reset to queued and resumed from the beginning; completed and review orders remain stored. This provides restart recovery for a single backend worker, not a multi-instance distributed scheduler.

## Production environment

Set these secrets in the Render service environment (never in Git): `NEXUS_ADMIN_TOKEN`, `GEMINI_API_KEY`, and `DATABASE_URL`. Also set `NODE_ENV=production` and configure `CORS_ORIGINS` for the deployed app origin. Use a random `NEXUS_ADMIN_TOKEN` with at least 32 characters. The API fails closed when the token is missing, and production task submissions fail when PostgreSQL is unavailable. Keep Render mutations disabled; credentials alone do not enable them.

## Build and test

```powershell
npm install
npm run build
```

The source was updated to integrate the SDK and orchestrator, but a successful install/build/runtime API call must be verified on a machine with working npm network access and a valid Gemini API key. Do not treat a queued task as completed until its actual result is visible in the work-order record.
