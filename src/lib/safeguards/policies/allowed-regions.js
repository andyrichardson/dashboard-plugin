'use strict';

module.exports = function allowedRegionsPolicy(policy, service, options) {
  const region = service.provider.getRegion()
  if (!options.includes(region)) {
    policy.fail(`Region "${region}" not in list of permitted regions: ${JSON.stringify(options)}`)
  } else {
    policy.approve()
  }
}

module.exports.docs = 'https://git.io/fjfI3'
