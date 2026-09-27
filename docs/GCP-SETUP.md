# GCP Free-Trial Setup — Phase A ($0, 90-day clock)

> **Goal:** one GCP account + one project + budget guardrails + GitHub OIDC federation,
> in a single sitting. Everything below runs in **Cloud Shell** (browser terminal —
> `gcloud` pre-installed, no local install needed).
>
> **Cost so far: $0.** Trial = $300 credit / 90 days. We never upgrade to paid.
> Trial **cannot be paused** and **auto-closes at day 90** (resources stopped, then
> deleted after a grace period) — migration off-ramp is scheduled at **day ~75**
> (`docs/runbooks/GCP-EXIT-75.md`, written in Phase G).

## What you get

| Item | Value |
|---|---|
| Credit | **$300**, valid 90 days from signup, never billed |
| GKE control plane | **$0 forever** — zonal cluster covered by the $74.40/mo GKE free-tier credit |
| Planned spend (~90 d) | ~$235 (t2a-standard-4 node + ~200 GB disks + egress) → **$65 buffer** |
| Region | `us-central1` (Iowa) — cheapest + Ampere ARM (`t2a`) available |

---

## Step 1 — Create the account (browser, ~5 min)

1. Open <https://cloud.google.com/free> → **Get started for free**.
2. Sign in with your Google account → country + personal details.
3. **Payments profile:** real personal **debit/credit card** + phone verification.
   - ⚠️ Virtual/prepaid cards are often declined → use a real card.
   - ⚠️ Nothing is charged: the trial bills **only** if you manually upgrade to Paid (we won't).
4. Finish → you now have a **free-trial billing account with $300 credit**.

- [ ] Card + phone verified
- [ ] `Billing → Credits` shows **$300** remaining

## Step 2 — Create the project (Cloud Shell, ~2 min)

Open Cloud Shell: console top-right **terminal icon** (>_) — stays in browser.

```bash
# Project IDs are globally unique — append a suffix if "egaop-prod" is taken.
export PROJECT_ID=egaop-prod-1234        # ← change 1234 to something unique
gcloud projects create "$PROJECT_ID" --name="E-GAOP Production"
gcloud config set project "$PROJECT_ID"
```

Link billing (required before any billable resource, incl. GKE):

```bash
gcloud billing accounts list             # copy the ACCOUNT_ID (trial account)
gcloud billing projects link "$PROJECT_ID" --billing-account=ACCOUNT_ID
```

> **Do not create a second project/cluster later** — one project, one cluster.
> A second GKE cluster costs $73/mo (free credit covers only one zonal cluster).

- [ ] Project created, billing linked

## Step 3 — Enable APIs (Cloud Shell, ~1 min)

```bash
gcloud services enable \
  kubernetes.googleapis.com \
  compute.googleapis.com \
  storage.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com
```

- [ ] All APIs enabled (no errors)

## Step 4 — Budget alerts (console, ~3 min)

Console → **Billing → Budgets & alerts → Create budget**:

| Field | Value |
|---|---|
| Scope | this billing account, project = your `$PROJECT_ID` |
| Budget amount | **$300** (full trial) |
| Alerts | **50%**, **90%**, **100%** (email checked) |

Also create a **second tiny budget of $1** (scope: this project) — early-warning canary
for accidental spend while wiring CI (e.g. a mis-sized LoadBalancer).

- [ ] $300 budget @ 50/90/100%
- [ ] $1 canary budget
- [ ] Test alert email received (may take a few hours)

## Step 5 — GitHub OIDC federation (deploy identity, ~10 min)

This gives GitHub Actions **key-less** deploy access (WIF — no exported keys ever).
Run in Cloud Shell:

```bash
export PROJECT_ID=egaop-prod-1234        # same as Step 2
gcloud config set project "$PROJECT_ID"

# 1) Deploy service account (only role it ever needs: GKE admin)
gcloud iam service-accounts create gha-deploy --display-name="GitHub Actions deploy"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:gha-deploy@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/container.admin"

# 2) Workload Identity pool + provider (restricted to THIS repo only)
gcloud iam workload-identity-pools create github-pool \
  --location=global --display-name="GitHub OIDC pool"

gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global \
  --workload-identity-pool=github-pool \
  --display-name="GitHub Actions" \
  --issuer-url="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='Ismail-2001/The-Kubernetes-of-AI-Agents'"

# 3) Let ONLY this repo's Actions assume the deploy SA
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding \
  "gha-deploy@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/Ismail-2001/The-Kubernetes-of-AI-Agents"

# 4) Print the three values Phase B needs (keep them handy)
echo "GCP_PROJECT_ID=${PROJECT_ID}"
echo "GCP_WIF_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
echo "GCP_SA_EMAIL=gha-deploy@${PROJECT_ID}.iam.gserviceaccount.com"
```

GitHub side (browser):

1. Repo → **Settings → Secrets and variables → Actions → General** → ensure
   **Allow GitHub Actions to create OpenID Connect tokens** is permitted
   (default on for standard repos).
2. Note the three values printed above — Step 6 pastes them.

- [ ] SA + pool + provider created
- [ ] Three `GCP_*` values saved

## Step 6 — GitHub secrets (Phase B, ~5 min)

```bash
node scripts/generate-secrets.mjs
```

→ writes `secrets/github-secrets.env` (**gitignored**) and prints a paste block.
Open <https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents/settings/secrets/actions>
and add each `NAME=value` as a repository secret — including the three `GCP_*`
values from Step 5. `OPENAI_API_KEY` / `SLACK_WEBHOOK` you fill yourself
(slack.com → incoming webhook, free).

Also: repo → **Settings → Environments** → create `staging` (no rules) and
`production` (add **Required reviewers = you** → manual promote gate).

- [ ] All secrets added, `staging` + `production` environments exist

---

## Final checklist

- [ ] $300 credit visible
- [ ] Project + billing linked, APIs enabled
- [ ] Budgets: $300 (50/90/100%) + $1 canary
- [ ] `GCP_PROJECT_ID` / `GCP_WIF_PROVIDER` / `GCP_SA_EMAIL` saved
- [ ] GitHub secrets + environments done
- [ ] Calendar reminder: **day 75 — migrate to OCI always-free** (Phase G)

**Next:** Phase C — GKE cluster bootstrap (`infrastructure/gke/gke-cluster.sh`),
then Phase D (`values-single-node.yaml` + first deploy).

## Guardrails (do NOT)

1. ❌ Upgrade to Paid billing (trial protects us from charges — don't remove it)
2. ❌ Second project or second GKE cluster (fees / split brain)
3. ❌ Enable GKE **auto-upgrade** on the node pool (node IP changes → nip.io hosts break)
4. ❌ Create a regional cluster ($73/mo fee — free credit covers zonal only)
5. ❌ Export/download SA keys — WIF replaces keys entirely
