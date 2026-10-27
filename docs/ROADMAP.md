# Nexus Tower roadmap

## Implemented in this package
- Central Google Gemini API client initialized only in the server process.
- Department-aware planning and specialist deliverable generation.
- Bounded task queue, parallel-call limits, progress/error updates and Socket.IO events.
- Work-order result storage with optional PostgreSQL persistence.
- UI status panel and generated deliverables view.

## Next engineering steps
1. Add authentication and authorization before any public deployment.
2. Move queue state to a durable queue (for example, PostgreSQL-backed jobs) and resume queued tasks after restart.
3. Add task cancellation, retries with backoff, per-user quotas and cost/token telemetry.
4. Add controlled read-only repository or website inspection tools with explicit permissions and evidence capture.
5. Add human approval records before any write operation; keep deploy, rollback, restart and scale operations disabled until reviewed and tested.
6. Add integration tests using mocked Gemini responses, plus an opt-in smoke test using a real key.
7. Deploy the backend separately from the frontend, store secrets in the host secret manager, and configure health monitoring.

The 1,000 roster profiles are not 1,000 autonomous processes. The central brain selects a small number of specialist prompts for each work order to keep API usage controlled.
