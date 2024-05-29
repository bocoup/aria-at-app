const startSupertestServer = require('../util/api-server');
const automationRoutes = require('../../routes/automation');
const {
    setupMockAutomationSchedulerServer
} = require('../util/mock-automation-scheduler-server');
const db = require('../../models/index');
const { query, mutate } = require('../util/graphql-test-utilities');
const dbCleaner = require('../util/db-cleaner');
const { default: axios } = require('axios');
const {
    getCollectionJobById
} = require('../../models/services/CollectionJobService');
const markAsFinalResolver = require('../../resolvers/TestPlanReportOperations/markAsFinalResolver');
const AtLoader = require('../../models/loaders/AtLoader');
const BrowserLoader = require('../../models/loaders/BrowserLoader');
const getGraphQLContext = require('../../graphql-context');
const { COLLECTION_JOB_STATUS } = require('../../util/enums');

let mockAutomationSchedulerServer;
let apiServer;
let sessionAgent;

const testPlanReportId = '18';

beforeAll(async () => {
    apiServer = await startSupertestServer({
        pathToRoutes: [['/api/jobs', automationRoutes]]
    });
    sessionAgent = apiServer.sessionAgent;
    mockAutomationSchedulerServer = await setupMockAutomationSchedulerServer();
});

afterAll(async () => {
    await mockAutomationSchedulerServer.tearDown();
    await apiServer.tearDown();
    await db.sequelize.close();
});

const getTestPlanReport = async (id, { transaction }) =>
    await query(
        `
            query {
                testPlanReport(id: "${id}") {
                    id
                    markedFinalAt
                    at { name }
                    browser { name }
                    finalizedTestResults {
                        test {
                            id
                        }
                        atVersion {
                            name
                        }
                        browserVersion {
                            name
                        }
                        scenarioResults {
                            id
                            scenario {
                                id
                            }
                            output
                            assertionResults {
                                passed
                                failedReason
                            }
                            unexpectedBehaviors {
                                id
                                details
                            }
                        }
                    }
                }
            }
        `,
        { transaction }
    );

const getTestPlanRun = async (id, { transaction }) =>
    await query(
        `
            query {
                testPlanRun(id: "${id}") {
                    testResults {
                        id
                        test {
                            id
                        }
                        atVersion {
                            id
                            name
                        }
                        browserVersion {
                            id
                            name
                        }
                        scenarioResults {
                            id
                            scenario {
                                id
                            }
                            output
                            assertionResults {
                                passed
                                failedReason
                            }
                            unexpectedBehaviors {
                                id
                                details
                            }
                        }

                    }
                }
            }
        `,
        { transaction }
    );

const getTestCollectionJob = async (jobId, { transaction }) =>
    await query(
        `
            query {
                collectionJob(id: "${jobId}") {
                    id
                    status
                    externalLogsUrl
                    testPlanRun {
                        testPlanReport {
                            id
                            testPlanVersion {
                                id
                                phase
                            }
                        }
                        testResults {
                            id
                            scenarioResults {
                                output
                            }
                        }
                    }
                    testStatus {
                        test { id }
                        status
                    }
                }
            }
        `,
        { transaction }
    );

const scheduleCollectionJobByMutation = async ({ transaction }) =>
    await mutate(
        `
            mutation {
                scheduleCollectionJob(testPlanReportId: "${testPlanReportId}") {
                    id
                    status
                    testPlanRun {
                        testPlanReport {
                            id
                            testPlanVersion {
                                id
                                phase
                            }
                        }
                        testResults {
                            id
                            scenarioResults {
                                output
                            }
                        }
                    }
                    testStatus {
                        test { id }
                        status
                    }
                }
            }
        `,
        { transaction }
    );

const restartCollectionJobByMutation = async (jobId, { transaction }) =>
    await mutate(
        `
            mutation {
                restartCollectionJob(id: "${jobId}") {
                    id
                    status
                }
            }
        `,
        { transaction }
    );

const cancelCollectionJobByMutation = async (jobId, { transaction }) =>
    await mutate(
        `
            mutation {
                collectionJob(id: "${jobId}") {
                    cancelCollectionJob {
                        id
                        status
                    }
                }
            }
        `,
        { transaction }
    );

const deleteCollectionJobByMutation = async (jobId, { transaction }) =>
    await mutate(
        `
            mutation {
                deleteCollectionJob(id: "${jobId}")
            }
        `,
        { transaction }
    );

describe('Automation controller', () => {
    it('should schedule a new job', async () => {
        await dbCleaner(async transaction => {
            const job = await scheduleCollectionJobByMutation({ transaction });
            // get job from result of graphql mutation
            const { scheduleCollectionJob: storedJob } = job;
            expect(storedJob).not.toEqual(undefined);
            expect(storedJob.status).toEqual('QUEUED');
            expect(storedJob.testPlanRun.testPlanReport.id).toEqual(
                testPlanReportId
            );
            expect(storedJob.testPlanRun.testResults.length).toEqual(0);
        });
    });

    it('should schedule a new job and correctly construct test data for automation scheduler', async () => {
        await dbCleaner(async transaction => {
            const axiosPostMock = jest.spyOn(axios, 'post').mockResolvedValue({
                data: { id: '999', status: 'QUEUED' }
            });

            const {
                testPlanReport: {
                    runnableTests,
                    testPlanVersion: {
                        gitSha: testPlanVersionGitSha,
                        testPlan: { directory: testPlanName }
                    }
                }
            } = await query(
                `
                    query {
                        testPlanReport(id: "${testPlanReportId}") {
                            runnableTests {
                                id
                            }
                            testPlanVersion {
                                testPlan {
                                    directory
                                }
                                gitSha
                            }
                        }
                    }
                `,
                { transaction }
            );

            const testIds = runnableTests.map(({ id }) => id);

            const collectionJob = await scheduleCollectionJobByMutation({
                transaction
            });

            const expectedRequestBody = {
                testPlanVersionGitSha,
                testIds,
                testPlanName,
                jobId: parseInt(collectionJob.scheduleCollectionJob.id),
                transactionId: transaction.id
            };

            expect(axiosPostMock).toHaveBeenCalledWith(
                `${process.env.AUTOMATION_SCHEDULER_URL}/jobs/new`,
                expectedRequestBody,
                {
                    headers: {
                        'x-automation-secret':
                            process.env.AUTOMATION_SCHEDULER_SECRET
                    },
                    timeout: 1000
                }
            );

            axiosPostMock.mockRestore();
        });
    });

    it('should cancel a job and all remaining tests', async () => {
        await dbCleaner(async transaction => {
            const { scheduleCollectionJob: job } =
                await scheduleCollectionJobByMutation({ transaction });
            const {
                collectionJob: { cancelCollectionJob: cancelledCollectionJob }
            } = await cancelCollectionJobByMutation(job.id, { transaction });

            expect(cancelledCollectionJob.status).toEqual('CANCELLED');
            const { collectionJob: storedCollectionJob } =
                await getTestCollectionJob(job.id, { transaction });
            expect(storedCollectionJob.status).toEqual('CANCELLED');
            for (const test of storedCollectionJob.testStatus) {
                expect(test.status).toEqual('CANCELLED');
            }
        });
    });

    it('should gracefully reject request to cancel a job that does not exist', async () => {
        await dbCleaner(async transaction => {
            expect.assertions(1); // Make sure an assertion is made
            await expect(
                cancelCollectionJobByMutation(2, { transaction })
            ).rejects.toThrow('Could not find collection job with id 2');
        });
    });

    it('should restart a job', async () => {
        await dbCleaner(async transaction => {
            const { scheduleCollectionJob: job } =
                await scheduleCollectionJobByMutation({ transaction });
            const { restartCollectionJob: collectionJob } =
                await restartCollectionJobByMutation(job.id, { transaction });
            expect(collectionJob).not.toBe(undefined);
            expect(collectionJob).toEqual({
                id: job.id,
                status: 'QUEUED'
            });
            const { collectionJob: storedCollectionJob } =
                await getTestCollectionJob(job.id, { transaction });
            expect(storedCollectionJob.id).toEqual(job.id);
            expect(storedCollectionJob.status).toEqual('QUEUED');
        });
    });

    it('should gracefully reject restarting a job that does not exist', async () => {
        await dbCleaner(async transaction => {
            const { restartCollectionJob: res } =
                await restartCollectionJobByMutation(2, { transaction });
            expect(res).toEqual(null);
        });
    });

    it('should not update a job status without verification', async () => {
        await dbCleaner(async transaction => {
            const { scheduleCollectionJob: job } =
                await scheduleCollectionJobByMutation({ transaction });
            const response = await sessionAgent.post(`/api/jobs/${job.id}`);
            expect(response.statusCode).toBe(403);
            expect(response.body).toEqual({
                error: 'Unauthorized'
            });
        });
    });

    it('should fail to update a job status with invalid status', async () => {
        await dbCleaner(async transaction => {
            const { scheduleCollectionJob: job } =
                await scheduleCollectionJobByMutation({ transaction });
            const response = await sessionAgent
                .post(`/api/jobs/${job.id}`)
                .send({ status: 'INVALID' })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                );
            expect(response.statusCode).toBe(400);
            expect(response.body).toEqual({
                error: 'Invalid status: INVALID'
            });
        });
    });

    it('should fail to update a job status for a non-existent jobId', async () => {
        const response = await sessionAgent
            .post(`/api/jobs/${444}`)
            .send({ status: 'RUNNING' })
            .set(
                'x-automation-secret',
                process.env.AUTOMATION_SCHEDULER_SECRET
            );
        expect(response.statusCode).toBe(404);
        expect(response.body).toEqual({
            error: `Could not find job with jobId: ${444}`
        });
    });

    it('should update a job status with verification', async () => {
        await apiServer.sessionAgentDbCleaner(async transaction => {
            const { scheduleCollectionJob: job } =
                await scheduleCollectionJobByMutation({ transaction });
            const response = await sessionAgent
                .post(`/api/jobs/${job.id}`)
                .send({ status: 'RUNNING' })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);
            const { body } = response;
            expect(response.statusCode).toBe(200);
            expect(body.id).toEqual(parseInt(job.id));
            expect(body.status).toEqual('RUNNING');
            expect(body).toHaveProperty('testPlanRunId');
            expect(body.testPlanRun.testPlanReportId).toEqual(
                parseInt(testPlanReportId)
            );

            const { collectionJob: storedCollectionJob } =
                await getTestCollectionJob(job.id, { transaction });
            expect(storedCollectionJob.id).toEqual(job.id);
            expect(storedCollectionJob.status).toEqual('RUNNING');
            expect(storedCollectionJob.externalLogsUrl).toEqual(null);
            expect(storedCollectionJob.testPlanRun.testPlanReport.id).toEqual(
                testPlanReportId
            );
        });
    });

    it('should update a job externalLogsUrl with verification', async () => {
        await apiServer.sessionAgentDbCleaner(async transaction => {
            const { scheduleCollectionJob: job } =
                await scheduleCollectionJobByMutation({ transaction });
            const response = await sessionAgent
                .post(`/api/jobs/${job.id}`)
                .send({
                    status: 'CANCELLED',
                    externalLogsUrl: 'https://www.aol.com/'
                })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);
            const { body } = response;
            expect(response.statusCode).toBe(200);
            expect(body.id).toEqual(parseInt(job.id));
            expect(body.status).toEqual('CANCELLED');
            expect(body).toHaveProperty('testPlanRunId');
            expect(body.testPlanRun.testPlanReportId).toEqual(
                parseInt(testPlanReportId)
            );

            const { collectionJob: storedCollectionJob } =
                await getTestCollectionJob(job.id, { transaction });
            expect(storedCollectionJob.id).toEqual(job.id);
            expect(storedCollectionJob.status).toEqual('CANCELLED');
            expect(storedCollectionJob.externalLogsUrl).toEqual(
                'https://www.aol.com/'
            );
            expect(storedCollectionJob.testPlanRun.testPlanReport.id).toEqual(
                testPlanReportId
            );
        });
    });

    it('should update job results', async () => {
        await apiServer.sessionAgentDbCleaner(async transaction => {
            const { scheduleCollectionJob: job } =
                await scheduleCollectionJobByMutation({ transaction });
            const collectionJob = await getCollectionJobById({
                id: job.id,
                transaction
            });
            await sessionAgent
                .post(`/api/jobs/${job.id}`)
                .send({ status: 'RUNNING' })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);
            const automatedTestResponse = 'AUTOMATED TEST RESPONSE';
            const ats = await AtLoader().getAll({ transaction });
            const browsers = await BrowserLoader().getAll({ transaction });
            const at = ats.find(
                at => at.id === collectionJob.testPlanRun.testPlanReport.at.id
            );
            const browser = browsers.find(
                browser =>
                    browser.id ===
                    collectionJob.testPlanRun.testPlanReport.browser.id
            );
            const { tests } =
                collectionJob.testPlanRun.testPlanReport.testPlanVersion;
            const testResultsNumber =
                collectionJob.testPlanRun.testResults.length;
            const selectedTestIndex = 0;

            const selectedTest = tests[selectedTestIndex];
            const selectedTestRowNumber = selectedTest.rowNumber;
            console.log(tests);
            console.log(tests.map(({ rowNumber }) => rowNumber));

            const numberOfScenarios = selectedTest.scenarios.filter(
                scenario => scenario.atId === at.id
            ).length;
            const response = await sessionAgent
                .post(`/api/jobs/${job.id}/test/${selectedTestRowNumber}`)
                .send({
                    capabilities: {
                        atName: at.name,
                        atVersion: at.atVersions[0].name,
                        browserName: browser.name,
                        browserVersion: browser.browserVersions[0].name
                    },
                    responses: new Array(numberOfScenarios).fill(
                        automatedTestResponse
                    )
                })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);
            expect(response.statusCode).toBe(200);
            const storedTestPlanRun = await getTestPlanRun(
                collectionJob.testPlanRun.id,
                { transaction }
            );
            const { testResults } = storedTestPlanRun.testPlanRun;
            expect(testResults.length).toEqual(testResultsNumber + 1);
            testResults.forEach(testResult => {
                expect(testResult.test.id).toEqual(selectedTest.id);
                expect(testResult.atVersion.name).toEqual(
                    at.atVersions[0].name
                );
                expect(testResult.browserVersion.name).toEqual(
                    browser.browserVersions[0].name
                );
                testResult.scenarioResults.forEach(scenarioResult => {
                    expect(scenarioResult.output).toEqual(
                        automatedTestResponse
                    );
                    scenarioResult.assertionResults.forEach(assertionResult => {
                        expect(assertionResult.passed).toEqual(false);
                        expect(assertionResult.failedReason).toEqual(
                            'AUTOMATED_OUTPUT'
                        );
                    });
                    scenarioResult.unexpectedBehaviors?.forEach(
                        unexpectedBehavior => {
                            expect(unexpectedBehavior.id).toEqual('OTHER');
                            expect(unexpectedBehavior.details).toEqual(null);
                        }
                    );
                });
            });
            // also marks status for test as COMPLETED
            const { collectionJob: storedCollectionJob } =
                await getTestCollectionJob(job.id, { transaction });
            expect(storedCollectionJob.id).toEqual(job.id);
            expect(storedCollectionJob.status).toEqual('RUNNING');
            const testStatus = storedCollectionJob.testStatus.find(
                status => status.test.id === selectedTest.id
            );
            expect(testStatus.status).toEqual(COLLECTION_JOB_STATUS.COMPLETED);
        });
    });

    it('should properly handle per-test status updates without capabilities present', async () => {
        await apiServer.sessionAgentDbCleaner(async transaction => {
            const { scheduleCollectionJob: job } =
                await scheduleCollectionJobByMutation({ transaction });
            const collectionJob = await getCollectionJobById({
                id: job.id,
                transaction
            });
            // flag overall job as RUNNING
            const externalLogsUrl = 'https://example.com/test/log/url';
            await sessionAgent
                .post(`/api/jobs/${job.id}`)
                .send({ status: 'RUNNING', externalLogsUrl })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);

            const { tests } =
                collectionJob.testPlanRun.testPlanReport.testPlanVersion;
            const selectedTestIndex = 0;
            const selectedTestRowNumber = 1;
            const selectedTest = tests[selectedTestIndex];
            let response = await sessionAgent
                .post(`/api/jobs/${job.id}/test/${selectedTestRowNumber}`)
                .send({
                    status: COLLECTION_JOB_STATUS.RUNNING
                })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);
            expect(response.statusCode).toBe(200);

            let { collectionJob: storedCollectionJob } =
                await getTestCollectionJob(job.id, { transaction });
            expect(storedCollectionJob.id).toEqual(job.id);
            expect(storedCollectionJob.status).toEqual('RUNNING');
            expect(storedCollectionJob.externalLogsUrl).toEqual(
                externalLogsUrl
            );
            let foundStatus = false;
            for (const testStatus of storedCollectionJob.testStatus) {
                let expectedStatus = COLLECTION_JOB_STATUS.QUEUED;
                if (testStatus.test.id === selectedTest.id) {
                    foundStatus = true;
                    expectedStatus = COLLECTION_JOB_STATUS.RUNNING;
                }
                expect(testStatus.status).toEqual(expectedStatus);
            }
            expect(foundStatus).toEqual(true);

            // check that putting this test into ERROR and sending an overall
            // collection job ERROR will properly update things
            response = await sessionAgent
                .post(`/api/jobs/${job.id}/test/${selectedTestRowNumber}`)
                .send({
                    status: COLLECTION_JOB_STATUS.ERROR
                })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);
            expect(response.statusCode).toBe(200);

            response = await sessionAgent
                .post(`/api/jobs/${job.id}`)
                .send({
                    // avoiding sending externalLogsUrl here to test that when
                    // missing it is not overwritten/emptied.
                    status: COLLECTION_JOB_STATUS.ERROR
                })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);
            expect(response.statusCode).toBe(200);

            storedCollectionJob = (
                await getTestCollectionJob(job.id, { transaction })
            ).collectionJob;
            expect(storedCollectionJob.id).toEqual(job.id);
            expect(storedCollectionJob.status).toEqual('ERROR');
            expect(storedCollectionJob.externalLogsUrl).toEqual(
                externalLogsUrl
            );
            foundStatus = false;
            for (const testStatus of storedCollectionJob.testStatus) {
                let expectedStatus = COLLECTION_JOB_STATUS.CANCELLED;
                if (testStatus.test.id === selectedTest.id) {
                    foundStatus = true;
                    expectedStatus = COLLECTION_JOB_STATUS.ERROR;
                }
                expect(testStatus.status).toEqual(expectedStatus);
            }
            expect(foundStatus).toEqual(true);
        });
    });

    it('should convert RUNNING test status to ERROR when job state becomes ERROR', async () => {
        await apiServer.sessionAgentDbCleaner(async transaction => {
            const { scheduleCollectionJob: job } =
                await scheduleCollectionJobByMutation({ transaction });
            const collectionJob = await getCollectionJobById({
                id: job.id,
                transaction
            });
            // flag overall job as RUNNING
            const externalLogsUrl = 'https://example.com/test/log/url';
            await sessionAgent
                .post(`/api/jobs/${job.id}`)
                .send({ status: 'RUNNING', externalLogsUrl })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);

            const { tests } =
                collectionJob.testPlanRun.testPlanReport.testPlanVersion;
            const selectedTestIndex = 0;
            const selectedTestRowNumber = 1;
            const selectedTest = tests[selectedTestIndex];
            let response = await sessionAgent
                .post(`/api/jobs/${job.id}/test/${selectedTestRowNumber}`)
                .send({
                    status: COLLECTION_JOB_STATUS.RUNNING
                })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);
            expect(response.statusCode).toBe(200);

            let { collectionJob: storedCollectionJob } =
                await getTestCollectionJob(job.id, { transaction });
            expect(storedCollectionJob.id).toEqual(job.id);
            expect(storedCollectionJob.status).toEqual('RUNNING');
            expect(storedCollectionJob.externalLogsUrl).toEqual(
                externalLogsUrl
            );
            let foundStatus = false;
            for (const testStatus of storedCollectionJob.testStatus) {
                let expectedStatus = COLLECTION_JOB_STATUS.QUEUED;
                if (testStatus.test.id === selectedTest.id) {
                    foundStatus = true;
                    expectedStatus = COLLECTION_JOB_STATUS.RUNNING;
                }
                expect(testStatus.status).toEqual(expectedStatus);
            }
            expect(foundStatus).toEqual(true);

            // Leave our test RUNNING but ERROR the job

            response = await sessionAgent
                .post(`/api/jobs/${job.id}`)
                .send({
                    // avoiding sending externalLogsUrl here to test that when
                    // missing it is not overwritten/emptied.
                    status: COLLECTION_JOB_STATUS.ERROR
                })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);
            expect(response.statusCode).toBe(200);

            storedCollectionJob = (
                await getTestCollectionJob(job.id, { transaction })
            ).collectionJob;
            expect(storedCollectionJob.id).toEqual(job.id);
            expect(storedCollectionJob.status).toEqual('ERROR');
            expect(storedCollectionJob.externalLogsUrl).toEqual(
                externalLogsUrl
            );
            foundStatus = false;
            for (const testStatus of storedCollectionJob.testStatus) {
                let expectedStatus = COLLECTION_JOB_STATUS.CANCELLED;
                if (testStatus.test.id === selectedTest.id) {
                    foundStatus = true;
                    expectedStatus = COLLECTION_JOB_STATUS.ERROR;
                }
                expect(testStatus.status).toEqual(expectedStatus);
            }
            expect(foundStatus).toEqual(true);
        });
    });

    it('should convert RUNNING test status to CANCELLED when job state becomes CANCELLED', async () => {
        await apiServer.sessionAgentDbCleaner(async transaction => {
            const { scheduleCollectionJob: job } =
                await scheduleCollectionJobByMutation({ transaction });
            const collectionJob = await getCollectionJobById({
                id: job.id,
                transaction
            });
            // flag overall job as RUNNING
            const externalLogsUrl = 'https://example.com/test/log/url';
            await sessionAgent
                .post(`/api/jobs/${job.id}`)
                .send({ status: 'RUNNING', externalLogsUrl })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);

            const { tests } =
                collectionJob.testPlanRun.testPlanReport.testPlanVersion;
            const selectedTestIndex = 0;
            const selectedTestRowNumber = 1;
            const selectedTest = tests[selectedTestIndex];
            let response = await sessionAgent
                .post(`/api/jobs/${job.id}/test/${selectedTestRowNumber}`)
                .send({
                    status: COLLECTION_JOB_STATUS.RUNNING
                })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);
            expect(response.statusCode).toBe(200);

            let { collectionJob: storedCollectionJob } =
                await getTestCollectionJob(job.id, { transaction });
            expect(storedCollectionJob.id).toEqual(job.id);
            expect(storedCollectionJob.status).toEqual('RUNNING');
            expect(storedCollectionJob.externalLogsUrl).toEqual(
                externalLogsUrl
            );
            let foundStatus = false;
            for (const testStatus of storedCollectionJob.testStatus) {
                let expectedStatus = COLLECTION_JOB_STATUS.QUEUED;
                if (testStatus.test.id === selectedTest.id) {
                    foundStatus = true;
                    expectedStatus = COLLECTION_JOB_STATUS.RUNNING;
                }
                expect(testStatus.status).toEqual(expectedStatus);
            }
            expect(foundStatus).toEqual(true);

            // Leave our test RUNNING but CANCELLED the job

            response = await sessionAgent
                .post(`/api/jobs/${job.id}`)
                .send({
                    // avoiding sending externalLogsUrl here to test that when
                    // missing it is not overwritten/emptied.
                    status: COLLECTION_JOB_STATUS.CANCELLED
                })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);
            expect(response.statusCode).toBe(200);

            storedCollectionJob = (
                await getTestCollectionJob(job.id, { transaction })
            ).collectionJob;
            expect(storedCollectionJob.id).toEqual(job.id);
            expect(storedCollectionJob.status).toEqual('CANCELLED');
            expect(storedCollectionJob.externalLogsUrl).toEqual(
                externalLogsUrl
            );
            for (const testStatus of storedCollectionJob.testStatus) {
                expect(testStatus.status).toEqual(
                    COLLECTION_JOB_STATUS.CANCELLED
                );
            }
        });
    });

    it('should convert RUNNING test status to CANCELLED when job state becomes COMPLETED', async () => {
        await apiServer.sessionAgentDbCleaner(async transaction => {
            const { scheduleCollectionJob: job } =
                await scheduleCollectionJobByMutation({ transaction });
            const collectionJob = await getCollectionJobById({
                id: job.id,
                transaction
            });
            // flag overall job as RUNNING
            const externalLogsUrl = 'https://example.com/test/log/url';
            await sessionAgent
                .post(`/api/jobs/${job.id}`)
                .send({ status: 'RUNNING', externalLogsUrl })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);

            const { tests } =
                collectionJob.testPlanRun.testPlanReport.testPlanVersion;
            const selectedTestIndex = 0;
            const selectedTestRowNumber = 1;
            const selectedTest = tests[selectedTestIndex];
            let response = await sessionAgent
                .post(`/api/jobs/${job.id}/test/${selectedTestRowNumber}`)
                .send({
                    status: COLLECTION_JOB_STATUS.RUNNING
                })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);
            expect(response.statusCode).toBe(200);

            let { collectionJob: storedCollectionJob } =
                await getTestCollectionJob(job.id, { transaction });
            expect(storedCollectionJob.id).toEqual(job.id);
            expect(storedCollectionJob.status).toEqual('RUNNING');
            expect(storedCollectionJob.externalLogsUrl).toEqual(
                externalLogsUrl
            );
            let foundStatus = false;
            for (const testStatus of storedCollectionJob.testStatus) {
                let expectedStatus = COLLECTION_JOB_STATUS.QUEUED;
                if (testStatus.test.id === selectedTest.id) {
                    foundStatus = true;
                    expectedStatus = COLLECTION_JOB_STATUS.RUNNING;
                }
                expect(testStatus.status).toEqual(expectedStatus);
            }
            expect(foundStatus).toEqual(true);

            // Leave our test RUNNING but COMPLETED the job

            response = await sessionAgent
                .post(`/api/jobs/${job.id}`)
                .send({
                    // avoiding sending externalLogsUrl here to test that when
                    // missing it is not overwritten/emptied.
                    status: COLLECTION_JOB_STATUS.COMPLETED
                })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);
            expect(response.statusCode).toBe(200);

            storedCollectionJob = (
                await getTestCollectionJob(job.id, { transaction })
            ).collectionJob;
            expect(storedCollectionJob.id).toEqual(job.id);
            expect(storedCollectionJob.status).toEqual('COMPLETED');
            expect(storedCollectionJob.externalLogsUrl).toEqual(
                externalLogsUrl
            );
            foundStatus = false;
            for (const testStatus of storedCollectionJob.testStatus) {
                let expectedStatus = COLLECTION_JOB_STATUS.CANCELLED;
                if (testStatus.test.id === selectedTest.id) {
                    foundStatus = true;
                    expectedStatus = COLLECTION_JOB_STATUS.CANCELLED;
                }
                expect(testStatus.status).toEqual(expectedStatus);
            }
            expect(foundStatus).toEqual(true);
        });
    });

    it('should copy assertion results when updating with results that match historical results', async () => {
        await apiServer.sessionAgentDbCleaner(async transaction => {
            const context = getGraphQLContext({
                req: {
                    session: { user: { roles: [{ name: 'ADMIN' }] } },
                    transaction
                }
            });

            // Start by getting historical results for comparing later
            // Test plan report used for test is in Draft so it
            // must be markedAsFinal to have historical results
            const finalizedTestPlanVersion = await markAsFinalResolver(
                { parentContext: { id: testPlanReportId } },
                null,
                context
            );

            const { testPlanReport } = await getTestPlanReport(
                finalizedTestPlanVersion.testPlanReport.id,
                { transaction }
            );
            const selectedTestIndex = 0;
            const selectedTestRowNumber = 1;

            const { at, browser } = testPlanReport;
            const historicalTestResult =
                testPlanReport.finalizedTestResults[selectedTestIndex];
            expect(historicalTestResult).not.toEqual(undefined);
            const historicalResponses =
                historicalTestResult?.scenarioResults.map(
                    scenarioResult => scenarioResult.output
                );
            const { atVersion, browserVersion } = historicalTestResult;

            const { scheduleCollectionJob: job } =
                await scheduleCollectionJobByMutation({ transaction });
            const collectionJob = await getCollectionJobById({
                id: job.id,
                transaction
            });
            await sessionAgent
                .post(`/api/jobs/${job.id}`)
                .send({ status: 'RUNNING' })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);

            const response = await sessionAgent
                .post(`/api/jobs/${job.id}/test/${selectedTestRowNumber}`)
                .send({
                    capabilities: {
                        atName: at.name,
                        atVersion: atVersion.name,
                        browserName: browser.name,
                        browserVersion: browserVersion.name
                    },
                    responses: historicalResponses
                })
                .set(
                    'x-automation-secret',
                    process.env.AUTOMATION_SCHEDULER_SECRET
                )
                .set('x-transaction-id', transaction.id);
            expect(response.statusCode).toBe(200);

            const storedTestPlanRun = await getTestPlanRun(
                collectionJob.testPlanRun.id,
                { transaction }
            );

            const { testResults } = storedTestPlanRun.testPlanRun;

            testResults.forEach(testResult => {
                expect(testResult.test.id).toEqual(
                    historicalTestResult.test.id
                );
                expect(testResult.atVersion.name).toEqual(atVersion.name);
                expect(testResult.browserVersion.name).toEqual(
                    browserVersion.name
                );
                testResult.scenarioResults.forEach((scenarioResult, index) => {
                    const historicalScenarioResult =
                        historicalTestResult.scenarioResults[index];
                    expect(scenarioResult.output).toEqual(
                        historicalScenarioResult.output
                    );

                    scenarioResult.assertionResults.forEach(
                        (assertionResult, index) => {
                            const historicalAssertionResult =
                                historicalScenarioResult.assertionResults[
                                    index
                                ];
                            expect(assertionResult.passed).toEqual(
                                historicalAssertionResult.passed
                            );
                            expect(assertionResult.failedReason).toEqual(
                                historicalAssertionResult.failedReason
                            );
                        }
                    );
                    scenarioResult.unexpectedBehaviors?.forEach(
                        (unexpectedBehavior, index) => {
                            expect(unexpectedBehavior.id).toEqual(
                                historicalScenarioResult.unexpectedBehaviors[
                                    index
                                ].id
                            );
                            expect(unexpectedBehavior.details).toEqual(
                                historicalScenarioResult.unexpectedBehaviors[
                                    index
                                ].details
                            );
                        }
                    );
                });
            });
        });
    });

    it('should delete a job', async () => {
        await dbCleaner(async transaction => {
            const { scheduleCollectionJob: job } =
                await scheduleCollectionJobByMutation({ transaction });
            const { collectionJob: storedCollectionJob } =
                await getTestCollectionJob(job.id, { transaction });
            expect(storedCollectionJob.id).toEqual(job.id);

            const res = await deleteCollectionJobByMutation(job.id, {
                transaction
            });
            expect(res).toEqual({
                deleteCollectionJob: true
            });

            const { collectionJob: deletedCollectionJob } =
                await getTestCollectionJob(job.id, { transaction });
            expect(deletedCollectionJob).toEqual(null);
        });
    });
});
