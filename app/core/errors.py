class HandoffError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class Unauthorized(HandoffError):
    status_code = 401
    code = "unauthorized"


class Forbidden(HandoffError):
    status_code = 403
    code = "forbidden"


class NotFound(HandoffError):
    status_code = 404
    code = "not_found"


class Conflict(HandoffError):
    status_code = 409
    code = "conflict"


class TooManyRequests(HandoffError):
    status_code = 429
    code = "too_many_requests"
