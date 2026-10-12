from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, Field

NAME = r"^[a-z0-9][a-z0-9._-]{1,31}$"
TEAM = r"^[a-z0-9][a-z0-9-]{1,31}$"


def lowered(value: object) -> object:
    return value.strip().lower() if isinstance(value, str) else value


Handle = Annotated[str, BeforeValidator(lowered), Field(pattern=NAME, examples=["sam"])]
TeamName = Annotated[str, BeforeValidator(lowered), Field(pattern=TEAM, examples=["frontend"])]


class User(BaseModel):
    name: str = Field(examples=["sam"])
    team: str = Field(examples=["backend"])
    is_admin: bool = False


class Member(BaseModel):
    name: str
    is_admin: bool = False


class Team(BaseModel):
    name: str = Field(examples=["frontend"])
    members: list[Member] = []


class MembersResponse(BaseModel):
    teams: list[Team]


class InviteRequest(BaseModel):
    team: TeamName | None = Field(default=None, description="The team the newcomer joins; they choose when empty")
    admin: bool = Field(default=False, description="Whether the newcomer may invite and remove members")
    days: int = Field(default=7, ge=1, le=30, description="How long the link works")


class Invite(BaseModel):
    url: str = Field(
        description="Single-use link to send to the newcomer", examples=["https://handoff.example.com/join/…"]
    )
    team: str | None = None
    admin: bool = False
    expires_at: datetime


class JoinRequest(BaseModel):
    code: str = Field(min_length=8, max_length=80)
    name: Handle
    team: TeamName | None = Field(default=None, description="Needed when the invite names no team")


class Joined(BaseModel):
    name: str
    team: str
    is_admin: bool
    url: str = Field(description="The server URL the plugin asks for")
    token: str = Field(description="Personal token, shown once")


class Token(BaseModel):
    token: str = Field(description="The new personal token, shown once; the old one stopped working")


class Meta(BaseModel):
    name: str = "team-handoff"
    version: str = Field(examples=["0.7.0"])
    min_plugin: str = Field(description="Oldest plugin version this server works with", examples=["0.7.0"])
