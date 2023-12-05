// Middleware requires 4 parameters to be recognized by Express
// eslint-disable-next-line no-unused-vars
const handleError = (err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({ error: err.message });
    console.error(err);
};

module.exports = {
    handleError
};
