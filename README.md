# Plum Health Insurance Claims Processing System

Production-grade end-to-end claims adjudication system built for the Plum AI Engineer assignment.

## What Is Included

- Policy-driven decision engine (no hardcoded policy logic)
- Early document-gating with specific member-facing errors
- Structured extraction layer with graceful degradation mode
- Real AI extraction support via OpenAI or Groq (optional, env-controlled)
- Deterministic decisioning: `APPROVED`, `PARTIAL`, `REJECTED`, `MANUAL_REVIEW`
- Full explainability trace on every response
- Fastify API contracts with Zod validation
- High-quality React UI for submission + trace review
- Dual claim intake modes: JSON payload and multipart file upload
- Automated eval runner for all 12 official test cases

## Tech Stack

- Frontend: React + Vite + TypeScript
- Backend: Node.js + Fastify + TypeScript
- Validation: Zod
- AI Extraction: OpenAI or Groq (with heuristic fallback)
- Testing: Vitest
- Package Manager: pnpm

## Monorepo Structure

```text
.
├── apps
│   ├── api
│   │   └── src
│   │       ├── engine
│   │       ├── routes
│   │       ├── scripts
│   │       └── __tests__
│   └── web
│       └── src
├── docs
│   ├── ARCHITECTURE.md
│   ├── COMPONENT_CONTRACTS.md
│   ├── EVAL_REPORT.md
│   └── DEMO_WALKTHROUGH.md
├── policy_terms.json
├── test_cases.json
└── assignment.md
```

## Quick Start

### 1) Install

```bash
pnpm install
```

### 2) Configure environment

```bash
cp .env.example .env
```

Then edit `.env` and set your AI provider key (see [AI Extraction](#ai-extraction) below). The system works without a key — it falls back to heuristic extraction automatically.

### 3) Run backend

```bash
pnpm dev:api
```

Backend runs at `http://localhost:8787`.

### 4) Run frontend

In a second terminal:

```bash
pnpm dev:web
```

Frontend runs at `http://localhost:5173`.

### 5) Upload mode (images/PDF/text)

Use the **Upload Mode** tab in the UI to submit files with real AI extraction. For each document:

- choose document type (used for policy requirement checks)
- choose quality hint (`GOOD`, `LOW`, `UNREADABLE`)
- attach the file (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.txt`, `.json`)

The pipeline streams live status events back to the UI — a progress ribbon shows each stage (Received → Validated → AI Extract → Policy → Adjudicate → Complete) in real time.

## AI Extraction

Set the following in `.env`:

| Variable | Value |
|---|---|
| `AI_PROVIDER` | `groq` or `openai` |
| `GROQ_API_KEY` | your Groq key (if using Groq) |
| `GROQ_MODEL` | model name, default `llama-3.3-70b-versatile` |
| `OPENAI_API_KEY` | your OpenAI key (if using OpenAI) |
| `OPENAI_VISION_MODEL` | model name, default `gpt-4o` |

Behavior:

- If a provider key is present: model extraction is used with retry + timeout.
- If the model call fails or no key is set: system auto-falls back to heuristic extraction and logs a `WARN` in the trace.
- Groq path is text-focused; image uploads on Groq fall back to heuristic extraction automatically.

## Build for Production

```bash
pnpm build
```

## Run Tests

```bash
pnpm test
```

## Run Official 12-Case Eval

```bash
pnpm eval
```

Outputs:
- `docs/eval_report.json`
- `docs/EVAL_REPORT.md`

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/policy/summary` | Active policy summary |
| `GET` | `/api/test-cases` | All 12 official test cases |
| `POST` | `/api/claims/process` | JSON claim → sync decision |
| `POST` | `/api/claims/process-live` | JSON claim → NDJSON stream (live trace) |
| `POST` | `/api/claims/process-form` | Multipart upload → sync decision |
| `POST` | `/api/claims/process-form-live` | Multipart upload → NDJSON stream (live trace) |

## Assignment Deliverables Mapping

1. Working System: API + UI + setup/build instructions in this README.
2. Architecture Document: `docs/ARCHITECTURE.md`.
3. Component Contracts: `docs/COMPONENT_CONTRACTS.md`.
4. Eval Report: `docs/EVAL_REPORT.md` (+ JSON artifact).
5. Demo Video Guide: `docs/DEMO_WALKTHROUGH.md`.

## Notes

- Policy behavior is read from `policy_terms.json`.
- Core logic is deterministic and fully traceable.
- Graceful degradation is demonstrated via `simulate_component_failure` payload flag.
- AI extraction is production-safe by design: timeout, retry, strict JSON parsing, and fallback path.
