import { randomBytes } from 'crypto'
import { ethers } from 'ethers'
import secp256k1 from 'secp256k1'
import ecurve from 'ecurve'
import elliptic from 'elliptic'
import bigi from 'bigi'
import { BN } from 'bn.js'

import { InternalNoncePairs, InternalNonces, InternalPublicNonces, InternalSignature } from './types'
import { KeyPair } from '../types'

const curve = ecurve.getCurveByName('secp256k1')
const n = curve?.n
const EC = elliptic.ec
const ec = new EC('secp256k1')
const generatorPoint = ec.g

const _generateNonce = (): InternalNoncePairs => {
  const k = ethers.utils.randomBytes(32)
  const kTwo = ethers.utils.randomBytes(32)
  const kPublic = secp256k1.publicKeyCreate(k)
  const kTwoPublic = secp256k1.publicKeyCreate(kTwo)

  return {
    k,
    kTwo,
    kPublic,
    kTwoPublic,
  }
}

const _bCoefficient = (combinedPublicKey: Uint8Array, msgHash: string, publicNonces: InternalPublicNonces[]): Uint8Array => {
  type KeyOf = keyof InternalPublicNonces
  const arrayColumn = (arr: Array<InternalPublicNonces>, n: KeyOf) => arr.map(x => x[n])
  const kPublicNonces = secp256k1.publicKeyCombine(arrayColumn(publicNonces, 'kPublic'))
  const kTwoPublicNonces = secp256k1.publicKeyCombine(arrayColumn(publicNonces, 'kTwoPublic'))

  return ethers.utils.arrayify(ethers.utils.solidityKeccak256(
    ['bytes', 'bytes32', 'bytes', 'bytes'],
    [combinedPublicKey, msgHash, kPublicNonces, kTwoPublicNonces]
  ))
}

const areBuffersSame = (buf1: Uint8Array, buf2: Uint8Array): boolean => {
  if (buf1.byteLength != buf2.byteLength) return false

  var dv1 = new Int8Array(buf1)
  var dv2 = new Int8Array(buf2)
  for (var i = 0; i != buf1.byteLength; i++) {
    if (dv1[i] != dv2[i]) return false
  }

  return true
}

const challenge = (R: Uint8Array, msgHash: string, publicKey: Uint8Array): Uint8Array => {
  // convert R to address
  var R_uncomp = secp256k1.publicKeyConvert(R, false)
  var R_addr = ethers.utils.arrayify(ethers.utils.keccak256(R_uncomp.slice(1, 65))).slice(12, 32)

  // e = keccak256(address(R) || compressed publicKey || msgHash)
  return ethers.utils.arrayify(
    ethers.utils.solidityKeccak256(
      ['address', 'uint8', 'bytes32', 'bytes32'],
      [R_addr, publicKey[0] + 27 - 2, publicKey.slice(1, 33), msgHash]
    )
  )
}

/**
 * Sign the given hash by the private key
 *
 * @param Uint8Array privateKey
 * @param string hash
 * @returns InternalSignature
 */
const internalSign = (privateKey: Uint8Array, hash: string): InternalSignature => {
  const localPk = new Uint8Array(privateKey)
  const publicKey = secp256k1.publicKeyCreate((localPk as any))

  // R = G * k
  var k = ethers.utils.randomBytes(32)
  var R = secp256k1.publicKeyCreate(k)

  // e = h(address(R) || compressed pubkey || m)
  var e = challenge(R, hash, publicKey)

  // xe = x * e
  var xe = secp256k1.privateKeyTweakMul((localPk as any), e)

  // s = k + xe mod(n)
  var s = secp256k1.privateKeyTweakAdd(k, xe)
  s = bigi.fromBuffer(s).mod(n).toBuffer(32)

  return {
    finalPublicNonce: R,
    challenge: e,
    signature: s
  }
}

const internalMultiSigSign = (nonces: InternalNonces, combinedPublicKey: Uint8Array, privateKey: Uint8Array, hash: string, publicKeys: Uint8Array[], publicNonces: InternalPublicNonces[]): InternalSignature => {
  if (publicKeys.length < 2) {
    throw Error('At least 2 public keys should be provided')
  }

  const localPk = new Uint8Array(privateKey)
  const xHashed = _hashPrivateKey(localPk)
  if (!(xHashed in nonces) || Object.keys(nonces[xHashed]).length === 0) {
    throw Error('Nonces should be exchanged before signing')
  }

  const publicKey = secp256k1.publicKeyCreate(localPk)
  const L = _generateL(publicKeys)
  const a = _aCoefficient(publicKey, L)
  const b = _bCoefficient(combinedPublicKey, hash, publicNonces)

  const effectiveNonces = publicNonces.map((batch) => {
    return secp256k1.publicKeyCombine([batch.kPublic, secp256k1.publicKeyTweakMul(batch.kTwoPublic, b)])
  })
  const signerEffectiveNonce = secp256k1.publicKeyCombine([
    nonces[xHashed].kPublic,
    secp256k1.publicKeyTweakMul(nonces[xHashed].kTwoPublic, b)
  ])
  const inArray = effectiveNonces.filter(nonce => areBuffersSame(nonce, signerEffectiveNonce)).length != 0
  if (!inArray) {
    throw Error('Passed nonces are invalid')
  }

  const R = secp256k1.publicKeyCombine(effectiveNonces)
  const e = challenge(R, hash, combinedPublicKey)

  const { k, kTwo } = nonces[xHashed]

  // xe = x * e
  const xe = secp256k1.privateKeyTweakMul(localPk, e)

  // xea = a * xe
  const xea = secp256k1.privateKeyTweakMul(xe, a)

  // k + xea
  const kPlusxea = secp256k1.privateKeyTweakAdd(xea, k)

  // kTwo * b
  const kTwoMulB = secp256k1.privateKeyTweakMul(kTwo, b)

  // k + kTwoMulB + xea
  const final = secp256k1.privateKeyTweakAdd(kPlusxea, kTwoMulB)


  return {
    // s = k + xea mod(n)
    signature: bigi.fromBuffer(final).mod(n).toBuffer(32),
    challenge: e,
    finalPublicNonce: R
  }
}

/**
 * Verify a signature for the given hash, public nonce and public key
 *
 * @param Uint8Array s
 * @param string hash
 * @param Uint8Array R
 * @param Uint8Array publicKey
 * @returns boolean
 */
const internalVerify = (s: Uint8Array, hash: string, R: Uint8Array, publicKey: Uint8Array): boolean => {
  const eC = challenge(R, hash, publicKey)
  const sG = generatorPoint.mul(ethers.utils.arrayify(s))
  const P = ec.keyFromPublic(publicKey).getPublic()
  const bnEC = new BN(Buffer.from(eC).toString('hex'), 'hex')
  const Pe = P.mul(bnEC)
  const toPublicR = ec.keyFromPublic(R).getPublic()
  const RplusPe = toPublicR.add(Pe)
  return sG.eq(RplusPe)
}

export const _generateL = (publicKeys: Array<Uint8Array>) => {
  return ethers.utils.keccak256(_concatTypedArrays(publicKeys.sort(Buffer.compare)))
}

export const _concatTypedArrays = (publicKeys: Uint8Array[]): Uint8Array => {
  const c: Buffer = Buffer.alloc(publicKeys.reduce((partialSum, publicKey) => partialSum + publicKey.length, 0))
  publicKeys.map((publicKey, index) => c.set(publicKey, (index * publicKey.length)))
  return new Uint8Array(c.buffer)
}


export const _aCoefficient = (publicKey: Uint8Array, L: string): Uint8Array => {
  return ethers.utils.arrayify(ethers.utils.solidityKeccak256(
    ['bytes', 'bytes'],
    [L, publicKey]
  ))
}

export const generateRandomKeys = () => {
  let privKeyBytes: Buffer | undefined
  do {
    privKeyBytes = randomBytes(32)
  } while (!secp256k1.privateKeyVerify(privKeyBytes))

  const pubKey = Buffer.from(secp256k1.publicKeyCreate(privKeyBytes))

  const data = {
    publicKey: pubKey,
    privateKey: privKeyBytes,
  }

  return new KeyPair(data)
}

export const _hashPrivateKey = (privateKey: Uint8Array): string => {
  return ethers.utils.keccak256(privateKey)
}

export const _generatePublicNonces = (privateKey: Buffer): {
  privateNonceData: Pick<InternalNoncePairs, 'k' | 'kTwo'>,
  publicNonceData: InternalPublicNonces,
  hash: string,
} => {
  const hash = _hashPrivateKey(privateKey)
  const nonce = _generateNonce()

  return {
    hash,
    privateNonceData: {
      k: nonce.k,
      kTwo: nonce.kTwo,
    },
    publicNonceData: {
      kPublic: nonce.kPublic,
      kTwoPublic: nonce.kTwoPublic,
    }
  }
}

export const _multiSigSign = (nonces: InternalNonces, combinedPublicKey: Uint8Array, privateKey: Uint8Array, msg: string, publicKeys: Uint8Array[], publicNonces: InternalPublicNonces[], hashFn: Function|null = null): InternalSignature => {
  const hashMsg = hashFn ? hashFn : _hashMessage
  const hash = hashMsg(msg)
  return internalMultiSigSign(nonces, combinedPublicKey, privateKey, hash, publicKeys, publicNonces)
}

export const _multiSigSignHash = (nonces: InternalNonces, combinedPublicKey: Uint8Array, privateKey: Uint8Array, hash: string, publicKeys: Uint8Array[], publicNonces: InternalPublicNonces[]): InternalSignature => {
  return internalMultiSigSign(nonces, combinedPublicKey, privateKey, hash, publicKeys, publicNonces)
}

export const _sumSigs = (signatures: Uint8Array[]): Buffer => {
  let combined = bigi.fromBuffer(signatures[0])
  signatures.shift()
  signatures.forEach(sig => {
    combined = combined.add(bigi.fromBuffer(sig))
  })
  return combined.mod(n).toBuffer(32)
}

export const _hashMessage = (message: string): string => {
  return ethers.utils.solidityKeccak256(['string'], [message])
}

export const _verify = (s: Uint8Array, msg: string, R: Uint8Array, publicKey: Uint8Array, hashFn: Function|null = null): boolean => {
  const hashMsg = hashFn ? hashFn : _hashMessage
  const hash = hashMsg(msg)
  return internalVerify(s, hash, R, publicKey)
}

export const _verifyHash = (s: Uint8Array, hash: string, R: Uint8Array, publicKey: Uint8Array): boolean  => {
  return internalVerify(s, hash, R, publicKey)
}

export const _generatePk = (combinedPublicKey: Uint8Array): string => {
  const px = ethers.utils.hexlify(combinedPublicKey.slice(1,33))
  return '0x' + px.slice(px.length - 40, px.length)
}

export const _sign = (privateKey: Uint8Array, msg: string, hashFn: Function|null = null): InternalSignature  => {
  const hashMsg = hashFn ? hashFn : _hashMessage
  const hash = hashMsg(msg)
  return internalSign(privateKey, hash)
}

export const _signHash = (privateKey: Uint8Array, hash: string): InternalSignature  => {
  return internalSign(privateKey, hash)
}