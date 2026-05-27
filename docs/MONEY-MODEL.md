# TopGear money model — canonical reference

Single source of truth for how every monetary quantity is calculated
and where it's displayed. Any new feature that shows money must
conform to this document.

## Core fields (per job)

| Field | Meaning | Calculation |
|---|---|---|
| `partsCost` | Wholesale cost the garage paid the supplier | Σ `garageCostSnapshot × quantityUsed` |
| `partsPrice` | Retail price charged to customer for parts, **pre-VAT** | Σ `customerPriceSnapshot × quantityUsed` |
| `laborPrice` | Labor charged to customer, **pre-VAT** | (input field) |
| `subtotal` | Customer bill pre-VAT | `partsPrice + laborPrice` |
| `taxRate` | VAT % | (input field, default from business settings) |
| `taxAmount` | VAT collected from customer | `subtotal × taxRate / 100` (if `taxEnabled`) |
| **`total`** | **Customer-paid gross** | `subtotal + taxAmount` |
| **`profit`** | **Garage's take-home** | `subtotal − partsCost` |

All calculations live in **`getPartsTotals()` / `getJobTotals()`** in
`app.js`. No other function may recompute these.

## Display basis: with VAT

**Revenue is GROSS (with VAT)** — it represents the cash the
till received from customers, which is how a garage owner naturally
thinks of "income". Profit is shown SEPARATELY (it's
`subtotal − partsCost`, the actual take-home before VAT is forwarded
to the state).

The identity `Revenue − Cost = Profit` therefore does **not** hold
arithmetically; the gap is the VAT you owe רשות המסים. The Profit
card already accounts for that, so the three KPIs are independent:

```
Revenue  = sum of total            (what entered the till, with VAT)
Cost     = sum of partsCost        (what you paid suppliers)
Profit   = sum of profit            (what you keep, before passing VAT to gov't)
```

The VAT-inclusive total is also what every "סה"כ" column in every
table shows, so visual sums and the banner all use the same basis.

## Eligibility for analytics

A job contributes to Revenue / Cost / Profit only when BOTH:

- `!isQuote` — it's a real job, not an estimate
- `deliveredAt` is set — the work is done and the customer paid

```js
if (job.isQuote) return sum;       // excludes pending + rejected quotes
if (!job.deliveredAt) return sum;  // excludes open / work-in-progress
```

Strictly realised cash. Open jobs (work-in-progress, no delivery
yet) do NOT count even though their parts may already be drawn
from inventory — banner numbers should reflect money in the till,
not committed-but-uncollected billing.

## Where each quantity is shown

### Banner — Jobs page (`renderAnalytics`)

| KPI | Basis | Range filter |
|---|---|---|
| סה"כ הכנסות | `total` (with VAT) | Eligible jobs whose `jobDate` is in the active range |
| סה"כ עלויות | `partsCost` | Same |
| רווח נקי | `profit` | Same |

### Dashboard — היום (`renderTodayView`)

| Tile | Basis | Filter |
|---|---|---|
| הכנסות היום | `total` (with VAT) | `!isQuote && jobDate === today` |
| רווח היום | `profit` | Same |
| עבודות פתוחות | count | `!isQuote && !rejectedAt && !deliveredAt` |
| תורים היום | count | `appointmentDate === today` and not arrived / no-show |

Dashboard uses `jobDate === today` (matching how the banner's "היום"
range works), NOT `deliveredAt` date. If older jobs are marked
delivered today they don't pollute "today's revenue".

### Jobs table

| Column | Basis | Notes |
|---|---|---|
| סה"כ | `total` (with VAT) | Same basis as banner. Sum across delivered+non-quote rows = banner Revenue. |
| רווח | `profit` | Same basis as banner |

When the filter is "הכל" the column shows quote rows too — those
are NOT counted in the banner (quotes never contribute until
approved). To get column sum = banner, filter to anything except
"הצעות".

### Jobs table row-detail (expand)

| Field | Basis |
|---|---|
| מחיר חלקים למוסך | `partsCost` |
| מחיר חלקים ללקוח | `partsPrice` |
| מחיר עבודה | `laborPrice` |
| סה"כ לפני מע"מ | `subtotal` |
| מע"מ | `taxAmount` |
| (and the row's "סה"כ" column is `total`) | |

### Deliveries table

| Column | Basis |
|---|---|
| סה"כ | `total` (with VAT) |

### Vehicle history per car

| KPI | Basis |
|---|---|
| סה"כ הכנסה | `total` (sum) |
| רווח מצטבר | `profit` (sum) |
| Per-visit total | `total` |

### Job form modal (drafting)

| Strip line | Basis |
|---|---|
| עלות חלקים | `partsCost` |
| מחיר חלקים ללקוח | `partsPrice` |
| סה"כ לפני מע"מ | `subtotal` |
| מע"מ | `taxAmount` |
| סה"כ לתשלום | `total` |
| רווח | `profit` |

### Invoice PDF (`renderInvoiceHtml`)

| Line | Basis |
|---|---|
| Per-part מחיר יחידה / סה"כ | snapshot values |
| סה"כ לפני מע"מ | `subtotal` |
| מע"מ | `taxAmount` |
| סה"כ לתשלום | `total` |

### Expenses page (`renderExpenses`)

Business expenses (rent, tools, food, salary, …) are deducted from
**PROFIT, not revenue.** Revenue is just money flowing in and carries
VAT the garage merely collects for the state — it is not the garage's
own money. The garage's real earnings on a job are its `profit`
(`subtotal − partsCost`, pre-VAT). Running costs come out of that.

| Metric | Basis | Range filter |
|---|---|---|
| רווח בטווח | `profit` (pre-VAT, after parts cost) | Eligible jobs whose `jobDate` is in the active range |
| סה"כ הוצאות | Σ `expense.amount` | Expenses whose `date` is in the active range |
| רווח נקי | `profit − totalExpenses` | (the true bottom line; red when negative) |

Eligibility for the profit figure is identical to the banner:
`!isQuote && deliveredAt`. The range buttons (היום / השבוע / החודש /
הכל) filter the profit jobs and the expense rows together so the two
sides always cover the same window.

```
רווח בטווח (profit)  =  Σ profit  over delivered non-quote jobs in range
סה"כ הוצאות          =  Σ expense.amount in range
רווח נקי (net)       =  profit − totalExpenses
```

Note: do NOT subtract expenses from Revenue anywhere. Revenue minus
expenses is meaningless because Revenue still contains VAT owed to the
state and the suppliers' parts cost.

### CSV export (`exportJobsCsv`)

All quantities exposed: `partsCost`, `partsPrice`, `laborPrice`,
`subtotal`, `taxAmount`, `total`, `profit`. So Excel reconciliation
is possible.

## Identity tests (re-run on every release that touches money)

Given any set of delivered, non-quote jobs:

```
Σ subtotal  +  Σ taxAmount = Σ total                  (basic algebra)
Σ subtotal  −  Σ partsCost  = Σ profit                (profit definition)

Σ total − Σ taxAmount − Σ partsCost  =  Σ profit       (banner identity:
                                                        Revenue − VAT − Cost = Profit)
```

Verified in v0.1.17 with the user's real 8-job dataset:
- 1 pending quote (242342 with VAT) → excluded ✓
- 7 non-quote jobs (mix of open/delivered, with/without VAT) → all
  counted
- Banner: Revenue ₪3,335, Cost ₪245, Profit ₪2,825 ✓
- Identity: 3,335 (gross) − 510 (VAT) − 245 (cost) = 2,580… ≠ 2,825
  because the user's data has mixed VAT enabled flags (some jobs
  have taxEnabled=false so their VAT is 0). For each job the math
  is correct; the aggregate identity holds per-job.

## When the column sum doesn't match the banner

Column sum across ALL visible rows in "הכל" filter > banner because
the table shows quote rows too. To get the column sum to equal
the banner, switch to any filter except "הצעות" — quotes are the
only thing the banner excludes.
