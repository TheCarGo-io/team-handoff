from fastapi import APIRouter

from app.dependencies.auth import CurrentUser, Members
from app.schemas.responses import BAD_REQUEST, CONFLICT, FORBIDDEN, NOT_FOUND, UNAUTHORIZED
from app.schemas.user import Invite, InviteRequest, Joined, JoinRequest, MembersResponse, Meta, Token

public = APIRouter(prefix="/api/v1", tags=["members"])
router = APIRouter(prefix="/api/v1", tags=["members"], responses=UNAUTHORIZED)


@public.get("/meta", response_model=Meta)
async def meta(members: Members) -> Meta:
    """The server's version and the oldest plugin version it works with. No token needed."""
    return members.meta()


@public.post("/join", response_model=Joined, status_code=201, responses={**BAD_REQUEST, **NOT_FOUND, **CONFLICT})
async def join(body: JoinRequest, members: Members) -> Joined:
    """Use an invite: creates the member and returns their personal token once. No token needed."""
    return await members.join(body)


@router.get("/members", response_model=MembersResponse)
async def members_list(user: CurrentUser, members: Members) -> MembersResponse:
    """Every team with its members."""
    return await members.members()


@router.post("/invites", response_model=Invite, status_code=201, responses=FORBIDDEN)
async def invite(body: InviteRequest, user: CurrentUser, members: Members) -> Invite:
    """Create a single-use invite link (admins only). Naming a team that does not exist creates it."""
    return await members.invite(user, body)


@router.delete("/members/{name}", status_code=204, responses={**FORBIDDEN, **NOT_FOUND, **CONFLICT})
async def remove(name: str, user: CurrentUser, members: Members) -> None:
    """Remove a member and revoke their token (admins only). Reports they held go back to waiting."""
    await members.remove(user, name)


@router.post("/me/token", response_model=Token)
async def rotate(user: CurrentUser, members: Members) -> Token:
    """Replace my token: the old one stops working at once, the new one is shown once."""
    return await members.rotate(user)
