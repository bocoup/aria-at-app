const {
    getCollectionJobById
} = require('../models/services/CollectionJobService');

const collectionJobResolver = async (_, { id }, context) => {
    const { transaction } = context;
    console.log('collection job resolver', transaction.id);
    const collectionJob = await getCollectionJobById({ id, transaction });

    return collectionJob;
};

module.exports = collectionJobResolver;
