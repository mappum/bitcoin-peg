import * as bitcoinPeg from '../src/index'
import * as deposit from '../src/deposit'
import anyTest, { TestInterface } from 'ava'
let test = anyTest as TestInterface<{
  bitcoind: any
  spvNode: any
  lotionApp: any
  lightClient: any
  relay: any
  aliceRpc: any
  bobRpc: any
  carolRpc: any
  minerRpc: any
  aliceWallet: any
  bobWallet: any
}>
let coins = require('coins')
let lotion = require('lotion-mock')
let createBitcoind = require('bitcoind')
import { tmpdir } from 'os'
let { mkdirSync, remove } = require('fs-extra')
import { join } from 'path'
import getPort = require('get-port')
import {
  commitPubkey,
  signDisbursal,
  getCurrentP2ssAddress
} from '../src/signatory'
let seed = require('random-bytes-seed')
import { Relay } from '../src/relay'
import * as bitcoin from 'bitcoinjs-lib'
let RPCClient = require('bitcoin-core')
let { genValidator } = require('tendermint-node')
let ed = require('ed25519-supercop')
let secp = require('secp256k1')
let randomBytes = seed('seed')
let base58 = require('bs58check')
import { ValidatorMap, ValidatorKey, SignedTx, RPCHeader } from '../src/types'

let aliceValidatorKey: ValidatorKey = JSON.parse(genValidator()).Key
let bobValidatorKey: ValidatorKey = JSON.parse(genValidator()).Key

let lotionValidators: ValidatorMap = {
  [bobValidatorKey.pub_key.value]: 10
}

async function makeBitcoind(t: any) {
  let rpcport = await getPort()
  let port = await getPort()
  let dataPath = join(tmpdir(), Math.random().toString(36) + rpcport + port)
  mkdirSync(dataPath)
  let bitcoind = createBitcoind({
    rpcport,
    port,
    listen: 1,
    regtest: true,
    datadir: dataPath,
    debug: 1,
    deprecatedrpc: 'signrawtransaction',
    txindex: 1,
    rpcauth:
      'foo:e1fcea9fb59df8b0388f251984fe85$26431097d48c5b6047df8dee64f387f63835c01a2a463728ad75087d0133b8e6'
  })

  await bitcoind.started() //?.

  // Create RPC clients
  t.context.aliceRpc = new RPCClient({
    network: 'regtest',
    port: rpcport,
    wallet: 'alice-wallet',
    username: 'foo',
    password: 'j1DuzF7QRUp-iSXjgewO9T_WT1Qgrtz_XWOHCMn_O-Y='
  })

  t.context.bobRpc = new RPCClient({
    network: 'regtest',
    port: rpcport,
    wallet: 'bob-wallet',
    username: 'foo',
    password: 'j1DuzF7QRUp-iSXjgewO9T_WT1Qgrtz_XWOHCMn_O-Y='
  })

  t.context.carolRpc = new RPCClient({
    network: 'regtest',
    port: rpcport,
    wallet: 'carol-wallet',
    username: 'foo',
    password: 'j1DuzF7QRUp-iSXjgewO9T_WT1Qgrtz_XWOHCMn_O-Y='
  })

  t.context.minerRpc = new RPCClient({
    network: 'regtest',
    port: rpcport,
    wallet: 'miner-wallet',
    username: 'foo',
    password: 'j1DuzF7QRUp-iSXjgewO9T_WT1Qgrtz_XWOHCMn_O-Y='
  })

  // Create wallets
  await t.context.aliceRpc.createWallet('alice-wallet')
  await t.context.bobRpc.createWallet('bob-wallet')
  await t.context.carolRpc.createWallet('carol-wallet')
  await t.context.minerRpc.createWallet('miner-wallet')

  return { rpc: bitcoind.rpc, port, rpcport, node: bitcoind, dataPath }
}

function makeCoinsWallets(t: any) {
  let lc = t.context.lightClient
  t.context.aliceWallet = coins.wallet(randomBytes(32), lc, { route: 'mycoin' })
  t.context.bobWallet = coins.wallet(randomBytes(32), lc, { route: 'mycoin' })
}

function makeLotionApp(trustedBtcHeader: RPCHeader) {
  let trustedHeader = formatHeader(trustedBtcHeader)
  let app = lotion({
    initialState: {}
  })

  app.use('staking', function(state: any, tx: any, context: any) {
    lotionValidators[tx.stakeToKey] = 10

    context.validators = lotionValidators
    state.nonce = (state.nonce || 0) + 1
  })
  app.use(function(state: any, tx: any, context: any) {
    context.validators = lotionValidators
    console.log(context)
  })
  app.useBlock(function(state: any, context: any) {
    context.validators = lotionValidators
  })
  app.useInitializer(function(state: any, context: any) {
    context.validators = lotionValidators
  })

  app.use('bitcoin', bitcoinPeg(trustedHeader, 'mycoin', 'regtest'))

  let coinsModule: any = coins({
    initialBalances: {},
    handlers: {
      bitcoin: bitcoinPeg.coinsHandler('bitcoin')
    }
  })
  app.use('mycoin', coinsModule)

  app.start()
  return app
}

test.beforeEach(async function(t) {
  let btcd = await makeBitcoind(t)
  t.context.bitcoind = btcd

  let generated = await t.context.minerRpc.generateToAddress(
    2016,
    await t.context.minerRpc.getNewAddress()
  )
  let trustedBlock = await btcd.rpc.getBlock(generated[generated.length - 1])

  t.context.lotionApp = makeLotionApp(trustedBlock)
  let lc: any = await lotion.connect(t.context.lotionApp) //?.
  lc.validators = [
    {
      address: bobValidatorKey.address,
      pub_key: bobValidatorKey.pub_key,
      power: 10,
      voting_power: 10,
      name: 'bob'
    }
  ]
  t.context.lightClient = lc
  makeCoinsWallets(t)

  t.context.relay = new Relay({
    bitcoinRPC: t.context.bobRpc,
    lotionLightClient: lc,
    network: 'regtest'
  })
})

test.afterEach.always(async function(t) {
  await t.context.bitcoind.node.kill()
  await remove(t.context.bitcoind.dataPath)
})

test('deposit / send / withdraw', async function(t) {
  let ctx = t.context
  let lc = ctx.lightClient
  // Alice has a Bitcoin address
  let aliceBtcAddress = await ctx.aliceRpc.getNewAddress()
  let minerBtcAddress = await ctx.minerRpc.getNewAddress()

  // ... but Alice has no coins :(
  let aliceBtcBalance = await ctx.aliceRpc.getBalance()
  t.is(aliceBtcBalance, 0)

  // A miner sends Alice coins and mines a block!
  await ctx.minerRpc.sendToAddress(aliceBtcAddress, 50)
  await ctx.minerRpc.generateToAddress(1, minerBtcAddress)

  // Alice has some spendable Bitcoin!
  aliceBtcBalance = await ctx.aliceRpc.getBalance()
  t.is(aliceBtcBalance, 50)

  // Alice wants to deposit her Bitcoin into the peg zone,
  // but there aren't any signatories on the peg zone yet.
  // let signatoryKeys = await lc.state.bitcoin.signatoryKeys
  // t.is(Object.keys(signatoryKeys).length, 0)

  // Bob, however, is already a validator.
  t.is(lc.validators[0].pub_key.value, bobValidatorKey.pub_key.value)

  // Bob the validator commits to a signatory key.
  let bobWallet = ctx.bobWallet
  await commitPubkey(lc, bobValidatorKey, bobWallet.pubkey)

  let p2ssAddress: string = await lc.state.bitcoin.currentP2ssAddress
  let signatoryKeys = await lc.state.bitcoin.signatorySets[p2ssAddress]
    .signatoryKeys
  t.deepEqual(signatoryKeys, {
    [bobValidatorKey.pub_key.value]: bobWallet.pubkey
  })
  await ctx.relay.step()
  // Alice builds, signs, and sends a deposit transaction to pay to the current signatory set.
  let utxos = (await ctx.aliceRpc.listUnspent()).map(formatUtxo)
  let signatorySet = await lc.state.bitcoin.signatorySets[p2ssAddress]
  let bitcoinDepositTx = deposit.createBitcoinTx(
    signatorySet,
    utxos,
    base58.decode(ctx.aliceWallet.address()),
    'regtest'
  )
  let signedDepositTx = await ctx.aliceRpc.signRawTransactionWithWallet(
    bitcoinDepositTx.toHex()
  )
  await ctx.aliceRpc.sendRawTransaction(signedDepositTx.hex)
  await ctx.minerRpc.generateToAddress(1, minerBtcAddress)
  t.is(await ctx.aliceRpc.getBalance(), 0)

  // Bob (the validator, signatory, relayer) does a relay step.
  let state = await lc.state
  t.is(state.bitcoin.chain.length, 2)
  await ctx.relay.step()
  state = await lc.state
  t.is(state.bitcoin.chain.length, 3)

  // Alice has pegged coins!
  t.is(await ctx.aliceWallet.balance(), 4999990000)

  // Alice sends some coins to Bob.
  await ctx.aliceWallet.send(ctx.bobWallet.address(), 1e9)
  t.is(await ctx.aliceWallet.balance(), 3999990000)
  t.is(await ctx.bobWallet.balance(), 1e9)

  // Bob wants to withdraw some of the pegged Bitcoin he received.
  // Bob submits a withdrawal transaction.
  let signingTx = await lc.state.bitcoin.signatorySets[p2ssAddress].signingTx
  t.is(signingTx, null)
  let bobBtcAddress = await ctx.bobRpc.getNewAddress()
  let outputScript = bitcoin.address.toOutputScript(
    bobBtcAddress,
    bitcoin.networks.regtest
  )
  await ctx.bobWallet.send({
    type: 'bitcoin',
    amount: 5e8,
    script: outputScript
  })
  signingTx = await lc.state.bitcoin.signatorySets[p2ssAddress].signingTx
  t.is(signingTx.outputs[0].amount, 5e8)
  t.is(signingTx.signatures.length, 0)

  // Bob adds his signature to the disbursal transaction.
  await signDisbursal(lc, ctx.bobWallet.privkey, 'regtest')
  signingTx = await lc.state.bitcoin.signatorySets[p2ssAddress].signingTx
  t.is(signingTx, null)
  let signedTx: SignedTx | null = await lc.state.bitcoin.signatorySets[
    p2ssAddress
  ].signedTx

  // The signed tx gets broadcast to the Bitcoin network by the relayer:
  await ctx.relay.step()
  await ctx.minerRpc.generateToAddress(1, minerBtcAddress)

  // Now bob has some Bitcoin.
  let bobBtcBalance = await ctx.bobRpc.getBalance()
  t.is(bobBtcBalance, 4.99999)

  // Alice becomes a validator (as if by staking)
  await lc.send({
    type: 'staking',
    stakeToKey: aliceValidatorKey.pub_key.value
  })
  // manually refresh light client validators for this test
  lc.validators.push({
    address: aliceValidatorKey.address,
    pub_key: aliceValidatorKey.pub_key,
    power: 10,
    voting_power: 10,
    name: 'alice'
  })
  t.is(Object.keys(lotionValidators).length, 2)

  // Alice commits to a signatory key
  await commitPubkey(lc, aliceValidatorKey, ctx.aliceWallet.pubkey)
  let updatedP2ssAddress: string = await lc.state.bitcoin.currentP2ssAddress
  signatoryKeys = await lc.state.bitcoin.signatorySets[updatedP2ssAddress]
    .signatoryKeys
  t.deepEqual(signatoryKeys, {
    [aliceValidatorKey.pub_key.value]: ctx.aliceWallet.pubkey,
    [bobValidatorKey.pub_key.value]: ctx.bobWallet.pubkey
  })

  // Current pay-to-signatory-set-address should change after a new signatory joins
  t.not(p2ssAddress, updatedP2ssAddress)

  // Bob withdraws a little more (just to trigger a disbursal)
})

function formatHeader(header: RPCHeader) {
  return {
    height: header.height,
    version: header.version,
    prevHash: header.previousblockhash
      ? Buffer.from(header.previousblockhash, 'hex').reverse()
      : Buffer.alloc(32),
    merkleRoot: Buffer.from(header.merkleroot, 'hex').reverse(),
    timestamp: header.time,
    bits: parseInt(header.bits, 16),
    nonce: header.nonce
  }
}

function formatUtxo(utxo: { vout: any; txid: string; amount: number }) {
  return {
    vout: utxo.vout,
    txid: Buffer.from(utxo.txid, 'hex').reverse(),
    value: utxo.amount * 1e8
  }
}
