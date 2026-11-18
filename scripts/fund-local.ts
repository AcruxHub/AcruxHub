// Dev helper: funds an address on the local "Acrux" chain (:8999) with SOL and the
// launchpad quote token (the dev wallet is its mint authority in tests).
import { PublicKey } from '@solana/web3.js'
import { launchpadProgram } from '../sdk/src/programs.ts'
import { CHAIN_B_RPC, waitForChain, providerFor, devWallet, fund, giveTokens } from '../tests/helpers.ts'

const to = new PublicKey(process.argv[2])
const conn = await waitForChain(CHAIN_B_RPC)
await fund(conn, to, 10)
const config = await launchpadProgram(providerFor(conn, devWallet)).account.config.fetch(
  PublicKey.findProgramAddressSync([Buffer.from('config')], (await import('../sdk/src/programs.ts')).LAUNCHPAD_ID)[0],
)
await giveTokens(conn, devWallet, config.quoteMint, to, 100_000_000_000n)
console.log('funded', to.toBase58(), '10 SOL + 100 quote', config.quoteMint.toBase58())
