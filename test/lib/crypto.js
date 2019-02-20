const tape = require('tape')

const crypto = require('../../lib/crypto.js')

tape ('plaintext matches message', t => {

  const secretKey = '2b32b9c560b52392a1b59bdc218234a2ff66c6d3f460bb5004aac00f251e9222'

  const message = 'Hello, world!'
  const { nonce, ciphertext } = crypto.encrypt(message, secretKey)
  const plaintext = crypto.decrypt(ciphertext, secretKey, nonce)

  t.same(plaintext, message)
  t.end()
})
