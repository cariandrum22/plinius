## Context

You are reviewing a Go ledger service used by an internal payments platform. It is split into two subsystems that are each responsible for their own state and each protect that state with their own `sync.Mutex`:

- `AccountManager` owns account balances and performs transfers between accounts.
- `TransferService` owns a rolling in-memory log of recent transfers, used for auditing and a periodic reconciliation job that annotates each log entry with the account's current balance.

The two subsystems call into each other. The service has been stable for months under normal load, but since a nightly reconciliation job was added, on-call has been paged twice for the entire ledger service becoming completely unresponsive — no transfers complete, health checks time out, and the only remedy has been a process restart. A `SIGQUIT` goroutine dump taken during the second incident showed exactly two goroutines alive: one blocked inside `AccountManager.Transfer` and one blocked inside `TransferService.Reconcile`, both blocked on acquiring a mutex. CPU was at 0% on both goroutines; nothing was spinning.

Here is the relevant code, trimmed to the two subsystems and their wiring:

```go
package ledger

import (
	"errors"
	"sync"
)

var errInsufficientFunds = errors.New("insufficient funds")

type Account struct {
	ID      string
	Balance int64 // cents
}

// AccountManager owns account balances.
type AccountManager struct {
	mu       sync.Mutex
	accounts map[string]*Account
	ts       *TransferService
}

func NewAccountManager() *AccountManager {
	return &AccountManager{accounts: make(map[string]*Account)}
}

func (am *AccountManager) AttachTransferService(ts *TransferService) {
	am.ts = ts
}

// Transfer moves amount from one account to another and records the
// movement in the transfer log for audit purposes.
func (am *AccountManager) Transfer(from, to string, amount int64) error {
	am.mu.Lock()
	defer am.mu.Unlock()

	src, ok := am.accounts[from]
	if !ok || src.Balance < amount {
		return errInsufficientFunds
	}
	dst := am.accounts[to]

	src.Balance -= amount
	dst.Balance += amount

	am.ts.recordTransfer(from, to, amount)
	return nil
}

// GetBalance returns the current balance for an account.
func (am *AccountManager) GetBalance(id string) int64 {
	am.mu.Lock()
	defer am.mu.Unlock()
	return am.accounts[id].Balance
}

type transferRecord struct {
	From, To        string
	Amount          int64
	SrcBalanceAfter int64
}

// TransferService keeps a rolling audit log of recent transfers.
type TransferService struct {
	mu  sync.Mutex
	log []transferRecord
	am  *AccountManager
}

func NewTransferService(am *AccountManager) *TransferService {
	return &TransferService{am: am}
}

func (ts *TransferService) recordTransfer(from, to string, amount int64) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ts.log = append(ts.log, transferRecord{From: from, To: to, Amount: amount})
}

// Reconcile walks the recent transfer log, once a minute, and annotates
// each entry with the source account's current balance for the audit
// dashboard.
func (ts *TransferService) Reconcile() {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	for i := range ts.log {
		rec := &ts.log[i]
		rec.SrcBalanceAfter = ts.am.GetBalance(rec.From)
	}
}
```

The service runs many concurrent `Transfer` calls from API handlers (dozens per second under peak load) plus a single background goroutine that calls `Reconcile()` once a minute. Both incidents happened during peak traffic, within the same minute that reconciliation ran.

## Deliverable

Provide:

1. A precise diagnosis of the deadlock: identify the two locks involved and the exact interleaving of goroutines that produces the circular wait, referencing the specific lines/calls where each lock is acquired and where the blocking acquisition of the second lock occurs.
2. An explanation of why this only manifests intermittently and specifically correlates with reconciliation running concurrently with transfer traffic, rather than happening on every call.
3. A concrete, production-ready redesign that eliminates the possibility of this deadlock (you may show revised code or describe the change precisely enough to implement). If more than one viable approach exists — e.g., a strict global lock ordering, restructuring so the two subsystems never call into each other while holding their own lock, using a single shared lock for both roles, or a lock-free/message-passing handoff between the two subsystems — name the credible options and recommend one, discussing the trade-offs each accepts (throughput/contention, code coupling, risk of future regressions, ease of enforcing the discipline as the codebase grows).
