// A domain error that carries an HTTP status. Thrown by services and translated
// to a response by the route-level error handler, which keeps route handlers thin.
//
// `code` is optional and machine-readable (e.g. 'SOLO_CANNOT_SUBMIT',
// 'TEAM_CONSTRAINT'). Pages branch on it; the message is for people.
class ServiceError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

module.exports = ServiceError;
