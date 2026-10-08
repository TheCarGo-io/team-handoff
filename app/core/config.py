from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    DEBUG: bool = False
    REDIS_URL: str = "redis://localhost:6379/0"
    REDIS_PREFIX: str = "handoff"
    PUBLIC_URL: str = "http://127.0.0.1:8012"
    EXTRA_ALLOWED_HOSTS: list[str] = []
    TEAMS: list[str] = ["backend", "frontend", "mobile", "design"]
    PROJECTS: list[str] = []
    OPEN_TTL_DAYS: int = 7
    CLOSED_TTL_HOURS: int = 48
    SSE_HEARTBEAT_SECONDS: float = 25.0
    MAX_STREAMS_PER_USER: int = 20
    MAX_TEXT_LENGTH: int = 20000
    MAX_REPLY_LENGTH: int = 4000
    MAX_REPLIES: int = 50
    WRITES_PER_MINUTE: int = 60

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
