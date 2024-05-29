//import token from '../.github-app-token.json';
const axios = require('axios');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const path = require('path');
const {
    promises: { resolve }
} = require('dns');

const ONE_MINUTE = 60;

// Assigned by GitHub
const GITHUB_APP_ID = '395709';

// > your JWT must be signed using the RS256 algorithm.
//
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
const ALGORITHM = 'RS256';

// > Note: [The `workflow_dispatch event] will only trigger a workflow run if
// > the workflow file is on the default branch.
//
// https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#workflow_dispatch
const WORKFLOW_REPO = 'bocoup/aria-at-gh-actions-helper';

// Generated from the GitHub.com UI
let privateKey = null;
let callbackUrlHostname = null;

exports.setup = async () => {
    privateKey = fs.readFileSync(
        path.join(__dirname, '../../jwt-signing-key.pem')
    );
    // strip possible https:// at start and trailing /
    callbackUrlHostname = process.env.AUTOMATION_CALLBACK_FQDN?.replace(
        /(^[^:]+:\/\/|\/$)/g,
        ''
    );
    if (!callbackUrlHostname) {
        throw new Error(
            'Environment AUTOMATION_CALLBACK_FQDN must be set to a valid hostname for the public address.'
        );
    }
    try {
        const results = await resolve(callbackUrlHostname);
        if (results.length < 1) {
            throw new Error('no results');
        }
    } catch (error) {
        throw new Error(
            `Error while resolving AUTOMATION_CALLBACK_FQDN ${callbackUrlHostname} ${error}`
        );
    }
};

exports.isEnabled = () => privateKey && callbackUrlHostname;
// > 2. Get the ID of the installation that you want to authenticate as.
// >
// >   If you are responding to a webhook event, the webhook payload will
// >   include the installation ID.
// >
// >   You can also use the REST API to find the ID for an installation of your
// >   app. For example, you can get an installation ID with the `GET
// >   /users/{username}/installation`, `GET
// >   /repos/{owner}/{repo}/installation`, `GET /orgs/{org}/installation`, or
// >   `GET /app/installations endpoints`. For more information, see
// >   "[GitHub Apps](https://docs.github.com/en/rest/apps/apps)".
//
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
const GITHUB_APP_INSTALLATION_ID = '42217598';

// > The time that the JWT was created. To protect against clock drift, we
// > recommend that you set this 60 seconds in the past and ensure that your
// > server's date and time is set accurately (for example, by using the Network
// > Time Protocol).
//
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
const calculateIssuedAt = () => Math.round(Date.now() / 1000) - ONE_MINUTE;

const createJWT = (payload, privateKey, algorithm) => {
    return new Promise((resolve, reject) => {
        jwt.sign(payload, privateKey, { algorithm }, (err, token) => {
            token ? resolve(token) : reject(err);
        });
    });
};

// > The expiration time of the JWT, after which it can't be used to request an
// > installation token. The time must be no more than 10 minutes into the
// > future.
//
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
const calculateExpiresAt = () => Math.round(Date.now() / 1000) + 9 * ONE_MINUTE;

const fetchInstallationAccessToken = async (jsonWebToken, installationID) => {
    const response = await axios({
        method: 'POST',
        url: `https://api.github.com/app/installations/${installationID}/access_tokens`,
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${jsonWebToken}`,
            'X-GitHub-Api-Version': '2022-11-28'
        },
        transformResponse: [],
        validateStatus: () => true,
        responseType: 'text'
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error(
            response.data ?? 'Unable to retrieve installation access token'
        );
    }
    return JSON.parse(response.data).token;
};

const createGithubWorkflow = async ({ job, directory, gitSha }) => {
    const payload = {
        iat: calculateIssuedAt(),
        exp: calculateExpiresAt(),
        iss: GITHUB_APP_ID
    };
    const jsonWebToken = await createJWT(payload, privateKey, ALGORITHM);
    const accessToken = await fetchInstallationAccessToken(
        jsonWebToken,
        GITHUB_APP_INSTALLATION_ID
    );

    const atKey = job.testPlanRun.testPlanReport.at.key;
    const workflowFilename = {
        nvda: 'nvda-test.yml',
        voiceover_macos: 'voiceover-test.yml'
    }[atKey];

    if (!workflowFilename) {
        throw new Error(`Unsupported AT workflow for ${atKey}`);
    }

    const browser = job.testPlanRun.testPlanReport.browser.name.toLowerCase();
    const inputs = {
        callback_url: `https://${callbackUrlHostname}/api/jobs/${job.id}/test/:testRowNumber`,
        status_url: `https://${callbackUrlHostname}/api/jobs/${job.id}`,
        callback_header: `x-automation-secret:${job.secret}`,
        work_dir: `tests/${directory}`,
        aria_at_ref: gitSha
    };
    if (atKey === 'nvda') {
        inputs.test_pattern = '{reference/**,test-*-nvda.*}';
        inputs.browser = browser;
    }
    const axiosConfig = {
        method: 'POST',
        url: `https://api.github.com/repos/${WORKFLOW_REPO}/actions/workflows/${workflowFilename}/dispatches`,

        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${accessToken}`,
            'X-GitHub-Api-Version': '2022-11-28'
        },
        data: JSON.stringify({
            ref: 'main',
            inputs
        }),
        validateStatus: () => true,
        responseType: 'text'
    };
    const response = await axios(axiosConfig);
    if (response.status < 200 || response.status >= 300) {
        throw new Error(
            response.data
                ? JSON.stringify(response.data)
                : 'Unable to initiate workflow'
        );
    }

    return true;
};

exports.default = createGithubWorkflow;
