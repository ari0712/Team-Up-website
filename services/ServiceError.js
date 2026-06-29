// A domain error that carries an HTTP status. Thrown by services and translated
// to a response by the route-level error handler, which keeps route handlers thin.
class ServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

module.exports = ServiceError;
