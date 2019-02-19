////////////////////////////////////////////////////////////////////////////////
//
// Hypha: always-on relay node (unprivileged).
//
// This node exists to provide findability and reliability. It does not
// know the owner’s passphrase or any of the secret keys derived from it.
// It also acts as a dumb relay between browser nodes and native nodes.
// (It communicates with browser nodes via WebSocket and with native nodes
// via TCP.)
//
// Copyright © 2019 Aral Balkan.
// Released under AGPLv3 or later.
//
////////////////////////////////////////////////////////////////////////////////

const fs = require('fs')
const https = require('https')
const { pipeline } = require('stream')

const express = require('express')
const expressWebSocket = require('express-ws')
const websocketStream = require('websocket-stream/stream')
const hyperdb = require('hyperdb')
const hyperswarm = require('@hyperswarm/network')

const signalHubServer = require('signalhub/server')

const budo = require('budo')
const babelify = require('babelify')

const { SecureEphemeralMessagingChannel } = require('@hypha/secure-ephemeral-messaging-channel')

const os = require('os')
const path = require('path')

const defaultSettings = {
  readKey: ''
}

let settings = {}

const dataDirectory = path.join(os.homedir(), '.hypha')
const settingsFilePath = path.join(dataDirectory, 'settings.json')

// Ensure data directory exists and that a settings file does too.
if (!fs.existsSync(dataDirectory)) {
  fs.mkdirSync(dataDirectory)
}

if (!fs.existsSync(settingsFilePath)) {
  console.log('Settings file does not exist, creating…')
  fs.writeFileSync(settingsFilePath, JSON.stringify(defaultSettings), 'utf-8')
  settings = defaultSettings
} else {
  console.log('Settings file exists, loading…')
  settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf-8'))
}

console.log('Settings loaded', settings)

console.log('Data directory', dataDirectory)

function persistSettings() {
  fs.writeFileSync(settingsFilePath, JSON.stringify(settings), 'utf-8')
}

const router = express.Router()

const hyperdbs = {}

// Note: the always-on node is an unprivileged node. It will only relay
// ===== the secure messages to other nodes (to other web nodes via WebSocket
//       and to other native nodes via TCP). It cannot decrypt the messages
//       itself. This is by design as the always-on nodes are designed to be
//       hosted by untrusted third parties.
const secureEphemeralMessagingChannel = new SecureEphemeralMessagingChannel()

// Create secure signalhub server.
const signalHub = signalHubServer({
  key: fs.readFileSync('always-on/localhost-key.pem'),
  cert: fs.readFileSync('always-on/localhost.pem')
})

signalHub.on('subscribe', channel => {
  console.log('[Signal Hub] Subscribe: ', channel)
})

signalHub.on('broadcast', (channel, message) => {
  console.log('[Signal Hub] Broadcast: ', channel, message.length)
})

signalHub.listen(444, 'localhost', () => {
  console.log(`[Signal Hub] Listening on port ${signalHub.address().port}.`)
})

// Create secure development web server via budo.
const server = budo('browser/index.js', {
  live: false,
  port: 443,
  ssl: true,
  dir: 'browser/static/',              // Static content directory
  key: 'always-on/localhost-key.pem',
  cert: 'always-on/localhost.pem',
  serve: 'bundle.js',
  stream: process.stdout,             // Log to console
  browserify: {
    transform: babelify
  },
  middleware: [
    function (request, response, next) {
      try {
        //
        // HTTPS routes.
        //

        // DAT DNS (see https://www.datprotocol.com/deps/0005-dns/)
        if (request.url === '/.well-known/dat') {
          response.setHeader('Content-Type', 'text/plain')
          response.end(settings.readKey)
          return
        }

        // Continue down the middleware chain.
        next()

      } catch (error) {
        console.log('Middleware error', error)
      }
    },
    router,
  ]
})

//
// Replicate hyperdb with passed readKey over passed websocket.
//
function replicate(websocket, readKey) {
  console.log('About to replicate hyperdb with read key', readKey)

  if (hyperdbs[readKey] !== undefined) {
    console.log(`Hyperdb with read key ${readKey} already exists. About to replicate.`)

    const db = hyperdbs[readKey]

    // Replicate.
    // TODO: Refactor to remove redundancy.
    const remoteWebStream = websocketStream(webSocket)
    const localReplicationStream = db.replicate({
      encrypt: false,
      live: true,
      extensions: ['secure-ephemeral']
    })

    // console.log('remoteWebStream', remoteWebStream)
    // console.log('localReplicationStream', localReplicationStream)

    pipeline(
      remoteWebStream,
      localReplicationStream,
      remoteWebStream,
      (error) => {
        console.log(`[Non origin web socket] Pipe closed for ${readKey}`, error && error.message)
      }
    )

    return
  }

  // Create a new hyperdb with the passed read key and replicate.
  const db = hyperdb('unprivileged.db', readKey, {
    // createIfMissing: false,
    // overwrite: false,
    // valueEncoding: 'json'
  })

  // Add to list of existing hyperdbs.
  hyperdbs[readKey] = db

  // Add this database to the secure ephemeral messaging channel.
  // Note: this is an unprivileged node; it will act as a relay.
  // It does so automatically, there is no further action required.
  // None of the regular methods for privileged nodes are active on
  // it and it emits no events.
  secureEphemeralMessagingChannel.addDatabase(db)

  // For debugging. Listen for the relay event. This event will most
  // likely be removed later.
  secureEphemeralMessagingChannel.on ('relay', (decodedMessage) => {
    console.log('About to relay secure message', decodedMessage)
  })

  db.on('ready', () => {
    console.log(`Hyperdb ready (${readKey})`)

    const remoteWebStream = websocketStream(webSocket)

    const watcher = db.watch('/table', () => {
      db.get('/table', (error, values) => {
        // New data is available on the db. Log it to the console.
        const obj = values[0].value
        for (let [key, value] of Object.entries(obj)) {
          console.log(`[Replicate] ${key}: ${value}`)
        }
      })
    })

    //
    // Replicate :)
    //
    const localReplicationStream = db.replicate({
      encrypt: false,
      live: true,
      extensions: ['secure-ephemeral']
    })

    pipeline(
      remoteWebStream,
      localReplicationStream,
      remoteWebStream,
      (error) => {
        console.log(`[Origin] Pipe closed for ${readKey}`, error && error.message)
      }
    )

    //
    // Connect to the hyperswarm for this hyperdb.
    //
    const nativePeers = {}

    const swarm = hyperswarm()

    const discoveryKey = db.discoveryKey
    const discoveryKeyInHex = discoveryKey.toString('hex')

    console.log(`Joining hyperswarm for discovery key ${discoveryKeyInHex}`)

    // Join the swarm
    swarm.join(discoveryKey, {
      lookup: true, // find and connect to peers.
      announce: true // optional: announce self as a connection target.
    })

    swarm.on('connection', (remoteNativeStream, details) => {
      console.log(`Got peer for ${readKey} (discovery key: ${discoveryKeyInHex})`)

      console.log('About to replicate!')

      // Create a new replication stream
      const nativeReplicationStream = db.replicate({
        encrypt: false,
        live: true,
        extensions: ['secure-ephemeral']
      })

      // Replicate!
      pipeline(
        remoteNativeStream,
        nativeReplicationStream,
        remoteNativeStream,
        (error) => {
          console.log(`(Native stream from swarm) Pipe closed for ${readKey}`, error && error.message)
        }
      )
    })
  })
}


server.on('connect', (event) => {
  console.log('Setting up web socket server.')
  expressWebSocket(router, event.server, {
    perMessageDeflate: false
  })

  //
  // Web socket routes.
  //
  // /hypha               : replicate the main hyperdb (the index)
  // /sign-up             : create the main hyperdb (and replicate)
  // /replicate/<readKey> : general replication method (for any hyperdb)
  //

  // Create the main hyperdb.
  router.ws('/sign-up/:readKey', (websocket, request) => {
    // Ensure that the forever node has not been initialised.
    if (settings.readKey !== null) {
      websocket.send({error: 'Hypha already exists.'})
      websocket.close()
      return
    }

    const readKey = request.params.readKey
    replicate(websocket, readKey)

    //
    // Save the read key in settings.
    // TODO: Do this after actual confirmation of successful
    // ===== hyperdb setup.
    //
    settings.readKey = readKey
    persistSettings()
  })


  // Replicate the main hyperdb.
  router.ws('/hypha', (websocket, request) => {
    // Ensure that the forever node been initialised.
    if (settings.readKey === null) {
      websocket.send({error: 'Hypha does not exist.'})
      websocket.close()
      return
    }

    replicate(websocket, settings.readKey)
  })


  // Replicate the hyperdb with the passed readKey.
  // TODO: Is this necessary? What checks should be in place?
  router.ws('/replicate/:readKey', (webSocket, request) => {

    const readKey = request.params.readKey

    console.log('Got web socket request for ', readKey)

    replicate(websocket, readKey)
  })


  // Display connection info.
  const horizontalRule = new Array(60).fill('⎺').join('')
  console.log('\nHypha Spike: Persistence 1')
  console.log(horizontalRule)
  console.log(`Serving: ${event.uri}`)
  console.log(`Working directory: ${event.dir}`)
  console.log(`Entry: ${event.serve}`)
  console.log(horizontalRule)
})
