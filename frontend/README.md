# 公论 Frontend

A React + TypeScript frontend for the 公论 (GongLun) structured discussion system.

## Tech Stack

- Vite + React 18 + TypeScript
- Tailwind CSS
- React Router DOM

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

Runs on http://localhost:5173

## Build

```bash
npm run build
```

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_BASE_URL` | `http://localhost:3000/api` | Backend API base URL |
| `VITE_USE_MOCK` | `false` | Use mock data instead of real backend |

## Mock Mode

To run with mock data (no backend required):

```bash
VITE_USE_MOCK=true npm run dev
```

Or set `VITE_USE_MOCK=true` in `.env`.

## Pages

- `/` — Topic list with search and pagination
- `/login` — Login
- `/register` — Register
- `/topics/:id` — Topic detail with messages and relations
- `/topics/:id/messages/:msgId` — Message detail with relation analysis
