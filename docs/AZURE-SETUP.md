# Azure for Students Setup — Phase A ($0, no credit card)

> **Why this doc:** GCP/AWS/Oracle all demand a card. **Azure for Students does not** —
> $100 credit / 12 months, renewed yearly while you're a student. AKS (managed
> Kubernetes) control plane is **$0 forever** on the Free tier. This replaces
> `GCP-SETUP.md` as the active path; that doc stays as the fallback if a card
> ever appears.
>
> **Everything runs in Azure Cloud Shell** (browser terminal — `az` CLI
> pre-installed, zero local install).

## What you get

| Item | Value |
|---|---|
| Credit | **$100 / 12 months**, no card, **renews annually** while student |
| AKS control plane | **$0 forever** (Free tier — no SLA, fine for a lab) |
| Planned burn | ~$30–40/mo (1× D2as_v5 **Spot** node + ~160 GB disks) → **~2.5–3.5 months runway** — our build plan is ~4 weeks, so it fits |
| Region | `eastus2` (cheap D-series + AKS available) |

## Eligibility (read first ⚠️)

- Full-time university student, **18+**, accredited degree-granting institution
- **Must verify with your institutional/school email** (e.g. `you@student.uni.edu.pk`).
  Gmail alone is **not** accepted. GitHub Student Pack by itself doesn't activate it either.
- One subscription per person
- **No school email?** → stop → go back to Route 1 (any Visa/Master card → `docs/GCP-SETUP.md`)

---

## Step 1 — Sign up (browser, ~10 min)

1. Open <https://azure.microsoft.com/en-us/free/students> → **Start free**.
2. Sign in with a Microsoft account (create one if needed) → choose **school email**
   verification flow. (Stuck on email not arriving? Use an **Incognito window** →
   <https://signup.azure.com/studentverification?offerType=1>, verify the school
   email, complete the phone check, wait 5–10 min, check Spam.)
3. Phone verification (text/call code).
4. Result: subscription active, **$100 credit** visible.

- [ ] Subscription created, $100 visible (portal header / **Cost Management**)

## Step 2 — Budget alerts (portal, ~3 min)

**Cost Management + Billing → Budgets → Add** (scope: this subscription):

| Field | Value |
|---|---|
| Amount | **$100** |
| Alerts | **50%**, **90%**, **100%** (email on) |

Credit not rolled over, unused credit dies at 12 months — alerts are the guardrail.
Also note: when credit hits 0 the subscription is **disabled** (not billed — no card exists) ✅

- [ ] Budget @ 50/90/100% + test email received

## Step 3 — Cloud Shell + register providers (~3 min)

Open Cloud Shell (console top-right `>_`):

```bash
az login          # opens browser, device-code fallback available
az account show   # verify: your subscription + $100 credit

az provider register --namespace Microsoft.ContainerService
az provider register --namespace Microsoft.Compute
az provider register --namespace Microsoft.Network
az provider register --namespace Microsoft.Storage
# registration is async: az provider show -n Microsoft.ContainerService --query registrationState
```

- [ ] `az login` OK, providers `Registered`

## Step 4 — GitHub OIDC deploy identity (key-less, ~8 min)

Same pattern as GCP-WIF: GitHub Actions assumes an Azure app — **no exported keys, ever**.

```bash
export SUB_ID=$(az account show --query id -o tsv)
export TENANT_ID=$(az account show --query tenantId -o tsv)

# 1) App registration + service principal
APP_ID=$(az ad app create --display-name gha-deploy --query appId -o tsv)
az ad sp create --id "$APP_ID" >/dev/null

# 2) Federated credential: ONLY this repo, ONLY main branch
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:Ismail-2001/The-Kubernetes-of-AI-Agents:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'

# 3) Role: enough to run kubectl/helm against AKS, nothing more
sleep 30   # AAD replication delay
az role assignment create \
  --assignee "$APP_ID" \
  --role "Azure Kubernetes Service Cluster User Role" \
  --scope "/subscriptions/${SUB_ID}"

# 4) Print the three values Phase B needs
echo "AZURE_CLIENT_ID=${APP_ID}"
echo "AZURE_TENANT_ID=${TENANT_ID}"
echo "AZURE_SUBSCRIPTION_ID=${SUB_ID}"
```

- [ ] Three `AZURE_*` values saved

## Step 5 — GitHub secrets + environments (~5 min)

```bash
node scripts/generate-secrets.mjs --force   # --force = regenerate for AZURE_* names
```

→ `secrets/github-secrets.env` (gitignored) → paste each into
<https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents/settings/secrets/actions>,
fill `OPENAI_API_KEY`, `SLACK_WEBHOOK`, and the three `AZURE_*` values from Step 4.

Environments: **staging** (no rules) + **production** (**Required reviewers = you**).

- [ ] Secrets + environments done

## Step 6 — Phase C preview (I build this next — don't run yet)

```bash
# Sketch only — exact flags verified in Phase C
az aks create -g egaop-rg -n egaop-aks --tier free \
  --location eastus2 --node-count 1 \
  --node-vm-size Standard_D2as_v5 --enable-node-public-ip
# + Spot node pool (--priority Spot), ingress-nginx (hostNetwork → $0 LB),
#   firewall/NSG 80/443 (AKS default already open), nip.io hosts
```

Design decisions baked in:
- **Spot node** = ~65% cheaper → credit lasts 2.5–3.5 months. Azure can evict
  spot capacity → AKS replaces the node; single-node lab tolerates it (runbook notes
  the new public IP → update `*.nip.io` hosts).
- **hostNetwork ingress** (node public IP + hostPort 80/443) → no Azure LB
  (LB would cost ~$18/mo = 18% of the credit).
- **No S3 on Azure** → chart backups target in-cluster **MinIO** (S3-compatible,
  free) + existing `backup.yml` → GitHub Artifacts as second channel (Phase D).
- Storage: `values-single-node.yaml` leaves `storageClass: ""` → AKS default disk
  class (portable: also works on GKE/kind later).

---

## Final checklist

- [ ] $100 credit visible + budget 50/90/100%
- [ ] Providers registered, `az login` OK
- [ ] `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` saved
- [ ] GitHub secrets + `staging`/`production` environments
- [ ] Calendar: **credit-burn check every 2 weeks** + exit plan (below)

## Exit reality (no-card constraint, honest version)

- Day ~70 of runway: **export state + decide**. Oracle always-free would be the
  lifetime home, but **OCI also wants a card** — so without a card the endgame is:
  1. **Best:** by then you likely have a card (bank/family) → migrate to OCI
     always-free (2 OCPU/12GB, lifetime) — images/values stay portable;
  2. Or renew Azure for Students next academic year (new $100) after a slim-down;
  3. Or freeze the validated system: kind cluster + full CI + docs = the artifact
     (the interview value was already produced by then).
- Phase G runbook (`AZURE-EXIT.md`) written in Phase E with the actual export steps.

## Guardrails (do NOT)

1. ❌ Upgrade to Pay-As-You-Go (there's no card anyway — and keep student renewal rights)
2. ❌ Second subscription / second AKS cluster (budget + one-person limit)
3. ❌ On-demand 8 GB VM 24/7 at full price (burns credit in ~6 weeks) — Spot + right-size
4. ❌ Azure Basic/LB or App Gateway in front (extra $/hr) — hostNetwork ingress only
5. ❌ Export the app's client secret/cert — federated credential only
6. ❌ Marketplace items (credit not applicable there)
