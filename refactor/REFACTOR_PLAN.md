# Refactor Plan: Unified Message Canvas

## Goal

Build a replacement application in this directory without modifying the legacy application.
Every persisted message, including `RELATION`, is a first-class client object.
A visual connector may describe a relationship, but never owns its identity or interaction.

## Non-goals

- Do not change the existing `frontend/` or `backend/` code during this migration.
- Do not preserve compatibility with legacy API endpoints, frontend types, exports, or database records.
- Do not use virtual `anon:*` nodes or a `relationMessageId` side-channel on graph edges.

## New Contract

The refactored backend will expose one versioned topic snapshot. Its `messages`
array contains every message kind, including `RELATION`; relationships are never
returned through a separate endpoint and are never converted into edge records.

## Milestones

- [x] M1: Create an independently buildable React/TypeScript application.
- [x] M2: Add a unified `TopicMessage` model, target references, indexes, and fixtures.
- [x] M3: Define the new versioned topic snapshot and repository contract without `DemoEdge`.
- [x] M4: Build the message canvas with first-class text, round, governance, and relationship items.
- [x] M5: Implement dedicated relation renderers for reply, reference, annotation, agree, disagree, tag, recommend, archive, correct, arrange, classify, merge, summary, notify, attention, block, and join.
- [~] M6: Selection, deep-link navigation, relation targeting, and direct-member container projections are complete; focus history and settlement entry points remain.
- [ ] M7: Add API integration, export loading, and authentication/signature compatibility.
- [~] M8: Added unified-model and navigation behavior tests; broader workflow coverage remains.

## First Vertical Slice

The initial runnable slice covers topic loading plus independent renderers for:

1. Text and system messages.
2. Reply, reference, and annotation.
3. Agree, disagree, recommend, and archive.
4. Classify, merge, summary, arrange, and correct.

It must demonstrate that every relation has a stable message ID, can be selected,
and can be inspected without selecting an edge.

## Validation

```powershell
Set-Location refactor
npm run lint
npm run build
```

Add unit tests for message normalization and relationship indexes before migrating each behavior family.
