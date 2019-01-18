//
// Hypha: A native client for testing replication of a single hypercore.
//
const hypercore = require('hypercore')
const ram = require('random-access-memory')
const hyperswarm = require('@hyperswarm/network')
const { pipeline } = require('stream')

const { discoveryKey } = require('hypercore/lib/crypto')

const swarm = hyperswarm()

//////////////////////////////////////////////////////////////////////////////////////////
//
// Manually entered for now.
//
const readKeyInHex = '0b77c7fc5a7dd4be30bf8e7c02c2c1a87798f0218697ce07b2bce93a5da82ba4'
//
//////////////////////////////////////////////////////////////////////////////////////////

const readKeyBuffer = Buffer.from(readKeyInHex, 'hex')
const discoveryKeyBuffer = discoveryKey(readKeyBuffer)
const discoveryKeyInHex = discoveryKeyBuffer.toString('hex')

// Create the local hypercore instance

const localCore = hypercore((filename) => ram(filename), readKeyBuffer, {
  createIfMissing: false,
  overwrite: false,
  valueEncoding: 'json',
  onwrite: (index, data, peer, next) => {
    // console.log(`Feed: [onWrite] index = ${index}, peer = ${peer}, data:`)
    // console.log(data)
    next()
  }
})

const localReadStream = localCore.createReadStream({live: true})
localReadStream.on('data', (data) => {
  console.log('[Replicate]', data)
})

localCore.on('ready', () => {
  console.log('Local core ready.')

  // HACK: Just for now, make sure we only connect once
  let connected = false

  //
  // Join the swarm
  //
  swarm.join(discoveryKeyBuffer, {
    lookup: true, // find and connect to peers.
    announce: true // optional: announce self as a connection target.
  })

  swarm.on('connection', (remoteNativeStream, details) => {
    // HACK: only handle first connection
    if (connected) return
    connected = true

    console.log(`Joined swarm for read key ${readKeyInHex}, discovery key ${discoveryKeyInHex}`)

    // Replicate!
    console.log('About to replicate!')

    // Create the local replication stream.
    const localReplicationStream = localCore.replicate({
      // TODO: why is Jim’s shopping list example setting encrypt to false?
      // The encryption of __what__ does this affect?
      // (I haven’t even tested this yet with it set to true to limit the variables.)
      encrypt: false,
      live: true
    })

    pipeline(
      remoteNativeStream,
      localReplicationStream,
      remoteNativeStream,
      (error) => {
        console.log(`Pipe closed for ${readKeyInHex}`, error && error.message)
      }
    )
  })

})