# Bridge

**Status: not live.** The bridge is built and tested, but it is deliberately not deployed. A bridge is where real money would sit, so it waits for an independent security review first.

## How it works

The same program runs on Solana and on Acrux Net.

1. **Send**: you lock a token in custody (if it's native to that chain) or burn its wrapped form. The program writes a permanent record: amount, recipient, destination chain and a sequence number.
2. **Approve**: independent **guardians** watch each chain. After the send is *finalized*, each guardian approves the exact transfer on the other chain. Approvals are keyed by a hash of every field, so a guardian can't change the amount or recipient. An invented transfer gets its own separate approval record and can never borrow approvals from the real one.
3. **Execute**: once a strict majority of guardians (for example 2 of 3) has approved, anyone can execute. The program releases the tokens from custody, or mints the wrapped form, to the recipient.

## Safety rails

- **Each transfer executes once**: a transfer's sequence number can be used only once.
- **Daily caps per token**: limits how much can move in a rolling 24 hours, which bounds the damage even if a majority of guardians were compromised.
- **Emergency pause**: any single guardian can pause the bridge. Only the admin can resume it.
- **Guardian rotation**: changing the guardian set cancels any approvals that are still pending.

All of these are covered by an end-to-end test that runs two chains and three guardians, including attacks: a stranger approving, a lying guardian inflating an amount, replaying a transfer, going over the cap, pausing, and rotating guardians.
