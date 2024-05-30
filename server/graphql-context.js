const AtLoader = require('./models/loaders/AtLoader');
const BrowserLoader = require('./models/loaders/BrowserLoader');

const getGraphQLContext = ({ req }) => {
    const user =
        req && req.session && req.session.user ? req.session.user : null;

    // Req will not be defined when queries are made with apolloServer.executeOperation()
    let transaction = req ? req.transaction : false;

    const atLoader = AtLoader();
    const browserLoader = BrowserLoader();
    console.log('gql context', transaction?.id);
    return { user, atLoader, browserLoader, transaction };
};

module.exports = getGraphQLContext;
