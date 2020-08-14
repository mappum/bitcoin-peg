import { createHash } from 'crypto'
let ed = require('ed25519-supercop')
let secp = require('secp256k1')
import * as bitcoin from 'bitcoinjs-lib'
import {
  ValidatorKey,
  ValidatorMap,
  BitcoinNetwork,
  LightClient,
  SigningTx,
  SignatorySet
} from './types'
import {
  getSignatorySet,
  buildOutgoingTx,
  createWitnessScript
} from './reserve'
import { convertValidatorsToLotion } from './relay.js'

export async function commitPubkey(
  client: LightClient,
  privValidator: ValidatorKey,
  signatoryPub: Buffer
) {
  if (!secp.publicKeyVerify(signatoryPub)) {
    throw Error('Invalid signatory public key')
  }

  // locate our validator key in validators array
  let validators = convertValidatorsToLotion(client.validators)
  let signatorySet = getSignatorySet(validators)
  let signatoryIndex
  for (let i = 0; i < signatorySet.length; i++) {
    let signatory = signatorySet[i]
    if (signatory.validatorKey === privValidator.pub_key.value) {
      signatoryIndex = i
      break
    }
  }
  if (signatoryIndex == null) {
    throw Error('Given validator key not found in validator set')
  }

  let signature = ed25519Sign(privValidator, signatoryPub)

  return checkResult(
    await client.send({
      type: 'bitcoin',
      signatoryIndex,
      signatoryKey: signatoryPub,
      signature
    })
  )
}

export async function signDisbursal(
  client: LightClient,
  signatoryPriv: Buffer,
  network: BitcoinNetwork
) {
  let signatoryPub = secp.publicKeyCreate(signatoryPriv)
  // let validators = convertValidatorsToLotion(client.validators)
  let p2ssAddress = await client.state.bitcoin.currentP2ssAddress
  let signatorySet: SignatorySet = await client.state.bitcoin.signatorySets[
    p2ssAddress
  ]
  let { signatoryKeys, validators } = signatorySet
  let signatoryKeyAndPower = getSignatorySet(validators)
  let signatoryIndex
  for (let i = 0; i < signatoryKeyAndPower.length; i++) {
    let signatory = signatoryKeyAndPower[i]
    if (signatoryKeys[signatory.validatorKey].equals(signatoryPub)) {
      // found our signatory
      signatoryIndex = i
      break
    }
  }
  if (signatoryIndex == null) {
    throw Error('Given signatory key not found in signatory set')
  }

  let { signingTx } = signatorySet
  if (signingTx == null) {
    throw Error('No tx to be signed')
  }

  let bitcoinTx = buildOutgoingTx(signingTx, validators, signatoryKeys, network)

  let p2ss = createWitnessScript(validators, signatoryKeys)
  let sigHashes = signingTx.inputs.map((input, i) =>
    bitcoinTx.hashForWitnessV0(
      i,
      p2ss,
      input.amount,
      bitcoin.Transaction.SIGHASH_ALL
    )
  )
  let signatures = sigHashes.map(hash => {
    let signature = secp.sign(hash, signatoryPriv).signature
    return secp.signatureExport(signature)
  })

  return checkResult(
    await client.send({
      type: 'bitcoin',
      signatures,
      signatoryIndex
    })
  )
}

function sha512(data: Buffer) {
  return createHash('sha512')
    .update(data)
    .digest()
}

function ed25519Sign(privValidator: ValidatorKey, message: Buffer) {
  if (privValidator.priv_key.type !== 'tendermint/PrivKeyEd25519') {
    throw Error('Expected privkey type "tendermint/PrivKeyEd25519"')
  }

  let pub = Buffer.from(privValidator.pub_key.value, 'base64')
  let ref10Priv = Buffer.from(privValidator.priv_key.value, 'base64')
  let priv = convertEd25519(ref10Priv)

  return ed.sign(message, pub, priv)
}

export async function getSignatoryScriptHashFromPegZone(
  lightClient: LightClient
) {
  let signatoryKeys = await lightClient.state.bitcoin.signatoryKeys
  let lotionValidators: ValidatorMap = {}
  lightClient.validators.forEach(validator => {
    lotionValidators[validator.pub_key.value] = validator.voting_power
  })
  let p2ss = createWitnessScript(lotionValidators, signatoryKeys)
  return p2ss
}

export async function getCurrentP2ssAddress(
  lightClient: any,
  network: BitcoinNetwork
) {
  let p2ss = await getSignatoryScriptHashFromPegZone(lightClient)

  let p2ssAddress = bitcoin.payments.p2wsh({
    redeem: { output: p2ss },
    network: bitcoin.networks[network === 'mainnet' ? 'bitcoin' : network]
  }).address
  if (!p2ssAddress) {
    throw new Error('Could not derive p2ss address from peg zone')
  }
  return p2ssAddress
}

// TODO: move this somewhere else
export function convertEd25519(ref10Priv: Buffer) {
  // see https://github.com/orlp/ed25519/issues/10#issuecomment-242761092
  let privConverted = sha512(ref10Priv.slice(0, 32))
  privConverted[0] &= 248
  privConverted[31] &= 63
  privConverted[31] |= 64
  return privConverted
}

function checkResult(res: any) {
  if (res.check_tx.code || res.deliver_tx.code) {
    let log = res.check_tx.log || res.deliver_tx.log
    throw Error(log)
  }
  return res
}
