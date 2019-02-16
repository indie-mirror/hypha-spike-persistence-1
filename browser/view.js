//
// View
//

const EventEmitter = require('events').EventEmitter
const ButtonWithProgressIndicator = require('./lib/button-with-progress-indicator')

// For client-side Diceware validation
// (when person is signing in and enters their password manually)
// Wrap it in starting and ending spaces as we search for word using
// indexOf surrounded by spaces: ' word '.
const effDicewareWords = ` ${require('eff-diceware-passphrase/wordlist.json').join(' ')} `


//
// HTML elements.
//

// Main views

const loadingView = document.getElementById('loadingView')
const gettingStartedView = document.getElementById('gettingStartedView')
const signedOutView = document.getElementById('signedOutView')
const singedInView = document.getElementById('signedInView')

// Developer console
const developerConsole = document.getElementById('developerConsole')

// Forms
const signUpForm = document.getElementById('signUpForm')

// ====
const setupForm = document.getElementById('setupForm')
const nodeNameTextField = document.getElementById('nodeName')
const changeButton = new ButtonWithProgressIndicator('changeButton')
const chooseButton = new ButtonWithProgressIndicator('chooseButton')
const authoriseButton = new ButtonWithProgressIndicator('authoriseButton')
const authorisationRequest = document.getElementById('authorisationRequest')
const authorisationRequestNodeName = document.getElementById('authorisationRequestNodeName')
const requestAuthorisationButton = new ButtonWithProgressIndicator('requestAuthorisationButton')

const passphraseTextField = document.getElementById('passphrase')
const indeterminateProgressIndicator = document.getElementById('indeterminateProgressIndicator')

const generatedTextField = document.getElementById('generated')
const dbContentsTextArea = document.getElementById('hypercoreContents')
const writeButton = new ButtonWithProgressIndicator('writeButton')
const errorsTextArea = document.getElementById('errors')
const publicSigningKeyTextField = document.getElementById('publicSigningKey')
const localReadKeyTextField = document.getElementById('localReadKey')
const localWriteKeyTextField = document.getElementById('localWriteKey')
const secureEphemeralMessagingChannelSecretKeyTextField = document.getElementById('secureEphemeralMessagingChannelSecretKey')
const privateSigningKeyTextArea = document.getElementById('privateSigningKey')
const publicEncryptionKeyTextField = document.getElementById('publicEncryptionKey')
const privateEncryptionKeyTextField = document.getElementById('privateEncryptionKey')

const signals = ['ready', 'change', 'error', 'append', 'download', 'upload', 'sync', 'close']


//
// viewModel
//

const views = {
  loading: loadingView,
  gettingStarted: gettingStartedView,
  signedIn: singedInView,
  signedOut: signedOutView
}

const viewModel = {
  currentState: null
}


class View extends EventEmitter {

  constructor (model) {
    super()

    this.model = model

    document.addEventListener('DOMContentLoaded', () => {
      this.resetForm()

      // this.validatePassphrase()

      passphraseTextField.addEventListener('keyup', this.validatePassphrase)

      // Change passphrase button
      changeButton.on('click', event => {
        this.emit('changePassphrase')
      })

      // Choose passphrase / sign-up button
      chooseButton.on('click', event => {
        this.emit('signUp')
        // } else {
        //   this.emit('signIn', passphraseTextField.value)
        // }
      })

      // Authorise button.
      authoriseButton.on('click', event => {
        this.emit('authorise')
      })

      // Request authorisation button.
      requestAuthorisationButton.on('click', event => {
        this.emit('requestAuthorisation')
      })

      // Write button.
      writeButton.on('click', event => {
        this.emit('write')
      })

      this.emit('ready')
    })
  }


  updateCurrentViewState() {
    console.log('Updating view state.')
    for (let viewState in this.viewStates) {
      views[viewState].hidden = !(viewState === viewModel.currentState)
    }
  }

  get viewStates () {
    return {
      loading: 'loading',
      gettingStarted: 'gettingStarted',
      signedIn: 'signedIn',
      signedOut: 'signedOut',
    }
  }

  set viewState (viewState) {
    console.log(`Setting view state to ${viewState}`)
    viewModel.currentState = viewState
    this.updateCurrentViewState()
  }


  get viewState () {
    return viewModel.currentState
  }


  set nodeName (name) {
    nodeNameTextField.value = name
  }


  get nodeName () {
    return setupForm.elements.nodeName.value
  }


  set domain(name) {
    setupForm.elements.domain.value = name
  }


  get domain () {
    return setupForm.elements.domain.value
  }


  validatePassphrase () {
    const passphrase = passphraseTextField.value
    viewModel.action = (passphrase === '') ? kSignUp : kSignIn
    chooseButton.label = viewModel.action

    if (viewModel.action === kSignIn) {
      // Validate that the passphrase exists solely of diceware words
      // and has at least eight words (as we know the password generation aims
      // for at least 100 bits of entropy. Seven words has ~90 bits.)
      const words = passphrase.trim().split(' ')
      const numWords = words.length
      const entropyIsHighEnough = numWords >= 8

      let allWordsInWordList = true
      for (let i = 0; i < numWords; i++) {
        const word = ` ${words[i]} `
        if (effDicewareWords.indexOf(word) === -1) {
          allWordsInWordList = false
          break
        }
      }

      // if (!entropyIsHighEnough) { console.log ('entropy is not high enough') }
      // if (!allWordsInWordList) { console.log ('Non-diceware words entered') }
      // if (entropyIsHighEnough && allWordsInWordList) { console.log ('Passphrase valid') }

      chooseButton.enabled = (entropyIsHighEnough && allWordsInWordList)
    } else {
      chooseButton.enabled = true
    }
  }

  addContent (content) {
    dbContentsTextArea.value += content
  }

  showPassphrase () {
    signUpForm.elements.passphrase.value = this.model.passphrase
  }

  showAccessProgress () {
    chooseButton.showProgress()
  }


  hideAccessProgress () {
    chooseButton.hideProgress()
  }


  showDatabaseIsReady () {
    this.displayKeys()
    this.blinkSignal('ready')
    generatedTextField.value = 'Yes'
  }


  setSignalVisible(signal, state) {
    const offState = document.querySelector(`#${signal}Signal > .off`)
    const onState = document.querySelector(`#${signal}Signal > .on`)

    if (state) {
      onState.classList.add('visible')
      offState.classList.add('invisible')
    } else {
      onState.classList.remove('visible')
      offState.classList.remove('invisible')
    }
  }


  resetSignals() {
    signals.forEach((signal) => {
      this.setSignalVisible(signal, false)
    })
  }


  blinkSignal(signal) {
    this.setSignalVisible(signal, true)

    // Keep the ready signal lit throughout. All others, blink.
    if (signal !== 'ready') {
      setTimeout(() => {
        this.setSignalVisible(signal, false)
      }, 333)
    }
  }


  resetForm() {
    authorisationRequest.hidden = true
    passphraseTextField.value = ''
    publicSigningKeyTextField.value = ''
    generatedTextField.value = 'No'
    this.resetSignals()
    dbContentsTextArea.value = ''
    errorsTextArea.value = ''
    privateSigningKeyTextArea.value = ''
    publicEncryptionKeyTextField.value = ''
    privateEncryptionKeyTextField.value = ''
  }


  logError(error) {
    errorsTextArea.value += error
  }

  showAuthorisationRequest (nodeName) {
    authorisationRequestNodeName.innerHTML = nodeName
    authorisationRequest.hidden = false
  }

  showDetails() {
    const detailSections = document.getElementsByClassName('details')
    for (var i = 0; detailSections[i]; i++) {
      detailSections[i].style.display = 'block'
    }

    chooseButton.visible = false

    this.displayKeys()
  }


  hideDetails() {
    const detailSections = document.getElementsByClassName('details')
    for (var i = 0; detailSections[i]; i++) {
      detailSections[i].style.display = 'none'
    }

    chooseButton.visible = true
  }


  displayKeys() {
    publicSigningKeyTextField.value = this.model.keys.nodeReadKeyInHex
    privateSigningKeyTextArea.value = this.model.keys.nodeWriteKeyInHex
    publicEncryptionKeyTextField.value = this.model.keys.publicEncryptionKeyInHex
    privateEncryptionKeyTextField.value = this.model.keys.privateEncryptionKeyInHex
    localReadKeyTextField.value = this.model.keys.localReadKeyInHex
    localWriteKeyTextField.value = this.model.keys.localWriteKeyInHex
    secureEphemeralMessagingChannelSecretKeyTextField.value = this.model.keys.secureEphemeralMessagingChannelSecretKeyInHex
  }


  clearOutputFields() {
    publicSigningKeyTextField.value = ''
    privateSigningKeyTextArea.value = ''
    publicEncryptionKeyTextField.value = ''
    privateEncryptionKeyTextField.value = ''
    localReadKeyTextField.value = ''
    localWriteKeyTextField.value = ''
  }
}

module.exports = View
