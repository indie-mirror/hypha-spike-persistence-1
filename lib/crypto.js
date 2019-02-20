// General crytographic primitives used by Hypha.
//
// (WIP Refactor; pull-out.)

const sodium = require('sodium-universal')

module.exports = {
  // Encrypts the passed message (string or object, if it’s an object, it is JSON.stringified)
  // using the passed secret key (buffer or hex string) using Sodium secretbox_easy function
  // and returns an object with the nonce used and the ciphertext.
  encrypt: (message, secretKey) => {

    // If the message was passed as not a string, serialise it as JSON.
    if (typeof message !== 'string') {
      message = JSON.stringify(message)
    }

    // If the secret key was passed as a hex string, convert it to a Buffer.
    if (typeof secretKey === 'string') {
      secretKey = Buffer.from(secretKey, 'hex')
    }

    message = Buffer.from(message, 'utf-8')

    const ciphertext = Buffer.alloc(message.length + sodium.crypto_secretbox_MACBYTES)
    const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES)

    sodium.randombytes_buf(nonce)
    sodium.crypto_secretbox_easy(ciphertext, message, nonce, secretKey)

    return {
      nonce,
      ciphertext
    }
  },


  // Returns the plaintext (string with UTF 8 encoding) given a ciphertext, secret key, and nonce.
  decrypt: (ciphertext, secretKey, nonce) => {
    // Sanity check nonce length.
    if (nonce.length !== sodium.crypto_secretbox_NONCEBYTES) {
      throw new Error('Incorrect nonce length.')
    }

    // If the secret key was passed as a hex string, convert it to a Buffer.
    if (typeof secretKey === 'string') {
      secretKey = Buffer.from(secretKey, 'hex')
    }

    // Decrypt the message using the secret key.
    const plaintext = Buffer.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)
    sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, secretKey)

    // We only ever use utf-8. The resulting may be serialised (e.g., JSON) depending
    // on use case but we do not handle that here.
    const plaintextInUtf8 = plaintext.toString('utf-8')

    return plaintextInUtf8
  }
}
