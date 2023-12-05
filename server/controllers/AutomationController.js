const axios = require('axios');
const {
    getCollectionJobById,
    updateCollectionJob
} = require('../models/services/CollectionJobService');
const {
    findOrCreateTestResult
} = require('../models/services/TestResultWriteService');
const convertTestResultToInput = require('../resolvers/TestPlanRunOperations/convertTestResultToInput');
const saveTestResultCommon = require('../resolvers/TestResultOperations/saveTestResultCommon');
const {
    getAts,
    findOrCreateAtVersion
} = require('../models/services/AtService');
const {
    getBrowsers,
    findOrCreateBrowserVersion
} = require('../models/services/BrowserService');
const { HttpQueryError } = require('apollo-server-core');
const { COLLECTION_JOB_STATUS } = require('../util/enums');
const populateData = require('../services/PopulatedData/populateData');
const {
    getFinalizedTestResults
} = require('../models/services/TestResultReadService');
const http = require('http');
const runnableTestsResolver = require('../resolvers/TestPlanReport/runnableTestsResolver');
const httpAgent = new http.Agent({ family: 4 });

const axiosConfig = {
    headers: {
        'x-automation-secret': process.env.AUTOMATION_SCHEDULER_SECRET
    },
    timeout: 1000,
    httpAgent
};

const throwNoJobFoundError = jobId => {
    throw new HttpQueryError(
        404,
        `Could not find job with jobId: ${jobId}`,
        true
    );
};

const throwNoTestFoundError = (testCsvRow, total) => {
    throw new HttpQueryError(
        404,
        `Could not find test at CSV row number ${testCsvRow} (${total} rows available)`,
        true
    );
};

const throwSchedulerError = schedulerResponse => {
    throw new HttpQueryError(
        502,
        `Response scheduler did not give a correct response: ${schedulerResponse}`,
        false
    );
};

const cancelJob = async (req, res) => {
    const automationSchedulerResponse = await axios.post(
        `${process.env.AUTOMATION_SCHEDULER_URL}/jobs/${req.params.jobID}/cancel`,
        {},
        axiosConfig
    );

    if (!automationSchedulerResponse.data) {
        throwSchedulerError(automationSchedulerResponse);
    }

    if (
        automationSchedulerResponse.data.status ===
        COLLECTION_JOB_STATUS.CANCELLED
    ) {
        const graphqlRes = await updateCollectionJob(req.params.jobID, {
            status: COLLECTION_JOB_STATUS.CANCELLED
        });
        if (!graphqlRes) {
            throwNoJobFoundError(req.params.jobID);
        }
    }
    res.json(automationSchedulerResponse.data);
};

const updateJobStatus = async (req, res) => {
    const { status, externalLogsUrl } = req.body;

    if (!Object.values(COLLECTION_JOB_STATUS).includes(status)) {
        throw new HttpQueryError(400, `Invalid status: ${status}`, true);
    }

    const updatePayload = {
        status,
        ...(externalLogsUrl != null && { externalLogsUrl })
    };

    const graphqlResponse = await updateCollectionJob(
        req.params.jobID,
        updatePayload
    );

    if (!graphqlResponse) {
        throwNoJobFoundError(req.params.jobID);
    }

    res.json(graphqlResponse);
};

const getApprovedFinalizedTestResults = async testPlanRun => {
    const {
        testPlanReport: { testPlanVersion }
    } = testPlanRun;

    // To be considered "Approved", a test plan run must be associated with a test plan report
    // that is associated with a test plan version that is in "CANDIDATE" or "RECOMMENDED" or
    // "DRAFT" phase and the test plan report been marked as final.
    const { phase } = testPlanVersion;

    if (
        phase === 'RD' ||
        (phase === 'DRAFT' && testPlanRun.testPlanReport.markedFinalAt === null)
    ) {
        return null;
    }

    const { testPlanReport } = await populateData({
        testPlanReportId: testPlanRun.testPlanReport.id
    });

    return await getFinalizedTestResults({
        ...testPlanReport
    });
};

const updateOrCreateTestResultWithResponses = async ({
    testCsvRow,
    testPlanRun,
    responses,
    atVersionId,
    browserVersionId
}) => {
    const runnableTests = await runnableTestsResolver(
        testPlanRun.testPlanReport
    );
    const testId = runnableTests[testCsvRow]?.id;

    if (testId === undefined) {
        throwNoTestFoundError(testCsvRow, runnableTests.length);
    }

    const { testResult } = await findOrCreateTestResult({
        testId,
        testPlanRunId: testPlanRun.id,
        atVersionId,
        browserVersionId
    });

    const historicalTestResults = await getApprovedFinalizedTestResults(
        testPlanRun
    );

    const historicalTestResult = historicalTestResults?.find(each => {
        return each.testId === testId;
    });

    if (
        historicalTestResult &&
        historicalTestResult.scenarioResults?.length !==
            testResult.scenarioResults.length
    ) {
        throw new Error(
            'Historical test result does not match current test result'
        );
    }

    const getAutomatedResultFromOutput = ({ baseTestResult, outputs }) => ({
        ...baseTestResult,
        atVersionId,
        browserVersionId,
        scenarioResults: baseTestResult.scenarioResults.map(
            (scenarioResult, i) => {
                // Check if output matches historical output
                const outputMatches =
                    historicalTestResult &&
                    historicalTestResult.scenarioResults[i] &&
                    historicalTestResult.scenarioResults[i].output ===
                        outputs[i];

                return {
                    ...scenarioResult,
                    output: outputs[i],
                    assertionResults: scenarioResult.assertionResults.map(
                        (assertionResult, j) => ({
                            ...assertionResult,
                            passed: outputMatches
                                ? historicalTestResult.scenarioResults[i]
                                      .assertionResults[j].passed
                                : false,
                            failedReason: outputMatches
                                ? historicalTestResult.scenarioResults[i]
                                      .assertionResults[j].failedReason
                                : 'AUTOMATED_OUTPUT'
                        })
                    ),
                    unexpectedBehaviors: []
                };
            }
        )
    });

    return saveTestResultCommon({
        testResultId: testResult.id,
        input: convertTestResultToInput(
            getAutomatedResultFromOutput({
                baseTestResult: testResult,
                outputs: responses
            })
        ),
        isSubmit: false
    });
};

const updateJobResults = async (req, res) => {
    const id = req.params.jobID;
    const { testId, testCsvRow, responses, atVersionName, browserVersionName } =
        req.body;
    const job = await getCollectionJobById(id);
    if (!job) {
        throwNoJobFoundError(id);
    }

    if (job.status !== COLLECTION_JOB_STATUS.RUNNING) {
        throw new Error(
            `Job with id ${id} is not running, cannot update results`
        );
    }

    /* TODO: Change this once we support more At + Browser Combos in Automation */
    const [at] = await getAts(null, { name: 'NVDA' });
    const [browser] = await getBrowsers(null, { name: 'Chrome' });

    const [atVersion, browserVersion] = await Promise.all([
        findOrCreateAtVersion({
            atId: at.id,
            name: atVersionName
        }),
        findOrCreateBrowserVersion({
            browserId: browser.id,
            name: browserVersionName
        })
    ]);

    await updateOrCreateTestResultWithResponses({
        testId,
        testCsvRow,
        responses,
        testPlanRun: job.testPlanRun,
        atVersionId: atVersion.id,
        browserVersionId: browserVersion.id
    });

    res.json({ success: true });
};

module.exports = {
    cancelJob,
    updateJobStatus,
    updateJobResults,
    axiosConfig
};
