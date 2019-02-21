// General utilities

module.exports = {

  // Takes a serialised JSON object and parses it with Buffer support.
  jsonParseWithBufferSupport: str => {
    // We use a reviver function so that any buffers that might have been included in the
    // JSON are correctly deserialised. (Courtesy: https://stackoverflow.com/a/34557997)
    return JSON.parse(str, (k, v) => {
      if (
        v !== null            &&
        typeof v === 'object' &&
        'type' in v           &&
        v.type === 'Buffer'   &&
        'data' in v           &&
        Array.isArray(v.data)) {
        return Buffer.from(v.data)
      }
      return v;
    })
  },

}
