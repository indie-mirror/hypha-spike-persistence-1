////////////////////////////////////////////////////////////////////////////////
//
// Hypha browser node.
//
// Copyright © 2019 Aral Balkan.
// Released under AGPLv3 or later.
//
////////////////////////////////////////////////////////////////////////////////

// Initial key generation
const session25519 = require('session25519')
const generateEFFDicewarePassphrase = require('eff-diceware-passphrase')

// Database
const { Buffer } = require('buffer')
const randomAccessIndexedDB = require('random-access-idb')
let storage

const HypercoreProtocol = require('hypercore-protocol')
const hypercore = require('hypercore')
const hyperdb = require('hyperdb')

// Streams (equivalent of pipeline in Node).
const pump = require('pump')

// HTTPS calls
const requestPromise = require('request-promise-native')

// Web socket replication
const webSocketStream = require('websocket-stream')

// WebRTC replication
const signalhub = require('signalhub')
const { discoveryKey } = require('hypercore/lib/crypto')
const swarm = require('webrtc-swarm')

const nextId = require('monotonic-timestamp-base36')

const platform = require('platform')

const crypto = require('crypto')

const hyphaCrypto = require('../lib/crypto')
const utils = require('../lib/utils')

const { SecureEphemeralMessagingChannel } = require('@hypha/secure-ephemeral-messaging-channel')

// The secure ephemeral messaging channel will be initialised once the
// secret key used for symmetric encryption is derived (after the person
// has either signed up or signed in to their hypha.)
let secureEphemeralMessagingChannel

// App-specific
const { to_hex } = require('./lib/helpers')
const View = require('./view')

const model = require('./model')
const view = new View(model)

//
// App settings object, peristed using local storage.
//
// (For glossary of terms, please see http://localhost:1313/2019/02/18/hypha-glossary/)
//
// isInitialisedNode:       (bool) Is this an initialised node?
//  isAuthorisedNode:       (bool) Is this an authorised node?
//         hyphalink: (hex string) 32-byte global read key (the hyphalink for this domain)
//      localReadKey: (hex string) 32-byte local writer read key
//     localWriteKey: (hex string) 64-byte local writer write key*
//
// * Encrypted with the encryption key if the node is an authorised node (writer),
//   plaintext otherwise.
//
let settings = null

const defaultSettings = {
  isInitialisedNode: false,
  isAuthorisedNode: false,
  hyphalink: null,
  readKey: null,
  writeKey: null,
}

const sodium = require('sodium-universal')

const ephemeralMessageHashes = {}

// Initialise the local node. Either with a new or existing domain.
async function initialiseNode(passphrase = null) {

  view.showAccessProgress()

  if (passphrase === null) {
    await createDomain()
  } else {
    await joinExistingDomain(passphrase)
  }

  view.hideAccessProgress()
}


// Create a new domain and a local node for it.
async function createDomain() {
  console.log('Initialising new node with new domain')

  const domain = view.domain

  try {
    model.keys = await generateKeys(model.passphrase, domain)
  } catch (error) {
    console.log('Error: could not generate keys', error)
    view.hideAccessProgress()
    throw(error)
  }

  // Create the secure ephemeral messaging channel
  console.log('About to create secure ephemeral messaging channel with secret key', model.keys.secureEphemeralMessagingChannelSecretKey.toString('hex'))
  secureEphemeralMessagingChannel = new SecureEphemeralMessagingChannel(model.keys.secureEphemeralMessagingChannelSecretKey)

  // This is the origin node; pass in the write key also.
  createDatabase(model.keys.nodeReadKey, model.keys.nodeWriteKey)

  view.showDetails()
}


// Create a local database and authorise it with the primary
// database for an existing domain.
async function joinExistingDomain(passphrase) {
  //
  // A passphrase has been passed. Replicate an existing domain’s database.
  //
  console.log('Initialising new node with existing domain')

  const domain = view.domain
  const nodeName = view.nodeName

  try {
    const originalKeys = await generateKeys(passphrase, domain)

    console.log('Original keys', originalKeys)

    console.log (`Sign into domain ${domain} with global read key ${originalKeys.nodeReadKeyInHex} and global write key ${originalKeys.nodeWriteKeyInHex}`)

    // Pass in global read key to create a local database based on the origin node.
    originalKeys.nodeWriteKey = null
    originalKeys.nodeWriteKeyInHex = null
    model.keys = originalKeys

    // Create the secure ephemeral messaging channel
    secureEphemeralMessagingChannel = new SecureEphemeralMessagingChannel(model.keys.secureEphemeralMessagingChannelSecretKey)

    console.log(`About to create database with read key: ${originalKeys.nodeReadKeyInHex}`)
    createDatabase(originalKeys.nodeReadKey)
    view.showDetails()

  } catch (error) {
    console.log('Error: could not generate keys at sign in', error)
    view.hideAccessProgress()
    throw(error)
  }
}


// Returns a promise that resolves to a passphrase.
function generatePassphrase () {
  return new Promise (resolve => {
    // On next tick, so the interface has a chance to update.
    setTimeout(() => {
      const passphrase = generateEFFDicewarePassphrase.entropy(100).join (' ')
      resolve(passphrase)
    }, 0)
  })
}


// Returns a promise that generates Ed25519 signing keys and
// Curve25519 encryption keys by deriving them from the passed
// passphrase and using the domain as the salt. Also creates the
// secret symmetric encryption key for the ephemeral messaging
// channel.
function generateKeys(passphrase, domain) {
  return new Promise((resolve, reject) => {

    session25519(domain, passphrase, (error, keys) => {

      if (error) {
        view.logError(error.message)
        reject(error)
      }

      //
      // Convert the keys first to ArrayBuffer and then to
      // Node’s implementation of Buffer, which is what
      // hypercore expected.
      //
      // If you try to pass an ArrayBuffer instead, you get
      // the following error:
      //
      // Error: key must be at least 16, was given undefined
      //
      const nodeReadKey = Buffer.from(keys.publicSignKey.buffer)
      const nodeDiscoveryKey = discoveryKey(nodeReadKey)
      const nodeDiscoveryKeyInHex = nodeDiscoveryKey.toString('hex')

      // TODO: Iterate on terminology. This routine is now used to
      // generate keys for the origin node as well as writer nodes.
      const nodeKeys = {
        nodeReadKey,
        nodeDiscoveryKey,
        nodeDiscoveryKeyInHex,
        nodeReadKeyInHex: to_hex(keys.publicSignKey),
        nodeWriteKeyInHex: to_hex(keys.secretSignKey),
        nodeWriteKey: Buffer.from(keys.secretSignKey.buffer),
        publicEncryptionKeyInHex: to_hex(keys.publicKey),
        privateEncryptionKeyInHex: to_hex(keys.secretKey)
      }

      // Derive the key that we will use to encrypt the ephemeral
      // messaging channel from the secretSignKey (node write key).
      const context = Buffer.from('ephemera')
      // Note: sodium_malloc and memory locking are not supported in the browser.
      const secureEphemeralMessagingChannelSecretKey = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES)
      sodium.crypto_kdf_derive_from_key(secureEphemeralMessagingChannelSecretKey, 1, context, nodeKeys.nodeWriteKey)

      nodeKeys.secureEphemeralMessagingChannelSecretKey = secureEphemeralMessagingChannelSecretKey
      nodeKeys.secureEphemeralMessagingChannelSecretKeyInHex = secureEphemeralMessagingChannelSecretKey.toString('hex')

      // TODO: Create a separate key for encrypting the settings.
      // (We may end up using a single key for these but let’s keep them separate for now.)
      const localStorageContext = Buffer.from('localStorage')
      const localStorageSecretKey = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES)
      sodium.crypto_kdf_derive_from_key(localStorageSecretKey, 1, localStorageContext, nodeKeys.nodeWriteKey)

      nodeKeys.localStorageSecretKey = localStorageSecretKey
      nodeKeys.localStorageSecretKeyInHex = localStorageSecretKey.toString('hex')

      resolve(nodeKeys)
    })
  })
}


function addRowToDatabase() {
  const key = nextId()
  const value = `(${model.localCounter}) ${model.nodeName}`
  let obj = {}
  obj[key] = value
  model.db.put('/table', obj, (error, o) => {
    console.log('Put callback')
    if (error) {
      view.logError(error)
      return
    }
    model.localCounter++
    console.log('  Feed', o.feed)
    console.log('  Sequence:', o.seq)
    console.log('  Key:', o.key)
    console.log('  Value:', o.value)
  })
}

function createMessageHash(message) {
  return crypto.createHash('sha256').update(JSON.stringify(message)).digest('hex')
}

function loadSettings () {
  let _settings = window.localStorage.settings
  console.log(_settings)
  if (_settings !== undefined) {
    _settings = utils.jsonParseWithBufferSupport(_settings)
  } else {
    console.log('Settings is undefined, using default settings.')
    _settings = defaultSettings
    persistSettings(_settings)
  }
  settings = _settings
  console.log('Loaded local settings', settings)
}

function persistSettings (_settings) {
  if (_settings === undefined) { _settings = settings }
  console.log('Persisting local settings', _settings)
  window.localStorage.settings = JSON.stringify(_settings)
}

function updateSetting (key, value) {
  console.log(`Updating setting: ${key} = ${value}`)
  settings[key] = value
  persistSettings(settings)
}


// Returns the global read key for this domain or returns null if one does not exist.
// (One not existing means that the always-on node for this domain has not been set up yet.)
async function getReadKeyFromDatDNS() {
  console.log('getReadKeyFromDatDNS()')
  let response = await requestPromise('https://localhost:443/.well-known/dat')
  if (response === '') {
    console.log('No DAT DNS entry. Forever node has not been initialised yet.')
    response = null
  }
  return response
}


function getReadKeyFromLocalStorage() {
  console.log(`settings.readKey ${settings.readKey}`)
  return settings.readKey === undefined ? null : Buffer.from(settings.readKey)
}


async function changePassphrase () {
  model.passphrase = await generatePassphrase()
  view.showPassphrase()
}

// Decide whether to show the Sign Up or Sign In screens and whether to create a new database or use the existing one.
async function setInitialState () {

  view.viewState = view.viewStates.loading

  loadSettings()

  if (settings.isInitialisedNode) {
    if (settings.isAuthorisedNode) {
      // This is an authorised node. We need the passphrase in order to set up the node.
      // Using the passphrase, we will calculate the encryption key with which we will
      // decrypt the local writer’s write key which we get from local storage.
      // TODO
      console.log('This is an authorised node. Going to prompt for passphrase and set up the hyperdb. TODO.')
    } else {
      // This is an initialised node but it has not been authorised yet.
      // Create the local database using the local read key and (unencrypted) local write key.
      // TODO
      console.log('This is an initialised node. About to load it using the local writer read and write keys.')
      createDatabase(settings.readKey, null, settings.localReadKey, settings.localWriteKey)
    }
  } else {
    // This node has not been initialised. Check if the hypha has
    // by attempting to read the global read key via Dat DNS
    // from the domain of this hypha.
    console.log('Node not initialised.')
    const readKeyFromDatDNS = await getReadKeyFromDatDNS()

    if (readKeyFromDatDNS !== null) {
      // We got the read key from Dat DNS, go ahead and create the database.
      console.log('Got read key from Dat DNS. Creating local database…')
      // TODO
    } else {
      // Global read key does not exist so the owner of this Hypha has not
      // signed up yet. Show the sign up interface.
      console.log('Could not get read key from Dat DNS. Showing sign-up interface.')
      view.viewState = view.viewStates.gettingStarted
      await changePassphrase()
    }
  }

  // const readKeyFromLocalStorage = getReadKeyFromLocalStorage()
  // if (readKeyFromLocalStorage !== null) {
  //   // Local read key exists, create the local database using it.
  //   console.log('Local read key from local storage exists. About to create database.')
  //   console.log('readKeyFromLocalStorage', readKeyFromLocalStorage)

  //   view.viewState = view.viewStates.signedOut
  //   createDatabase(readKeyFromLocalStorage)
  //   showDetails()
  // } else {
  //   // Local database does not exist. Check if the owner of this Hypha has signed up yet
  //   // by attempting to get the read key from a Dat DNS lookup.
  //   const readKeyFromDatDNS = await getReadKeyFromDatDNS()
  //   if (readKeyFromDatDNS !== null) {
  //     // We got the read key from Dat DNS, go ahead and create the database.
  //     console.log('Got read key from Dat DNS. Creating local database…')
  //     // TODO
  //   } else {
  //     // Global read key does not exist so the owner of this Hypha has not
  //     // signed up yet. Show the sign up interface.
  //     console.log('Could not get read key from Dat DNS. Showing sign-up interface.')
  //     view.viewState = view.viewStates.gettingStarted
  //     await changePassphrase()
  //   }
  // }
}


// TODO: Make this accept the global read key, global secret key, and local read key, and local write key as parameters.
// ===== If the global secret key is not passed in and the local read and write keys are, then we create a writer based
//       on an existing database (using its global read key).
//
// TODO: Update hyperDB so that we can pass in the local key and local secret key to the local writer.
// ===== Matthias suggested we do this using a factory function passed into the constructor.
function createDatabase(readKey, writeKey = null, localReadKey = null, localWriteKey = null) {
  let db = null
  let stream = null
  let updateInterval = null

  console.log(`Creating new hyperdb with read key ${to_hex(readKey)} and write key ${to_hex(writeKey)}`, readKey)
  console.log(`This node ${(writeKey === null) ? 'is not': 'is'} an origin node.`)

  // Note: I cannot find a way to catch the

  const databaseName = model.domain

  storage = randomAccessIndexedDB(databaseName)

  // I can find no way to catch the Error: another hypercore is stored here error from hypercore
  // so let’s watch out for IndexedDB timing issues leading to corrupted installations. Given that
  // we have no reliable way of checking if an IndexedDB database already exists (!!!), we are
  // going to rely on our own flag, stored in localStorage. I don’t completely understand when exactly
  // an indexedDB database is created and we don’t have a callback for that in hyperdb (is it synchronous,
  // right after the following db = hyperdb(…) line or at on('ready') or sometime in between the two?) so
  // this may or may not be an issue.
  //
  // I opened an issue for the error at https://github.com/mafintosh/hyperdb/issues/164

  const databaseOptions = {
    createIfMissing: false,
    overwrite: false,
    valueEncoding: 'json',
    secretKey: writeKey,
    storeSecretKey: false
    // Note: do not define onWrite(). Leads to errors.
  }

  // If we are recreating a database on an initialised node,
  // supply the local keys so we can reproduce the writer.
  if (localReadKey !== null && localWriteKey !== null) {
    databaseOptions.localKey = localReadKey
    databaseOptions.localSecretKey = localWriteKey
  }

  // Create a new hypercore using the newly-generated key material.
  db = hyperdb((filename) => storage(filename), readKey, )

  db.on('error', error => {
    console.log('Database error', error)
  })

  // Watch the database for ephemeral messages.
  secureEphemeralMessagingChannel.addDatabase(db)

  secureEphemeralMessagingChannel.on('message', (database, peer, message) => {
    console.log('*** Ephemeral message received. ***')
    console.log(`Peer.feed.key ${peer.feed.key.toString('hex')}, peer.feed.id ${peer.feed.id.toString('hex')} has sent a mesage on database with key and id ${database.key.toString('hex')} ${database.id.toString('hex')}`, message)

    const request = message

    const messageHash = createMessageHash(message)

    console.log('request', request)
    console.log('messageHash', messageHash)

    console.log('ephemeralMessageHashes[messageHash]', ephemeralMessageHashes[messageHash])

    if (ephemeralMessageHashes[messageHash] !== undefined) {
      console.log('Message already seen, ignoring.')
      return
    }

    // Push the message hash into the list of seen messages in case we get it again
    // due to redundant channels of communication.
    ephemeralMessageHashes[messageHash] = true

    // Note (todo): also, we should probably not broadcast this to all nodes but only to known writers.

    // Any authorised node (initially just the origin node but then any other node that was
    // authorised by the origin node) can authorise other nodes.
    if (request.action === 'authorise') {

      console.log('Checking self authorisation state.')
      db.authorized(db.local.key, (error, isAuthorised) => {
        if (error) {
          console.log('Error while checking for authorisation state of the local writer on the global database. Ignoring request.')
          return
        }

        if (isAuthorised === true) {
          model.lastRequest = request
          view.showAuthorisationRequest(request.nodeName)
        } else {
          console.log('Not a writeable node, ignoring authorise request.')
        }
      })
    } else {
      console.log('Unknown request.')
    }
  })


  secureEphemeralMessagingChannel.on('received-bad-message', (error, database, peer) => {
    console.log('!!! Emphemeral message: received bad message !!!', error, database, peer)
  })


  db.on('ready', () => {
    const dbKey = db.key
    const dbKeyInHex = to_hex(dbKey)

    console.log(`db: [Ready] ${dbKeyInHex}`)

    // Save the read key in local storage
    updateSetting('readKey', dbKeyInHex)

    // TODO: It looks like we will need reproducible local writers after all: how else
    // ===== can we recreate a local database on reload?

    // Also note whether this is the origin node or not
    if (writeKey !== null) {
      updateSetting('isOriginNode', true)
    }

    // Add the database to the model.
    model.db = db

    // Update the model with the actual key material from the database.
    model.keys.nodeReadKey = db.key
    model.keys.nodeReadKeyInHex = to_hex(db.key)
    model.keys.localReadKeyInHex = db.local.key.toString('hex')
    model.keys.localWriteKeyInHex = db.local.secretKey.toString('hex')


    console.log('Local ready key', localReadKey)
    console.log('Local write key', localWriteKey)

    if (localReadKey === null || localWriteKey === null) {
      updateSetting('localReadKey', model.keys.localReadKeyInHex)
      updateSetting('localWriteKeyEncrypted', hyphaCrypto.encrypt(model.keys.localWriteKeyInHex, model.keys.localStorageSecretKey))
    }

    if (settings.isInitialisedNode === false) {
      settings.isInitialisedNode = true
    }

    persistSettings()

    view.showDatabaseIsReady()

    // Display the local key for the local writer.
    console.log(db.local)

    const watcher = db.watch('/table', () => {
      console.log('Database updated!')
      db.get('/table', (error, values) => {
        console.log(values)

        view.blinkSignal('change')
        console.log('db [change: get]', values)

        // New data is available on the db. Display it on the view.
        const obj = values[0].value
        for (let [key, value] of Object.entries(obj)) {
          view.addContent(`${key}: ${value}\n`)
        }
      })
    })


    // Hypercore db is ready: connect to web socket and start replicating.
    const remoteStream = webSocketStream(`wss://localhost/replicate/${dbKeyInHex}`)

    console.log('remoteStream', remoteStream)

    const localStream = db.replicate({
      // If we remove the encrypt: false, we get an error on the server:
      // Pipe closed for c4a99bc919c23d9c12b1fe440a41488141263e59fb98288388b578e105ad2523 Remote message is larger than 8MB (max allowed)
      // Why is this and what’s the encryption that we’re turning off here and what effects does this have on privacy and security? (TODO: investigate and file issue if necessary.)
      encrypt: false,
      live: true,
      extensions: ['secure-ephemeral']
    })

    console.log('localStream', localStream)

    // Create a duplex stream.
    //
    // What’s actually happening:
    //
    // remoteStream.write -> localStream.read
    // localStream.write -> remoteStream.read
    pump(
      remoteStream,
      localStream,
      remoteStream,
      (error) => {
        console.log(`[WebSocket] Pipe closed for ${dbKeyInHex}`, error && error.message)
        view.logError(error.message)
      }
    )

    // Also join a WebRTC swarm so that we can peer-to-peer replicate
    // this hypercore (browser to browser).
    const webSwarm = swarm(signalhub(model.keys.nodeDiscoveryKeyInHex, ['https://localhost:444']))
    webSwarm.on('peer', function (remoteWebStream) {

      console.log(`WebSwarm [peer for ${model.keys.nodeReadKeyInHex} (discovery key: ${model.keys.nodeDiscoveryKeyInHex})] About to replicate.`)

      // Create the local replication stream.
      const localReplicationStream = db.replicate({
        live: true,
        extensions: ['secure-ephemeral']
      })

      console.log('[[[ About to start replicating over webrtc. localReplicationStream.id = ]]]', localReplicationStream.id.toString('hex'))

      // Start replicating.
      pump(
        remoteWebStream,
        localReplicationStream,
        remoteWebStream,
        (error) => {
          console.log(`[WebRTC] Pipe closed for ${model.keys.nodeReadKeyInHex}`, error && error.message)
        }
      )
    })

    //
    // TEST
    //
    const NUMBER_TO_APPEND = 3

    const intervalToUpdateInMS = 500
    let counter = 0
    updateInterval = setInterval(() => {
      counter++
      if (counter === NUMBER_TO_APPEND) {
        console.log(`Reached max number of items to append (${NUMBER_TO_APPEND}). Will not add any more.`)
        clearInterval(updateInterval)
        updateInterval = null
      }

      addRowToDatabase()

    }, intervalToUpdateInMS)
  })

  db.on('error', (error) => {
    console.log(`db [Error] ${error}`)
    view.blinkSignal('error')
    view.logError(error)
  })

  db.on('download', (index, data) => {
    view.blinkSignal('download')
    console.log(`db [Download] index = ${index}, data = ${data}`)
  })

  db.on('upload', (index, data) => {
    view.blinkSignal('upload')
    console.log(`db [Upload] index = ${index}, data = ${data}`)
  })

  db.on('append', () => {
    view.blinkSignal('append')
    console.log('db [Append]')
  })

  db.on('sync', () => {
    view.blinkSignal('sync')
    console.log('db [Sync]')
  })

  db.on('close', () => {
    view.blinkSignal('close')
    console.log('db [Close]')
  })

}


// Main

view.on('ready', () => {
  // Generate the initial node name as <platform> on <os>
  model.nodeName = `${platform.name} on ${platform.os}`
  view.nodeName = model.nodeName
  model.domain = document.location.hostname
  view.domain = model.domain

  setInitialState()
})

view.on('changePassphrase', changePassphrase)

view.on('signUp', () => {
  initialiseNode()
})

view.on('signIn', (passphrase) => {
  initialiseNode(passphrase)
})

// TODO: move to authorisation handler
view.on('authorise', () => {
  console.log(`Authorising request for ${model.lastRequest.nodeName} (local read key: ${model.lastRequest.readKey})`)

  const otherNodeReadKey = Buffer.from(model.lastRequest.readKey, 'hex')

  model.db.authorize(otherNodeReadKey, (error, authorisation) => {
    if (error) throw error

    console.log(authorisation)
  })
})

view.on('requestAuthorisation', () => {
  console.log('Requesting authorisation…')

  const message = {
    nodeName: model.nodeName,
    timestamp: new Date(),
    action: 'authorise',
    readKey: model.db.local.key.toString('hex'),
  }

  const messageHash = createMessageHash(message)
  secureEphemeralMessagingChannel.broadcast(model.db, message)
  ephemeralMessageHashes[messageHash] = true

  console.log(`Broadcast message with hash ${messageHash}`)
})

view.on('write', () => {
  addRowToDatabase()
})
