import {
  networks,
  payments,
  script,
  Transaction,
  TxOutput
} from 'bitcoinjs-lib'

import {
  BitcoinNetwork,
  SignatoryKeyMap,
  SigningTx,
  SignatorySet,
  ValidatorMap
} from './types'

const MAX_SIGNATORIES = 76
const MIN_RELAY_FEE = 1000

const firstSignatory = (signatory: { votingPower: number; pubkey: string }) => {
  return `
  ${signatory.pubkey} OP_CHECKSIG
  OP_IF
    ${uint(signatory.votingPower)}
  OP_ELSE
    OP_0
  OP_ENDIF
`
}
const nthSignatory = (signatory: { pubkey: string; votingPower: number }) => `
  OP_SWAP
    ${signatory.pubkey} OP_CHECKSIG
  OP_IF
    ${uint(signatory.votingPower)}
    OP_ADD
  OP_ENDIF
`

const compare = (threshold: number) => `
  ${uint(threshold)}
  OP_GREATERTHAN
`

function signature(signature: string) {
  return signature || 'OP_0'
}

function uint(n: number) {
  n = Number(n)
  if (!Number.isInteger(n)) {
    throw Error('Number must be an integer')
  }
  if (n > 0xffffffff || n < 0) {
    throw Error('Number must be >= 0 and < 2^32')
  }
  let nHex = n.toString(16)
  if (nHex.length % 2 === 1) {
    nHex = '0' + nHex
  }
  return nHex
}

export function getVotingPowerThreshold(
  signatories: { votingPower: number }[]
) {
  let totalVotingPower = signatories.reduce((sum, s) => sum + s.votingPower, 0)
  let twoThirdsVotingPower = Math.ceil((totalVotingPower * 2) / 3)
  return twoThirdsVotingPower
}

export function createWitnessScript(
  validators: ValidatorMap,
  signatoryKeys: SignatoryKeyMap
) {
  // get signatory key for each signatory
  let signatories: { pubkey: string; votingPower: number }[] = getSignatorySet(
    validators
  )
    .filter(validator => {
      return signatoryKeys[validator.validatorKey]
    })
    .map(({ validatorKey, votingPower }) => {
      let pubkeyBytes: Buffer = signatoryKeys[validatorKey]
      let pubkeyHex = pubkeyBytes.toString('hex')
      return { pubkey: pubkeyHex, votingPower }
    })

  let twoThirdsVotingPower = getVotingPowerThreshold(signatories)

  let asm =
    firstSignatory(signatories[0]) +
    signatories
      .slice(1)
      .map(nthSignatory)
      .join('\n') +
    compare(twoThirdsVotingPower)

  return script.fromASM(trim(asm))
}

export function createScriptSig(signatures: string[]) {
  let asm = signatures
    .map(signature)
    .reverse()
    .join('\n')

  return script.fromASM(trim(asm))
}

function trim(s: string) {
  return s
    .split(/\s/g)
    .filter(s => !!s)
    .join(' ')
}

// gets the array of validators who are in the signatory set.
// note that each will commit to a separate secp256k1 signatory
// key for bitcoin transactions.
export function getSignatorySet(validators: ValidatorMap) {
  let entries = Object.entries(validators)
  entries.sort((a: any, b: any) => {
    // sort by voting power, breaking ties with pubkey
    let votingPowerA: number = a[1]
    let votingPowerB: number = b[1]
    let cmp = votingPowerB - votingPowerA
    if (cmp === 0) {
      cmp = b[0] < a[0] ? 1 : -1
    }
    return cmp
  })
  return entries
    .map(([validatorKey, votingPower]) => ({ validatorKey, votingPower }))
    .slice(0, MAX_SIGNATORIES)
}

export function buildOutgoingTx(
  signingTx: SigningTx,
  validators: ValidatorMap,
  signatoryKeys: SignatoryKeyMap,
  network: BitcoinNetwork
) {
  let { inputs, outputs } = signingTx
  let tx = new Transaction()
  let totalAmount = 0

  for (let { txid, index, amount } of inputs) {
    tx.addInput(txid, index)
    totalAmount += amount
  }

  let remainingAmount = totalAmount
  for (let { script, amount } of outputs) {
    tx.addOutput(script, amount)
    remainingAmount -= amount
    if (remainingAmount <= 0) {
      throw Error('Output amount exceeds input amount')
    }
  }

  // change output
  let p2ss = createOutput(validators, signatoryKeys, network)
  tx.addOutput(p2ss, remainingAmount)

  // withdrawals pay fee
  let txLength = tx.byteLength()
  let feeAmount = txLength // 1 satoshi per byte
  // TODO: configure min relay fee
  feeAmount = Math.max(feeAmount, MIN_RELAY_FEE)
  // TODO: adjust fee amount
  let feeAmountPerWithdrawal = Math.ceil(feeAmount / outputs.length)
  for (let i = 0; i < outputs.length; i++) {
    let out: TxOutput = tx.outs[i] as TxOutput
    out.value -= feeAmountPerWithdrawal
    if (out.value <= 0) {
      // TODO: remove this output and start fee paying process over
      throw Error('Output is not large enough to pay fee')
    }
  }
  return tx
}

/**
 * Get the pay-to-signatory-set hex script and address.
 *
 */
export function getP2ssInfo(
  signatorySet: SignatorySet,
  network: BitcoinNetwork
) {
  let p2ss = createWitnessScript(
    signatorySet.validators,
    signatorySet.signatoryKeys
  )
  let p2ssAddress = payments.p2wsh({
    redeem: { output: p2ss },
    network: networks[network === 'mainnet' ? 'bitcoin' : network]
  }).address as string
  return { address: p2ssAddress, script: p2ss }
}

export function createOutput(
  validators: ValidatorMap,
  signatoryKeys: SignatoryKeyMap,
  network: BitcoinNetwork
) {
  // p2ss = pay to signatory set
  let p2ss = createWitnessScript(validators, signatoryKeys)

  return payments.p2wsh({
    redeem: { output: p2ss },
    network: networks[network === 'mainnet' ? 'bitcoin' : network]
  }).output as Buffer
}
