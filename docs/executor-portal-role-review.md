# بوابة التنفيذ — مراجعة الأدوار وتجربة العمل | Executor portal role & UX review

Reviewed against `main` after PRs **#38** (live-queue perf), **#39** (shared-balance pools), **#40** (pool manager UI). Findings below are from routes, controllers, services, views, and tests — not from product docs alone.

---

## A. Role-by-role UI & workflow map | خريطة الأدوار اليوم

Login is the same for every executor employee: unified `/login` (or legacy `/executor-portal/login`) → optional WhatsApp OTP → optional MFA enroll → **`/executor-portal/dashboard`**. Role is **not** stored on the session; it is loaded from `Employee.role` on each request (`operator` | `manager` | `accountant` | `external`). Inactive employee or group clears the session.

| Role | AR | Lands on | Nav items | Tasks (claim/complete) | Deposits / money | Team / pools | Reports |
|------|----|----------|-----------|------------------------|------------------|--------------|---------|
| **manager** | مدير تنفيذي | Live queue | المهام، التقارير، الإيداعات، الفريق، الدعم، الإعدادات | Sees all group `processing`/`accepted` tasks. Claim/complete/cancel/return. If **manual routing** is on, manager **cannot self-claim** (`ROUTING_REQUIRED`); must route to an **operator**. | Sees **إجمالي** + **خاص**. Can review **admin-initiated** deposits. Create-deposit form exists but is hidden (`d-none`). Funds/deducts external (solo or pool) from **private** balance. | Create employees (`operator` / `accountant` / `external`), pools, attach/detach, archive, routing mode | Group scope + employee filter + team performance |
| **operator** | موظف تنفيذ | Live queue | المهام، التقارير، الدعم، الإعدادات | Claim/complete own work. Open pool = unassigned `processing` tasks in the **group’s one service**. One **accepted** task at a time (`ACTIVE_TASK_EXISTS`). | No deposits page | No | **Personal** only (`operatorId` = self). `canViewAllReports` toggle in UI does **not** widen `getExecutorReports`. |
| **accountant** | محاسب | Redirected to **التقارير** | التقارير، الإيداعات، الدعم، الإعدادات | **Blocked** (`requireExecutorTaskAccess`). No live queue. | View company deposit list. **Cannot** approve/reject. | No | **Group** financials. No team-performance block. |
| **external** | منفّذ خارجي | Live queue | المهام، التقارير، **رصيدي**، الدعم، الإعدادات | Same claim/complete as operator (including one-active-task). **Cannot** be a manual-routing target (`role: 'operator'` only). | Sees only own `external_balance` funding/deductions (solo or named pool). Cannot see company deposits. | No | Personal + own funding ledger. Working balance is pool or solo. |

**Money path (claim → complete)**

1. Task is auto-routed to a group whose `serviceKey` supports `transferType` (`autoRouteService` sets `status: processing`).
2. Employee **اسحب ونفذ فوراً** → `acceptExecutorTask` (lock per employee, one accepted task).
3. Recipient number is revealed only after accept (`recipientRevealed`).
4. **إنهاء العملية** → proofs/sender entries → receipt → `status: completed`. Then `syncBotBalance` **rebuilds `ExecutorGroup.balance` (private)** by subtracting completed amounts and adding deposits/deductions. **`external_balance` rows are excluded** from that rebuild.
5. External/pool working balance is **not** decremented on complete. It only moves when a manager funds or deducts.

PRs #39/#40 added named pools for **external** members only: attach clears solo float into the pool; fund/deduct hits pool vs solo; alerts go to the funded person only.

---

## B. Friction / bugs / inconsistencies | احتكاك وأخطاء

Verified unless marked *hypothesis*.

1. **Live-queue type labels defaulted every non-postal task to «محفظة كاش»** (bank / Sefa / Bankak). Tiny copy fix in this PR.
2. **Settings «الخدمة» showed raw `serviceKey`** (`vodafone`, `bank_account`). Tiny copy fix in this PR.
3. **Dashboard profile badge** used «مدير النظام / منفذ العمليات» vs nav «مدير تنفيذي / موظف تنفيذ / منفّذ خارجي». Tiny copy fix. Profile pane itself is still **CSS-hidden** (`body.executor-os .bottom-nav-mobile { display: none }`) so «حسابي» on the live page is hard to reach after the OS chrome.
4. **Accountant deposit hero** told them to accept/cancel admin deposits. Tiny copy fix (view-only).
5. **`canViewAllReports` is a dead web control** for operators: manager can toggle it; `getExecutorReports` scopes `operator`/`external` to self regardless. Legacy `getLegacyExecutorReports` still reads the flag.
6. **Web vs mobile deposits:** web `POST /api/deposits` is **manager-only** + receipts. Mobile `requestExecutorDeposit` allows any **non-accountant** and does **not** require receipts (idempotent pending row).
7. **Manual routing cannot assign to `external`**. Externals can still self-claim when routing is off.
8. **Web live list omits `pending`**; mobile includes it (`LIVE_TASK_STATUSES` vs `MOBILE_LIVE_TASK_STATUSES`). Auto-route uses `processing`, so the usual path is fine; leftover `pending`+group rows would show on app only.
9. **Auth GET cache (15s, PR #38)** omits `balancePoolId` and `serviceKey`. Pool membership on cached reads can lag until a mutation.
10. **PR #38 leftover:** first HTML still CDN Bootstrap/FA/fonts; claim/complete still the slow financial path; auth cache is process-local (a just-suspended executor can poll for ~15s).
11. **External float vs execution (*product, not a crash*):** reports show `executedAmount` against working balance, but complete never spends pool/solo. Accountants/managers must reconcile by hand.
12. **Support categories** have no `external` list (falls back to operator). Group chat/tickets: manager sees group; others see own.
13. **Receipt generator** still titles most non-Sefa manuals as «محافظ كاش» (`executorTransactionController` `generateManualExecutorReceiptProof`). Not changed in this PR.
14. English API errors on employee toggle/password (`Cannot toggle manager`, `Not allowed`).
15. Duplicate `GET /reports` on portal + `executorReports` routers (harmless).
16. Low-balance banner uses **private** `groupId.balance` only — correct after pools, but managers with money sitting in pools still see “company is empty”.

---

## C. Speed & ease ideas | تسريع وتبسيط العمل اليومي

### Quick wins (ops UX, small code)

- Keep this PR’s service/role labels; extend the same map to **manual receipts** and mobile task cards.
- One **primary action** on the live card: claim → complete, with cancel/return behind a menu. Keyboard/scan already helps; add **paste-from-clipboard** for the execution number.
- Surface **today’s completed list** on the visible live page (monitor rail already has counts; the detailed «حسابي» list is orphaned).
- Hide or wire **`canViewAllReports`** so the team page matches `getExecutorReports`.
- Align mobile deposit create with the web receipt workflow (or hide the mobile shortcut).
- Allow routing candidates to include **active externals** when the company uses them as executors.
- Idle poll is already 12s / hidden-tab pause (PR #38). Next: **push-first** so the tab does not poll at all when web-push is live.

### Larger (technical + ops)

- **Per-employee service allow-list** (see D) so one login can work cash + bank without a second company.
- **Spend external/pool float on complete** (or stop showing executed amount as if it reduced the float). Pick one ledger model.
- Claim/complete latency: the remaining slowness is proofs + `syncBotBalance` scanning many txs. Incremental `$inc` (with the same exclusion of `external_balance`) would beat a full rebuild.
- Self-host CSS/fonts (PR #38 remaining limit).
- Optional **busy-slot > 1** for trusted operators (today hard-coded one accepted task).

---

## D. Multi-service capability | تعدد الخدمات

### What the code allows today | الوضع الحالي

- **`ExecutorGroup.serviceKey` is singular** (`vodafone` | `postal` | `bank_account` | `sefa_niger` | `bankak_sudan`).
- Employees inherit **that one service** via `groupId`. There is **no** per-employee service list; schema allows only one group.
- Within a service, multiple **transfer types** are allowed only where the catalog says so (`postal` → `post_account` + `post_card`). Cash + bank are **different services**, so **one company cannot legally receive both**.
- Auto-route / API queue / admin reassignment all call `executorSupportsTransferType(group, transferType)` and **reject mismatches**.
- The live portal does **not** filter by type; it trusts upstream routing.
- **Concurrent work:** even for one service, an employee may have only **one accepted task**. They cannot “handle cash and bank at once” as two in-flight executions.

**Answer:** No — one executor login cannot cleanly handle cash **and** bank (or Vodafone **and** another catalog service) today. Workarounds are a second company/login, or treating postal’s two transfer types as the only built-in multi-type case.

### Recommended design if you need it | تصميم مقترح

1. Add `serviceKeys: [String]` (or `Employee.allowedTransferTypes`) while keeping group `serviceKey` as the **billing/routing home** or promoting the group to a multi-service company.
2. Filter `loadPortalLiveTasks` / `acceptExecutorTask` with `executorSupportsTransferType` **per employee**, not only per group.
3. Auto-route: candidate = group ∩ employee allow-list ∩ not busy.
4. Separate **working balances** if economics differ (cash vs bank). Pools today are not service-scoped.
5. UI: service chips on the live card (this PR’s labels), settings, and receipts; optional live filter “كاش / بنك / بريد”.
6. Do not lift the one-accepted-task rule until ownership + receipt identity are explicit per in-flight task.

---

## E. Suggested next implementation order | ترتيب التنفيذ المقترح

1. **Ship these label fixes** (this PR) so bank/Sefa/Bankak cards and settings are not mislabeled as cash.
2. **Unify deposit create** (web receipts vs mobile shortcut) and **accountant view-only** behavior on mobile.
3. **Decide the external float model:** either debit pool/solo on complete, or stop implying that executed EGP reduced that float in reports.
4. **Manual routing + externals** (include `external` in `listRouteCandidates`) — needed if shops mix staff and contractors.
5. **Multi-service allow-list** (D) only after 1–4; it touches routing, balances, and receipts.

---

## Tiny copy PR in this branch

- Live queue + today’s list: catalog labels for `bank_account` / `sefa_niger` / `bankak_sudan` (unknown → «عملية تنفيذ», not cash).
- Settings: Arabic `getExecutorServiceLabel` instead of raw `serviceKey`.
- Profile badge aligned with nav role names.
- Accountant deposits: view-only help text.
