const tape = require('tape')

const utils = require('../../lib/utils')

tape ('buffer with JSON should parse', t => {
  const obj = {
    buffer: Buffer.from('Hello, world!')
  }
  const str = JSON.stringify(obj)
  const parsedObj = utils.jsonParseWithBufferSupport(str)
  t.same(obj.buffer, parsedObj.buffer)
  t.end()
})
