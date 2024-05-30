const { ApolloServer } = require('apollo-server');
const typeDefs = require('../../graphql-schema');
const getGraphQLContext = require('../../graphql-context');
const resolvers = require('../../resolvers');
const defaultUser = require('../mock-data/newUser.json');

let mockReq;

const server = new ApolloServer({
    typeDefs,
    context: () => getGraphQLContext({ req: mockReq }),
    resolvers,
    plugins: [
        {
            async requestDidStart(arg) {
                arg.logger.log = arg.logger.info;
                console.log('requestDidStart', arg.context, arg.query);
                return {
                    async didResolveSource(arg) {
                        console.log('didResolveSource', arg.source);
                    },
                    async parsingDidStart(arg) {
                        console.log('parsing did start');
                        return async (err) => console.error(err);
                    },
                    async didResolveOperation(arg) {
                        console.log('didResolveOperation', require('util').inspect(arg.operation, false, 10, true));
                    },
                    async didEncounterErrors(arg) {
                        console.error('didEncounterErrors', arg);
                    },
                    async willSendResponse(arg) {
                        console.log('willSendResponse', arg.response);
                    }
                };
            }
        }
    ]
});

const failWithErrors = errors => {
    let formatted = '';
    errors.forEach(error => {
        if (error.originalError) {
            formatted += `${error.originalError.stack}\n\n`;
        }

        const formattedType = error.name ? `${error.name}: ` : '';
        const formattedPath = error.path
            ? ` in ${JSON.stringify(error.path)} `
            : '';
        let formattedException = '';
        if (error.extensions.exception) {
            formattedException = 'Exception content:\n\n';
            Object.entries(error.extensions.exception).forEach(
                ([key, value]) => {
                    formattedException += `${key}:\n${value}\n\n`;
                }
            );
            delete error.extensions.exception;
        }
        formatted +=
            `GraphQL error${formattedPath}:\n\n` +
            `${formattedType}${error.message}\n\n` +
            `(${JSON.stringify({
                extensions: error.extensions,
                location: error.location
            })})\n\n` +
            formattedException;
    });
    throw new Error(formatted);
};

/**
 * Returns the data from a given query, useful for situations where errors are
 * not expected.
 * @param {GraphQLSyntaxTree} gql - GraphQL query from a gql template string.
 * @example gql`query { me { username } }`
 * @param {object} options
 * @param {object} options.user - Replace the default user or set it to null
 * to simulate being logged out.
 * @param {*} options.transaction - Sequelize transaction
 * @returns {any} Data matching the query.
 */
const query = async (
    gql,
    { transaction, user = defaultUser, ...queryOptions } = {}
) => {
    mockReq = { session: { user }, transaction };
    console.log('setup mock req', transaction?.id, gql);
    const { data, errors } = await server.executeOperation({
        query: gql,
        ...queryOptions
    });
    console.log(data, errors);
    if (errors) failWithErrors(errors);
    return data;
};

const mutate = async (gql, options) => {
    return query(gql, options); // same as query
};

module.exports = { query, mutate };
