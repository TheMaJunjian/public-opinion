---
name: verify-before-change
description: "Use when a project has a runtime bug, failing test, unexpected behavior, or reported operational problem and the cause is not yet proven. Verify the suspected cause with a focused check before changing implementation code; do not modify business code based on guesswork alone."
argument-hint: "Describe the observed problem, reproduction steps, and suspected cause"
user-invocable: true
disable-model-invocation: false
---

# Verify Before Change

## Purpose

Diagnose project problems from evidence. A suspected cause is a hypothesis, not a conclusion: implementation code may be changed only after a focused verification supports that hypothesis.

## When to Use

- The user reports a runtime problem, regression, failing test, or unexpected UI/API behavior.
- The cause is uncertain or multiple code paths could explain the symptom.
- A proposed fix is based mainly on intuition, code reading, or a similar past issue.

## Non-Negotiable Rule

Do not directly modify business or implementation code from a suspected cause. First run a cheap, focused check that could confirm or falsify the hypothesis. If the check does not support the hypothesis, do not apply that fix; investigate the nearest code path that controls the observed behavior.

Configuration, test, or diagnostic-only changes are allowed before verification when they are necessary to perform the check. Keep them minimal, explain their purpose, and remove temporary diagnostics after the root cause is confirmed and fixed.

## Procedure

1. Read the project's local conventions and relevant debugging instructions before acting. Identify the concrete anchor: failing command, test, error, user-visible symptom, named file, or controlling symbol.
2. State one falsifiable hypothesis about the cause. Record the expected evidence if it is true and what observation would disprove it.
3. Choose the cheapest discriminating check available, in this order when applicable:
   - Run the failing or narrowest existing test.
   - Reproduce the issue with the smallest relevant command or browser/API flow.
   - Inspect a nearby call site, state transition, request/response, or rendered value.
   - Add temporary, targeted diagnostics to the key path, then reproduce once.
4. Run the check before changing implementation code. Capture the relevant output, inputs, state, and expected-versus-actual result. Avoid broad searches or speculative refactors.
5. Decide from the evidence:
   - **Confirmed:** the evidence directly supports the hypothesis. Make the smallest root-cause fix.
   - **Disproved:** the expected evidence is absent or contradicts the hypothesis. Do not apply the proposed fix; make one nearby step toward the code that actually controls the behavior and form a new hypothesis.
   - **Ambiguous:** perform one additional focused check or read one nearby boundary, then decide. Do not stack speculative edits.
6. After a confirmed fix, rerun the same focused check first. Then run the narrowest relevant typecheck, lint, integration test, or end-to-end test available.
7. Remove temporary diagnostic code and rerun the focused check if its removal could affect behavior. Keep only intentional error logging and project-standard operational logs.
8. Unless the user requests detail, respond in the shortest useful form with only: **Problem/Symptom**, **Cause Verification**, **Confirmed Cause**, and **Solution**. Use one short sentence or phrase for each item; keep cause verification to the essential confirming observation, and omit other diagnostic steps, test output, file lists, and unrelated context. If verification was impossible, state briefly that the cause is not confirmed and do not propose an implementation change.

## Evidence Quality

A valid verification must connect the suspected cause to the symptom through observable behavior, such as a failing assertion, controlled reproduction, request/response value, state transition, stack trace, or targeted log. Mere proximity of code, naming similarity, or a plausible explanation is insufficient.

Prefer checks that distinguish competing hypotheses. Keep diagnostic output focused on directly relevant parameters and state; do not dump large objects or secrets. For frontend debugging, use tagged structured logs. For backend debugging, use the project's logger and its documented log location.

## Completion Criteria

- The root cause is supported by a focused, reproducible check, or implementation code was intentionally left unchanged because it could not be verified.
- The fix is minimal and addresses the verified controlling path.
- The original focused check passes after the fix.
- Relevant temporary diagnostics are removed.
- Unless more detail is requested, the final response contains only short statements of the problem/symptom, cause verification, confirmed cause, and corresponding solution.
