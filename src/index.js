'use strict';

require('./runtime')
const { version } = require('@serverless/platform-sdk/package.json')

module.exports = require('./lib/plugin')

module.exports.sdkVersion = version
