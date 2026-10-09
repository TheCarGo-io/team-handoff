from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    DEBUG: bool = False
    DATABASE_URL: str = "postgresql+asyncpg://postgres:123@localhost:5432/thecargo_handoff"
    MIGRATION_DATABASE_URL: str | None = None
    DB_USE_NULLPOOL: bool = False
    DB_POOL_SIZE: int = 3
    DB_MAX_OVERFLOW: int = 2
    REDIS_URL: str = "redis://localhost:6379/0"
    REDIS_PREFIX: str = "handoff"
    PUBLIC_URL: str = "http://127.0.0.1:8012"
    EXTRA_ALLOWED_HOSTS: list[str] = []
    TEAMS: list[str] = ["backend", "frontend", "mobile", "design"]
    PROJECTS: list[str] = []
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


settings = Settings()
