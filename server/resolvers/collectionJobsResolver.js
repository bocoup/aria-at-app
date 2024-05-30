const {
    getCollectionJobs
} = require('../models/services/CollectionJobService');

const collectionJobsResolver = async (_, __, context) => {
    const { transaction } = context;
    console.log('collectionJobs', transaction?.id);
    const collectionJobs = await getCollectionJobs({ transaction });

    return collectionJobs;
};

module.exports = collectionJobsResolver;
