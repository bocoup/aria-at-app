const { isFunction, isEqualWith, sortBy } = require('lodash');
const { sequelize } = require('..');

/**
 * Created Query Sequelize Example:
 * UserModel.findOne({
 *   where: { id },
 *   attributes: ['username', 'email'],
 *   include: [
 *     {
 *       model: RoleModel,
 *       as: 'roles'
 *       attributes: ['name', 'permissions']
 *     }
 *   ]
 * })
 *
 * @example
 * // returns { attribute: 'value', associationData: [ { associationAttribute: 'associationAttributeValue' } ] }
 * return ModelService.getById(Model, {
 *   id,
 *   attributes: ['attribute'],
 *   include: [
 *     {
 *       model: AssociationModel,
 *       as: 'associationData',
 *       attributes: ['associationAttribute']
 *     }
 *   ]
 * })
 *
 * @param {Model} model - Sequelize Model instance to query for
 * @param {object} options
 * @param {number | string} options.id - ID of the Sequelize Model to query for
 * @param {any[]} options.attributes - attributes of the Sequelize Model to be returned
 * @param {any[]} options.include - information on Sequelize Model relationships
 * @param {*} options.transaction - Current transaction
 * @returns {Promise<Model>} - Sequelize Model
 */
const getById = async (
    model,
    { id, attributes = [], include = [], transaction, logging }
) => {
    if (!model) throw new Error('Model not defined');

    if (!transaction && transaction !== false) {
        throw new Error(
            'Please provide a transaction via the "transaction" field or ' +
                'pass a value of false to specify that a transaction is not ' +
                'needed'
        );
    }

    // findByPk
    return model.findOne({
        where: { id },
        attributes,
        include,
        transaction,
        logging
    });
};

/**
 * @param {Model} model - Sequelize Model instance to query for
 * @param {object} options
 * @param {object} options.where - values to be used to query Sequelize Model
 * @param {any[]} options.attributes - attributes of the Sequelize Model to be returned
 * @param {any[]} options.include - information on Sequelize Model relationships
 * @param {*} options.transaction - Sequelize transaction
 * @returns {Promise<Model>} - Sequelize Model
 */
const getByQuery = async (
    model,
    { where, attributes = [], include = [], transaction }
) => {
    if (!model) throw new Error('Model not defined');

    if (!transaction && transaction !== false) {
        throw new Error(
            'Please provide a transaction via the "transaction" field or ' +
                'pass a value of false to specify that a transaction is not ' +
                'needed'
        );
    }

    return model.findOne({
        where: { ...where },
        attributes,
        include,
        transaction
    });
};

/**
 * @link {https://sequelize.org/v5/manual/models-usage.html#-code-findandcountall--code----search-for-multiple-elements-in-the-database--returns-both-data-and-total-count}
 * @param {Model} model - Sequelize Model instance to query for
 * @param {object} options
 * @param {object} options.where - values to be used to search Sequelize Model
 * @param {any[]} options.attributes - attributes of the Sequelize Model to be returned
 * @param {any[]} options.include - information on Sequelize Model relationships
 * @param {object} options.pagination - pagination options for query (page and limit; it also includes sorting functionality)
 * @param {number} options.pagination.page - page to be queried in the pagination result (affected by {@param pagination.enablePagination})
 * @param {number} options.pagination.limit - amount of results to be returned per page (affected by {@param pagination.enablePagination})
 * @param {string[][]} options.pagination.order - expects a Sequelize structured input dataset for sorting the Sequelize Model results (NOT affected by {@param pagination.enablePagination}). See {@link https://sequelize.org/v5/manual/querying.html#ordering} and {@example [ [ 'username', 'DESC' ], [..., ...], ... ]}
 * @param {boolean} options.pagination.enablePagination - use to enable pagination for a query result as well useful values. Data for all items matching query if not enabled
 * @param {*} options.transaction - Sequelize transaction
 * @returns {Promise<*>} - collection of queried Sequelize Models or paginated structure if pagination flag is enabled
 */
const get = async (
    model,
    {
        where = {}, // passed in search and filtering options
        attributes = [],
        include = [],
        pagination = {},
        transaction,
        logging
    }
) => {
    if (!model) throw new Error('Model not defined');

    if (!transaction && transaction !== false) {
        throw new Error(
            'Please provide a transaction via the "transaction" field or ' +
                'pass a value of false to specify that a transaction is not ' +
                'needed'
        );
    }

    // pagination and sorting options
    let {
        page = 0,
        limit = 10,
        order = [],
        enablePagination = false
    } = pagination; // page 0->1, 1->2; manage through middleware
    // 'order' structure eg. [ [ 'username', 'DESC' ], [..., ...], ... ]
    if (page < 0) page = 0;
    if (limit < 0 || !enablePagination) limit = null;
    const offset = limit < 0 || !limit ? 0 : page * limit; // skip (1 * 10 results) = 10 to get get to page 2

    const queryOptions = {
        where,
        order,
        attributes,
        include, // included fields being marked as 'required' will affect overall count for pagination
        transaction,
        logging
    };

    // enablePagination paginated result structure and related values
    if (enablePagination) {
        const result = await model.findAndCountAll({
            ...queryOptions,
            limit,
            offset,
            distinct: true // applies distinct SQL rule to avoid duplicates created by 'includes' affecting count
        });

        const { count: totalResultsCount, rows: data } = result;
        const resultsCount = data.length;
        const pagesCount = limit ? Math.ceil(totalResultsCount / limit) : 1;

        return {
            page: page + 1,
            pageSize: limit,
            pagesCount,
            resultsCount,
            totalResultsCount,
            data
        };
    }
    return model.findAll({ ...queryOptions });
};

/**
 * @param {Model} model - Sequelize Model instance to query for
 * @param {object} options
 * @param {object} options.params - properties to be used to create the {@param model} Sequelize Model that is being used
 * @param {*} options.transaction - Sequelize transaction
 * @returns {Promise<*>} - result of the sequelize.create function
 */
const create = async (model, { values, transaction }) => {
    if (!model) throw new Error('Model not defined');

    if (!transaction && transaction !== false) {
        throw new Error(
            'Please provide a transaction via the "transaction" field or ' +
                'pass a value of false to specify that a transaction is not ' +
                'needed'
        );
    }
    return model.create(values, { transaction });
};

/**
 * @param {Model} model - Sequelize Model instance to query for
 * @param {object} options
 * @param {object} options.valuesList - array of properties to be used to create the {@param model} Sequelize Model that is being used
 * @param {*} options.transaction - Sequelize transaction
 * @returns {Promise<*>} - result of the sequelize.create function
 */
const bulkCreate = async (model, { valuesList, transaction }) => {
    if (!model) throw new Error('Model not defined');

    if (!transaction && transaction !== false) {
        throw new Error(
            'Please provide a transaction via the "transaction" field or ' +
                'pass a value of false to specify that a transaction is not ' +
                'needed'
        );
    }
    return model.bulkCreate(valuesList, { transaction });
};

/**
 * @param {Model} model - Sequelize Model instance to query for
 * @param {object} options
 * @param {object} options.where - query to be used to find the Sequelize Model to be updated
 * @param {object} options.values - values to be updated when the Sequelize Model is found
 * @param {*} options.transaction - Sequelize transaction
 * @returns {Promise<*>} - result of the sequelize.update function
 */
const update = async (model, { values, where, transaction }) => {
    if (!model) throw new Error('Model not defined');

    if (!transaction && transaction !== false) {
        throw new Error(
            'Please provide a transaction via the "transaction" field or ' +
                'pass a value of false to specify that a transaction is not ' +
                'needed'
        );
    }

    return model.update(values, { where, transaction });
};

/**
 * Gets or creates multiple records for multiple models as part of a
 * single transaction.
 *
 * Accepts an array of objects specifying the get and create functions for the
 * model, the values to get or create, and the attributes to use when returning
 * the final result.
 *
 * If you need the result of previous operations, e.g. the ids, you can pass a
 * function instead of an object.
 *
 * If you need to update fields but do not want to use them in the get query,
 * you can specify an update function and updateValues.
 *
 * Returns an array of results, where each item is an array containing the model
 * instance and a boolean for whether it was newly created.
 *
 * @example
 * const results = await ModelService.nestedGetOrCreate({
 *     operations: [
 *         {
 *             get: getAtVersions,
 *             create: createAtVersion,
 *             values: { atId, atVersion },
 *             returnAttributes: {}
 *         },
 *         {
 *             get: getBrowserVersions,
 *             create: createBrowserVersion,
 *             values: { browserId, browserVersion },
 *             returnAttributes: {}
 *         },
 *         {
 *             get: getTestPlanTargets,
 *             create: createTestPlanTarget,
 *             values: { atId, browserId, atVersion, browserVersion },
 *             returnAttributes: {}
 *         },
 *         accumulatedResults => {
 *             const [testPlanTarget] = accumulatedResults[2];
 *             return {
 *                 get: getTestPlanReports,
 *                 create: createTestPlanReport,
 *                 update: updateTestPlanReport,
 *                 values: {
 *                     testPlanTargetId: testPlanTarget.id,
 *                     testPlanVersionId: testPlanVersionId
 *                 },
 *                 updateValues: { status },
 *                 returnAttributes: {}
 *             };
 *         }
 *     ],
 *     transaction
 * });
 *
 * const [
 *     [atVersion, isNewAtVersion],
 *     [browserVersion, isNewBrowserVersion],
 *     [testPlanTarget, isNewTestPlanTarget],
 *     [testPlanReport, isNewTestPlanReport],
 * ] = results;
 *
 * @param {object} options - Generic options for Sequelize
 * @param {[object|function]} options.operations
 * @param {*} options.transaction - Sequelize transaction
 * @returns {Promise<[[*,Boolean]]>}
 */
const nestedGetOrCreate = async ({ operations, transaction }) => {
    if (!transaction && transaction !== false) {
        throw new Error(
            'Please provide a transaction via the "transaction" field or ' +
                'pass a value of false to specify that a transaction is not ' +
                'needed'
        );
    }

    let accumulatedResults = [];
    for (const getOperation of operations) {
        const {
            get,
            create,
            update,
            values,
            updateValues,
            bulkGetOrReplace,
            bulkGetOrReplaceWhere,
            valuesList,
            returnAttributes
        } = isFunction(getOperation)
            ? getOperation(accumulatedResults)
            : getOperation;

        if (bulkGetOrReplace) {
            if (get || create || update) {
                throw new Error(
                    'Cannot mix bulkGetOrReplace with get, create or update' +
                        'update, because one works with an array and the ' +
                        'others work with a single record'
                );
            }
            const [records, isUpdated] = await bulkGetOrReplace({
                where: bulkGetOrReplaceWhere,
                valuesList,
                ...returnAttributes,
                transaction
            });
            accumulatedResults.push([records, isUpdated]);
            continue;
        }

        const found = await get({
            where: values,
            ...returnAttributes,
            transaction
        });

        if (found.length) {
            if (updateValues) {
                await update({
                    id: found[0].id,
                    values: updateValues,
                    ...returnAttributes,
                    transaction
                });
            }
            accumulatedResults.push([found[0], false]);
            continue;
        }

        const created = await create({
            values: { ...values, ...updateValues },
            ...returnAttributes,
            transaction
        });

        accumulatedResults.push([created, true]);
    }

    return accumulatedResults;
};

/**
 * Allows you to bulk replace an array of records, such as the roles for a user.
 * @example
 * await bulkGetOrReplace(UserRoles, {
 *   where: { userId: 1 },
 *   valuesList: [{ roleName: 'TESTER' }, { roleName: 'ADMIN' }],
 *   transaction,
 * });
 *
 * @param {Model} model - Sequelize Model instance to query for
 * @param {object} where - values to be used to search Sequelize Model. Only supports exact values.
 * @param {object} valuesList - values to be replaced. Note the "where" values will be merged in so they do not need to be duplicated here.
 * @param {object} options - Generic options for Sequelize
 * @param {*} options.transaction - Sequelize transaction
 * @returns {Promise<boolean>} - True / false if the records were replaced
 */
const bulkGetOrReplace = async (Model, { where, valuesList, transaction }) => {
    if (!transaction && transaction !== false) {
        throw new Error(
            'Please provide a transaction via the "transaction" field or ' +
                'pass a value of false to specify that a transaction is not ' +
                'needed'
        );
    }

    const comparisonKeys =
        valuesList.length === 0 ? [] : Object.keys(valuesList[0]);

    const whereKeys = Object.keys(where);

    const persistedValues = await get(Model, {
        where,
        attributes: [...whereKeys, ...comparisonKeys],
        transaction
    });

    const isUpdated =
        valuesList.length === 0
            ? persistedValues.length !== 0
            : !isEqualWith(
                  sortBy(persistedValues, comparisonKeys),
                  sortBy(valuesList, comparisonKeys),
                  (persisted, expected, index) => {
                      // See https://github.com/lodash/lodash/issues/2490
                      if (index === undefined) return;

                      return !comparisonKeys.find(comparisonKey => {
                          return (
                              persisted[comparisonKey] !==
                              expected[comparisonKey]
                          );
                      });
                  }
              );

    if (isUpdated) {
        // eslint-disable-next-line no-use-before-define
        await removeByQuery(Model, { where, transaction });

        if (valuesList.length !== 0) {
            const fullRecordValues = valuesList.map(expectedValue => ({
                ...where,
                ...expectedValue
            }));

            await bulkCreate(Model, {
                valuesList: fullRecordValues,
                transaction
            });
        }
    }

    return isUpdated;
};

/**
 * See {@link https://sequelize.org/v5/class/lib/model.js~Model.html#static-method-destroy}
 * @param {Model} model - Sequelize Model instance to query for
 * @param {object} options
 * @param {number | string} options.id - ID of the Sequelize Model to be removed
 * @param {boolean} options.truncate - enables the truncate option to be used when running a deletion
 * @param {*} options.transaction - Sequelize transaction
 * @returns {Promise<boolean>} - returns true if record was deleted
 */
const removeById = async (model, { id, truncate = false, transaction }) => {
    if (!model) throw new Error('Model not defined');

    if (!transaction && transaction !== false) {
        throw new Error(
            'Please provide a transaction via the "transaction" field or ' +
                'pass a value of false to specify that a transaction is not ' +
                'needed'
        );
    }

    await model.destroy({
        where: { id },
        truncate,
        transaction
    });

    return true;
};

/**
 * @param {Model} model - Sequelize Model instance to query for
 * @param {object} options
 * @param options.where - query params to be used to find the Sequelize Models to be removed
 * @param {boolean} options.truncate - enables the truncate option to be used when running a deletion
 * @param {*} options.transaction - Sequelize transaction
 * @returns {Promise<boolean>} - returns true if record was deleted
 */
const removeByQuery = async (
    model,
    { where, truncate = false, transaction }
) => {
    if (!model) throw new Error('Model not defined');

    if (!transaction && transaction !== false) {
        throw new Error(
            'Please provide a transaction via the "transaction" field or ' +
                'pass a value of false to specify that a transaction is not ' +
                'needed'
        );
    }

    await model.destroy({ where, truncate, transaction });

    return true;
};

/**
 * See @link {https://sequelize.org/v5/manual/raw-queries.html} for related documentation in case of expanding
 * @param {string} query - raw SQL query string to be executed
 * @returns {Promise<*>} - results of the raw SQL query after being ran
 */
const rawQuery = async (query, { transaction }) => {
    if (!transaction && transaction !== false) {
        throw new Error(
            'Please provide a transaction via the "transaction" field or ' +
                'pass a value of false to specify that a transaction is not ' +
                'needed'
        );
    }

    const [results /*, metadata*/] = await sequelize.query(query, {
        transaction
    });

    return results;
};

module.exports = {
    getById,
    getByQuery,
    get,
    create,
    bulkCreate,
    update,
    bulkGetOrReplace,
    nestedGetOrCreate,
    removeById,
    removeByQuery,
    rawQuery
};
