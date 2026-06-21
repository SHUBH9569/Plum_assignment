# Plum Health Insurance Claims Processing System

Production-grade end-to-end claims adjudication system built for the Plum AI Engineer assignment.

## What Is Included

- Policy-driven decision engine (no hardcoded policy logic)
- Early document-gating with specific member-facing errors
- Structured extraction layer with graceful degradation mode
- Deterministic decisioning: `APPROVED`, `PARTIAL`, `REJECTED`, `MANUAL_REVIEW`
- Full explainability trace on every response
- Fastify API contracts with Zod validation
- High-quality React UI for submission + trace review
- Automated eval runner for all 12 official test cases

## Tech Stack

- Frontend: React + Vite + TypeScript
- Backend: Node.js + Fastify + TypeScript
- Validation: Zod
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

### 2) Run backend

```bash
pnpm dev:api
```

Backend runs at `http://localhost:8787`.

### 3) Run frontend

In a second terminal:

```bash
pnpm dev:web
```

Frontend runs at `http://localhost:5173`.

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

- `GET /health`
- `GET /api/policy/summary`
- `GET /api/test-cases`
- `POST /api/claims/process`

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
