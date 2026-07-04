# E-GAOP CI/CD Validation Test Plan

## Overview

This document records the validation of the E-GAOP CI/CD pipeline. Each test
proves a specific failure mode is caught or a success path works correctly.

## Test Matrix

### Test A: Deliberately Failing Unit Test

**Objective:** Confirm CI shows red and merge is blocked.

**Steps:**
1. Create branch `test/failing-unit-test`
2. Add a failing test to `control-plane/api-server/src/__tests__/api-server.test.ts`:
   ```ts
   test("deliberate failure", () => {
     expect(true).toBe(false);
   });
   ```
3. Push and open PR against `main`
4. Observe GitHub Actions

**Expected result:**
- `lint-and-typecheck` passes (no TS errors)
- `unit-tests` job for `control-plane/api-server` fails
- `integration-tests` still runs (independent of unit-tests)
- PR merge button shows "Required status checks are failing"
- Merge is blocked

**Actual result:** _(To be filled after execution)_

---

### Test B: TypeScript Error — Fast Fail

**Objective:** Confirm lint-and-typecheck fails fast without running expensive tests.

**Steps:**
1. Create branch `test/ts-error`
2. Add a type error to any service:
   ```ts
   // In control-plane/api-server/src/index.ts
   const x: number = "not a number";
   ```
3. Push and open PR against `main`

**Expected result:**
- `lint-and-typecheck` fails within 2 minutes
- `unit-tests` and `integration-tests` jobs are **NOT started** (due to `needs: lint-and-typecheck`)
- Total CI time is under 3 minutes

**Actual result:** _(To be filled after execution)_

---

### Test C: All Green — Merge and Deploy

**Objective:** Confirm a clean PR can be merged and triggers deploy-staging.

**Steps:**
1. Create branch `test/clean-pr`
2. Add a harmless change (e.g., update a comment in README)
3. Push and open PR against `main`
4. Wait for all checks to pass
5. Merge the PR
6. Observe that `deploy-staging` job triggers on the `main` push

**Expected result:**
- All 3 required checks pass (lint-and-typecheck, unit-tests, integration-tests)
- Merge button is enabled
- After merge, `deploy-staging` job starts
- `build` job builds and pushes Docker images tagged with git SHA
- `deploy-staging` deploys to staging and runs smoke tests

**Actual result:** _(To be filled after execution)_

---

### Test D: Staging Health Check Failure — Auto-Rollback

**Objective:** Confirm auto-rollback triggers on smoke test failure.

**Steps:**
1. Temporarily break a health check endpoint in one service (e.g., return 500)
2. Push to `main`
3. Wait for `deploy-staging` to run
4. Observe smoke tests fail
5. Observe rollback job triggers

**Expected result:**
- Smoke tests detect unhealthy service
- `deploy-staging` job fails at smoke test step
- Rollback step runs: redeploys `LAST_SUCCESSFUL_DEPLOY_TAG`
- GitHub issue is created with rollback details
- Slack notification is sent (if webhook configured)

**Actual result:** _(To be filled after execution)_

---

### Test E: Cache Effectiveness

**Objective:** Confirm caching reduces CI time on subsequent runs.

**Steps:**
1. Run CI once (cold cache)
2. Run CI again immediately after (warm cache)
3. Compare job durations

**Expected result:**
- Cold run: ~8-12 minutes total
- Warm run: ~3-5 minutes total
- `npm ci` step is significantly faster with cached node_modules
- Docker builds use cached layers

**Actual result:** _(To be filled after execution)_

---

## How to Execute

```bash
# Test A: Create failing test branch
git checkout -b test/failing-unit-test
echo 'test("deliberate failure", () => { expect(true).toBe(false); });' >> \
  control-plane/api-server/src/__tests__/api-server.test.ts
git add . && git commit -m "test: deliberate failure"
git push -u origin test/failing-unit-test
# Open PR and observe CI

# Test B: Create TS error branch
git checkout -b test/ts-error
echo 'const x: number = "bad";' >> control-plane/api-server/src/index.ts
git add . && git commit -m "test: deliberate type error"
git push -u origin test/ts-error
# Open PR and observe CI

# Test C: Create clean branch
git checkout -b test/clean-pr
echo "# Test" >> README.md
git add . && git commit -m "test: clean PR"
git push -u origin test/clean-pr
# Open PR, merge, observe deploy-staging
```

## Evidence Collection

After each test, collect:
1. Screenshot of GitHub Actions run showing pass/fail status
2. Screenshot of PR showing merge button state (blocked/enabled)
3. Logs from the `deploy-staging` job if applicable
4. Duration of each job for cache effectiveness comparison
