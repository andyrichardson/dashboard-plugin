'use strict';

const _ = require('lodash');
const chalk = require('chalk');
const accountUtils = require('@serverless/utils/account');
const configUtils = require('@serverless/utils/config');
const { ServerlessSDK } = require('@serverless/platform-client');
const writeOrgAndApp = require('./write-org-and-app');
const { getPlatformClientWithAccessKey, getOrCreateAccessKeyForOrg } = require('../../clientUtils');
const { StepHistory } = require('@serverless/utils/telemetry');

const isValidAppName = RegExp.prototype.test.bind(/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/);

const orgUpdateConfirm = async (inquirer, stepHistory) => {
  process.stdout.write(
    "Service has monitoring setup, but provided configuration doesn't seem to correspond" +
      " to account you're logged in with.\n\n"
  );
  const shouldUpdateOrg = (
    await inquirer.prompt({
      message: 'Would you like to update it?',
      type: 'confirm',
      name: 'shouldUpdateOrg',
    })
  ).shouldUpdateOrg;
  stepHistory.set('shouldUpdateOrg', shouldUpdateOrg);
  return shouldUpdateOrg;
};
const appUpdateConfirm = async (inquirer, appName, orgName, stepHistory) => {
  process.stdout.write(
    "Service seems to have monitoring enabled, but configured app doesn't seem to exist in an organization.\n\n"
  );

  const appUpdateType = (
    await inquirer.prompt({
      message: 'What would you like to do?',
      type: 'list',
      name: 'appUpdateType',
      choices: [
        { name: `Create '${appName}' app in '${orgName}' org`, value: 'create' },
        {
          name: 'Switch to one of the existing apps (or create new one with different name)',
          value: 'chooseExisting',
        },
        { name: "Skip, I'll sort this out manually", value: 'skip' },
      ],
    })
  ).appUpdateType;
  stepHistory.set('appUpdateType', appUpdateType);
  return appUpdateType;
};

const orgsChoice = async (inquirer, orgNames, stepHistory) => {
  const orgName = (
    await inquirer.prompt({
      message: 'What org do you want to add this to?',
      type: 'list',
      name: 'orgName',
      choices: [...orgNames, { name: '[Skip]', value: '_skip_' }],
    })
  ).orgName;
  stepHistory.set('orgName', orgName.startsWith('_') ? orgName : '_user_provided_');
  return orgName;
};

const appNameChoice = async (inquirer, appNames, stepHistory) => {
  const appName = (
    await inquirer.prompt({
      message: 'What application do you want to add this to?',
      type: 'list',
      name: 'appName',
      choices: Array.from(appNames).concat({ name: '[create a new app]', value: '_create_' }),
    })
  ).appName;
  stepHistory.set('appName', appName.startsWith('_') ? appName : '_user_provided_');
  return appName;
};

const appNameInput = async (inquirer, appNames, stepHistory) => {
  const appName = (
    await inquirer.prompt({
      message: 'What do you want to name this application?',
      type: 'input',
      name: 'newAppName',
      validate: (input) => {
        input = input.trim();
        if (!isValidAppName(input)) {
          return (
            'App name is not valid.\n' +
            '   - It should only contain lowercase alphanumeric and hyphens.\n' +
            '   - It should start and end with an alphanumeric character.\n' +
            "   - Shouldn't exceed 128 characters"
          );
        }
        if (appNames.includes(input)) return 'App of this name already exists';
        return true;
      },
    })
  ).newAppName.trim();
  stepHistory.set('newAppName', '_user_provided_');
  return appName;
};

const steps = {
  resolveOrgNames: async (user) => {
    if (process.env.SERVERLESS_ACCESS_KEY) {
      const sdk = new ServerlessSDK({ accessKey: process.env.SERVERLESS_ACCESS_KEY });
      const { orgName } = await sdk.accessKeys.get();
      return new Set([orgName]);
    }

    let orgs = new Set();
    if (!user.idToken) {
      // User registered over CLI hence idToken is not stored.
      // Still to resolve organizations from platform idToken is needed.
      // Handling it gently by assuming that orgs listed in config file
      // make a valid representation
      for (const org of Object.keys(user.accessKeys)) orgs.add(org);
    } else {
      const sdk = new ServerlessSDK();
      await accountUtils.refreshToken(sdk);
      user = configUtils.getLoggedInUser();
      sdk.config({ accessKey: user.idToken });
      orgs = new Set(
        (await sdk.organizations.list({ username: user.username })).map((org) => org.tenantName)
      );
    }
    return orgs;
  },
  setOrgAndApp: async (
    context,
    {
      orgNames,
      orgName,
      apps,
      appName,
      newAppName,
      isDashboardMonitoringOverridenByCli,
      isDashboardAppPreconfigured,
    }
  ) => {
    const { inquirer, history, stepHistory } = context;
    if (!orgName) {
      orgName = await (async () => {
        // We only want to automatically select the single available org in situations where user explicitly
        // logged in/registered during the process and created new service, for existing services we want to always ask
        // that question. It will also be always asked if `SERVERLESS_ACCESS_KEY` was provided
        if (
          orgNames.size === 1 &&
          history &&
          history.has('dashboardLogin') &&
          history.has('service')
        ) {
          return orgNames.values().next().value;
        }
        return orgsChoice(inquirer, orgNames, stepHistory);
      })();
    }

    if (orgName === '_skip_') {
      return;
    }

    const sdk = await getPlatformClientWithAccessKey(orgName);
    if (!newAppName && !appName) {
      if (!apps) apps = await sdk.apps.list({ orgName });

      const appNames = apps.map((app) => app.appName);

      if (!apps.length) {
        newAppName = context.configuration.service;
      } else {
        appName = await appNameChoice(inquirer, appNames, stepHistory);
        if (appName === '_create_') {
          newAppName = await appNameInput(inquirer, appNames, stepHistory);
        }
      }
    }
    if (newAppName) {
      ({ appName } = await sdk.apps.create({ orgName, app: { name: newAppName } }));
    }
    if (isDashboardMonitoringOverridenByCli && isDashboardAppPreconfigured) {
      const { shouldOverrideDashboardConfig } = await inquirer.prompt({
        message:
          'Are you sure you want to update monitoring settings ' +
          `to ${chalk.bold(`app: ${appName}, org: ${orgName}`)}`,
        type: 'confirm',
        name: 'shouldOverrideDashboardConfig',
      });
      stepHistory.set('shouldOverrideDashboardConfig', shouldOverrideDashboardConfig);
      if (!shouldOverrideDashboardConfig) {
        delete context.configuration.app;
        delete context.configuration.org;
        return;
      }
    }
    process.stdout.write(
      `\n${chalk.green('Your project has been setup with org: ')}${chalk.white.bold(
        orgName
      )}${chalk.green(' and app: ')}${chalk.white.bold(appName)}\n`
    );
    await writeOrgAndApp(orgName, appName, context);
    return;
  },
};

module.exports = {
  async isApplicable(context) {
    const { configuration, options } = context;
    if (
      _.get(configuration, 'provider') !== 'aws' &&
      _.get(configuration, 'provider.name') !== 'aws'
    ) {
      context.inapplicabilityReasonCode = 'NON_AWS_PROVIDER';
      return false;
    }
    const sdk = new ServerlessSDK();
    const { supportedRegions, supportedRuntimes } = await sdk.metadata.get();
    if (!supportedRuntimes.includes(_.get(configuration.provider, 'runtime') || 'nodejs12.x')) {
      context.inapplicabilityReasonCode = 'UNSUPPORTED_RUNTIME';
      return false;
    }
    if (
      !supportedRegions.includes(options.region || configuration.provider.region || 'us-east-1')
    ) {
      context.inapplicabilityReasonCode = 'UNSUPPORTED_REGION';
      return false;
    }
    const usesServerlessAccessKey = Boolean(process.env.SERVERLESS_ACCESS_KEY);

    let user = configUtils.getLoggedInUser();
    if (!user && !usesServerlessAccessKey) {
      context.inapplicabilityReasonCode = 'NOT_LOGGED_IN';
      return false;
    }

    const orgNames = await steps.resolveOrgNames(user);
    if (!orgNames.size) {
      context.inapplicabilityReasonCode = 'NO_ORGS_AVAILABLE';
      return false;
    }
    if (!usesServerlessAccessKey) {
      user = configUtils.getLoggedInUser(); // Refreshed, as new token might have been generated
    }

    const orgName = options.org || configuration.org;
    const appName = options.app || configuration.app;

    const isDashboardMonitoringPreconfigured = Boolean(configuration.org);
    const isDashboardAppPreconfigured = Boolean(configuration.app);
    const isDashboardMonitoringOverridenByCli =
      isDashboardMonitoringPreconfigured &&
      ((options.org && options.org !== configuration.org) ||
        (options.app && options.app !== configuration.app));
    if (orgName && orgNames.has(orgName)) {
      if (!isValidAppName(appName)) {
        return {
          user,
          orgName,
          isDashboardMonitoringPreconfigured,
          isDashboardAppPreconfigured,
          isDashboardMonitoringOverridenByCli,
        };
      }

      const accessKey = await getOrCreateAccessKeyForOrg(orgName);
      sdk.config({ accessKey });
      const apps = await sdk.apps.list({ orgName });

      if (options.org || options.app) {
        if (apps.some((app) => app.appName === appName)) {
          if (
            isDashboardMonitoringPreconfigured &&
            isDashboardAppPreconfigured &&
            !isDashboardMonitoringOverridenByCli
          ) {
            context.inapplicabilityReasonCode = 'MONITORING_NOT_OVERRIDEN_BY_CLI';
            return false;
          }
          return {
            user,
            orgName,
            appName,
            isDashboardMonitoringPreconfigured,
            isDashboardAppPreconfigured,
            isDashboardMonitoringOverridenByCli,
          };
        }
        if (options.app) {
          process.stdout.write(
            chalk.red(
              "\nPassed value for `--app` doesn't seem to correspond to chosen organization.\n"
            )
          );
        }
        return {
          user,
          orgName,
          isDashboardMonitoringPreconfigured,
          isDashboardAppPreconfigured,
          isDashboardMonitoringOverridenByCli,
        };
      } else if (apps.some((app) => app.appName === appName)) {
        context.inapplicabilityReasonCode = 'HAS_MONITORING_SETUP';
        return false;
      }
      return {
        user,
        orgName,
        apps,
        newAppName: appName,
        isDashboardMonitoringPreconfigured,
        isDashboardAppPreconfigured,
        isDashboardMonitoringOverridenByCli,
      };
    } else if (orgName) {
      if (options.org) {
        process.stdout.write(
          chalk.red(
            "\nPassed value for `--org` doesn't seem to correspond to account with which you're logged in with.\n"
          )
        );
      } else {
        process.stdout.write(
          chalk.red(`\nConfigured org '${orgName}' is not available in your account.\n`)
        );
      }
    }
    return {
      user,
      orgNames,
      isDashboardMonitoringPreconfigured,
      isDashboardAppPreconfigured,
      isDashboardMonitoringOverridenByCli,
    };
  },
  async run(context, stepData) {
    // TODO: Remove check for `StepHistory` after releasing new major version
    if (!_.get(context.stepHistory, 'set')) context.stepHistory = new StepHistory();
    const { inquirer, configuration, options, stepHistory } = context;
    if (!stepData.orgName) delete configuration.org;
    if (!stepData.appName && !stepData.newAppName) delete configuration.app;
    if (!options.org && !options.app) {
      if (stepData.isDashboardMonitoringPreconfigured) {
        if (!stepData.orgName) {
          if (!(await orgUpdateConfirm(inquirer, stepHistory))) return;
        } else if (stepData.newAppName) {
          const appUpdateTypeChoice = await appUpdateConfirm(
            inquirer,
            stepData.newAppName,
            stepData.orgName,
            stepHistory
          );
          switch (appUpdateTypeChoice) {
            case 'create':
              break;
            case 'chooseExisting':
              delete stepData.newAppName;
              break;
            case 'skip':
              return;
            default:
              throw new Error('Unexpected app update type');
          }
        }
      }
    }
    await steps.setOrgAndApp(context, stepData);
  },
  steps,
  configuredQuestions: [
    'orgName',
    'appName',
    'newAppName',
    'shouldUpdateOrg',
    'appUpdateType',
    'shouldOverrideDashboardConfig',
  ],
};
