import json
from pathlib import Path
from typing import Annotated
from urllib.parse import quote

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

Names = Annotated[list[str], NoDecode]


class Settings(BaseSettings):
    DEBUG: bool = False
    DATABASE_URL: str = ""
    DB_HOST: str = "localhost:5432"
    DB_NAME: str = "handoff"
    DB_USER: str = "handoff"
    DB_PASSWORD: str = ""
    DB_PASSWORD_FILE: str | None = None
    MIGRATION_DATABASE_URL: str | None = None
    LISTEN_DATABASE_URL: str | None = None
    DB_USE_NULLPOOL: bool = False
    DB_POOL_SIZE: int = 3
    DB_MAX_OVERFLOW: int = 2
    PUBLIC_URL: str = "http://127.0.0.1:8012"
    EXTRA_ALLOWED_HOSTS: Names = []
    PLUGIN_SOURCE: str = "TheCarGo-io/team-handoff"
    PLUGIN_ID: str = "handoff@thecargo"
    TEAMS: Names = ["backend", "frontend", "mobile", "design"]
    PROJECTS: Names = []
    PROJECT_ALIASES: dict[str, str] = {}
    CLOSED_VISIBLE_DAYS: int = 14
    SSE_HEARTBEAT_SECONDS: float = 25.0
    MAX_STREAMS_PER_USER: int = 20
    SESSION_GRACE_SECONDS: float = 90.0
    MAX_TEXT_LENGTH: int = 60000
    MAX_REPLY_LENGTH: int = 20000
    MAX_REPLIES: int = 50
    MAX_ITEMS: int = 30
    WRITES_PER_MINUTE: int = 60

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @field_validator("EXTRA_ALLOWED_HOSTS", "TEAMS", "PROJECTS", mode="before")
    @classmethod
    def split_names(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        text = value.strip()
        if text.startswith("["):
            return json.loads(text)
        return [name.strip() for name in text.split(",") if name.strip()]

    @model_validator(mode="after")
    def assemble_database_url(self) -> "Settings":
        if not self.DATABASE_URL:
            password = Path(self.DB_PASSWORD_FILE).read_text().strip() if self.DB_PASSWORD_FILE else self.DB_PASSWORD
            account = f"{quote(self.DB_USER, safe='')}:{quote(password, safe='')}"
            self.DATABASE_URL = f"postgresql+asyncpg://{account}@{self.DB_HOST}/{self.DB_NAME}"
        return self

    @property
    def listen_dsn(self) -> str:
        return (self.LISTEN_DATABASE_URL or self.DATABASE_URL).replace("postgresql+asyncpg://", "postgresql://", 1)


settings = Settings()
