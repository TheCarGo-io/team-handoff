from app.schemas.report import ErrorResponse

UNAUTHORIZED = {401: {"model": ErrorResponse, "description": "Missing, unknown or revoked token"}}
NOT_FOUND = {404: {"model": ErrorResponse, "description": "The report does not exist or has expired"}}
FORBIDDEN = {403: {"model": ErrorResponse, "description": "Your team or user may not do this to the report"}}
CONFLICT = {409: {"model": ErrorResponse, "description": "The report is not in a status that allows this"}}
BAD_REQUEST = {400: {"model": ErrorResponse, "description": "Unknown team, project or recipient, or nothing to change"}}
INVALID = {422: {"model": ErrorResponse, "description": "A field is missing, too long or malformed"}}
RATE_LIMITED = {429: {"model": ErrorResponse, "description": "Too many changes in one minute"}}
WRITE = {**INVALID, **RATE_LIMITED}
